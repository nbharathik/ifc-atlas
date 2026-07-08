"""Tests for the IDS library service + /api/ids routes.

All IFC models are authored in-memory with ifcopenshell; no fixture file is
loaded from disk. Route tests mount the router on a fresh FastAPI app and
monkeypatch the ifc_service singleton, mirroring the existing route tests.
"""

from __future__ import annotations

import csv
import io
import shutil

import pytest
from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ids_xml(
    title: str = "Test IDS",
    spec_name: str = "Wall Fire Rating",
    ifc_type: str = "IfcWall",
    pset: str = "Pset_WallCommon",
    prop: str = "FireRating",
) -> str:
    """Build a minimal IDS 1.0 XML with one Property requirement via ifctester."""
    import ifctester.ids as ids_mod
    import ifctester.facet as f

    ids = ids_mod.Ids(title=title)
    spec = ids_mod.Specification(
        name=spec_name, ifcVersion=["IFC2X3", "IFC4", "IFC4X3_ADD2"]
    )
    spec.applicability.append(f.Entity(name=ifc_type))
    spec.requirements.append(
        f.Property(propertySet=pset, baseName=prop, dataType="IFCLABEL")
    )
    ids.specifications.append(spec)
    return ids.to_string()


def _wall_model(wall_count: int = 1):
    """Return an in-memory IFC4 model with bare IfcWall entities (no psets)."""
    import ifcopenshell
    import ifcopenshell.guid

    model = ifcopenshell.file(schema="IFC4")
    for i in range(wall_count):
        model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name=f"Wall-{i}")
    return model


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def lib():
    """Library service rooted at the conftest temp home, wiped per test."""
    from app.services.ids_library_service import IdsLibraryService

    service = IdsLibraryService()
    shutil.rmtree(service.root, ignore_errors=True)
    yield service
    shutil.rmtree(service.root, ignore_errors=True)


@pytest.fixture()
def client(lib, monkeypatch):
    """TestClient with the /api/ids router on a fresh app + clean last-run cache."""
    from fastapi import FastAPI
    from app.api import ids_routes

    monkeypatch.setattr(ids_routes, "ids_library_service", lib)
    monkeypatch.setattr(ids_routes, "_last_run", None)
    app = FastAPI()
    app.include_router(ids_routes.router)
    return TestClient(app)


@pytest.fixture()
def loaded_wall(monkeypatch):
    """Load a one-wall in-memory model into the ifc_service singleton."""
    from app.services.ifc_service import ifc_service

    model = _wall_model()
    monkeypatch.setattr(ifc_service, "_model", model)
    monkeypatch.setattr(ifc_service, "_model_fingerprint", "test-fingerprint-a")
    return model


def _upload(client, xml: str, filename: str = "spec.ids"):
    return client.post(
        "/api/ids/library",
        files={"file": (filename, xml.encode("utf-8"), "application/xml")},
    )


# ---------------------------------------------------------------------------
# Service unit tests - add / list / delete / dedupe
# ---------------------------------------------------------------------------

