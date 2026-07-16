"""Tests for per-storey fragment streaming.

All tests are pure - no real IFC file I/O, no real sidecar calls.
Covers:
  - serialize_storey unit tests (mocked ifcopenshell via sys.modules)
  - GET /api/ifc/fragments/storey endpoint tests (TestClient + mock services)
"""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import spatial_fragment_service
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    read_fragment_cache,
    storey_fragment_cache_entry,
    subset_fragment_cache_entry,
)
from app.services.spatial_fragment_service import SpatialSubsetUnavailable
from app.services.storey_splitter import StoreyFragmentSplitter, StoreyInfo, StoreyManifest

# ─────────────────────────────────────────────────────────────────────────────
# Shared helpers
# ─────────────────────────────────────────────────────────────────────────────

_SHA = "abc123" * 10 + "ab"  # 64-char hex string (SHA-256 len)
_SHA2 = "def456" * 10 + "de"

_MANIFEST = StoreyManifest(
    source_sha256=_SHA,
    storeys=[
        StoreyInfo(idx=0, name="Ground Floor", element_ids=[10, 20, 30], element_count=3),
        StoreyInfo(idx=1, name="First Floor", element_ids=[40, 50], element_count=2),
    ],
)

_EMPTY_STOREY_MANIFEST = StoreyManifest(
    source_sha256=_SHA,
    storeys=[
        StoreyInfo(idx=0, name="Roof", element_ids=[], element_count=0),
    ],
)


def _loaded_svc(sha: str = _SHA) -> MagicMock:
    svc = MagicMock()
    svc.is_loaded = True
    svc._model_fingerprint = sha
    svc.model = MagicMock()
    return svc


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


# ─────────────────────────────────────────────────────────────────────────────
# serialize_storey unit tests (no real IfcOpenShell)
# ─────────────────────────────────────────────────────────────────────────────

def _make_mock_ifc_modules():
    """Return (mock_ifc, mock_util, mock_dest_file) tuple."""
    mock_dest = MagicMock()
    mock_dest.to_string.return_value = "ISO-10303-21;\nHEADER;END;\nDATA;END-DATA;"

    mock_ifc = MagicMock()
    mock_ifc.file.return_value = mock_dest

    mock_util = MagicMock()
    mock_util.copy_deep = MagicMock()

    return mock_ifc, mock_util, mock_dest


def _make_mock_model(storeys: list[tuple[str, float, list[int]]]):
    """Return mock ifcopenshell.file with given storeys."""
    model = MagicMock()
    model.schema = "IFC4"

    storey_mocks = []
    for name, elevation, element_ids in storeys:
        s = MagicMock()
        s.Name = name
        s.Elevation = elevation
        elements = [MagicMock() for _ in element_ids]
        rel = MagicMock()
        rel.RelatedElements = elements
        s.ContainsElements = [rel]
        storey_mocks.append(s)

    model.by_type.side_effect = lambda t: storey_mocks if t == "IfcBuildingStorey" else []
    return model


# 1. Basic: returns bytes on success.
def test_serialize_storey_basic():
    mock_ifc, mock_util, mock_dest = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1, 2, 3])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        result = spl.serialize_storey(model, 0, "sha1")

    assert isinstance(result, bytes)
    assert len(result) > 0


# 2. Returns UTF-8 encoded IFC content.
def test_serialize_storey_returns_utf8_bytes():
    mock_ifc, mock_util, mock_dest = _make_mock_ifc_modules()
    mock_dest.to_string.return_value = "ISO-10303-21;"
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        result = spl.serialize_storey(model, 0, "sha1")

    assert result == b"ISO-10303-21;"


# 3. Index out of range raises IndexError.
def test_serialize_storey_index_out_of_range():
    mock_ifc, mock_util, _ = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        with pytest.raises(IndexError, match="out of range"):
            spl.serialize_storey(model, 5, "sha1")


# 4. Cache hit avoids re-computation.
def test_serialize_storey_cache_hit():
    mock_ifc, mock_util, mock_dest = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        r1 = spl.serialize_storey(model, 0, "sha-cache")
        # Replace model so a re-compute would produce different bytes.
        model2 = _make_mock_model([("FF", 3.0, [99])])
        r2 = spl.serialize_storey(model2, 0, "sha-cache")

    # Second call should return cached bytes from first call.
    assert r1 is r2


# 5. Empty SHA disables caching.
def test_serialize_storey_empty_sha_not_cached():
    mock_ifc, mock_util, _ = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        spl.serialize_storey(model, 0, "")
        assert spl.byte_cache_size() == 0


