"""FastAPI TestClient coverage for ``GET /api/ifc/convert-status``.

Patches ``fragment_prebuild_service`` + ``FRAGMENT_CACHE_DIR`` so each test
gets a sandboxed registry + temp cache directory. No real IFC file I/O.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.fragment_prebuild_service import FragmentPrebuildService

_SHA = "abcd" * 16  # 64-char hex string


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def test_idle_for_unknown_fingerprint(tmp_path: Path) -> None:
    fresh = FragmentPrebuildService()
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={_SHA}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "idle"
    assert body["fingerprint"] == _SHA
    assert body["profile"] == "balanced"
    assert body["serve_url"] is None
    assert body["size_bytes"] is None


def test_inflight_after_register(tmp_path: Path) -> None:
    fresh = FragmentPrebuildService()
    asyncio.run(fresh.register_inflight(_SHA, "balanced"))
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={_SHA}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "inflight"
    assert body["elapsed_ms"] is not None
    assert body["serve_url"] is None


def test_complete_returns_serve_url(tmp_path: Path) -> None:
    cache_file = tmp_path / f"{_SHA}-balanced.frag"
    cache_file.write_bytes(b"x" * 1024)
    fresh = FragmentPrebuildService()
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={_SHA}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "complete"
    assert body["size_bytes"] == 1024
    assert body["serve_url"] == (
        f"/api/ifc/fragments/serve?fingerprint={_SHA}&profile=balanced"
    )


def test_failed_state_surfaces_error(tmp_path: Path) -> None:
    fresh = FragmentPrebuildService()
    asyncio.run(fresh.register_inflight(_SHA, "balanced"))
    asyncio.run(fresh.mark_failed(_SHA, "balanced", error="sidecar exited 1"))
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={_SHA}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["error"] == "sidecar exited 1"
    assert body["serve_url"] is None


def test_disk_cache_wins_over_registry(tmp_path: Path) -> None:
    """If the cache file exists, the response must read ``complete`` even
    when the registry has the entry stuck as ``inflight``."""
    cache_file = tmp_path / f"{_SHA}-balanced.frag"
    cache_file.write_bytes(b"y" * 7)
    fresh = FragmentPrebuildService()
    asyncio.run(fresh.register_inflight(_SHA, "balanced"))
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={_SHA}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "complete"
    assert body["size_bytes"] == 7
    assert body["serve_url"] is not None


def test_path_traversal_in_fingerprint_is_sanitised(tmp_path: Path) -> None:
    """Reject path-traversal characters before they hit the cache lookup."""
    fresh = FragmentPrebuildService()
    bad_fp = "../../../etc/passwd"
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(f"/api/ifc/convert-status?fingerprint={bad_fp}")
    assert resp.status_code == 200
    body = resp.json()
    # Slashes, backslashes, and `..` are stripped per `safe_fp` rules.
    assert body["fingerprint"] == "etcpasswd"


def test_wait_ms_returns_inflight_on_timeout(tmp_path: Path) -> None:
    fresh = FragmentPrebuildService()
    asyncio.run(fresh.register_inflight(_SHA, "balanced"))
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        # 50 ms wait - task never resolves, so we still see ``inflight``.
        resp = _client().get(
            f"/api/ifc/convert-status?fingerprint={_SHA}&wait_ms=50"
        )
    assert resp.status_code == 200
    assert resp.json()["status"] == "inflight"


def test_profile_validation_rejects_unknown(tmp_path: Path) -> None:
    fresh = FragmentPrebuildService()
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(
            f"/api/ifc/convert-status?fingerprint={_SHA}&profile=bogus"
        )
    # FastAPI Literal validation → 422.
    assert resp.status_code == 422


def test_wait_ms_clamped_to_max(tmp_path: Path) -> None:
    """wait_ms > 30_000 is rejected at validation time (le=30_000)."""
    fresh = FragmentPrebuildService()
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(
            f"/api/ifc/convert-status?fingerprint={_SHA}&wait_ms=100000"
        )
    assert resp.status_code == 422


def test_ultra_fast_profile_is_independent_from_performance(tmp_path: Path) -> None:
    """Same fingerprint, different profile → independent registry rows."""
    fresh = FragmentPrebuildService()
    asyncio.run(fresh.register_inflight(_SHA, "performance"))
    asyncio.run(fresh.mark_complete(_SHA, "performance", size_bytes=99))
    with (
        patch("app.api.ifc_routes.fragment_prebuild_service", fresh),
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
    ):
        resp = _client().get(
            f"/api/ifc/convert-status?fingerprint={_SHA}&profile=ultra_fast"
        )
    assert resp.status_code == 200
    # ultra_fast has no entry - falls through to ``idle``.
    assert resp.json()["status"] == "idle"
