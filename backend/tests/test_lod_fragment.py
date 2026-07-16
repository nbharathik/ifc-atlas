"""Tests for the LOD (decimated) fragment service + ``GET /api/ifc/lod`` route.

All tests are pure - no real sidecar spawn, no real Node decimation. The
sidecar's ``decimate`` call is mocked and the fragment cache is redirected to a
per-test ``tmp_path``. Covers:

  - cache-key helpers (``full_frag_cache_path`` / ``lod_frag_cache_path``) +
    path-traversal sanitisation (pure)
  - ``get_or_build_lod_fragment`` build / cache-hit / degrade paths (service)
  - the route's 200 (cache + fresh build), 503 (no frag / no sidecar), and
    422 (param validation) responses (FastAPI TestClient)
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app import services  # noqa: F401 - ensures package import side effects
from app.main import app
from app.services import lod_service
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    inspect_fragment_cache,
    lod_fragment_cache_entry,
    read_fragment_cache,
)

_SHA = "abcd" * 16  # 64-char hex string (SHA-256 length)
_META = {
    "inputBytes": 100,
    "outputBytes": 30,
    "trisBefore": 10,
    "trisAfter": 3,
    "elapsedMs": 5,
    "targetRatio": 0.35,
    "targetError": 0.05,
    "achievedMaxError": 0.012,
    "achievedWeightedMeanError": 0.008,
    "identityCount": 7,
    "identitySha256": "1" * 64,
    "identityVerified": True,
}


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def _write_full(tmp_path: Path, payload: bytes) -> None:
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), payload
    )


def _write_lod(
    tmp_path: Path,
    payload: bytes,
    *,
    ratio: float | None = None,
    error: float | None = None,
) -> None:
    atomic_write_fragment_cache(
        lod_fragment_cache_entry(
            tmp_path,
            _SHA,
            "balanced",
            ratio=ratio,
            error=error,
        ),
        payload,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Pure cache-key helpers
# ─────────────────────────────────────────────────────────────────────────────

def test_full_frag_cache_path(tmp_path: Path) -> None:
    with patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path):
        assert lod_service.full_frag_cache_path(_SHA, "balanced") == (
            full_fragment_cache_entry(tmp_path, _SHA, "balanced").path
        )


def test_lod_frag_cache_path_appends_lod_suffix(tmp_path: Path) -> None:
    with patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path):
        assert lod_service.lod_frag_cache_path(_SHA, "performance") == (
            lod_fragment_cache_entry(tmp_path, _SHA, "performance").path
        )


def test_lod_frag_cache_path_distinct_from_full(tmp_path: Path) -> None:
    """The LOD key must never collide with the full-frag key for the same model."""
    with patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path):
        assert lod_service.full_frag_cache_path(_SHA, "balanced") != (
            lod_service.lod_frag_cache_path(_SHA, "balanced")
        )


def test_cache_path_strips_path_traversal(tmp_path: Path) -> None:
    with patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path):
        p = lod_service.lod_frag_cache_path("../../../etc/passwd", "balanced")
    # Slashes, backslashes, and `..` are stripped; the result stays inside the dir.
    assert p.parent == tmp_path
    assert ".." not in p.name
    assert p.name.startswith("etcpasswd-balanced-lod-v2-")
    assert p.suffix == ".frag"


# ─────────────────────────────────────────────────────────────────────────────
# Service: get_or_build_lod_fragment
# ─────────────────────────────────────────────────────────────────────────────

def test_service_serves_existing_lod_cache(tmp_path: Path) -> None:
    _write_lod(tmp_path, b"CACHED_LOD")
    mock_sidecar = AsyncMock()
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        out = asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced"))
    assert out == b"CACHED_LOD"
    mock_sidecar.decimate.assert_not_called()  # served from cache, no sidecar hit


def test_service_builds_and_caches_on_first_call(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL_FRAG_BYTES")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(return_value=(b"LOD_BYTES", _META))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        out = asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced", ratio=0.3))
    assert out == b"LOD_BYTES"
    # The full frag bytes were handed to the sidecar with the ratio override.
    call = mock_sidecar.decimate.call_args
    assert call.kwargs["frag_bytes"] == b"FULL_FRAG_BYTES"
    assert call.kwargs["ratio"] == 0.3
    # Result was cached under the settings-specific LOD key.
    lod_entry = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=0.3, error=None
    )
    assert read_fragment_cache(lod_entry) == b"LOD_BYTES"
    info = inspect_fragment_cache(lod_entry)
    assert info is not None
    assert info.preprocessing["identity"] == {
        "verified": True,
        "item_count": 7,
        "sha256": "1" * 64,
    }
    assert info.preprocessing["lod"]["achieved_max_error"] == 0.012


def test_service_missing_full_frag_raises(tmp_path: Path) -> None:
    mock_sidecar = AsyncMock()
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        try:
            asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced"))
            assert False, "expected LodUnavailable"
        except lod_service.LodUnavailable as exc:
            assert "full fragment not cached" in str(exc)
    mock_sidecar.decimate.assert_not_called()


def test_service_sidecar_error_raises_lod_unavailable(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(side_effect=RuntimeError("sidecar unavailable"))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        try:
            asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced"))
            assert False, "expected LodUnavailable"
        except lod_service.LodUnavailable as exc:
            assert "decimation sidecar error" in str(exc)


def test_service_empty_lod_output_raises(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(return_value=(b"", _META))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        try:
            asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced"))
            assert False, "expected LodUnavailable"
        except lod_service.LodUnavailable as exc:
            assert "empty" in str(exc).lower()
    # An empty result must not poison the cache.
    lod_entry = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    assert not lod_entry.path.exists()
    assert not lod_entry.manifest_path.exists()


def test_service_rejects_explicit_identity_failure(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL")
    mock_sidecar = AsyncMock()
    failed_meta = {**_META, "identityVerified": False}
    mock_sidecar.decimate = AsyncMock(return_value=(b"LOD", failed_meta))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        try:
            asyncio.run(lod_service.get_or_build_lod_fragment(_SHA, "balanced"))
            assert False, "expected LodUnavailable"
        except lod_service.LodUnavailable as exc:
            assert "identity" in str(exc).lower()

    lod_entry = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    assert not lod_entry.path.exists()
    assert not lod_entry.manifest_path.exists()


# ─────────────────────────────────────────────────────────────────────────────
# Route: GET /api/ifc/lod
# ─────────────────────────────────────────────────────────────────────────────

def test_route_cache_hit_200(tmp_path: Path) -> None:
    _write_lod(tmp_path, b"CACHED_LOD_FRAG", ratio=0.35, error=0.05)
    mock_sidecar = AsyncMock()
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}")
    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "lod-cache"
    assert resp.headers["X-Fragment-Profile"] == "balanced"
    assert resp.headers["X-Fragments-Format-Version"]
    assert resp.content == b"CACHED_LOD_FRAG"
    mock_sidecar.decimate.assert_not_called()


def test_route_fresh_build_200(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL_FRAG")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(return_value=(b"FRESH_LOD", _META))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}")
    assert resp.status_code == 200
    assert resp.headers["X-Fragment-Source"] == "lod-sidecar"
    assert resp.content == b"FRESH_LOD"
    # Cached for the next request.
    lod_entry = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=0.35, error=0.05
    )
    assert read_fragment_cache(lod_entry) == b"FRESH_LOD"


def test_route_no_full_frag_503(tmp_path: Path) -> None:
    mock_sidecar = AsyncMock()
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}")
    assert resp.status_code == 503
    assert "full fragment not cached" in resp.json()["detail"]


def test_route_sidecar_unavailable_503(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(side_effect=RuntimeError("sidecar unavailable"))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}")
    assert resp.status_code == 503
    assert "decimation sidecar error" in resp.json()["detail"]


def test_route_missing_fingerprint_422() -> None:
    resp = _client().get("/api/ifc/lod")
    assert resp.status_code == 422


def test_route_bad_profile_422() -> None:
    resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}&profile=bogus")
    assert resp.status_code == 422


def test_route_ratio_out_of_range_422() -> None:
    # ratio must be within [0.05, 0.95].
    resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}&ratio=2.0")
    assert resp.status_code == 422


def test_route_ratio_and_error_forwarded(tmp_path: Path) -> None:
    _write_full(tmp_path, b"FULL")
    mock_sidecar = AsyncMock()
    mock_sidecar.decimate = AsyncMock(return_value=(b"LOD", _META))
    with (
        patch.object(lod_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(lod_service, "sidecar_manager", mock_sidecar),
    ):
        resp = _client().get(f"/api/ifc/lod?fingerprint={_SHA}&ratio=0.2&error=0.05")
    assert resp.status_code == 200
    kwargs = mock_sidecar.decimate.call_args.kwargs
    assert kwargs["ratio"] == 0.2
    assert kwargs["error"] == 0.05
