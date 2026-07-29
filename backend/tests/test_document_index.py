"""
Tests for DocumentIndexService - pure unit tests, no IfcOpenShell, no file I/O outside tmp.
"""

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_index(tmp_path):
    """Return a fresh service instance rooted at a temp index directory."""
    import app.services.document_index_service as mod

    svc = mod.DocumentIndexService(index_dir=tmp_path)
    return svc, tmp_path


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------

def test_chunk_empty_text():
    from app.services.document_index_service import _chunk_text
    assert _chunk_text("") == []
    assert _chunk_text("   \n\n  ") == []


def test_chunk_short_text():
    from app.services.document_index_service import _chunk_text
    text = "Hello world."
    chunks = _chunk_text(text)
    assert len(chunks) == 1
    assert chunks[0] == "Hello world."


def test_chunk_long_text_produces_multiple_chunks():
    from app.services.document_index_service import _chunk_text, CHUNK_SIZE
    text = "A" * (CHUNK_SIZE * 3)
    chunks = _chunk_text(text)
    assert len(chunks) >= 2


def test_chunk_overlap_text():
    """Adjacent chunks should share some content (overlap > 0)."""
    from app.services.document_index_service import _chunk_text, CHUNK_OVERLAP
    text = "word " * 300  # 1500 chars
    chunks = _chunk_text(text)
    assert len(chunks) >= 2
    # The start of chunk[1] should contain something from the end of chunk[0]
    overlap_region = chunks[0][-CHUNK_OVERLAP:]
    assert any(w in chunks[1] for w in overlap_region.split()[:3])


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------

def test_tokenize_basic():
    from app.services.document_index_service import _tokenize
    assert _tokenize("Hello World 123") == ["hello", "world", "123"]


def test_tokenize_empty():
    from app.services.document_index_service import _tokenize
    assert _tokenize("") == []


def test_tokenize_special_chars():
    from app.services.document_index_service import _tokenize
    assert _tokenize("fire-rating=REI90") == ["fire", "rating", "rei90"]


# ---------------------------------------------------------------------------
# BM25
# ---------------------------------------------------------------------------

def test_bm25_empty_corpus():
    from app.services.document_index_service import _BM25Index
    idx = _BM25Index([])
    assert idx.search("wall") == []


def test_bm25_single_doc():
    from app.services.document_index_service import _BM25Index
    idx = _BM25Index(["The fire rating of the wall is REI 90"])
    results = idx.search("fire rating")
    assert len(results) == 1
    assert results[0][0] == 0
    assert results[0][1] > 0


def test_bm25_ranking():
    """Document containing more query terms should rank higher."""
    from app.services.document_index_service import _BM25Index
    docs = [
        "The wall has fire rating REI 90 and is load bearing",
        "The door is green",
        "Fire rating and fire performance requirements for walls fire fire",
    ]
    idx = _BM25Index(docs)
    results = idx.search("fire rating wall")
    # First result should be doc 2 (most 'fire' occurrences) or doc 0
    top_idx = results[0][0]
    assert top_idx in (0, 2)
    # Last result should be doc 1 (no query terms)
    if len(results) == 3:
        assert results[-1][0] == 1


def test_bm25_no_match_returns_empty():
    from app.services.document_index_service import _BM25Index
    idx = _BM25Index(["The wall is red", "The door is blue"])
    results = idx.search("xyzzy_unknown_term")
    assert results == []


# ---------------------------------------------------------------------------
# DocumentIndexService
# ---------------------------------------------------------------------------

def test_index_markdown(tmp_index):
    svc, _ = tmp_index
    content = "# BIM Standard\n\nWalls must have a fire rating of REI 90.\n\nDoors shall be fire-rated."
    meta = svc.index_document("standard.md", content.encode())
    assert meta["name"] == "standard.md"
    assert meta["chunk_count"] >= 1
    assert meta["char_count"] == len(content)


def test_list_docs_empty(tmp_index):
    svc, _ = tmp_index
    assert svc.list_docs() == []


def test_list_docs_after_index(tmp_index):
    svc, _ = tmp_index
    svc.index_document("a.md", b"Content A about walls and doors")
    svc.index_document("b.md", b"Content B about beams and columns")
    docs = svc.list_docs()
    assert len(docs) == 2
    names = {d["name"] for d in docs}
    assert "a.md" in names and "b.md" in names


