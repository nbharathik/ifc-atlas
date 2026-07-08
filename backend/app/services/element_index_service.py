"""
IFC Element Index - per-element NL descriptions + BM25 search.

Search strategy: BM25 keyword shortlist → optional numpy cosine re-rank.

No required new deps: pure-Python BM25 is the baseline.
If numpy is importable, cosine re-ranking is enabled automatically using
a bag-of-words TF-IDF vector space (zero-copy for models <20K elements).

Usage:
    from app.services.element_index_service import element_index
    element_index.invalidate()          # call after model reload
    results = element_index.search("load bearing walls", ifc_model, top_k=10)
"""

from __future__ import annotations

import logging
import math
import re
import threading
from collections import Counter
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# BM25 tuning constants
_K1 = 1.5
_B = 0.75
_SHORTLIST = 50        # BM25 candidates to pass to re-ranker
_MAX_ELEMENTS = 20_000  # beyond this, skip rerank (speed guard)
_MAX_PROPS = 20         # property pairs per element description


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def _tokenise(text: str) -> list[str]:
    """Lowercase, split on non-alphanumerics, drop empty tokens."""
    return [t for t in re.split(r"[^a-z0-9]+", text.lower()) if t]


# ---------------------------------------------------------------------------
# Element description builder
# ---------------------------------------------------------------------------

def _get_storey_name(entity: Any) -> str:
    """Return the containing storey name, or empty string on failure."""
    try:
        import ifcopenshell.util.element as _util  # type: ignore
        container = _util.get_container(entity)
        if container and container.is_a("IfcBuildingStorey"):
            return container.Name or ""
    except Exception:
        pass
    return ""


def _describe_element(entity: Any, ifc_model: Any) -> str:
    """Build a short natural-language description for an IFC entity.

    Includes type, name, storey, and a flattened property-value string.
    Caps property pairs at _MAX_PROPS to bound token length.
    """
    try:
        ifc_type = entity.is_a()
        name = entity.Name or ""
        obj_type = getattr(entity, "ObjectType", None) or ""
        storey = _get_storey_name(entity)

        # Property sets - flat key=value pairs
        props: list[str] = []
        try:
            import ifcopenshell.util.element as _util  # type: ignore
            psets = _util.get_psets(entity)
            for pset_name, pset_props in psets.items():
                if pset_name == "IFCOPENSHELL_QUANTITY":
                    continue
                for k, v in pset_props.items():
                    if v is not None and len(props) < _MAX_PROPS:
                        props.append(f"{k}={v}")
        except Exception:
            pass

        parts = [ifc_type, name, obj_type, storey] + props
        return " ".join(p for p in parts if p)
    except Exception as exc:
        logger.debug("_describe_element(%s): %s", getattr(entity, "id", lambda: "?")(), exc)
        return entity.is_a() if hasattr(entity, "is_a") else ""


# ---------------------------------------------------------------------------
# BM25 helpers
# ---------------------------------------------------------------------------

def _bm25_score(
    query_tokens: list[str],
    doc_tokens: list[str],
    doc_freq: dict[str, int],
    num_docs: int,
    avg_doc_len: float,
) -> float:
    doc_len = len(doc_tokens)
    tf_counter = Counter(doc_tokens)
    score = 0.0
    for token in set(query_tokens):
        tf = tf_counter.get(token, 0)
        if tf == 0:
            continue
        df = doc_freq.get(token, 0)
        if df == 0:
            continue
        idf = math.log((num_docs - df + 0.5) / (df + 0.5) + 1.0)
        tf_norm = tf * (_K1 + 1) / (tf + _K1 * (1 - _B + _B * doc_len / max(avg_doc_len, 1)))
        score += idf * tf_norm
    return score


# ---------------------------------------------------------------------------
# Main index class
# ---------------------------------------------------------------------------

