from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, raise_server_exceptions=False)


def test_upload_rejects_oversized_ifc_and_removes_partial_file(tmp_path, monkeypatch):
    from app.api import ifc_routes

    monkeypatch.setattr(ifc_routes, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(ifc_routes, "MAX_IFC_UPLOAD_BYTES", 4)

    resp = _client().post(
        "/api/ifc/upload",
        files={"file": ("too-large.ifc", b"12345", "application/octet-stream")},
    )

    assert resp.status_code == 413
    assert resp.json()["detail"] == "IFC file too large (max 4 B)."
    assert not (tmp_path / "too-large.ifc").exists()


def test_upload_rejects_empty_ifc_before_model_load(tmp_path, monkeypatch):
    from app.api import ifc_routes

    monkeypatch.setattr(ifc_routes, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(ifc_routes, "MAX_IFC_UPLOAD_BYTES", 1024)

    resp = _client().post(
        "/api/ifc/upload",
        files={"file": ("empty.ifc", b"", "application/octet-stream")},
    )

    assert resp.status_code == 400
    assert resp.json()["detail"] == "Empty file body"


def test_preview_upload_endpoints_share_ifc_size_cap(monkeypatch):
    from app.api import ifc_routes

    monkeypatch.setattr(ifc_routes, "MAX_IFC_UPLOAD_BYTES", 4)
    client = _client()

    for path in ("/api/ifc/native-parse", "/api/ifc/geometry", "/api/ifc/geometry/stream"):
        resp = client.post(
            path,
            files={"file": ("too-large.ifc", b"12345", "application/octet-stream")},
        )
        assert resp.status_code == 413
        assert resp.json()["detail"] == "IFC file too large (max 4 B)."


def test_convert_endpoint_uses_ifc_size_cap(monkeypatch):
    from app.api import ifc_routes

    monkeypatch.setattr(ifc_routes, "MAX_IFC_UPLOAD_BYTES", 4)

    resp = _client().post(
        "/api/ifc/convert",
        content=b"12345",
        headers={"content-type": "application/octet-stream"},
    )

    assert resp.status_code == 413
    assert resp.json()["detail"] == "IFC file too large (max 4 B)."


def test_convert_cache_hit_exposes_fragments_format_version(tmp_path, monkeypatch):
    from app.api import ifc_routes
    from app.services.fragment_cache import (
        atomic_write_fragment_cache,
        fragments_format_version,
        full_fragment_cache_entry,
    )

    ifc_bytes = b"ISO-10303-21;test-cache-hit"
    fingerprint = hashlib.sha256(ifc_bytes).hexdigest()
    entry = full_fragment_cache_entry(tmp_path, fingerprint, "balanced")
    atomic_write_fragment_cache(entry, b"FRAGMENT")
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)

    resp = _client().post(
        "/api/ifc/convert",
        content=ifc_bytes,
        headers={
            "content-type": "application/octet-stream",
            "origin": "http://localhost:5173",
        },
    )

    assert resp.status_code == 200
    assert resp.content == b"FRAGMENT"
    assert resp.headers["X-Fragment-Source"] == "cache"
    assert resp.headers["X-Fragments-Format-Version"] == fragments_format_version(entry)
    exposed = resp.headers["Access-Control-Expose-Headers"].lower()
    assert "x-fragments-format-version" in exposed
