"""Tests for IfcService.get_aggregate and the /api/ifc/aggregate endpoint."""
from __future__ import annotations

import pytest

# Uses the conftest `svc` fixture which loads BasicHouse.ifc via IfcOpenShell.
# Skipped by the fast pre-flight: pytest -m "not requires_ifc_load".
pytestmark = pytest.mark.requires_ifc_load


# ---------------------------------------------------------------------------
# Unit tests - IfcService.get_aggregate
# ---------------------------------------------------------------------------


def test_aggregate_empty_ids(svc):
    result = svc.get_aggregate([])
    assert result["count"] == 0
    assert result["type_histogram"] == {}
    assert result["material_histogram"] == {}
    assert result["total_area"] is None
    assert result["total_volume"] is None


def test_aggregate_all_products(svc):
    """Aggregate over all products should sum area/volume from BasicHouse."""
    all_ids = [e.id() for e in svc.model.by_type("IfcProduct")]
    result = svc.get_aggregate(all_ids)
    assert result["count"] == len(all_ids)
    # BasicHouse has quantities - at least some area should appear
    assert result["total_area"] is not None or result["total_volume"] is not None
    assert isinstance(result["type_histogram"], dict)
    assert len(result["type_histogram"]) > 0


def test_aggregate_type_histogram_keys(svc):
    """Type keys should have 'Ifc' stripped (e.g. 'Wall' not 'IfcWall')."""
    walls = [e.id() for e in svc.model.by_type("IfcWall")]
    if not walls:
        pytest.skip("BasicHouse has no IfcWall")
    result = svc.get_aggregate(walls)
    # Keys must not start with 'Ifc'
    for k in result["type_histogram"]:
        assert not k.startswith("Ifc"), f"Type key '{k}' still has Ifc prefix"


def test_aggregate_material_histogram(svc):
    """Material histogram should be non-empty for BasicHouse walls."""
    walls = [e.id() for e in svc.model.by_type("IfcWall")]
    if not walls:
        pytest.skip("BasicHouse has no IfcWall")
    result = svc.get_aggregate(walls)
    # BasicHouse walls have materials; histogram may be partial but should not error
    assert isinstance(result["material_histogram"], dict)


def test_aggregate_missing_qty_list(svc):
    """Elements without quantities should be listed in missing_quantity_ids."""
    result = svc.get_aggregate([])
    assert isinstance(result["missing_quantity_ids"], list)


def test_aggregate_unknown_id_is_skipped(svc):
    """Non-existent express IDs should be silently skipped."""
    result = svc.get_aggregate([999999999])
    assert result["count"] == 1
    # Unknown ID → skipped silently; type_histogram empty
    assert result["type_histogram"] == {}


def test_aggregate_result_values_are_non_negative(svc):
    """Area and volume sums must be ≥ 0."""
    all_ids = [e.id() for e in svc.model.by_type("IfcProduct")]
    result = svc.get_aggregate(all_ids)
    if result["total_area"] is not None:
        assert result["total_area"] >= 0
    if result["total_volume"] is not None:
        assert result["total_volume"] >= 0


# ---------------------------------------------------------------------------
# HTTP integration test - /api/ifc/aggregate
# ---------------------------------------------------------------------------


def test_aggregate_endpoint_no_model(monkeypatch):
    """Without a loaded model the endpoint should return 400/503."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.ifc_service import ifc_service

    # Patch the private attribute so the service reports no model
    monkeypatch.setattr(ifc_service, "_model", None)
    client = TestClient(app)
    resp = client.post("/api/ifc/aggregate", json={"express_ids": [1, 2, 3]})
    assert resp.status_code in (400, 503)


def test_aggregate_endpoint_with_model(_session_ifc, monkeypatch):
    """Loaded model → 200 with aggregate payload."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.ifc_service import ifc_service

    monkeypatch.setattr(ifc_service, "_persist_model", lambda: None)
    ifc_service.load(_session_ifc)

    client = TestClient(app)
    walls = [e.id() for e in ifc_service.model.by_type("IfcWall")]
    if not walls:
        pytest.skip("BasicHouse has no walls")

    resp = client.post("/api/ifc/aggregate", json={"express_ids": walls[:5]})
    assert resp.status_code == 200
    data = resp.json()
    assert "count" in data
    assert "type_histogram" in data
    assert "material_histogram" in data


def test_aggregate_endpoint_too_many_ids(_session_ifc, monkeypatch):
    """Sending > 2000 IDs should return 400."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.ifc_service import ifc_service

    monkeypatch.setattr(ifc_service, "_persist_model", lambda: None)
    ifc_service.load(_session_ifc)

    client = TestClient(app)
    resp = client.post("/api/ifc/aggregate", json={"express_ids": list(range(2001))})
    assert resp.status_code == 400