class IFCElementIndex:
    """In-memory BM25 index over IFC element descriptions.

    Thread-safe: a single build lock prevents concurrent rebuilds.
    The index is invalidated when the model is reloaded.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._built = False
        # List of (express_id, ifc_type, name, storey, description)
        self._docs: list[tuple[int, str, str, str, str]] = []
        # tokenised parallel to _docs
        self._doc_tokens: list[list[str]] = []
        # document frequency dict
        self._doc_freq: dict[str, int] = {}
        self._avg_doc_len: float = 0.0
        # numpy TF-IDF vectors (built lazily if numpy available)
        self._np_vectors: Any = None
        self._vocab: dict[str, int] = {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def invalidate(self) -> None:
        """Call after a model reload to discard the stale index."""
        with self._lock:
            self._built = False
            self._docs = []
            self._doc_tokens = []
            self._doc_freq = {}
            self._avg_doc_len = 0.0
            self._np_vectors = None
            self._vocab = {}

    def _build(self, ifc_model: Any) -> None:
        """Walk all IfcProduct entities and build the BM25 index."""
        docs: list[tuple[int, str, str, str, str]] = []
        doc_tokens: list[list[str]] = []
        doc_freq: dict[str, int] = {}

        for entity in ifc_model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            if len(docs) >= _MAX_ELEMENTS:
                logger.warning("Element index capped at %d elements", _MAX_ELEMENTS)
                break

            eid = entity.id()
            ifc_type = entity.is_a()
            name = entity.Name or ""

            desc = _describe_element(entity, ifc_model)
            storey = _get_storey_name(entity)
            tokens = _tokenise(desc)

            docs.append((eid, ifc_type, name, storey, desc))
            doc_tokens.append(tokens)

            for t in set(tokens):
                doc_freq[t] = doc_freq.get(t, 0) + 1

        num_docs = len(docs)
        avg_doc_len = (sum(len(t) for t in doc_tokens) / max(num_docs, 1))

        self._docs = docs
        self._doc_tokens = doc_tokens
        self._doc_freq = doc_freq
        self._avg_doc_len = avg_doc_len
        self._num_docs = num_docs

        # Optional: build numpy TF-IDF vectors for cosine rerank
        try:
            import numpy as np  # type: ignore
            self._build_numpy_index(np, doc_tokens)
        except ImportError:
            pass

        self._built = True
        logger.info("IFCElementIndex: indexed %d elements (numpy=%s)", num_docs, self._np_vectors is not None)

    def _build_numpy_index(self, np: Any, doc_tokens: list[list[str]]) -> None:
        """Build sparse TF-IDF matrix for cosine rerank (numpy required)."""
        # Build vocabulary
        vocab: dict[str, int] = {}
        for tokens in doc_tokens:
            for t in tokens:
                if t not in vocab:
                    vocab[t] = len(vocab)

        if not vocab:
            return

        n = len(doc_tokens)
        v = len(vocab)
        mat = np.zeros((n, v), dtype=np.float32)
        num_docs = n

        for i, tokens in enumerate(doc_tokens):
            tf = Counter(tokens)
            for tok, count in tf.items():
                j = vocab.get(tok)
                if j is None:
                    continue
                df = self._doc_freq.get(tok, 1)
                idf = math.log((num_docs + 1) / (df + 1)) + 1.0
                mat[i, j] = (count / max(len(tokens), 1)) * idf

        # L2-normalise each row
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        mat /= norms

        self._np_vectors = mat
        self._vocab = vocab

    # ------------------------------------------------------------------
    # Search
    # ------------------------------------------------------------------

    def search(
        self,
        query: str,
        ifc_model: Any,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Return top-k element matches for `query`.

        Lazily builds the index on first call. If the index is empty or
        ifcopenshell is unavailable, returns an empty list.
        """
        with self._lock:
            if not self._built:
                self._build(ifc_model)

        if not self._docs:
            return []

        query_tokens = _tokenise(query)
        if not query_tokens:
            return []

        num_docs = len(self._docs)

        # ---- BM25 shortlist ----
        scores: list[tuple[int, float]] = []  # (index, score)
        for idx in range(num_docs):
            s = _bm25_score(
                query_tokens,
                self._doc_tokens[idx],
                self._doc_freq,
                num_docs,
                self._avg_doc_len,
            )
            if s > 0:
                scores.append((idx, s))

        scores.sort(key=lambda x: x[1], reverse=True)
        shortlist = scores[:_SHORTLIST]

        # ---- Optional numpy cosine rerank ----
        if self._np_vectors is not None and shortlist:
            try:
                import numpy as np
                v = len(self._vocab)
                q_vec = np.zeros(v, dtype=np.float32)
                for tok in query_tokens:
                    j = self._vocab.get(tok)
                    if j is not None:
                        df = self._doc_freq.get(tok, 1)
                        idf = math.log((num_docs + 1) / (df + 1)) + 1.0
                        q_vec[j] += idf
                qnorm = np.linalg.norm(q_vec)
                if qnorm > 0:
                    q_vec /= qnorm
                    shortlist_idxs = [i for i, _ in shortlist]
                    cos = self._np_vectors[shortlist_idxs] @ q_vec
                    reranked = sorted(
                        zip(shortlist_idxs, cos.tolist()),
                        key=lambda x: x[1],
                        reverse=True,
                    )
                    shortlist = reranked
            except Exception as exc:
                logger.debug("numpy rerank failed: %s", exc)

        # Return top_k
        results = []
        for idx, score in shortlist[:top_k]:
            eid, ifc_type, name, storey, _ = self._docs[idx]
            results.append({
                "id": eid,
                "name": name,
                "ifc_type": ifc_type,
                "storey": storey,
                "score": round(float(score), 4),
            })

        return results


# Singleton - shared across the application
element_index = IFCElementIndex()
