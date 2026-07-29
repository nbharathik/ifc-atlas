"""
Endpoint-level tests for POST /api/ifc/ids-validate.

Uses FastAPI TestClient + unittest.mock to avoid loading a real IFC file
(which would SIGSEGV on Windows/Python 3.13 with IfcOpenShell).
All tests are pure - no disk I/O, no real IFC parsing.
"""

from __future__ import annotations

import base64
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ids_b64() -> str:
    """Minimal IDS XML, base64-encoded."""
    import ifctester.ids as ids_mod
    import ifctester.facet as f
    ids = ids_mod.Ids(title="Test IDS")
    spec = ids_mod.Specification(
        name="Wall check", ifcVersion=["IFC2X3", "IFC4", "IFC4X3_ADD2"]
    )
    spec.applicability.append(f.Entity(name="IfcWall"))
    spec.requirements.append(
        f.Property(propertySet="Pset_WallCommon", baseName="FireRating", dataType="IFCLABEL")
    )
    ids.specifications.append(spec)
    xml = ids.to_string()
    return base64.b64encode(xml.encode()).decode()


def _client_with_loaded_model():
    """Return a TestClient with ifc_service.is_loaded patched to True
    and a minimal in-memory ifcopenshell model injected."""
    import ifcopenshell
    model = ifcopenshell.file()
    client = TestClient(app, raise_server_exceptions=False)
    return client, model


# ---------------------------------------------------------------------------
# No-model-loaded guard (400)
# ---------------------------------------------------------------------------

def test_ids_validate_no_model_returns_400():
    """Endpoint must return 400 when no IFC model is loaded."""
    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = False
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": "dGVzdA==", "format": "csv"},
        )
    assert resp.status_code == 400
    assert "No IFC model loaded" in resp.json().get("detail", "")


# ---------------------------------------------------------------------------
# CSV format - response headers
# ---------------------------------------------------------------------------

def test_ids_validate_csv_content_type():
    """CSV format must return content-type text/csv."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc, \
         patch("app.api.ifc_routes.validate_ids_base64_to_csv", return_value="spec_name,express_id\n") as _:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64, "format": "csv"},
        )
    assert resp.status_code == 200
    assert "text/csv" in resp.headers.get("content-type", "")


def test_ids_validate_csv_content_disposition():
    """CSV response must include Content-Disposition with ids_failures.csv."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc, \
         patch("app.api.ifc_routes.validate_ids_base64_to_csv", return_value="spec_name,express_id\n"):
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64, "format": "csv"},
        )
    assert resp.status_code == 200
    disposition = resp.headers.get("content-disposition", "")
    assert "ids_failures.csv" in disposition


def test_ids_validate_csv_has_header_row():
    """CSV body must start with a header row containing expected column names."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    # Use the real service function but against an empty model (no walls → header only)

    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64, "format": "csv"},
        )
    assert resp.status_code == 200
    first_line = resp.text.splitlines()[0]
    assert "spec_name" in first_line
    assert "express_id" in first_line


# ---------------------------------------------------------------------------
# JSON format - response headers
# ---------------------------------------------------------------------------

def test_ids_validate_json_content_type():
    """Default (JSON) format must return application/json."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64, "format": "json"},
        )
    assert resp.status_code == 200
    assert "application/json" in resp.headers.get("content-type", "")


# ---------------------------------------------------------------------------
# X-IDS-Engine header
# ---------------------------------------------------------------------------

def test_ids_validate_engine_header_present():
    """Both JSON and CSV responses must include X-IDS-Engine header."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64, "format": "json"},
        )
    assert resp.status_code == 200
    assert "x-ids-engine" in resp.headers


# ---------------------------------------------------------------------------
# Bad input → 400
# ---------------------------------------------------------------------------

def test_ids_validate_invalid_base64_returns_400():
    """Invalid base64 string must yield a 400 error."""
    import ifcopenshell
    model = ifcopenshell.file()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": "!!!not-base64!!!", "format": "json"},
        )
    assert resp.status_code == 400


def test_ids_validate_limit_per_spec_default():
    """Default limit_per_spec (25) must not cause a server error."""
    import ifcopenshell
    model = ifcopenshell.file()
    b64 = _make_ids_b64()

    with patch("app.api.ifc_routes.ifc_service") as mock_svc:
        mock_svc.is_loaded = True
        mock_svc.model = model
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.post(
            "/api/ifc/ids-validate",
            json={"ids_base64": b64},  # format defaults to json
        )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /ids-info endpoint
# ---------------------------------------------------------------------------


def test_ids_info_returns_title():
    """ids-info must parse the IDS title from the XML."""
    b64 = _make_ids_b64()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post("/api/ifc/ids-info", json={"ids_base64": b64})
    assert resp.status_code == 200
    body = resp.json()
    assert "title" in body
    assert body["title"] == "Test IDS"


def test_ids_info_returns_spec_count():
    """ids-info must report how many specifications the IDS contains."""
    b64 = _make_ids_b64()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post("/api/ifc/ids-info", json={"ids_base64": b64})
    assert resp.status_code == 200
    body = resp.json()
    assert "specifications_count" in body
    assert body["specifications_count"] == 1


def test_ids_info_invalid_base64_returns_400():
    """ids-info must return 400 for malformed base64."""
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post("/api/ifc/ids-info", json={"ids_base64": "$$not-base64$$"})
    assert resp.status_code == 400