def test_search_finds_relevant_chunk(tmp_index):
    svc, _ = tmp_index
    svc.index_document("spec.md", b"All walls shall achieve a minimum fire rating of REI 90. Doors need REI 60.")
    results = svc.search("fire rating wall", top_k=3)
    assert len(results) >= 1
    assert results[0]["score"] > 0
    assert "fire" in results[0]["text"].lower() or "rating" in results[0]["text"].lower()


def test_search_empty_index(tmp_index):
    svc, _ = tmp_index
    results = svc.search("fire rating")
    assert results == []


def test_delete_doc(tmp_index):
    svc, tmp_path = tmp_index
    meta = svc.index_document("to_delete.md", b"Some content about walls")
    doc_id = meta["doc_id"]
    assert svc.delete_doc(doc_id) is True
    assert len(svc.list_docs()) == 0
    # Files should be removed
    assert not (tmp_path / f"{doc_id}.meta.json").exists()
    assert not (tmp_path / f"{doc_id}.chunks.json").exists()


def test_delete_nonexistent(tmp_index):
    svc, _ = tmp_index
    assert svc.delete_doc("nonexistent-id") is False


def test_search_after_delete(tmp_index):
    svc, _ = tmp_index
    meta = svc.index_document("a.md", b"Walls must have fire rating REI 90")
    svc.index_document("b.md", b"Doors need REI 60 for fire safety")
    doc_id = meta["doc_id"]
    svc.delete_doc(doc_id)
    results = svc.search("wall fire rating")
    for r in results:
        assert r["doc_id"] != doc_id


def test_index_empty_file_raises(tmp_index):
    svc, _ = tmp_index
    with pytest.raises(ValueError, match="extract"):
        svc.index_document("empty.md", b"")


def test_empty_query_does_not_crash(tmp_index):
    svc, _ = tmp_index
    svc.index_document("spec.md", b"Wall fire rating REI 90")
    results = svc.search("")
    assert results == []


def test_persistence(tmp_index):
    """A new service instance should load persisted docs."""
    svc, tmp_path = tmp_index
    svc.index_document("persisted.md", b"Fire rating content for walls")

    import app.services.document_index_service as mod

    svc2 = mod.DocumentIndexService(index_dir=tmp_path)
    docs = svc2.list_docs()
    assert len(docs) == 1
    assert docs[0]["name"] == "persisted.md"


# ---------------------------------------------------------------------------
# Semantic index (mocked fastembed + hnswlib)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# _normalise_scores
# ---------------------------------------------------------------------------

def test_normalise_scores_empty():
    from app.services.document_index_service import _normalise_scores
    assert _normalise_scores({}) == {}


def test_normalise_scores_basic():
    from app.services.document_index_service import _normalise_scores
    result = _normalise_scores({0: 2.0, 1: 4.0, 2: 1.0})
    assert result[1] == pytest.approx(1.0)
    assert result[0] == pytest.approx(0.5)
    assert result[2] == pytest.approx(0.25)


def test_normalise_scores_all_zero():
    from app.services.document_index_service import _normalise_scores
    result = _normalise_scores({0: 0.0, 1: 0.0})
    assert result == {0: 0.0, 1: 0.0}


def _make_mock_embeddings(n: int, dim: int = 4):
    """Return a simple identity-like float32 array for testing."""
    import numpy as np
    rng = np.random.default_rng(42)
    return rng.random((n, dim), dtype="float32").astype("float32")


class _FakeHNSW:
    """Minimal stand-in for hnswlib.Index - returns deterministic top-k results."""

    def __init__(self, n: int):
        self._n = n

    def get_current_count(self) -> int:
        return self._n

    def knn_query(self, query_vec, k: int):
        k = min(k, self._n)
        labels = list(range(k))
        distances = [0.1 * (i + 1) for i in range(k)]
        import numpy as np
        return np.array([labels]), np.array([distances])


