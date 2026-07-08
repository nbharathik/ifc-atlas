"""Tests for ``app.services.metadata_index_service``.

These tests exercise the load / cache / query pipeline using a fake
``sidecar_manager.parse`` so we don't need a live Node process. The
parser itself has its own tests in ``backend/sidecar/test/parser.test.ts``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


@pytest.fixture
def fresh_index_service(tmp_path, monkeypatch):
    """Fresh MetadataIndexService writing to an isolated temp cache dir."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    # Force config + service modules to re-import with the new DATA_DIR.
    for mod in [
        "app.services.metadata_index_service",
        "app.core.config",
    ]:
        sys.modules.pop(mod, None)

    from app.services.metadata_index_service import MetadataIndexService

    return MetadataIndexService(), tmp_path


def _fake_index(sha: str, element_count: int = 2) -> dict:
    return {
        "index_version": 1,
        "producer_version": "test-0.1.0",
        "source_sha256": sha,
        "source_bytes": 1024,
        "schema": "IFC2X3",
        "header": {
            "schema": "IFC2X3",
            "description": ["Test"],
            "implementationLevel": "2;1",
            "fileName": {
                "name": "test.ifc",
                "timeStamp": None,
                "author": [],
                "organization": [],
                "preprocessorVersion": None,
                "originatingSystem": None,
                "authorization": None,
            },
            "extras": [],
        },
        "project": {
            "id": 1,
            "global_id": "0aaaaaaaaaaaaaaaaaaaaa",
            "name": "Test Project",
            "description": None,
            "long_name": None,
            "phase": None,
        },
        "spatial": {
            "1": {"id": 1, "global_id": "0aaaaaaaaaaaaaaaaaaaaa", "type": "IFCPROJECT", "name": "Test Project", "parent_id": None, "child_ids": [4]},
            "4": {"id": 4, "global_id": "1aaaaaaaaaaaaaaaaaaaaa", "type": "IFCBUILDINGSTOREY", "name": "L1", "parent_id": 1, "child_ids": []},
        },
        "spatial_roots": [1],
        "storey_ids": [4],
        "elements": {
            "5": {"id": 5, "global_id": "2aaaaaaaaaaaaaaaaaaaaa", "type": "IFCWALL", "name": "Wall A", "description": None, "storey_id": 4, "storey_name": "L1"},
            "6": {"id": 6, "global_id": "3aaaaaaaaaaaaaaaaaaaaa", "type": "IFCDOOR", "name": "Door A", "description": None, "storey_id": 4, "storey_name": "L1"},
        },
        "by_type": {"IFCWALL": 1, "IFCDOOR": 1},
        "ids_by_type": {"IFCWALL": [5], "IFCDOOR": [6]},
        "ids_by_storey": {"4": [5, 6]},
        "id_by_global_id": {
            "2aaaaaaaaaaaaaaaaaaaaa": 5,
            "3aaaaaaaaaaaaaaaaaaaaa": 6,
        },
        "materials": ["Brick"],
        "stats": {
            "inputBytes": 1024,
            "entityCount": 6,
            "byType": {"IFCWALL": 1, "IFCDOOR": 1},
            "parseMs": 5,
            "warningCount": 0,
            "warnings": [],
            "lex_ms": 3,
            "index_ms": 2,
            "total_ms": 5,
            "storey_count": 1,
            "element_count": element_count,
        },
    }


@pytest.mark.asyncio
async def test_build_from_bytes_calls_sidecar_and_caches(fresh_index_service, monkeypatch):
    service, tmp_path = fresh_index_service
    bytes_in = b"not a real IFC, just bytes"
    fake_index = _fake_index("aabbcc")  # SHA computed from bytes_in is different
    sidecar_calls = {"count": 0}

    async def fake_parse(*_args, **_kwargs):
        sidecar_calls["count"] += 1
        # Match the sha the service computes from these bytes
        import hashlib
        sha = hashlib.sha256(bytes_in).hexdigest()
        idx = _fake_index(sha)
        return idx, {"elapsedMs": 10, "inputBytes": len(bytes_in), "indexBytes": 1000, "elementCount": 2, "storeyCount": 1}

    from app.services import metadata_index_service as mis_module
    monkeypatch.setattr(mis_module.sidecar_manager, "parse", fake_parse)

    idx, meta, cached = await service.build_from_bytes(bytes_in)
    assert cached is False
    assert sidecar_calls["count"] == 1
    assert idx.stats.element_count == 2
    assert service.is_loaded is True

    cache_path = service.cache_path(idx.source_sha256)
    assert cache_path.exists(), "index should be cached to disk"

    # Second call with same bytes hits the cache, doesn't re-call sidecar.
    idx2, meta2, cached2 = await service.build_from_bytes(bytes_in)
    assert cached2 is True
    assert sidecar_calls["count"] == 1, "sidecar should NOT be called again"
    assert idx2.source_sha256 == idx.source_sha256
    assert meta2.get("cached") is True