# 6. Storeys sorted by elevation: idx=0 is lowest, idx=1 is highest.
#    Elevation sort is directly verified in test_storey_splitter.py
#    (test_two_storey_sorted_by_elevation). Here we just confirm that
#    serialize_storey uses the same sorted order (requesting idx=0 on a
#    2-storey model fed in reverse elevation order succeeds without IndexError
#    and that idx=1 also succeeds - proving sort is not broken here).
def test_serialize_storey_elevation_sort():
    mock_ifc, mock_util, _ = _make_mock_ifc_modules()

    # Feed storeys in reverse-elevation order: TopFloor first, Ground second.
    model = _make_mock_model([("TopFloor", 6000.0, [1]), ("Ground", 0.0, [2])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        # Both idx=0 and idx=1 must succeed (no IndexError) - confirming the
        # 2 storeys are found and sorted regardless of input order.
        r0 = spl.serialize_storey(model, 0, "sha-sort-a")
        r1 = spl.serialize_storey(model, 1, "sha-sort-b")

    assert isinstance(r0, bytes)
    assert isinstance(r1, bytes)
    # idx=2 must be out-of-range.
    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl2 = StoreyFragmentSplitter()
        with pytest.raises(IndexError):
            spl2.serialize_storey(model, 2, "sha-sort-c")


# 7. Missing ifcopenshell raises RuntimeError.
def test_serialize_storey_no_ifcopenshell():
    model = _make_mock_model([("GF", 0.0, [1])])
    # Setting sys.modules entry to None causes Python to raise ImportError.
    with patch.dict(sys.modules, {
        "ifcopenshell": None,
        "ifcopenshell.util": None,
        "ifcopenshell.util.element": None,
    }):
        spl = StoreyFragmentSplitter()
        with pytest.raises(RuntimeError, match="ifcopenshell"):
            spl.serialize_storey(model, 0, "sha-no-ifc")


# 8. Different (sha, idx) combos are cached independently.
def test_serialize_storey_independent_cache_keys():
    mock_ifc, mock_util, mock_dest = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1]), ("FF", 3.0, [2])])

    call_count = [0]
    def tracked_to_string():
        call_count[0] += 1
        return f"IFC-{call_count[0]}"
    mock_dest.to_string = tracked_to_string

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        r0 = spl.serialize_storey(model, 0, "sha-multi")
        r1 = spl.serialize_storey(model, 1, "sha-multi")

    assert r0 != r1, "Different storey indices should produce different bytes"
    assert spl.byte_cache_size() == 2


# 9. clear_cache removes byte cache for matching sha.
def test_clear_cache_removes_byte_cache():
    mock_ifc, mock_util, _ = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        spl.serialize_storey(model, 0, "sha-clr")
        assert spl.byte_cache_size() == 1
        spl.clear_cache("sha-clr")
        assert spl.byte_cache_size() == 0


# 10. clear_cache(None) clears all caches.
def test_clear_cache_all_clears_byte_cache():
    mock_ifc, mock_util, _ = _make_mock_ifc_modules()
    model = _make_mock_model([("GF", 0.0, [1])])

    with patch.dict(sys.modules, {
        "ifcopenshell": mock_ifc,
        "ifcopenshell.util": MagicMock(),
        "ifcopenshell.util.element": mock_util,
    }):
        spl = StoreyFragmentSplitter()
        spl.serialize_storey(model, 0, "sha-A")
        spl.serialize_storey(model, 0, "sha-B")
        spl.clear_cache()
        assert spl.byte_cache_size() == 0


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/ifc/fragments/storey endpoint tests
# ─────────────────────────────────────────────────────────────────────────────

# 11. No model loaded → 400.
def test_storey_fragment_no_model_400():
    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = False
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})
    assert resp.status_code == 400


# 12. SHA mismatch → 404.
def test_storey_fragment_sha_mismatch_404():
    with patch("app.api.ifc_routes.ifc_service", _loaded_svc(sha=_SHA)):
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA2, "idx": 0})
    assert resp.status_code == 404
    assert "mismatch" in resp.json()["detail"].lower()


# 13. Storey index out of range → 404.
def test_storey_fragment_out_of_range_404():
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 99})
    assert resp.status_code == 404
    assert "out of range" in resp.json()["detail"].lower()


# 14. Empty storey → 204 No Content.
def test_storey_fragment_empty_storey_204(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _EMPTY_STOREY_MANIFEST
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})
    assert resp.status_code == 204