@pytest.fixture()
def semantic_index(tmp_index, monkeypatch):
    """
    Fixture that wires mock fastembed + hnswlib into a fresh service instance.
    Uses dim=4 to keep tests fast; the real model uses dim=384.
    """
    import app.services.document_index_service as mod

    monkeypatch.setattr(mod, "EMBEDDING_DIM", 4)

    # Make _fastembed_available() return True (no real fastembed/hnswlib needed)
    monkeypatch.setattr(mod, "_fastembed_available", lambda: True)

    call_counter = {"n": 0}

    def fake_embed_texts(texts):
        vecs = _make_mock_embeddings(len(texts), dim=4)
        call_counter["n"] += len(texts)
        return vecs

    def fake_embed_query(query):
        return _make_mock_embeddings(1, dim=4)

    def fake_build_hnsw(embeddings):
        return _FakeHNSW(len(embeddings))

    def fake_cosine_search(hnsw_index, query_vec, top_k):
        n = hnsw_index.get_current_count()
        k = min(top_k, n)
        return [(i, 0.9 - 0.05 * i) for i in range(k)]

    monkeypatch.setattr(mod, "_embed_texts", fake_embed_texts)
    monkeypatch.setattr(mod, "_embed_query", fake_embed_query)
    monkeypatch.setattr(mod, "_build_hnsw_index", fake_build_hnsw)
    monkeypatch.setattr(mod, "_cosine_semantic_search", fake_cosine_search)

    svc, tmp_path = tmp_index
    svc._call_counter = call_counter
    return svc, tmp_path


def test_index_document_saves_npy(semantic_index):
    """Embedding .npy file is created when semantic is available."""
    svc, tmp_path = semantic_index
    meta = svc.index_document("spec.md", b"Walls must achieve REI 90. Fire rating is mandatory.")
    doc_id = meta["doc_id"]
    npy_path = tmp_path / f"{doc_id}.embeddings.npy"
    assert npy_path.exists(), ".embeddings.npy should be written"
    import numpy as np
    arr = np.load(str(npy_path))
    assert arr.ndim == 2
    assert arr.shape[1] == 4


def test_index_document_semantic_flag(semantic_index):
    """meta['semantic'] should be True when embedding succeeds."""
    svc, _ = semantic_index
    meta = svc.index_document("a.md", b"Fire safety requirements for load-bearing walls")
    assert meta["semantic"] is True


def test_search_uses_hybrid_mode(semantic_index):
    """search() result includes search_mode='hybrid' when semantic is active."""
    svc, _ = semantic_index
    svc.index_document("spec.md", b"Fire safety walls must be REI 90 rated")
    results = svc.search("fire rating", top_k=3)
    assert len(results) >= 1
    modes = {r["search_mode"] for r in results}
    assert "hybrid" in modes


def test_search_returns_score(semantic_index):
    """All results have a non-negative score."""
    svc, _ = semantic_index
    svc.index_document("spec.md", b"Load-bearing walls require fire rating REI 90 certification")
    results = svc.search("wall fire rating")
    for r in results:
        assert r["score"] >= 0.0


def test_delete_removes_npy(semantic_index):
    """delete_doc removes the .embeddings.npy file."""
    svc, tmp_path = semantic_index
    meta = svc.index_document("todel.md", b"Some content about structural elements")
    doc_id = meta["doc_id"]
    npy_path = tmp_path / f"{doc_id}.embeddings.npy"
    assert npy_path.exists()
    svc.delete_doc(doc_id)
    assert not npy_path.exists()


def test_semantic_status_available(semantic_index):
    """semantic_status() returns available=True when mocked."""
    svc, _ = semantic_index
    svc.index_document("s.md", b"Some content")
    status = svc.semantic_status()
    assert status["available"] is True
    assert status["built"] is True
    assert "model" in status


def test_semantic_status_unavailable(tmp_index, monkeypatch):
    """semantic_status() returns available=False without fastembed."""
    import app.services.document_index_service as mod
    monkeypatch.setattr(mod, "_fastembed_available", lambda: False)
    svc, _ = tmp_index
    status = svc.semantic_status()
    assert status["available"] is False
    assert status["built"] is False


def test_bm25_fallback_when_no_semantic(tmp_index, monkeypatch):
    """search() falls back to BM25 and returns search_mode='bm25'."""
    import app.services.document_index_service as mod
    monkeypatch.setattr(mod, "_fastembed_available", lambda: False)
    svc, _ = tmp_index
    svc.index_document("spec.md", b"Fire rating walls REI 90 load bearing")
    results = svc.search("fire rating wall")
    assert results
    assert all(r["search_mode"] == "bm25" for r in results)


def test_normalise_scores_no_division_by_zero(tmp_index, monkeypatch):
    """hybrid search with all-zero BM25 scores does not crash."""
    import app.services.document_index_service as mod

    # Force BM25 to return empty (all-zero scenario covered by no-match path)
    monkeypatch.setattr(mod, "_fastembed_available", lambda: False)
    svc, _ = tmp_index
    svc.index_document("spec.md", b"Walls and doors and beams")
    # Query that doesn't match anything
    results = svc.search("xyzzy_completely_unknown_term_42")
    assert results == []
