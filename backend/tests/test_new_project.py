"""Tests for new-project creation: project_template_service + POST /api/ifc/new.

Builds tiny (~1 KB) IFC files via ifcopenshell.api and reopens them - fast and
not the 50 MB BasicHouse load the requires_ifc_load marker guards, so these run
in the fast lane.
"""

from __future__ import annotations

import os
import tempfile

import ifcopenshell
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services.project_template_service import TEMPLATES, create_blank_project


def _open_bytes(data: bytes):
    p = os.path.join(tempfile.mkdtemp(), "t.ifc")
    with open(p, "wb") as fh:
        fh.write(data)
    return ifcopenshell.open(p)


class TestCreateBlankProject:
    def test_single_storey_scaffold(self):
        m = _open_bytes(create_blank_project("single_storey"))
        assert m.schema == "IFC4"
        assert m.by_type("IfcProject")
        assert m.by_type("IfcSite") and m.by_type("IfcBuilding")
        assert len(m.by_type("IfcBuildingStorey")) == 1
        assert m.by_type("IfcRelAggregates")  # spatial hierarchy wired

    def test_two_storey_has_two_storeys(self):
        m = _open_bytes(create_blank_project("two_storey"))
        assert len(m.by_type("IfcBuildingStorey")) == 2

    def test_empty_has_no_storeys(self):
        m = _open_bytes(create_blank_project("empty"))
        assert m.by_type("IfcProject")
        assert len(m.by_type("IfcBuildingStorey")) == 0

    def test_unknown_template_falls_back_to_default(self):
        m = _open_bytes(create_blank_project("bogus"))
        assert len(m.by_type("IfcBuildingStorey")) == 1  # single_storey default

    def test_units_and_context_present(self):
        m = _open_bytes(create_blank_project("single_storey"))
        assert m.by_type("IfcUnitAssignment")
        assert m.by_type("IfcGeometricRepresentationContext")

    def test_project_name(self):
        m = _open_bytes(create_blank_project("empty", project_name="My House"))
        assert m.by_type("IfcProject")[0].Name == "My House"

    def test_all_templates_open_cleanly(self):
        for t in TEMPLATES:
            m = _open_bytes(create_blank_project(t))
            assert m.by_type("IfcProject"), f"template {t} produced no project"


def _client() -> TestClient:
    from app.api.ifc_routes import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestNewProjectRoute:
    def test_returns_ifc_bytes(self):
        r = _client().post("/api/ifc/new?template=single_storey")
        assert r.status_code == 200
        assert b"IFCPROJECT" in r.content.upper()
        assert r.headers["content-type"].startswith("application/x-ifc")

    def test_default_template_has_a_storey(self):
        r = _client().post("/api/ifc/new")
        assert r.status_code == 200
        assert b"IFCBUILDINGSTOREY" in r.content.upper()
