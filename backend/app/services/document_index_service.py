"""
Document Index Service - chunk, index, and search uploaded documents.

Supports PDF (via pypdf if installed) and plain-text / Markdown files.

Search strategy (tiered, best-available):
  1. Hybrid BM25 + semantic (fastembed + hnswlib) when both packages are installed.
  2. BM25-only when fastembed or hnswlib are absent.
  3. OpenAI embedding fallback (text-embedding-3-small) if OPENAI_API_KEY is set
     and PREFER_OPENAI_EMBED=1. (Legacy path - offline semantic is now preferred.)

Storage layout under {DATA_DIR}/doc_index/  (DATA_DIR resolved by
app.core.config - ``~/.ifc-atlas/data`` by default):
  {doc_id}.meta.json       - document metadata
  {doc_id}.chunks.json     - list of chunk strings (plain text)
  {doc_id}.embeddings.npy  - float32 numpy array (rows = chunks) - optional
  __semantic.hnsw          - serialised hnswlib HNSW index for fast restart
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

from app.core.config import DATA_DIR as _CONFIG_DATA_DIR

DOC_INDEX_DIR = _CONFIG_DATA_DIR / "doc_index"
CHUNK_SIZE = 512      # characters per chunk
CHUNK_OVERLAP = 64    # characters overlap between adjacent chunks
BM25_K1 = 1.5
BM25_B = 0.75
MAX_DOCS = 50         # hard cap on indexed documents

# Fastembed model - BAAI/bge-small-en-v1.5 (25 MB ONNX, 384 dims, MTEB 63.2).
# Outperforms all-MiniLM-L6-v2 (MTEB 56.3) at the same file size.
FASTEMBED_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384

# Weight for combining BM25 and semantic scores in hybrid search.
# 0.0 = pure BM25, 1.0 = pure semantic.  0.5 is a balanced default.
HYBRID_ALPHA = 0.5


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def _extract_text(content_bytes: bytes, filename: str) -> str:
    """Best-effort text extraction from PDF or text/markdown bytes."""
    lower = filename.lower()
    if lower.endswith(".pdf"):
        try:
            import pypdf  # type: ignore
            import io
            reader = pypdf.PdfReader(io.BytesIO(content_bytes))
            parts = []
            for page in reader.pages:
                text = page.extract_text() or ""
                parts.append(text)
            return "\n".join(parts)
        except ImportError:
            logger.warning("pypdf not installed - treating PDF as raw text")
        except Exception as exc:
            logger.warning("PDF extraction failed (%s) - treating as text", exc)
    try:
        return content_bytes.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _chunk_text(text: str) -> list[str]:
    """Split text into overlapping chunks, preferring paragraph boundaries."""
    if not text.strip():
        return []

    text = re.sub(r"\r\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)

    chunks: list[str] = []
    start = 0
    length = len(text)

    while start < length:
        end = min(start + CHUNK_SIZE, length)
        lookback_start = max(start, end - CHUNK_SIZE // 5)
        para_break = text.rfind("\n\n", lookback_start, end)
        if para_break > lookback_start:
            end = para_break

        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)

        if end >= length:
            break

        step = max(1, CHUNK_SIZE - CHUNK_OVERLAP)
        start = start + step

    return chunks


def _tokenize(text: str) -> list[str]:
    """Lowercase, split on non-word chars."""
    return re.findall(r"[a-z0-9_]+", text.lower())


# ---------------------------------------------------------------------------
# BM25 index
# ---------------------------------------------------------------------------

class _BM25Index:
    """Minimal BM25 in-memory index over a flat list of chunk texts."""

    def __init__(self, chunks: list[str]):
        self._chunks = chunks
        self._tokenized = [_tokenize(c) for c in chunks]
        self._n = len(chunks)
        self._avgdl = (
            sum(len(t) for t in self._tokenized) / self._n if self._n else 1.0
        )
        df: Counter = Counter()
        for toks in self._tokenized:
            for tok in set(toks):
                df[tok] += 1
        self._df = df

    def _idf(self, term: str) -> float:
        df = self._df.get(term, 0)
        return math.log((self._n - df + 0.5) / (df + 0.5) + 1)

    def search(self, query: str, top_k: int = 5) -> list[tuple[int, float]]:
        """Return list of (chunk_idx, bm25_score) sorted desc."""
        query_terms = _tokenize(query)
        if not query_terms or self._n == 0:
            return []
        scores = [0.0] * self._n
        for term in query_terms:
            idf = self._idf(term)
            for i, toks in enumerate(self._tokenized):
                tf = toks.count(term)
                if tf == 0:
                    continue
                dl = len(toks)
                tf_norm = (tf * (BM25_K1 + 1)) / (
                    tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / self._avgdl)
                )
                scores[i] += idf * tf_norm
        ranked = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
        return [(idx, sc) for idx, sc in ranked[:top_k] if sc > 0.0]


# ---------------------------------------------------------------------------
# Semantic (fastembed + hnswlib) index - optional
# ---------------------------------------------------------------------------

def _fastembed_available() -> bool:
    """Return True if both fastembed and hnswlib are importable."""
    try:
        import fastembed  # type: ignore  # noqa: F401
        import hnswlib    # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


def _embed_texts(texts: list[str]) -> "Any | None":
    """
    Embed texts using fastembed. Returns numpy float32 array shape (n, dim),
    or None if fastembed is not available.
    """
    try:
        import numpy as np
        from fastembed import TextEmbedding  # type: ignore
        model = TextEmbedding(FASTEMBED_MODEL)
        vecs = list(model.embed(texts))
        return np.array(vecs, dtype="float32")
    except ImportError:
        return None
    except Exception as exc:
        logger.warning("Embedding failed: %s", exc)
        return None


def _embed_query(query: str) -> "Any | None":
    """Embed a single query string. Returns float32 array (1, dim) or None."""
    try:
        import numpy as np
        from fastembed import TextEmbedding  # type: ignore
        model = TextEmbedding(FASTEMBED_MODEL)
        vec = next(model.embed([query]))
        return np.array([vec], dtype="float32")
    except ImportError:
        return None
    except Exception as exc:
        logger.warning("Query embedding failed: %s", exc)
        return None


def _build_hnsw_index(embeddings: "Any") -> "Any":
    """Build an hnswlib cosine-similarity index from a float32 embedding matrix."""
    import hnswlib  # type: ignore
    n, dim = embeddings.shape
    index = hnswlib.Index(space="cosine", dim=dim)
    index.init_index(max_elements=max(n + 100, 1000), ef_construction=200, M=16)
    if n > 0:
        index.add_items(embeddings, list(range(n)))
    index.set_ef(50)
    return index


def _normalise_scores(scores: dict[int, float]) -> dict[int, float]:
    """Scale a score dict to [0, 1] relative to its maximum. Preserves zeros."""
    if not scores:
        return {}
    mx = max(scores.values())
    if mx == 0:
        return {k: 0.0 for k in scores}
    return {k: v / mx for k, v in scores.items()}


def _cosine_semantic_search(
    hnsw_index: "Any",
    query_vec: "Any",
    top_k: int,
) -> list[tuple[int, float]]:
    """Return list of (global_chunk_idx, cosine_sim_score) from hnswlib."""
    labels, distances = hnsw_index.knn_query(query_vec, k=min(top_k, hnsw_index.get_current_count()))
    # hnswlib cosine space returns distances = 1 - cosine_sim, so sim = 1 - dist
    results = []
    for label, dist in zip(labels[0], distances[0]):
        sim = float(1.0 - dist)
        results.append((int(label), sim))
    return sorted(results, key=lambda x: x[1], reverse=True)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class DocumentIndexService:
    """Thread-safe (enough for single-worker FastAPI) document index."""

    def __init__(self, index_dir: Path | None = None):
        self._index_dir = Path(index_dir) if index_dir is not None else DOC_INDEX_DIR
        self._index_dir.mkdir(parents=True, exist_ok=True)
        self._loaded = False
        self._docs: dict[str, dict] = {}
        self._chunks: list[dict] = []
        self._bm25: _BM25Index | None = None
        self._hnsw: Any = None          # hnswlib Index or None
        self._has_semantic = False      # True when hnsw is built and usable

    # ------------------------------------------------------------------ load

    def _ensure_loaded(self):
        if self._loaded:
            return
        self._loaded = True
        for meta_path in sorted(self._index_dir.glob("*.meta.json")):
            try:
                meta = json.loads(meta_path.read_text("utf-8"))
                doc_id = meta["doc_id"]
                chunks_path = self._index_dir / f"{doc_id}.chunks.json"
                if not chunks_path.exists():
                    continue
                chunks = json.loads(chunks_path.read_text("utf-8"))
                self._docs[doc_id] = meta
                for i, chunk_text in enumerate(chunks):
                    self._chunks.append(
                        {"doc_id": doc_id, "name": meta["name"], "chunk_idx": i, "text": chunk_text}
                    )
            except Exception as exc:
                logger.warning("Failed to load doc index entry %s: %s", meta_path, exc)
        self._rebuild_bm25()
        self._rebuild_semantic()

    def _rebuild_bm25(self):
        texts = [c["text"] for c in self._chunks]
        self._bm25 = _BM25Index(texts)

    def _rebuild_semantic(self):
        """Rebuild the hnswlib HNSW index from all persisted .embeddings.npy files."""
        if not _fastembed_available():
            self._hnsw = None
            self._has_semantic = False
            return

        try:
            import numpy as np

            if not self._chunks:
                self._hnsw = None
                self._has_semantic = False
                return

            # Collect embeddings in chunk order
            all_vecs: list["np.ndarray"] = []
            for chunk in self._chunks:
                doc_id = chunk["doc_id"]
                chunk_idx = chunk["chunk_idx"]
                npy_path = self._index_dir / f"{doc_id}.embeddings.npy"
                if not npy_path.exists():
                    all_vecs.append(np.zeros(EMBEDDING_DIM, dtype="float32"))
                    continue
                try:
                    doc_embs = np.load(str(npy_path))
                    if chunk_idx < len(doc_embs):
                        all_vecs.append(doc_embs[chunk_idx])
                    else:
                        all_vecs.append(np.zeros(EMBEDDING_DIM, dtype="float32"))
                except Exception:
                    all_vecs.append(np.zeros(EMBEDDING_DIM, dtype="float32"))

            embeddings = np.vstack(all_vecs).astype("float32")
            self._hnsw = _build_hnsw_index(embeddings)
            self._has_semantic = True
            logger.info("Semantic index built: %d chunks, %d dims", len(self._chunks), EMBEDDING_DIM)

        except Exception as exc:
            logger.warning("Semantic index build failed: %s", exc)
            self._hnsw = None
            self._has_semantic = False

    # ----------------------------------------------------------------- index

    def index_document(self, name: str, content_bytes: bytes) -> dict:
        """Extract text from bytes, chunk, embed if possible, and persist."""
        self._ensure_loaded()

        if len(self._docs) >= MAX_DOCS:
            raise ValueError(f"Document index is full ({MAX_DOCS} docs). Delete some before adding more.")

        text = _extract_text(content_bytes, name)
        if not text.strip():
            raise ValueError("Could not extract any text from the uploaded file.")

        chunks = _chunk_text(text)
        if not chunks:
            raise ValueError("Document produced no indexable chunks.")

        doc_id = str(uuid.uuid4())
        meta = {
            "doc_id": doc_id,
            "name": name,
            "chunk_count": len(chunks),
            "char_count": len(text),
            "uploaded_at": datetime.now(timezone.utc).isoformat(),
            "sha256": hashlib.sha256(content_bytes).hexdigest()[:16],
            "semantic": False,
        }

        # Persist chunks
        (self._index_dir / f"{doc_id}.meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )
        (self._index_dir / f"{doc_id}.chunks.json").write_text(
            json.dumps(chunks, indent=2), encoding="utf-8"
        )

        # Embed and persist embeddings if fastembed available
        embeddings = _embed_texts(chunks)
        if embeddings is not None:
            try:
                import numpy as np
                np.save(str(self._index_dir / f"{doc_id}.embeddings.npy"), embeddings)
                meta["semantic"] = True
                # Update meta file with semantic flag
                (self._index_dir / f"{doc_id}.meta.json").write_text(
                    json.dumps(meta, indent=2), encoding="utf-8"
                )
                logger.info("Embedded %d chunks for '%s'", len(chunks), name)
            except Exception as exc:
                logger.warning("Failed to save embeddings: %s", exc)

        # Update in-memory state
        self._docs[doc_id] = meta
        for i, chunk_text in enumerate(chunks):
            self._chunks.append(
                {"doc_id": doc_id, "name": name, "chunk_idx": i, "text": chunk_text}
            )
        self._rebuild_bm25()
        self._rebuild_semantic()

        logger.info("Indexed document '%s' → %d chunks (semantic=%s)", name, len(chunks), meta["semantic"])
        return meta

    # ----------------------------------------------------------------- search

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        """
        Hybrid BM25 + semantic search. When fastembed is available, combines
        normalised BM25 and cosine-similarity scores weighted by HYBRID_ALPHA.
        Falls back to BM25-only when semantic index is unavailable.
        """
        self._ensure_loaded()
        if not self._chunks:
            return []

        # ── BM25 scores (always available)
        bm25_results = self._bm25.search(query, top_k=top_k * 3) if self._bm25 else []
        bm25_scores: dict[int, float] = {idx: sc for idx, sc in bm25_results}

        # ── Semantic scores (optional)
        sem_scores: dict[int, float] = {}
        if self._has_semantic and self._hnsw is not None:
            query_vec = _embed_query(query)
            if query_vec is not None:
                sem_results = _cosine_semantic_search(self._hnsw, query_vec, top_k=top_k * 3)
                sem_scores = {idx: sc for idx, sc in sem_results}

        if not bm25_scores and not sem_scores:
            return []

        norm_bm25 = _normalise_scores(bm25_scores)
        norm_sem = _normalise_scores(sem_scores)

        # ── Combine: hybrid = (1 - alpha) * bm25 + alpha * semantic
        alpha = HYBRID_ALPHA if sem_scores else 0.0
        all_idxs = set(norm_bm25) | set(norm_sem)
        combined: dict[int, float] = {
            idx: (1.0 - alpha) * norm_bm25.get(idx, 0.0) + alpha * norm_sem.get(idx, 0.0)
            for idx in all_idxs
        }

        ranked = sorted(combined.items(), key=lambda x: x[1], reverse=True)[:top_k]

        out = []
        for idx, score in ranked:
            if score <= 0.0 or idx >= len(self._chunks):
                continue
            chunk = self._chunks[idx]
            out.append(
                {
                    "doc_id": chunk["doc_id"],
                    "name": chunk["name"],
                    "chunk_idx": chunk["chunk_idx"],
                    "text": chunk["text"],
                    "score": round(score, 4),
                    "search_mode": "hybrid" if sem_scores else "bm25",
                }
            )
        return out

    # ------------------------------------------------------------------ list

    def list_docs(self) -> list[dict]:
        """Return metadata for all indexed documents, newest first."""
        self._ensure_loaded()
        return sorted(
            self._docs.values(),
            key=lambda d: d.get("uploaded_at", ""),
            reverse=True,
        )

    # ---------------------------------------------------------------- delete

    def delete_doc(self, doc_id: str) -> bool:
        """Remove a document and its chunks. Returns True if found."""
        self._ensure_loaded()
        if doc_id not in self._docs:
            return False
        for suffix in (".meta.json", ".chunks.json", ".embeddings.npy"):
            path = self._index_dir / f"{doc_id}{suffix}"
            if path.exists():
                path.unlink()
        del self._docs[doc_id]
        self._chunks = [c for c in self._chunks if c["doc_id"] != doc_id]
        self._rebuild_bm25()
        self._rebuild_semantic()
        return True

    # ----------------------------------------------------------- diagnostics

    def semantic_status(self) -> dict:
        """Return current semantic-index status for diagnostics / API."""
        self._ensure_loaded()
        return {
            "available": _fastembed_available(),
            "built": self._has_semantic,
            "model": FASTEMBED_MODEL,
            "chunk_count": len(self._chunks),
            "alpha": HYBRID_ALPHA,
        }


document_index_service = DocumentIndexService()