class TestIdsLibraryService:
    def test_add_entry_returns_metadata(self, lib):
        xml = _make_ids_xml(title="My Standard")
        entry = lib.add_entry("spec.ids", xml.encode())
        assert len(entry["id"]) == 12
        int(entry["id"], 16)  # id is hex
        assert entry["filename"] == "spec.ids"
        assert entry["title"] == "My Standard"
        assert entry["specifications_count"] == 1
        assert entry["size_bytes"] == len(xml.encode())
        assert entry["added_at"].endswith("Z")

    def test_add_entry_writes_file_and_index(self, lib):
        xml = _make_ids_xml()
        entry = lib.add_entry("spec.ids", xml.encode())
        assert (lib.root / f"{entry['id']}.ids").exists()
        assert (lib.root / "library.json").exists()

    def test_list_entries_returns_all(self, lib):
        lib.add_entry("a.ids", _make_ids_xml(title="A").encode())
        lib.add_entry("b.ids", _make_ids_xml(title="B").encode())
        titles = {e["title"] for e in lib.list_entries()}
        assert titles == {"A", "B"}

    def test_dedupe_same_content_same_entry(self, lib):
        xml = _make_ids_xml()
        first = lib.add_entry("spec.ids", xml.encode())
        second = lib.add_entry("renamed.ids", xml.encode())
        assert first["id"] == second["id"]
        assert second["filename"] == "spec.ids"  # original entry kept
        assert len(lib.list_entries()) == 1

    def test_delete_entry_removes_file_and_index_row(self, lib):
        entry = lib.add_entry("spec.ids", _make_ids_xml().encode())
        lib.delete_entry(entry["id"])
        assert lib.list_entries() == []
        assert not (lib.root / f"{entry['id']}.ids").exists()

    def test_delete_unknown_raises_keyerror(self, lib):
        with pytest.raises(KeyError):
            lib.delete_entry("000000000000")

    def test_get_xml_roundtrip(self, lib):
        xml = _make_ids_xml(title="Roundtrip")
        entry = lib.add_entry("spec.ids", xml.encode())
        assert "Roundtrip" in lib.get_xml(entry["id"])

    def test_get_xml_unknown_raises_keyerror(self, lib):
        with pytest.raises(KeyError):
            lib.get_xml("ffffffffffff")

    def test_add_invalid_content_raises_value_error(self, lib):
        with pytest.raises(ValueError, match="Not a valid IDS file"):
            lib.add_entry("bad.ids", b"not xml at all <<<")


# ---------------------------------------------------------------------------
# Route tests - library CRUD
# ---------------------------------------------------------------------------

class TestLibraryRoutes:
    def test_upload_and_list(self, client):
        res = _upload(client, _make_ids_xml(title="Uploaded"))
        assert res.status_code == 200
        entry = res.json()
        assert entry["title"] == "Uploaded"
        assert entry["filename"] == "spec.ids"
        assert entry["specifications_count"] == 1

        listed = client.get("/api/ids/library")
        assert listed.status_code == 200
        entries = listed.json()["entries"]
        assert [e["id"] for e in entries] == [entry["id"]]

    def test_upload_invalid_returns_422(self, client):
        res = client.post(
            "/api/ids/library",
            files={"file": ("bad.ids", b"<not-valid-ids>", "application/xml")},
        )
        assert res.status_code == 422
        assert res.json()["detail"] == "Not a valid IDS file"

    def test_upload_wrong_extension_returns_400(self, client):
        res = client.post(
            "/api/ids/library",
            files={"file": ("spec.txt", b"whatever", "text/plain")},
        )
        assert res.status_code == 400

    def test_upload_dedupes_to_same_id(self, client):
        xml = _make_ids_xml()
        first = _upload(client, xml).json()
        second = _upload(client, xml, filename="copy.ids").json()
        assert first["id"] == second["id"]
        assert len(client.get("/api/ids/library").json()["entries"]) == 1

    def test_delete_entry(self, client):
        entry = _upload(client, _make_ids_xml()).json()
        res = client.delete(f"/api/ids/library/{entry['id']}")
        assert res.status_code == 200
        assert res.json() == {"deleted": True}
        assert client.get("/api/ids/library").json()["entries"] == []

    def test_delete_unknown_returns_404(self, client):
        res = client.delete("/api/ids/library/000000000000")
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# Route tests - validate
# ---------------------------------------------------------------------------

