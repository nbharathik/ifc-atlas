"""Tests for the run_model_audit tool + app.services.model_audit.

The audit model is authored in memory with ifcopenshell.api (mirroring
test_qto_service): two concrete walls with quantities, a door, and a proxy
element with neither quantities nor a rate, so the cost/carbon sections have
both priced/factored and uncovered rows.
"""

from __future__ import annotations

from unittest.mock import patch

import ifcopenshell
import ifcopenshell.api
import pytest

from app.services import model_audit
from app.services.model_audit import run_model_audit

SECTION_NAMES = ["health", "quantities", "cost", "carbon", "ids"]
VALID_STATUSES = {"ok", "warnings", "issues"}


def _api(verb: str, model, **kwargs):
    return ifcopenshell.api.run(verb, model, **kwargs)


@pytest.fixture(autouse=True)
def _isolated_rate_libraries(tmp_path, monkeypatch):
    """Pin the cost/carbon libraries to a fresh temp path so the audit prices
    with the shipped defaults (and the empty carbon library + keyword
    fallback) regardless of what other tests persisted earlier."""
    from app.services import carbon_service, cost_service

    monkeypatch.setattr(cost_service, "_RATES_PATH", tmp_path / "rates.json")
    monkeypatch.setattr(carbon_service, "_FACTORS_PATH", tmp_path / "factors.json")