# 15. Cache hit → 200 with X-Fragment-Source: cache.
def test_storey_fragment_cache_hit_200(tmp_path):
    cache_entry = storey_fragment_cache_entry(tmp_path, _SHA, 0)
    atomic_write_fragment_cache(cache_entry, b"CACHED_FRAG_BYTES")

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "cache"
    assert resp.headers["X-Fragments-Format-Version"]
    assert resp.content == b"CACHED_FRAG_BYTES"


# 16. Sidecar available → 200 with X-Fragment-Source: sidecar.
def test_storey_fragment_sidecar_path_200(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"SUB_IFC_BYTES"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": True})
        mock_sidecar.convert = AsyncMock(return_value=(b"FRAG_BYTES", {"elapsedMs": 800}))

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "sidecar"
    assert resp.content == b"FRAG_BYTES"


# 17. Sidecar unavailable → 200 with X-Fragment-Source: sub-ifc.
def test_storey_fragment_sub_ifc_fallback_200(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"RAW_SUB_IFC"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "sub-ifc"
    assert resp.content == b"RAW_SUB_IFC"


# 18. Sidecar RuntimeError falls back to sub-IFC.
def test_storey_fragment_sidecar_error_falls_back(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"RAW_SUB_IFC"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": True})
        mock_sidecar.convert = AsyncMock(side_effect=RuntimeError("sidecar timeout"))

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "sub-ifc"


# 19. X-Fragment-Storey-Idx header matches requested idx.
def test_storey_fragment_storey_idx_header(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"BYTES"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 1})

    assert resp.headers["X-Fragment-Storey-Idx"] == "1"


# 20. X-Fragment-Storey-Name matches storey name from manifest.
def test_storey_fragment_storey_name_header(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"BYTES"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.headers["X-Fragment-Storey-Name"] == "Ground Floor"


# ─────────────────────────────────────────────────────────────────────────────
# Edge-case tests (8 more)
# ─────────────────────────────────────────────────────────────────────────────

# 21. Single-storey model at idx=0 succeeds.
def test_storey_fragment_single_storey_idx0(tmp_path):
    single = StoreyManifest(
        source_sha256=_SHA,
        storeys=[StoreyInfo(idx=0, name="Only Floor", element_ids=[1], element_count=1)],
    )
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = single
        mock_spl.serialize_storey.return_value = b"SINGLE"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})
    assert resp.status_code == 200


# 22. Max valid idx succeeds (idx = len(storeys) - 1).
def test_storey_fragment_max_valid_idx(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"TOP"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 1})
    assert resp.status_code == 200


# 23. serialize_storey RuntimeError → 503.
def test_storey_fragment_serialize_error_503(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.side_effect = RuntimeError("copy_deep failed")
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})
    assert resp.status_code == 503
    assert "Serialization error" in resp.json()["detail"]


# 24. Negative idx → 422 (FastAPI param validation).
def test_storey_fragment_negative_idx_422():
    with patch("app.api.ifc_routes.ifc_service", _loaded_svc()):
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": -1})
    assert resp.status_code == 422


# 25. Missing sha param → 422 (FastAPI param validation).
def test_storey_fragment_missing_sha_422():
    with patch("app.api.ifc_routes.ifc_service", _loaded_svc()):
        resp = _client().get("/api/ifc/fragments/storey", params={"idx": 0})
    assert resp.status_code == 422


# 26. Missing idx param → 422 (FastAPI param validation).
def test_storey_fragment_missing_idx_422():
    with patch("app.api.ifc_routes.ifc_service", _loaded_svc()):
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA})
    assert resp.status_code == 422