class TestValidateRoute:
    def test_validate_no_model_returns_400(self, client, monkeypatch):
        from app.services.ifc_service import ifc_service
        monkeypatch.setattr(ifc_service, "_model", None)
        entry = _upload(client, _make_ids_xml()).json()
        res = client.post(f"/api/ids/library/{entry['id']}/validate")
        assert res.status_code == 400

    def test_validate_unknown_entry_returns_404(self, client, loaded_wall):
        res = client.post("/api/ids/library/000000000000/validate")
        assert res.status_code == 404

    def test_validate_returns_enriched_report(self, client, loaded_wall):
        entry = _upload(client, _make_ids_xml()).json()
        res = client.post(f"/api/ids/library/{entry['id']}/validate")
        assert res.status_code == 200
        body = res.json()

        assert body["ids_id"] == entry["id"]
        assert body["ran_at"].endswith("Z")
        for key in ("total_specifications", "passed", "failed", "no_applicable",
                    "specifications", "ids_title", "ids_version",
                    "ids_description", "engine", "all_failing_ids"):
            assert key in body, f"Missing key: {key}"

        assert body["total_specifications"] == 1
        assert body["failed"] == 1
        spec = body["specifications"][0]
        assert spec["status"] == "failed"
        assert spec["applied_to"] == 1
        failing = spec["failing_elements"][0]
        for key in ("id", "global_id", "ifc_type", "name", "facet_type", "reason"):
            assert key in failing, f"Missing failing-element key: {key}"
        assert failing["ifc_type"] == "IfcWall"

    def test_validate_failing_id_is_wall_express_id(self, client, loaded_wall):
        wall_id = loaded_wall.by_type("IfcWall")[0].id()
        entry = _upload(client, _make_ids_xml()).json()
        body = client.post(f"/api/ids/library/{entry['id']}/validate").json()
        assert body["all_failing_ids"] == [wall_id]
        assert isinstance(body["all_failing_ids"][0], int)

    def test_validate_limit_per_spec_truncates(self, client, monkeypatch):
        from app.services.ifc_service import ifc_service
        model = _wall_model(wall_count=4)
        monkeypatch.setattr(ifc_service, "_model", model)
        monkeypatch.setattr(ifc_service, "_model_fingerprint", "test-fingerprint-b")

        entry = _upload(client, _make_ids_xml()).json()
        body = client.post(
            f"/api/ids/library/{entry['id']}/validate", params={"limit_per_spec": 2}
        ).json()
        spec = body["specifications"][0]
        assert len(spec["failing_elements"]) == 2
        assert spec["failing_truncated"] is True


# ---------------------------------------------------------------------------
# Route tests - last-run cache
# ---------------------------------------------------------------------------

class TestLastRunCache:
    def test_last_empty_cache_unavailable(self, client, loaded_wall):
        res = client.get("/api/ids/last")
        assert res.status_code == 200
        assert res.json()["available"] is False

    def test_last_returns_cached_report(self, client, loaded_wall):
        entry = _upload(client, _make_ids_xml()).json()
        validated = client.post(f"/api/ids/library/{entry['id']}/validate").json()

        res = client.get("/api/ids/last")
        assert res.status_code == 200
        body = res.json()
        assert body["available"] is True
        assert body["ids_id"] == entry["id"]
        assert body["ran_at"] == validated["ran_at"]
        assert body["report"]["total_specifications"] == 1
        assert body["report"]["all_failing_ids"] == validated["all_failing_ids"]

    def test_last_fingerprint_mismatch_unavailable(self, client, loaded_wall, monkeypatch):
        from app.services.ifc_service import ifc_service
        entry = _upload(client, _make_ids_xml()).json()
        client.post(f"/api/ids/library/{entry['id']}/validate")

        monkeypatch.setattr(ifc_service, "_model_fingerprint", "different-model")
        assert client.get("/api/ids/last").json()["available"] is False
        assert client.get("/api/ids/last.csv").status_code == 404

    def test_last_csv_404_when_empty(self, client, loaded_wall):
        assert client.get("/api/ids/last.csv").status_code == 404

    def test_last_csv_content_shape(self, client, loaded_wall):
        wall_id = loaded_wall.by_type("IfcWall")[0].id()
        entry = _upload(client, _make_ids_xml()).json()
        client.post(f"/api/ids/library/{entry['id']}/validate")

        res = client.get("/api/ids/last.csv")
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/csv")
        assert "attachment" in res.headers["content-disposition"]

        rows = list(csv.reader(io.StringIO(res.text)))
        assert rows[0] == [
            "spec_name", "express_id", "global_id", "ifc_type",
            "name", "facet_type", "reason",
        ]
        assert len(rows) == 2  # header + the single failing wall
        assert rows[1][0] == "Wall Fire Rating"
        assert rows[1][1] == str(wall_id)
