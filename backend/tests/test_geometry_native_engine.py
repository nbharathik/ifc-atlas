"""Tests for the native geometry extraction endpoint and the metadata-index tool fast-path.

Mocks out sidecar_manager.geometry so no live Node process is required.
"""
from __future__ import annotations

import base64
import struct
from io import BytesIO
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _b64_float32(vals: list[float]) -> str:
    buf = struct.pack(f"{len(vals)}f", *vals)
    return base64.b64encode(buf).decode()


def _b64_uint32(vals: list[int]) -> str:
    buf = struct.pack(f"{len(vals)}I", *vals)
    return base64.b64encode(buf).decode()


def _fake_geo_response() -> tuple[dict, dict]:
    """Minimal geometry response with one wall mesh (cube-like)."""
    pos = [0.0, 0.0, 0.0,  1.0, 0.0, 0.0,  1.0, 1.0, 0.0,  0.0, 1.0, 0.0]
    idx = [0, 1, 2,  0, 2, 3]
    result = {
        "meshCount": 1,
        "attempted": 3,
        "skipped": 2,
        "geoElapsedMs": 42,
        "totalElapsedMs": 80,
        "meshes": [
            {
                "expressId": 100,
                "ifcType": "IFCWALL",
                "name": "Wall A",
                "positions": _b64_float32(pos),
                "indices": _b64_uint32(idx),
                "bbox": [0.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            }
        ],
    }
    sidecar_meta = {
        "elapsedMs": 80,
        "meshCount": 1,
        "attempted": 3,
        "skipped": 2,
    }
    return result, sidecar_meta


# ─────────────────────────────────────────────────────────────────────────────
# Geometry endpoint - POST /api/ifc/geometry
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def client():
    from app.main import app
    return TestClient(app, raise_server_exceptions=False)


def test_geometry_endpoint_happy_path(client):
    result_json, sidecar_meta = _fake_geo_response()

    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry",
        new_callable=AsyncMock,
        return_value=(result_json, sidecar_meta),
    ):
        fake_ifc = b"ISO-10303-21; ... fake ifc content"
        resp = client.post(
            "/api/ifc/geometry",
            files={"file": ("model.ifc", BytesIO(fake_ifc), "application/octet-stream")},
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["meshCount"] == 1
    assert len(body["meshes"]) == 1
    mesh = body["meshes"][0]
    assert mesh["expressId"] == 100
    assert mesh["ifcType"] == "IFCWALL"
    assert mesh["name"] == "Wall A"
    # base64 buffers should survive the round-trip
    positions = struct.unpack("12f", base64.b64decode(mesh["positions"]))
    assert len(positions) == 12  # 4 verts × 3 floats


def test_geometry_endpoint_rejects_non_ifc(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry",
        new_callable=AsyncMock,
        return_value=_fake_geo_response(),
    ):
        resp = client.post(
            "/api/ifc/geometry",
            files={"file": ("model.obj", BytesIO(b"obj file"), "application/octet-stream")},
        )
    assert resp.status_code == 400


def test_geometry_endpoint_rejects_empty_file(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry",
        new_callable=AsyncMock,
        return_value=_fake_geo_response(),
    ):
        resp = client.post(
            "/api/ifc/geometry",
            files={"file": ("model.ifc", BytesIO(b""), "application/octet-stream")},
        )
    assert resp.status_code == 400


def test_geometry_endpoint_503_on_sidecar_unavailable(client):
    with patch(
        "app.services.sidecar_manager.SidecarManager.geometry",
        new_callable=AsyncMock,
        side_effect=RuntimeError("sidecar unavailable"),
    ):
        fake_ifc = b"some ifc"
        resp = client.post(
            "/api/ifc/geometry",
            files={"file": ("model.ifc", BytesIO(fake_ifc), "application/octet-stream")},
        )
    assert resp.status_code == 503


# ─────────────────────────────────────────────────────────────────────────────
# Metadata index - get_element_psets / search_by_property / get_all_property_names
# ─────────────────────────────────────────────────────────────────────────────

def _make_index_with_psets():
    """Minimal MetadataIndex with element_psets populated."""
    from app.models.metadata_index_models import (
        HeaderRecord,
        IndexElementSummary,
        IndexPropertySet,
        IndexPropertyValue,
        IndexSpatialNode,
        IndexStats,
        MetadataIndex,
    )
    storey = IndexSpatialNode(id=4, global_id="1aaa", type="IFCBUILDINGSTOREY", name="L1", parent_id=1, child_ids=[])
    elem = IndexElementSummary(
        id=5,
        global_id="2aaa",
        type="IFCWALL",
        name="Wall A",
        description=None,
        storey_id=4,
        storey_name="L1",
    )
    pset = IndexPropertySet(
        id=100,
        name="Pset_WallCommon",
        description=None,
        properties=[
            IndexPropertyValue(name="LoadBearing", value="true", value_type="IfcBoolean"),
            IndexPropertyValue(name="FireRating", value="60 min", value_type="IfcLabel"),
        ],
    )
    stats = IndexStats(
        inputBytes=100,
        entityCount=5,
        byType={"IFCWALL": 1},
        parseMs=1,
        warningCount=0,
        warnings=[],
        lex_ms=0,
        index_ms=1,
        total_ms=1,
        storey_count=1,
        element_count=1,
    )
    idx = MetadataIndex(
        index_version=2,
        producer_version="test",
        source_sha256="abc123",
        source_bytes=100,
        header=HeaderRecord(),
        project=None,
        spatial={4: storey},  # type: ignore[dict-item]
        spatial_roots=[1],
        storey_ids=[4],
        elements={5: elem},  # type: ignore[dict-item]
        by_type={"IFCWALL": 1},
        ids_by_type={"IFCWALL": [5]},
        ids_by_storey={4: [5]},
        id_by_global_id={"2aaa": 5},
        materials=[],
        all_pset_names={"Pset_WallCommon": ["LoadBearing", "FireRating"]},
        element_psets={5: [pset]},  # type: ignore[dict-item]
        stats=stats,
    )
    return idx


def test_get_element_psets_returns_data():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    psets = svc.get_element_psets(5)
    assert len(psets) == 1
    assert psets[0]["name"] == "Pset_WallCommon"
    props = {p["name"]: p["value"] for p in psets[0]["properties"]}
    assert props["LoadBearing"] == "true"
    assert props["FireRating"] == "60 min"


def test_get_element_psets_unknown_element():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    psets = svc.get_element_psets(9999)
    assert psets == []


def test_get_all_property_names():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    pset_map = svc.get_all_property_names()
    assert "Pset_WallCommon" in pset_map
    assert "LoadBearing" in pset_map["Pset_WallCommon"]
    assert "FireRating" in pset_map["Pset_WallCommon"]


def test_search_by_property_name_match():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    results = svc.search_by_property("LoadBearing")
    assert len(results) == 1
    assert results[0]["element_id"] == 5
    assert results[0]["value"] == "true"


def test_search_by_property_value_filter():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    # Should find "60 min" in FireRating
    results = svc.search_by_property("FireRating", property_value="60")
    assert len(results) == 1
    assert results[0]["property_name"] == "FireRating"

    # Should NOT find "60 min" value for LoadBearing
    results_no = svc.search_by_property("LoadBearing", property_value="60")
    assert results_no == []


def test_search_by_property_pset_filter():
    idx = _make_index_with_psets()

    import sys
    sys.modules.pop("app.services.metadata_index_service", None)
    from app.services.metadata_index_service import MetadataIndexService
    svc = MetadataIndexService()
    svc._current = idx  # type: ignore[attr-defined]

    # Correct pset_name matches
    results = svc.search_by_property("LoadBearing", pset_name="Pset_WallCommon")
    assert len(results) == 1

    # Wrong pset_name → no match
    results_none = svc.search_by_property("LoadBearing", pset_name="Nonexistent_Pset")
    assert results_none == []


# ─────────────────────────────────────────────────────────────────────────────
# Tools fast-path - execute_tool uses metadata_index_service when loaded
# ─────────────────────────────────────────────────────────────────────────────

def test_tools_get_project_info_uses_native_index(monkeypatch):
    """get_project_info should prefer the native index when available."""
    from app.services import tools as tools_module

    class _FakeMIS:
        is_loaded = True

        def get_project_info(self):
            return {"name": "Native Project", "description": None, "phase": None}

    monkeypatch.setattr(tools_module, "metadata_index_service", _FakeMIS())

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = tools_module.execute_tool("describe_model", {"part": "project"})

    assert result.get("name") == "Native Project"
    assert result.get("_source") == "native_index"


def test_tools_get_project_info_falls_back_when_index_not_loaded(monkeypatch):
    """When native index is not loaded, get_project_info falls back to ifc_service."""
    from app.services import tools as tools_module
    from app.models.ifc_models import ProjectInfo

    class _FakeMIS:
        is_loaded = False  # simulate index not yet ready

    monkeypatch.setattr(tools_module, "metadata_index_service", _FakeMIS())

    mock_info = ProjectInfo(
        name="IfcOpenShell Project",
        description=None,
        schema_version="IFC2X3",
        author=None,
        organization=None,
    )

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.get_project_info.return_value = mock_info
        result = tools_module.execute_tool("describe_model", {"part": "project"})

    assert result.get("name") == "IfcOpenShell Project"
    # Readiness-aware routing - both paths annotate `_source` + `_complete` so
    # the structural-parity test suite (test_native_index_parity.py) can
    # compare them. The fallback path marks `_source: "ifcopenshell"`.
    assert result.get("_source") == "ifcopenshell"
    assert result.get("_complete") is True


def test_tools_search_elements_uses_native_index(monkeypatch):
    from app.services import tools as tools_module
    from app.models.metadata_index_models import IndexElementSummary

    elem = IndexElementSummary(
        id=42,
        global_id="aaaa",
        type="IFCWALL",
        name="Test Wall",
        description=None,
        storey_id=1,
        storey_name="Level 1",
    )

    class _FakeMIS:
        is_loaded = True

        def search(self, query, ifc_type=None, storey=None, limit=50):
            return [elem]

    monkeypatch.setattr(tools_module, "metadata_index_service", _FakeMIS())

    with patch("app.services.tools.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        result = tools_module.execute_tool(
            "query_elements", {"mode": "text", "query": "wall"}
        )

    assert result["_source"] == "native_index"
    assert result["total"] == 1
    assert result["elements"][0]["name"] == "Test Wall"