# 27. Sidecar path caches frag to disk.
def test_storey_fragment_sidecar_writes_cache(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"SUB"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": True})
        mock_sidecar.convert = AsyncMock(return_value=(b"FRAG", {"elapsedMs": 500}))

        _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    cache_entry = storey_fragment_cache_entry(tmp_path, _SHA, 0)
    assert read_fragment_cache(cache_entry) == b"FRAG"


# 28. ID-preserving subset path is preferred when the full fragment is cached
#     and the sidecar subset succeeds; headers carry the subset source and the
#     cache key of the filtered element-ID list.
def test_storey_fragment_prefers_subset_path_when_full_fragment_cached(tmp_path):
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"FULL-FRAG"
    )
    subset_meta = {
        "resolvedCount": 3,
        "identityCount": 3,
        "identityVerified": True,
        "contentVerified": True,
        "identitySha256": "1" * 64,
        "contentSha256": "2" * 64,
        "guidRemapCount": 0,
        "elapsedMs": 5,
    }
    subset_sidecar = MagicMock()
    subset_sidecar.subset = AsyncMock(return_value=(b"SUBSET-FRAG", subset_meta))

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "sidecar_manager", subset_sidecar),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        first = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})
        second = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert first.status_code == 200
    assert first.content == b"SUBSET-FRAG"
    assert first.headers["X-Fragment-Source"] == "storey-subset-sidecar"
    assert first.headers["X-Fragment-Source-Sha"] == _SHA
    assert first.headers["X-Fragment-Storey-Idx"] == "0"
    assert first.headers["X-Fragment-Storey-Name"] == "Ground Floor"
    expected_entry = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="storey",
        subset_id="0",
        element_ids=[10, 20, 30],
    )
    assert first.headers["X-Fragment-Cache-Key"] == expected_entry.key.digest
    # The verified subset is persisted, so the repeat request is a cache hit.
    assert second.status_code == 200
    assert second.headers["X-Fragment-Source"] == "storey-subset-cache"
    subset_sidecar.subset.assert_awaited_once()
    # Sub-IFC reconstruction never runs when the subset path succeeds.
    mock_spl.serialize_storey.assert_not_called()


# 29. Mocked subset builder success short-circuits before any sidecar convert.
def test_storey_fragment_subset_builder_receives_storey_subset_request(tmp_path):
    builder = AsyncMock(return_value=(b"SUBSET-FRAG", "sidecar"))
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.get_or_build_spatial_fragment", builder),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 1})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "storey-subset-sidecar"
    assert resp.headers["X-Fragment-Storey-Idx"] == "1"
    kwargs = builder.await_args.kwargs
    assert kwargs["fingerprint"] == _SHA
    assert kwargs["profile"] == "balanced"
    assert kwargs["subset_kind"] == "storey"
    assert kwargs["subset_id"] == "1"
    assert kwargs["element_ids"] == [40, 50]
    mock_sidecar.convert.assert_not_called()
    mock_spl.serialize_storey.assert_not_called()


# 30. SpatialSubsetUnavailable falls back to sub-IFC reconstruction unchanged.
def test_storey_fragment_falls_back_when_subset_unavailable(tmp_path):
    builder = AsyncMock(side_effect=SpatialSubsetUnavailable("full fragment missing"))
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.get_or_build_spatial_fragment", builder),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"RAW_SUB_IFC"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": False})

        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "sub-ifc"
    assert resp.content == b"RAW_SUB_IFC"
    builder.assert_awaited_once()


# 31. SpatialSubsetUnavailable still serves the reconstruction disk cache.
def test_storey_fragment_subset_unavailable_uses_reconstruction_cache(tmp_path):
    cache_entry = storey_fragment_cache_entry(tmp_path, _SHA, 0)
    atomic_write_fragment_cache(cache_entry, b"CACHED_FRAG_BYTES")
    builder = AsyncMock(side_effect=SpatialSubsetUnavailable("full fragment missing"))

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.get_or_build_spatial_fragment", builder),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        resp = _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 0})

    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "cache"
    assert resp.content == b"CACHED_FRAG_BYTES"


# 32. Sidecar called with correct model_id and profile.
def test_storey_fragment_sidecar_called_with_correct_args(tmp_path):
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as mock_spl,
        patch("app.api.ifc_routes.sidecar_manager") as mock_sidecar,
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        mock_spl.get_manifest.return_value = _MANIFEST
        mock_spl.serialize_storey.return_value = b"SUB"
        mock_sidecar.capabilities = AsyncMock(return_value={"available": True})
        mock_sidecar.convert = AsyncMock(return_value=(b"FRAG", {}))

        _client().get("/api/ifc/fragments/storey", params={"sha": _SHA, "idx": 1})

    call_kwargs = mock_sidecar.convert.call_args.kwargs
    # Storey fragments use the "balanced" profile (matches the main
    # /api/ifc/convert default). Sub-storey IFC slices are small, so the
    # fidelity-vs-speed tradeoff of "balanced" is preferred over "performance"
    # (which aggressively drops property/unit classes a sub-storey browse may
    # still want to inspect).
    assert call_kwargs.get("profile") == "balanced"
    expected_model_id = f"storey-{_SHA[:8]}-s1"
    assert call_kwargs.get("model_id") == expected_model_id
