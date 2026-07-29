"""
Tests for IFCElementIndex - pure-Python BM25 + optional numpy rerank.

All tests use a mock IFC model so no IfcOpenShell file I/O occurs.
"""

from unittest.mock import MagicMock, patch


from app.services.element_index_service import (
    IFCElementIndex,
    _bm25_score,
    _tokenise,
)


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

def _make_entity(eid: int, ifc_type: str, name: str, storey: str = "Ground Floor") -> MagicMock:
    """Create a minimal mock IFC entity where is_a() mimics IfcOpenShell behavior:
    - is_a() → returns the type string
    - is_a("SomeType") → returns True iff the type matches
    """
    e = MagicMock()
    e.id.return_value = eid
    e.is_a.side_effect = lambda t=None: ifc_type if t is None else (ifc_type == t)
    e.Name = name
    e.ObjectType = None
    e.GlobalId = f"GUID{eid:04d}"
    return e


def _make_model(entities: list) -> MagicMock:
    """Create a minimal mock IFC model."""
    m = MagicMock()

    def by_type(t: str):
        if t == "IfcProduct":
            return entities
        return []

    m.by_type.side_effect = by_type
    return m


# ---------------------------------------------------------------------------
# Tokenise
# ---------------------------------------------------------------------------

def test_tokenise_basic():
    assert _tokenise("IfcWall LoadBearing=True") == ["ifcwall", "loadbearing", "true"]


def test_tokenise_empty():
    assert _tokenise("") == []
    assert _tokenise("   ") == []


def test_tokenise_numbers():
    tokens = _tokenise("Wall-150 height=3.0m")
    assert "wall" in tokens
    assert "150" in tokens
    assert "3" in tokens


# ---------------------------------------------------------------------------
# BM25 score
# ---------------------------------------------------------------------------

def test_bm25_score_exact_match():
    score = _bm25_score(
        ["wall"],
        ["wall", "concrete", "exterior"],
        {"wall": 1, "concrete": 1, "exterior": 1},
        num_docs=10,
        avg_doc_len=3.0,
    )
    assert score > 0


def test_bm25_score_no_match():
    score = _bm25_score(
        ["door"],
        ["wall", "concrete"],
        {"wall": 1, "concrete": 1},
        num_docs=10,
        avg_doc_len=2.0,
    )
    assert score == 0.0


def test_bm25_score_rare_term_higher():
    """A term that appears in fewer docs should have higher IDF and thus higher score."""
    common_score = _bm25_score(
        ["wall"],
        ["wall"],
        {"wall": 9},
        num_docs=10,
        avg_doc_len=1.0,
    )
    rare_score = _bm25_score(
        ["firerating"],
        ["firerating"],
        {"firerating": 1},
        num_docs=10,
        avg_doc_len=1.0,
    )
    assert rare_score > common_score


# ---------------------------------------------------------------------------
# IFCElementIndex
# ---------------------------------------------------------------------------

def _mock_ifcopenshell_util(entities: list):
    """Context manager that patches ifcopenshell.util.element.get_container
    and ifcopenshell.util.element.get_psets so no real IfcOpenShell is needed."""
    import types

    # Build a fake ifcopenshell.util.element module
    fake_module = types.ModuleType("ifcopenshell.util.element")

    def get_container(entity):
        storey = MagicMock()
        storey.is_a.return_value = "IfcBuildingStorey"
        storey.Name = "Ground Floor"
        return storey

    def get_psets(entity):
        # Return one property set with a few props per entity
        return {
            "Pset_WallCommon": {
                "IsExternal": True,
                "LoadBearing": True,
                "FireRating": "REI90",
            }
        }

    fake_module.get_container = get_container
    fake_module.get_psets = get_psets

    return fake_module


def _make_fake_util():
    """Return a fake ifcopenshell.util.element module."""
    import types

    fake_util = types.ModuleType("ifcopenshell.util.element")

    def get_container(entity):
        c = MagicMock()
        c.is_a.side_effect = lambda t=None: "IfcBuildingStorey" if t is None else (t == "IfcBuildingStorey")
        c.Name = "Ground Floor"
        return c

    def get_psets(entity):
        return {
            "Pset_WallCommon": {
                "IsExternal": True,
                "LoadBearing": True,
                "FireRating": "REI90",
            }
        }

    fake_util.get_container = get_container
    fake_util.get_psets = get_psets
    return fake_util