@pytest.fixture(scope="module")
def audit_model():
    model = ifcopenshell.file(schema="IFC4")
    project = _api("root.create_entity", model, ifc_class="IfcProject", name="Audit")
    length = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    area = model.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE")
    volume = model.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    project.UnitsInContext = model.create_entity(
        "IfcUnitAssignment", Units=[length, area, volume]
    )
    site = _api("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = _api("root.create_entity", model, ifc_class="IfcBuilding", name="B")
    storey = _api(
        "root.create_entity", model, ifc_class="IfcBuildingStorey", name="Level 1"
    )
    _api("aggregate.assign_object", model, products=[site], relating_object=project)
    _api("aggregate.assign_object", model, products=[building], relating_object=site)
    _api("aggregate.assign_object", model, products=[storey], relating_object=building)

    concrete = _api("material.add_material", model, name="Concrete")
    walls = []
    for name, quantities in (
        ("W1", {"NetVolume": 2.0, "GrossSideArea": 8.0}),
        ("W2", {"NetVolume": 3.0, "GrossSideArea": 10.0}),
    ):
        wall = _api("root.create_entity", model, ifc_class="IfcWall", name=name)
        _api(
            "spatial.assign_container", model, products=[wall], relating_structure=storey
        )
        qto = _api("pset.add_qto", model, product=wall, name="Qto_WallBaseQuantities")
        _api("pset.edit_qto", model, qto=qto, properties=quantities)
        walls.append(wall)
    _api("material.assign_material", model, products=walls, material=concrete)

    door = _api("root.create_entity", model, ifc_class="IfcDoor", name="D1")
    _api("spatial.assign_container", model, products=[door], relating_structure=storey)

    # No quantities, no material, no rate entry -> unpriced + unfactored row.
    proxy = _api(
        "root.create_entity", model, ifc_class="IfcBuildingElementProxy", name="P1"
    )
    _api("spatial.assign_container", model, products=[proxy], relating_structure=storey)

    return model


FAILING_IDS_RUN = {
    "ids_id": "spec-1",
    "ran_at": "2026-07-06T00:00:00Z",
    "report": {
        "total_specifications": 2,
        "passed": 1,
        "failed": 1,
        "no_applicable": 0,
        "specifications": [
            {"name": "Walls must have FireRating", "status": "failed", "failed": 3},
            {"name": "Doors must have names", "status": "passed", "failed": 0},
        ],
        "all_failing_ids": [11, 12, 13],
    },
}


# ---------------------------------------------------------------------------
# Report shape
# ---------------------------------------------------------------------------


def test_audit_report_shape(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    assert [s["name"] for s in report["sections"]] == SECTION_NAMES
    for section in report["sections"]:
        assert section["status"] in VALID_STATUSES, section["name"]
        assert isinstance(section["findings"], list) and section["findings"]
        assert isinstance(section["stats"], dict)
    summary = report["summary"]
    assert summary["status"] in VALID_STATUSES
    assert set(summary["section_statuses"]) == set(SECTION_NAMES)
    assert sum(summary["counts"].values()) == len(SECTION_NAMES)
    assert "duration_ms" in summary
    assert "estimate" in summary["note"]


def test_audit_summary_status_is_worst_section(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    rank = {"ok": 0, "warnings": 1, "issues": 2}
    worst = max((s["status"] for s in report["sections"]), key=rank.__getitem__)
    assert report["summary"]["status"] == worst


def test_audit_quantity_coverage(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    quantities = next(s for s in report["sections"] if s["name"] == "quantities")
    assert quantities["stats"]["element_count"] == 4
    assert quantities["stats"]["coverage"]["volume"]["elements"] == 2
    assert quantities["stats"]["coverage"]["volume"]["pct"] == 50.0
    assert quantities["status"] == "ok"


def test_audit_cost_and_carbon_coverage(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    cost = next(s for s in report["sections"] if s["name"] == "cost")
    # IfcWall (area) + IfcDoor (count) priced; the proxy has no rate.
    assert cost["stats"]["total_rows"] == 3
    assert cost["stats"]["priced_rows"] == 2
    assert cost["stats"]["priced_pct"] == pytest.approx(66.7)
    assert cost["status"] == "warnings"
    assert any("Unpriced rows" in f for f in cost["findings"])

    carbon = next(s for s in report["sections"] if s["name"] == "carbon")
    # Concrete resolves via keyword factor; "No material" does not.
    assert carbon["stats"]["total_rows"] == 2
    assert carbon["stats"]["factored_rows"] == 1
    assert carbon["stats"]["total_kg"] == pytest.approx(600.0)  # 5 m3 * 120
    assert carbon["status"] == "warnings"


def test_audit_health_section_ok_on_clean_model(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    health = next(s for s in report["sections"] if s["name"] == "health")
    assert health["status"] == "ok"
    assert health["stats"]["errors"] == 0


# ---------------------------------------------------------------------------
# IDS section
# ---------------------------------------------------------------------------


def test_audit_ids_section_without_run(audit_model):
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    ids = next(s for s in report["sections"] if s["name"] == "ids")
    assert ids["status"] == "ok"
    assert ids["stats"] == {"available": False}
    assert "No IDS validation run" in ids["findings"][0]


def test_audit_ids_section_with_failing_run(audit_model):
    report = run_model_audit(
        audit_model, fingerprint=None, ids_last_run=FAILING_IDS_RUN
    )
    ids = next(s for s in report["sections"] if s["name"] == "ids")
    assert ids["status"] == "issues"
    assert ids["stats"]["failed"] == 1
    assert ids["stats"]["failing_elements"] == 3
    assert ids["stats"]["ids_id"] == "spec-1"
    assert any("Walls must have FireRating" in f for f in ids["findings"])
    assert report["summary"]["status"] == "issues"


def test_audit_ids_section_with_passing_run(audit_model):
    passing = {
        **FAILING_IDS_RUN,
        "report": {
            "total_specifications": 1,
            "passed": 1,
            "failed": 0,
            "no_applicable": 0,
            "specifications": [{"name": "S", "status": "passed", "failed": 0}],
            "all_failing_ids": [],
        },
    }
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=passing)
    ids = next(s for s in report["sections"] if s["name"] == "ids")
    assert ids["status"] == "ok"
    assert ids["stats"]["available"] is True


# ---------------------------------------------------------------------------
# Fault isolation - a failing computation degrades one section only
# ---------------------------------------------------------------------------


def test_audit_degraded_section_does_not_abort(audit_model, monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("pricing exploded")

    monkeypatch.setattr(model_audit, "compute_boq", _boom)
    report = run_model_audit(audit_model, fingerprint=None, ids_last_run=None)
    assert [s["name"] for s in report["sections"]] == SECTION_NAMES
    cost = next(s for s in report["sections"] if s["name"] == "cost")
    assert cost["status"] == "issues"
    assert cost["stats"] == {"failed": True}
    assert any("pricing exploded" in f for f in cost["findings"])
    # Other sections still computed normally.
    health = next(s for s in report["sections"] if s["name"] == "health")
    assert health["status"] == "ok"
    assert report["summary"]["status"] == "issues"


# ---------------------------------------------------------------------------
# execute_tool routing
# ---------------------------------------------------------------------------


def test_execute_tool_run_model_audit(monkeypatch):
    from app.services.tools import execute_tool

    sentinel = {"sections": [], "summary": {"status": "ok"}}
    captured: dict = {}

    def _fake_audit(model, fingerprint=None, limit_per_rule=10, **kwargs):
        captured["fingerprint"] = fingerprint
        captured["limit_per_rule"] = limit_per_rule
        return sentinel

    monkeypatch.setattr(model_audit, "run_model_audit", _fake_audit)
    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        svc.get_model_contract.return_value = {
            "model_fingerprint": "abc",
            "model_version": 3,
            "edit_id": None,
        }
        result = execute_tool("run_model_audit", {"limit_per_rule": 5})

    assert result is sentinel
    assert captured["fingerprint"] == "abc:3:None"
    assert captured["limit_per_rule"] == 5


def test_execute_tool_run_model_audit_default_limit(monkeypatch):
    from app.services.tools import execute_tool

    captured: dict = {}

    def _fake_audit(model, fingerprint=None, limit_per_rule=10, **kwargs):
        captured["limit_per_rule"] = limit_per_rule
        return {"sections": [], "summary": {"status": "ok"}}

    monkeypatch.setattr(model_audit, "run_model_audit", _fake_audit)
    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = True
        svc.get_model_contract.return_value = {
            "model_fingerprint": "abc",
            "model_version": 1,
            "edit_id": None,
        }
        execute_tool("run_model_audit", {})
    assert captured["limit_per_rule"] == 10


def test_execute_tool_run_model_audit_no_model():
    from app.services.tools import execute_tool

    with patch("app.services.tools.ifc_service") as svc:
        svc.is_loaded = False
        result = execute_tool("run_model_audit", {})
    assert result == {"error": "No IFC model is currently loaded."}


def test_fetch_ids_last_run_none_when_no_cache():
    # The routes module has no cached run in a fresh test process (and even if
    # another test ran one, a mocked/absent model makes the fingerprint stale).
    with patch("app.api.ids_routes._last_run", None):
        assert model_audit.fetch_ids_last_run() is None
