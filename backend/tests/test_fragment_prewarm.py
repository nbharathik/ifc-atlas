"""Post-edit fragment cache prewarm (plan A5-lite) - safety + trigger tests.

The prewarm makes the viewer's post-geometry-edit reload a fast cache hit
instead of a full reconvert. It MUST be best-effort: never raise, never block,
and never run for metadata-only edits.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.api import ifc_routes
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    read_fragment_cache,
)


def _fake_svc(fingerprint="abc123def", data=b"ISO-10303-21;" + b"x" * 100):
    return SimpleNamespace(
        model_fingerprint=fingerprint,
        read_bytes=lambda: data,
    )


def test_prewarm_noop_without_fingerprint(monkeypatch, tmp_path):
    monkeypatch.setattr(ifc_routes, "ifc_service", _fake_svc(fingerprint=""))
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)
    # No running loop, no fingerprint → returns cleanly, schedules nothing.
    ifc_routes._prewarm_fragments_after_geometry_edit()


def test_prewarm_noop_without_bytes(monkeypatch, tmp_path):
    svc = SimpleNamespace(model_fingerprint="fp", read_bytes=lambda: None)
    monkeypatch.setattr(ifc_routes, "ifc_service", svc)
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)
    ifc_routes._prewarm_fragments_after_geometry_edit()


def test_prewarm_skips_when_cache_already_warm(monkeypatch, tmp_path):
    fp = "warmfp"
    cache_entry = full_fragment_cache_entry(tmp_path, fp, ifc_routes._PREWARM_PROFILE)
    atomic_write_fragment_cache(cache_entry, b"cached")
    monkeypatch.setattr(ifc_routes, "ifc_service", _fake_svc(fingerprint=fp))
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)
    sidecar = MagicMock()
    sidecar.convert = AsyncMock()
    monkeypatch.setattr(ifc_routes, "sidecar_manager", sidecar)
    ifc_routes._prewarm_fragments_after_geometry_edit()
    sidecar.convert.assert_not_called()


def test_prewarm_never_raises_on_broken_service(monkeypatch, tmp_path):
    class Broken:
        @property
        def model_fingerprint(self):
            raise RuntimeError("boom")

    monkeypatch.setattr(ifc_routes, "ifc_service", Broken())
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)
    ifc_routes._prewarm_fragments_after_geometry_edit()  # must not raise


@pytest.mark.asyncio
async def test_prewarm_converts_and_caches_when_scheduled(monkeypatch, tmp_path):
    fp = "livefp"
    monkeypatch.setattr(ifc_routes, "ifc_service", _fake_svc(fingerprint=fp))
    monkeypatch.setattr(ifc_routes, "FRAGMENT_CACHE_DIR", tmp_path)

    sidecar = MagicMock()
    sidecar.convert = AsyncMock(return_value=(b"F" * 8192, {}))
    monkeypatch.setattr(ifc_routes, "sidecar_manager", sidecar)

    pbs = MagicMock()
    pbs.get_status.return_value = SimpleNamespace(status="idle")
    pbs.register_inflight = AsyncMock()
    pbs.mark_complete = AsyncMock()
    pbs.mark_failed = AsyncMock()
    monkeypatch.setattr(ifc_routes, "fragment_prebuild_service", pbs)

    import asyncio

    ifc_routes._prewarm_fragments_after_geometry_edit()
    # Let the fire-and-forget task run.
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    sidecar.convert.assert_awaited_once()
    cache_entry = full_fragment_cache_entry(tmp_path, fp, ifc_routes._PREWARM_PROFILE)
    assert read_fragment_cache(cache_entry) == b"F" * 8192
    pbs.mark_complete.assert_awaited()