@pytest.mark.asyncio
async def test_force_skips_cache(fresh_index_service, monkeypatch):
    service, _ = fresh_index_service
    bytes_in = b"forced bytes"
    sidecar_calls = {"count": 0}

    async def fake_parse(*_args, **_kwargs):
        sidecar_calls["count"] += 1
        import hashlib
        sha = hashlib.sha256(bytes_in).hexdigest()
        return _fake_index(sha), {"elapsedMs": 1, "inputBytes": 1, "indexBytes": 1, "elementCount": 2, "storeyCount": 1}

    from app.services import metadata_index_service as mis_module
    monkeypatch.setattr(mis_module.sidecar_manager, "parse", fake_parse)

    await service.build_from_bytes(bytes_in)
    await service.build_from_bytes(bytes_in, force=True)
    assert sidecar_calls["count"] == 2


@pytest.mark.asyncio
async def test_query_methods(fresh_index_service, monkeypatch):
    service, _ = fresh_index_service
    bytes_in = b"query test"

    async def fake_parse(*_args, **_kwargs):
        import hashlib
        sha = hashlib.sha256(bytes_in).hexdigest()
        return _fake_index(sha), {"elapsedMs": 0, "inputBytes": 0, "indexBytes": 0, "elementCount": 2, "storeyCount": 1}

    from app.services import metadata_index_service as mis_module
    monkeypatch.setattr(mis_module.sidecar_manager, "parse", fake_parse)

    await service.build_from_bytes(bytes_in)

    storeys = service.get_storeys()
    assert len(storeys) == 1
    assert storeys[0].name == "L1"
    assert storeys[0].ifc_type == "IFCBUILDINGSTOREY"

    walls = service.get_elements_by_type("IfcWall")
    assert len(walls) == 1
    assert walls[0].name == "Wall A"

    # Type-prefix tolerance: tools may pass "Wall" or "IfcWall".
    walls2 = service.get_elements_by_type("WALL")
    assert len(walls2) == 1

    # Storey lookup with int and string keys (JSON round-trip safety).
    elems_int = service.get_elements_by_storey(4)
    assert {e.id for e in elems_int} == {5, 6}

    found = service.get_element_by_global_id("2aaaaaaaaaaaaaaaaaaaaa")
    assert found is not None
    assert found.id == 5

    stats = service.get_model_stats()
    assert stats["total_elements"] == 2
    assert stats["storeys"] == ["L1"]
    assert stats["materials"] == ["Brick"]

    # Search: case-insensitive name match.
    hits = service.search("wall a")
    assert len(hits) == 1
    assert hits[0].id == 5

    # Search by type filter.
    hits_door = service.search("", ifc_type="IFCDOOR")
    assert len(hits_door) == 1
    assert hits_door[0].name == "Door A"


@pytest.mark.asyncio
async def test_disk_cache_persists_across_service_instances(fresh_index_service, monkeypatch):
    service, tmp_path = fresh_index_service
    bytes_in = b"disk persistence"

    async def fake_parse(*_args, **_kwargs):
        import hashlib
        sha = hashlib.sha256(bytes_in).hexdigest()
        return _fake_index(sha), {"elapsedMs": 0, "inputBytes": 0, "indexBytes": 0, "elementCount": 2, "storeyCount": 1}

    from app.services import metadata_index_service as mis_module
    monkeypatch.setattr(mis_module.sidecar_manager, "parse", fake_parse)
    await service.build_from_bytes(bytes_in)

    # Spin up a fresh service pointing at the same cache dir; it should
    # not need to call the sidecar.
    from app.services.metadata_index_service import MetadataIndexService
    fresh = MetadataIndexService()

    sidecar_called = {"flag": False}

    async def fail_parse(*_args, **_kwargs):
        sidecar_called["flag"] = True
        raise AssertionError("sidecar should not be called on cache hit")

    monkeypatch.setattr(mis_module.sidecar_manager, "parse", fail_parse)

    idx, _meta, cached = await fresh.build_from_bytes(bytes_in)
    assert cached is True
    assert sidecar_called["flag"] is False
    assert idx.stats.element_count == 2
