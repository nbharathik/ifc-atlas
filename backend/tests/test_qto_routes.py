"""Route tests for /api/qto/summary and /api/qto/export.csv.

The router is mounted on a fresh FastAPI app (app.main is never imported) and
the ifc_service singleton is monkeypatched with an in-memory IFC4 model.
"""

from __future__ import annotations

import csv
import io

import ifcopenshell
import ifcopenshell.api
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.takeoff_routes import qto_router as router
from app.services import qto_service
from app.services.ifc_service import ifc_service


@pytest.fixture(autouse=True)
def _clear_qto_cache():
    """Every monkeypatched test model shares the singleton's default contract
    fingerprint, so the module cache must be wiped between tests to keep one
    test's result from answering the next test's request."""
    qto_service._RESULT_CACHE.clear()
    yield
    qto_service._RESULT_CACHE.clear()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _api(verb: str, model, **kwargs):
    return ifcopenshell.api.run(verb, model, **kwargs)


def _build_model():
    """One storey with two quantified walls and one slab without quantities."""
    model = ifcopenshell.file(schema="IFC4")
    project = _api("root.create_entity", model, ifc_class="IfcProject", name="P")
    length = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    project.UnitsInContext = model.create_entity("IfcUnitAssignment", Units=[length])
    site = _api("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = _api("root.create_entity", model, ifc_class="IfcBuilding", name="B")
    storey = _api("root.create_entity", model, ifc_class="IfcBuildingStorey", name="Ground Floor")
    _api("aggregate.assign_object", model, products=[site], relating_object=project)
    _api("aggregate.assign_object", model, products=[building], relating_object=site)
    _api("aggregate.assign_object", model, products=[storey], relating_object=building)

    for name, volume in (("W1", 2.0), ("W2", 3.0)):
        wall = _api("root.create_entity", model, ifc_class="IfcWall", name=name)
        _api("spatial.assign_container", model, products=[wall], relating_structure=storey)
        qto = _api("pset.add_qto", model, product=wall, name="Qto_WallBaseQuantities")
        _api(
            "pset.edit_qto", model, qto=qto,
            properties={"NetVolume": volume, "GrossSideArea": 8.0, "Length": 4.0},
        )

    slab = _api("root.create_entity", model, ifc_class="IfcSlab", name="S1")
    _api("spatial.assign_container", model, products=[slab], relating_structure=storey)
    return model


@pytest.fixture
def loaded_model(monkeypatch):
    model = _build_model()
    monkeypatch.setattr(ifc_service, "_model", model)
    return model


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


def test_summary_400_when_no_model(client, monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)
    response = client.get("/api/qto/summary", params={"group_by": "ifc_class"})
    assert response.status_code == 400
    assert response.json()["detail"] == "No IFC model loaded"


def test_export_400_when_no_model(client, monkeypatch):
    monkeypatch.setattr(ifc_service, "_model", None)
    response = client.get("/api/qto/export.csv", params={"group_by": "ifc_class"})
    assert response.status_code == 400
    assert response.json()["detail"] == "No IFC model loaded"


def test_summary_422_on_unknown_group_by(client, loaded_model):
    response = client.get("/api/qto/summary", params={"group_by": "bogus"})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "bogus" in detail
    assert "Allowed values" in detail
    for field in ("ifc_class", "storey", "material", "type_object", "classification"):
        assert field in detail


def test_summary_422_on_empty_group_by(client, loaded_model):
    response = client.get("/api/qto/summary", params={"group_by": " , "})
    assert response.status_code == 422
    assert "at least one" in response.json()["detail"]


def test_summary_422_when_group_by_missing(client, loaded_model):
    response = client.get("/api/qto/summary")
    assert response.status_code == 422


def test_export_422_on_unknown_group_by(client, loaded_model):
    response = client.get("/api/qto/export.csv", params={"group_by": "nope"})
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Summary happy paths
# ---------------------------------------------------------------------------


def test_summary_shape(client, loaded_model):
    response = client.get("/api/qto/summary", params={"group_by": "ifc_class,storey"})
    assert response.status_code == 200
    data = response.json()
    assert data["group_by"] == ["ifc_class", "storey"]
    assert data["truncated"] is False
    assert isinstance(data["elapsed_ms"], float)
    assert data["overall"]["count"] == 3
    assert set(data["overall"]["quantities"]) == {"volume_m3", "area_m2", "length_m"}

    top = data["groups"][0]
    assert top["key"] == {"ifc_class": "IfcWall", "storey": "Ground Floor"}
    assert top["label"] == "IfcWall / Ground Floor"
    assert top["count"] == 2
    assert top["quantities"]["volume_m3"] == pytest.approx(5.0)
    assert top["coverage"]["volume"] == 2
    # include_ids defaults to false: the key must be absent, not null.
    assert "element_ids" not in top


def test_summary_include_ids(client, loaded_model):
    response = client.get(
        "/api/qto/summary", params={"group_by": "ifc_class", "include_ids": "true"}
    )
    assert response.status_code == 200
    wall_group = next(g for g in response.json()["groups"] if g["label"] == "IfcWall")
    assert isinstance(wall_group["element_ids"], list)
    assert len(wall_group["element_ids"]) == wall_group["count"] == 2
    assert all(isinstance(express_id, int) for express_id in wall_group["element_ids"])


def test_summary_groups_sorted_by_count_descending(client, loaded_model):
    response = client.get("/api/qto/summary", params={"group_by": "ifc_class"})
    counts = [g["count"] for g in response.json()["groups"]]
    assert counts == sorted(counts, reverse=True)


def test_summary_trims_whitespace_and_duplicates(client, loaded_model):
    response = client.get(
        "/api/qto/summary", params={"group_by": " ifc_class , ifc_class ,storey "}
    )
    assert response.status_code == 200
    assert response.json()["group_by"] == ["ifc_class", "storey"]


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------


def test_export_csv_single_field(client, loaded_model):
    response = client.get("/api/qto/export.csv", params={"group_by": "ifc_class"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="qto-ifc_class.csv"'
    )
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == ["ifc_class", "count", "volume_m3", "area_m2", "length_m"]
    wall_row = next(r for r in rows[1:] if r[0] == "IfcWall")
    assert wall_row[1] == "2"
    assert float(wall_row[2]) == pytest.approx(5.0)


def test_export_csv_multi_field(client, loaded_model):
    response = client.get(
        "/api/qto/export.csv", params={"group_by": "ifc_class,storey"}
    )
    assert response.status_code == 200
    assert 'filename="qto-ifc_class-storey.csv"' in response.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows[0] == ["ifc_class", "storey", "count", "volume_m3", "area_m2", "length_m"]
    # Slab has no quantities: numeric cells are blank, mirroring the UI's "-".
    slab_row = next(r for r in rows[1:] if r[0] == "IfcSlab")
    assert slab_row[2:] == ["1", "", "", ""]