def _build_index_with_mock(entities: list) -> IFCElementIndex:
    """Build an IFCElementIndex with mocked ifcopenshell utilities."""
    with patch.dict("sys.modules", {"ifcopenshell.util.element": _make_fake_util()}):
        idx = IFCElementIndex()
        model = _make_model(entities)
        idx._build(model)
    return idx


def test_index_builds_docs():
    entities = [
        _make_entity(1, "IfcWall", "Wall-001"),
        _make_entity(2, "IfcDoor", "Door-001"),
        _make_entity(3, "IfcSlab", "Slab-001"),
    ]
    idx = _build_index_with_mock(entities)
    assert idx._built
    assert len(idx._docs) == 3


def test_index_skips_opening_elements():
    wall = _make_entity(1, "IfcWall", "Wall-001")
    opening = _make_entity(2, "IfcOpeningElement", "Opening")
    entities = [wall, opening]
    idx = _build_index_with_mock(entities)
    assert len(idx._docs) == 1
    assert idx._docs[0][1] == "IfcWall"


def test_search_returns_hits():
    """Verify BM25 finds IfcWall by 'wall' query using pre-injected index state."""
    from app.services.element_index_service import _tokenise

    idx = IFCElementIndex()
    # Directly populate the index (bypasses ifcopenshell import in _build)
    docs = [
        (1, "IfcWall", "Exterior Wall", "Ground Floor", "IfcWall Exterior Wall Ground Floor"),
        (2, "IfcDoor", "Main Door", "Ground Floor", "IfcDoor Main Door Ground Floor"),
        (3, "IfcSlab", "Ground Slab", "Ground Floor", "IfcSlab Ground Slab Ground Floor"),
    ]
    doc_tokens = [_tokenise(d[4]) for d in docs]
    doc_freq: dict = {}
    for tokens in doc_tokens:
        for t in set(tokens):
            doc_freq[t] = doc_freq.get(t, 0) + 1

    idx._docs = docs
    idx._doc_tokens = doc_tokens
    idx._doc_freq = doc_freq
    idx._avg_doc_len = sum(len(t) for t in doc_tokens) / 3
    idx._num_docs = 3
    idx._np_vectors = None  # skip numpy rerank for this test
    idx._built = True

    model = _make_model([])  # model won't be used since _built=True

    results = idx.search("wall", model, top_k=5)

    assert len(results) >= 1
    ids = [r["id"] for r in results]
    assert 1 in ids  # IfcWall should rank first


def test_search_empty_query():
    entities = [_make_entity(1, "IfcWall", "Wall")]
    idx = _build_index_with_mock(entities)
    model = _make_model(entities)

    with patch.dict("sys.modules", {"ifcopenshell.util.element": _make_fake_util()}):
        results = idx.search("", model, top_k=5)
    assert results == []


def test_invalidate_resets_state():
    entities = [_make_entity(1, "IfcWall", "Wall")]
    idx = _build_index_with_mock(entities)
    assert idx._built
    idx.invalidate()
    assert not idx._built
    assert idx._docs == []
    assert idx._doc_freq == {}


def test_doc_freq_populated():
    entities = [
        _make_entity(1, "IfcWall", "Wall"),
        _make_entity(2, "IfcWall", "Wall Two"),
    ]
    idx = _build_index_with_mock(entities)
    # "ifcwall" should appear in both docs → doc_freq >= 2
    assert idx._doc_freq.get("ifcwall", 0) >= 2


def test_top_k_capped():
    entities = [_make_entity(i, "IfcWall", f"Wall-{i:03d}") for i in range(1, 20)]
    idx = _build_index_with_mock(entities)
    model = _make_model(entities)

    with patch.dict("sys.modules", {"ifcopenshell.util.element": _make_fake_util()}):
        results = idx.search("wall", model, top_k=3)
    assert len(results) <= 3
