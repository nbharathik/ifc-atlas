"""FastAPI TestClient coverage for `/api/ifc/aabb/*`.

Strategy mirrors `test_storey_fragment_endpoint.py`: patch `ifc_service` in the
route module so the endpoints think a model is loaded, then drive the routes
through TestClient. No real IFC file I/O, no real IfcOpenShell calls - every
backing service that the routes touch is monkeypatched.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.aabb_service import AABBComputeStatus, AABBService


# Helpers ──────────────────────────────────────────────────────────────────

_SHA = "abc123" * 10 + "ab"  # 64-char hex string


def _loaded_svc(sha: str = _SHA) -> MagicMock:
    """Mock ifc_service with `.is_loaded == True` and a SHA fingerprint."""
    svc = MagicMock()
    svc.is_loaded = True
    svc._model_fingerprint = sha
    return svc


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


# ── GET /aabb/status ─────────────────────────────────────────────────────────


def test_aabb_status_no_model_400():
    with patch("app.api.ifc_routes.ifc_service") as svc:
        svc.is_loaded = False
        resp = _client().get("/api/ifc/aabb/status")
    assert resp.status_code == 400


def test_aabb_status_idle_when_no_compute_yet():
    fresh = AABBService()
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", fresh),
    ):
        resp = _client().get("/api/ifc/aabb/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "idle"
    assert body["count"] == 0
    assert body["sha"] == _SHA


def test_aabb_status_ready_after_compute(tmp_path, monkeypatch):
    """Pre-seed the in-memory cache via compute_sync and read /status back."""
    from app.services import aabb_service as aabb_mod

    monkeypatch.setattr(aabb_mod, "AABB_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        aabb_mod,
        "_compute_aabbs_via_ifcopenshell",
        lambda model: {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))},
    )
    svc = AABBService()
    svc.compute_sync(MagicMock(), _SHA)

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", svc),
    ):
        resp = _client().get("/api/ifc/aabb/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "ready"
    assert body["count"] == 1


def test_aabb_status_surfaces_failed_state():
    svc = AABBService()
    svc._status[_SHA] = AABBComputeStatus(  # noqa: SLF001
        sha=_SHA, state="failed", error="IfcOpenShell crashed"
    )
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", svc),
    ):
        resp = _client().get("/api/ifc/aabb/status")
    body = resp.json()
    assert body["state"] == "failed"
    assert body["error"] == "IfcOpenShell crashed"


# ── GET /aabb/{express_id} ───────────────────────────────────────────────────


def test_aabb_one_no_model_400():
    with patch("app.api.ifc_routes.ifc_service") as svc:
        svc.is_loaded = False
        resp = _client().get("/api/ifc/aabb/42")
    assert resp.status_code == 400


def test_aabb_one_cache_miss_404():
    fresh = AABBService()
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", fresh),
    ):
        resp = _client().get("/api/ifc/aabb/9999")
    assert resp.status_code == 404
    assert "9999" in resp.json()["detail"]


def test_aabb_one_returns_cached_aabb(tmp_path, monkeypatch):
    from app.services import aabb_service as aabb_mod

    monkeypatch.setattr(aabb_mod, "AABB_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        aabb_mod,
        "_compute_aabbs_via_ifcopenshell",
        lambda model: {42: ((1.0, 2.0, 3.0), (4.0, 5.0, 6.0))},
    )
    svc = AABBService()
    svc.compute_sync(MagicMock(), _SHA)

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", svc),
    ):
        resp = _client().get("/api/ifc/aabb/42")
    assert resp.status_code == 200
    body = resp.json()
    assert body["express_id"] == 42
    assert body["aabb_min"] == [1.0, 2.0, 3.0]
    assert body["aabb_max"] == [4.0, 5.0, 6.0]


def test_aabb_one_negative_id_404():
    """Negative IDs are valid Python ints - endpoint must return 404, not 422."""
    fresh = AABBService()
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", fresh),
    ):
        resp = _client().get("/api/ifc/aabb/-1")
    assert resp.status_code == 404


# ── POST /aabb/bulk ──────────────────────────────────────────────────────────


def test_aabb_bulk_no_model_400():
    with patch("app.api.ifc_routes.ifc_service") as svc:
        svc.is_loaded = False
        resp = _client().post("/api/ifc/aabb/bulk", json={"express_ids": [1, 2]})
    assert resp.status_code == 400


def test_aabb_bulk_empty_request_returns_empty_lists():
    fresh = AABBService()
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", fresh),
    ):
        resp = _client().post("/api/ifc/aabb/bulk", json={"express_ids": []})
    assert resp.status_code == 200
    body = resp.json()
    assert body["sha"] == _SHA
    assert body["aabbs"] == []
    assert body["missing"] == []


def test_aabb_bulk_partial_hit_reports_missing(tmp_path, monkeypatch):
    from app.services import aabb_service as aabb_mod

    monkeypatch.setattr(aabb_mod, "AABB_CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(
        aabb_mod,
        "_compute_aabbs_via_ifcopenshell",
        lambda model: {
            1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)),
            2: ((2.0, 2.0, 2.0), (3.0, 3.0, 3.0)),
        },
    )
    svc = AABBService()
    svc.compute_sync(MagicMock(), _SHA)

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.aabb_service", svc),
    ):
        resp = _client().post(
            "/api/ifc/aabb/bulk", json={"express_ids": [1, 2, 99, 100]}
        )
    assert resp.status_code == 200
    body = resp.json()
    assert {a["express_id"] for a in body["aabbs"]} == {1, 2}
    assert set(body["missing"]) == {99, 100}


def test_aabb_bulk_rejects_request_over_10k_ids():
    """Pydantic max_length=10000 should kick in with a 422."""
    big = list(range(10001))
    with patch("app.api.ifc_routes.ifc_service", _loaded_svc()):
        resp = _client().post("/api/ifc/aabb/bulk", json={"express_ids": big})
    assert resp.status_code == 422


# ── DELETE /aabb/cache ───────────────────────────────────────────────────────


def test_aabb_cache_delete_memory_only_default():
    svc = MagicMock(spec=AABBService)
    with (
        patch("app.api.ifc_routes.aabb_service", svc),
    ):
        resp = _client().delete("/api/ifc/aabb/cache")
    assert resp.status_code == 200
    body = resp.json()
    assert body["cleared"] == "all"
    assert body["disk_files_removed"] == 0
    svc.clear.assert_called_once_with(None)
    svc.clear_disk.assert_not_called()


def test_aabb_cache_delete_with_disk_flag():
    svc = MagicMock(spec=AABBService)
    svc.clear_disk.return_value = 3
    with patch("app.api.ifc_routes.aabb_service", svc):
        resp = _client().delete("/api/ifc/aabb/cache?disk=true")
    body = resp.json()
    assert body["disk_files_removed"] == 3
    svc.clear_disk.assert_called_once_with(None)


def test_aabb_cache_delete_one_sha():
    svc = MagicMock(spec=AABBService)
    svc.clear_disk.return_value = 1
    with patch("app.api.ifc_routes.aabb_service", svc):
        resp = _client().delete(f"/api/ifc/aabb/cache?sha={_SHA}&disk=true")
    body = resp.json()
    assert body["cleared"] == _SHA
    assert body["disk_files_removed"] == 1
    svc.clear.assert_called_once_with(_SHA)
    svc.clear_disk.assert_called_once_with(_SHA)


# ── /tile-manifest aabb_source provenance + B2 cache-invalidation ────────────


def test_tile_manifest_advertises_aabb_source(monkeypatch):
    """When the splitter records source='real', the route surfaces it."""
    fake_tile_splitter = MagicMock()
    fake_manifest = MagicMock()
    fake_manifest.source_sha256 = _SHA
    fake_manifest.grid_resolution = 2
    fake_manifest.world_aabb_min = (0.0, 0.0, 0.0)
    fake_manifest.world_aabb_max = (10.0, 10.0, 10.0)
    fake_manifest.total_elements = 5
    fake_manifest.total_tiles = 1
    fake_manifest.tiles = []
    fake_tile_splitter.get_manifest.return_value = fake_manifest
    fake_tile_splitter.aabb_source.return_value = "real"

    fake_aabb = MagicMock()
    fake_aabb.get_all_aabbs.return_value = {1: ((0, 0, 0), (1, 1, 1))}

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as fake_storey,
        patch("app.api.ifc_routes.spatial_tile_splitter", fake_tile_splitter),
        patch("app.api.ifc_routes.aabb_service", fake_aabb),
    ):
        fake_storey.get_manifest.return_value = MagicMock()
        resp = _client().get("/api/ifc/tile-manifest?grid=2")
    assert resp.status_code == 200
    body = resp.json()
    assert body["aabb_source"] == "real"


def test_tile_manifest_cache_invalidates_when_aabbs_warm():
    """B2 fix: a placement-cached manifest should be evicted when the AABB
    cache later warms up, so the next /tile-manifest pulls real AABBs."""
    from app.services.spatial_tile_splitter import SpatialTileSplitter

    splitter = SpatialTileSplitter()

    # First call - no aabb_lookup → placement-source manifest gets cached.
    with patch(
        "app.services.spatial_tile_splitter.extract_element_aabbs",
        return_value=[],
    ):
        m1 = splitter.get_manifest(MagicMock(), MagicMock(), sha=_SHA, grid_resolution=2)
    assert splitter.aabb_source(_SHA, 2) == "placement"
    assert splitter.cache_size() == 1

    # Second call - aabb_lookup is now warm → must evict + recompute.
    import sys
    sys.modules.setdefault("ifcopenshell", MagicMock())
    model = MagicMock()
    el = MagicMock()
    el.id.return_value = 1
    model.by_type.return_value = [el]
    cache = {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}
    m2 = splitter.get_manifest(
        model, MagicMock(), sha=_SHA, grid_resolution=2, aabb_lookup=cache
    )
    assert m1 is not m2  # cache evicted
    assert splitter.aabb_source(_SHA, 2) == "real"


def test_tile_manifest_warm_cache_stays_cached():
    """Sanity: once the cache is 'real', subsequent calls with warm AABBs reuse it."""
    from app.services.spatial_tile_splitter import SpatialTileSplitter

    splitter = SpatialTileSplitter()

    import sys
    sys.modules.setdefault("ifcopenshell", MagicMock())
    model = MagicMock()
    el = MagicMock()
    el.id.return_value = 1
    model.by_type.return_value = [el]
    cache = {1: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))}

    m1 = splitter.get_manifest(model, MagicMock(), sha=_SHA, grid_resolution=2, aabb_lookup=cache)
    m2 = splitter.get_manifest(model, MagicMock(), sha=_SHA, grid_resolution=2, aabb_lookup=cache)
    assert m1 is m2
    assert splitter.aabb_source(_SHA, 2) == "real"


def test_tile_fragment_route_serves_verified_binary_subset(tmp_path):
    tile = SimpleNamespace(
        tile_id="0-0-0",
        storey_idx=0,
        cell_x=0,
        cell_y=0,
        aabb_min=(0.0, 0.0, 0.0),
        aabb_max=(1.0, 1.0, 1.0),
        element_ids=[12, 14],
        element_count=2,
    )
    manifest = SimpleNamespace(tiles=[tile])
    splitter = MagicMock()
    splitter.get_manifest.return_value = manifest
    splitter.aabb_source.return_value = "real"
    builder = AsyncMock(return_value=(b"TILE-FRAGMENT", "sidecar"))
    aabb = MagicMock()
    aabb.get_all_aabbs.return_value = {
        12: ((0.0, 0.0, 0.0), (1.0, 1.0, 1.0))
    }

    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as storeys,
        patch("app.api.ifc_routes.spatial_tile_splitter", splitter),
        patch("app.api.ifc_routes.aabb_service", aabb),
        patch("app.api.ifc_routes.get_or_build_spatial_fragment", builder),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        storeys.get_manifest.return_value = MagicMock()
        response = _client().get(
            f"/api/ifc/fragments/tile?sha={_SHA}&grid=2&tile_id=0-0-0"
        )

    assert response.status_code == 200
    assert response.content == b"TILE-FRAGMENT"
    assert response.headers["X-Fragment-Source"] == "tile-sidecar"
    assert response.headers["X-Fragment-Tile-Id"] == "0-0-0"
    assert response.headers["X-Fragment-AABB-Source"] == "real"
    assert builder.await_args.kwargs["element_ids"] == [12, 14]


def test_tile_fragment_route_rejects_unknown_tile():
    splitter = MagicMock()
    splitter.get_manifest.return_value = SimpleNamespace(tiles=[])
    aabb = MagicMock()
    aabb.get_all_aabbs.return_value = {}
    with (
        patch("app.api.ifc_routes.ifc_service", _loaded_svc()),
        patch("app.api.ifc_routes.storey_splitter") as storeys,
        patch("app.api.ifc_routes.spatial_tile_splitter", splitter),
        patch("app.api.ifc_routes.aabb_service", aabb),
    ):
        storeys.get_manifest.return_value = MagicMock()
        response = _client().get(
            f"/api/ifc/fragments/tile?sha={_SHA}&grid=2&tile_id=9-9-9"
        )

    assert response.status_code == 404
    assert "not present" in response.json()["detail"]
