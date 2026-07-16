"""Versioning, validation, and publication tests for the fragment cache."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.services import fragment_cache
from app.services.fragment_cache import (
    FRAGMENT_ARTIFACT_SCHEMA_VERSION,
    atomic_write_fragment_cache,
    build_fragment_cache_key,
    fragments_format_version,
    full_fragment_cache_entry,
    inspect_fragment_cache,
    lod_fragment_cache_entry,
    read_fragment_cache,
    storey_fragment_cache_entry,
    subset_fragment_cache_entry,
)


_SHA = "abcd" * 16
_PROVENANCE = {
    "name": "test-sidecar",
    "version": "1.2.3",
    "runtime_mode": "bundle",
    "runtime_sha256": "1" * 64,
    "profile_settings_sha256": "2" * 64,
    "dependencies": {"web-ifc": "0.0.77", "three": "0.182.0"},
    "namespace": "test",
}


def test_cache_key_is_canonical_across_mapping_order() -> None:
    key_a = build_fragment_cache_key(
        _SHA,
        "balanced",
        settings={"z": 1, "nested": {"b": 2, "a": 1}},
        provenance=_PROVENANCE,
    )
    reordered_provenance = {
        "namespace": "test",
        "dependencies": {"three": "0.182.0", "web-ifc": "0.0.77"},
        "profile_settings_sha256": "2" * 64,
        "runtime_sha256": "1" * 64,
        "runtime_mode": "bundle",
        "version": "1.2.3",
        "name": "test-sidecar",
    }
    key_b = build_fragment_cache_key(
        _SHA,
        "balanced",
        settings={"nested": {"a": 1, "b": 2}, "z": 1},
        provenance=reordered_provenance,
    )

    assert key_a.digest == key_b.digest


def test_cache_key_versions_source_profile_converter_dependencies_and_settings() -> None:
    base = build_fragment_cache_key(
        _SHA,
        "balanced",
        settings={"detail": 1},
        provenance=_PROVENANCE,
    )
    changed_runtime = {**_PROVENANCE, "runtime_sha256": "3" * 64}
    changed_dependencies = {
        **_PROVENANCE,
        "dependencies": {"web-ifc": "0.0.78", "three": "0.182.0"},
    }
    variants = {
        build_fragment_cache_key(
            "ef01" * 16,
            "balanced",
            settings={"detail": 1},
            provenance=_PROVENANCE,
        ).digest,
        build_fragment_cache_key(
            _SHA,
            "performance",
            settings={"detail": 1},
            provenance=_PROVENANCE,
        ).digest,
        build_fragment_cache_key(
            _SHA,
            "balanced",
            settings={"detail": 1},
            provenance=changed_runtime,
        ).digest,
        build_fragment_cache_key(
            _SHA,
            "balanced",
            settings={"detail": 1},
            provenance=changed_dependencies,
        ).digest,
        build_fragment_cache_key(
            _SHA,
            "balanced",
            settings={"detail": 2},
            provenance=_PROVENANCE,
        ).digest,
    }

    assert base.digest not in variants
    assert len(variants) == 5


def test_entry_names_include_schema_and_logical_variant(tmp_path: Path) -> None:
    full = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    storey = storey_fragment_cache_entry(tmp_path, _SHA, 4)
    lod = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    marker = f"-v{FRAGMENT_ARTIFACT_SCHEMA_VERSION}-"

    assert marker in full.path.name
    assert "-s4-" in storey.path.name and marker in storey.path.name
    assert "-balanced-lod-" in lod.path.name and marker in lod.path.name
    assert len({full.path, storey.path, lod.path}) == 3


def test_spatial_subset_key_tracks_membership_and_full_artifact(tmp_path: Path) -> None:
    first = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[3, 1, 2],
    )
    same = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[2, 3, 1, 1],
    )
    changed = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[1, 2, 4],
    )

    assert first.path == same.path
    assert first.path != changed.path
    assert first.key.settings["input_artifact_key"] == full_fragment_cache_entry(
        tmp_path, _SHA, "balanced"
    ).key.digest


def test_lod_settings_are_normalized_and_version_each_variant(tmp_path: Path) -> None:
    default = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    explicit_default = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=0.35, error=0.05
    )
    non_finite_default = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=float("nan"), error=float("inf")
    )
    lower_clamped = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=-2.0, error=-1.0
    )
    lower_explicit = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=0.01, error=0.0
    )
    alternate = lod_fragment_cache_entry(
        tmp_path, _SHA, "balanced", ratio=0.2, error=0.05
    )

    assert default.path == explicit_default.path == non_finite_default.path
    assert lower_clamped.path == lower_explicit.path
    assert alternate.path != default.path


def test_atomic_write_round_trip_publishes_valid_manifest(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    info = atomic_write_fragment_cache(entry, b"fragment-bytes")

    assert entry.path.read_bytes() == b"fragment-bytes"
    assert entry.manifest_path.is_file()
    assert inspect_fragment_cache(entry) == info
    assert read_fragment_cache(entry) == b"fragment-bytes"
    assert not list(tmp_path.glob("*.tmp"))

    manifest = json.loads(entry.manifest_path.read_text(encoding="utf-8"))
    assert manifest["schema_version"] == FRAGMENT_ARTIFACT_SCHEMA_VERSION
    assert manifest["cache_key"] == entry.key.digest
    assert manifest["fragments_format_version"] == fragments_format_version(entry)
    assert manifest["artifact"]["filename"] == entry.path.name


def test_preprocessing_metadata_is_checksummed_and_round_trips(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    preprocessing = {
        "pipeline": "test-preprocess-v1",
        "identity": {"verified": True, "item_count": 42},
        "lod": {"achieved_max_error": 0.0125},
    }

    written = atomic_write_fragment_cache(
        entry,
        b"fragment-bytes",
        preprocessing=preprocessing,
    )
    inspected = inspect_fragment_cache(entry)

    assert written.preprocessing == preprocessing
    assert inspected is not None
    assert inspected.preprocessing == preprocessing
    manifest = json.loads(entry.manifest_path.read_text(encoding="utf-8"))
    assert manifest["artifact"]["preprocessing"] == preprocessing
    assert len(manifest["artifact"]["preprocessing_sha256"]) == 64


def test_corrupt_preprocessing_metadata_rejects_cache_entry(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(
        entry,
        b"fragment-bytes",
        preprocessing={"identity": {"verified": True}},
    )
    manifest = json.loads(entry.manifest_path.read_text(encoding="utf-8"))
    manifest["artifact"]["preprocessing"]["identity"]["verified"] = False
    entry.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert inspect_fragment_cache(entry) is None
    assert read_fragment_cache(entry) is None


def test_read_hashes_artifact_once_without_inspection_pass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(entry, b"fragment-bytes")
    real_sha256_bytes = fragment_cache._sha256_bytes
    calls = 0

    def _counted_sha256(data: bytes) -> str:
        nonlocal calls
        calls += 1
        return real_sha256_bytes(data)

    monkeypatch.setattr(fragment_cache, "_sha256_bytes", _counted_sha256)
    monkeypatch.setattr(
        fragment_cache,
        "_validated_file_digest",
        lambda *_args: pytest.fail("read path must not perform an inspection digest"),
    )

    assert read_fragment_cache(entry) == b"fragment-bytes"
    assert calls == 1


def test_unmanifested_and_legacy_files_are_cache_misses(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    entry.path.write_bytes(b"partial-new-entry")
    (tmp_path / f"{_SHA}-balanced.frag").write_bytes(b"legacy-entry")

    assert inspect_fragment_cache(entry) is None
    assert read_fragment_cache(entry) is None


@pytest.mark.parametrize("replacement", [b"short", b"tampered-bytes"])
def test_artifact_corruption_is_rejected(tmp_path: Path, replacement: bytes) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(entry, b"original-bytes")

    entry.path.write_bytes(replacement)

    assert inspect_fragment_cache(entry) is None
    assert read_fragment_cache(entry) is None


def test_manifest_identity_corruption_is_rejected(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(entry, b"fragment-bytes")
    manifest = json.loads(entry.manifest_path.read_text(encoding="utf-8"))
    manifest["identity"]["settings"]["coordinate_to_origin"] = False
    entry.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert inspect_fragment_cache(entry) is None
    assert read_fragment_cache(entry) is None


def test_empty_write_does_not_replace_existing_entry(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(entry, b"existing")

    with pytest.raises(ValueError, match="empty"):
        atomic_write_fragment_cache(entry, b"")

    assert read_fragment_cache(entry) == b"existing"


def _pin_provenance(
    monkeypatch: pytest.MonkeyPatch, provenance: dict[str, object]
) -> None:
    monkeypatch.setattr(
        fragment_cache, "sidecar_artifact_provenance", lambda: dict(provenance)
    )


def test_publish_removes_superseded_sibling_and_legacy_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_provenance(monkeypatch, _PROVENANCE)
    old_entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(old_entry, b"old-bytes")
    legacy = tmp_path / f"{_SHA}-balanced.frag"
    legacy.write_bytes(b"legacy-bytes")

    _pin_provenance(monkeypatch, {**_PROVENANCE, "runtime_sha256": "3" * 64})
    new_entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    assert new_entry.path != old_entry.path
    atomic_write_fragment_cache(new_entry, b"new-bytes")

    assert not old_entry.path.exists()
    assert not old_entry.manifest_path.exists()
    assert not legacy.exists()
    assert read_fragment_cache(new_entry) == b"new-bytes"


def test_publish_gc_spares_unrelated_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_provenance(monkeypatch, _PROVENANCE)
    unrelated = [
        full_fragment_cache_entry(tmp_path, "ef01" * 16, "balanced"),
        full_fragment_cache_entry(tmp_path, _SHA, "performance"),
        storey_fragment_cache_entry(tmp_path, _SHA, 4),
        lod_fragment_cache_entry(tmp_path, _SHA, "balanced"),
        subset_fragment_cache_entry(
            tmp_path,
            _SHA,
            "balanced",
            subset_kind="tile-g2",
            subset_id="0-0-0",
            element_ids=[1, 2],
        ),
    ]
    for entry in unrelated:
        atomic_write_fragment_cache(entry, b"unrelated-bytes")

    _pin_provenance(monkeypatch, {**_PROVENANCE, "runtime_sha256": "3" * 64})
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"new-bytes"
    )

    for entry in unrelated:
        assert read_fragment_cache(entry) == b"unrelated-bytes"


def test_publish_gc_scopes_to_matching_subset_and_lod_markers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_provenance(monkeypatch, _PROVENANCE)
    old_subset = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[1, 2],
    )
    other_tile = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-1-1",
        element_ids=[1, 2],
    )
    old_lod = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    old_storey = storey_fragment_cache_entry(tmp_path, _SHA, 4)
    other_storey = storey_fragment_cache_entry(tmp_path, _SHA, 5)
    for entry in (old_subset, other_tile, old_lod, old_storey, other_storey):
        atomic_write_fragment_cache(entry, b"old-bytes")

    _pin_provenance(monkeypatch, {**_PROVENANCE, "runtime_sha256": "3" * 64})
    new_subset = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[1, 2],
    )
    atomic_write_fragment_cache(new_subset, b"new-bytes")
    new_lod = lod_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(new_lod, b"new-bytes")
    new_storey = storey_fragment_cache_entry(tmp_path, _SHA, 4)
    atomic_write_fragment_cache(new_storey, b"new-bytes")

    assert not old_subset.path.exists()
    assert not old_lod.path.exists()
    assert not old_storey.path.exists()
    assert read_fragment_cache(other_tile) == b"old-bytes"
    assert read_fragment_cache(other_storey) == b"old-bytes"
    assert read_fragment_cache(new_subset) == b"new-bytes"
    assert read_fragment_cache(new_lod) == b"new-bytes"
    assert read_fragment_cache(new_storey) == b"new-bytes"


def test_publish_succeeds_when_gc_deletion_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _pin_provenance(monkeypatch, _PROVENANCE)
    old_entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    atomic_write_fragment_cache(old_entry, b"old-bytes")

    _pin_provenance(monkeypatch, {**_PROVENANCE, "runtime_sha256": "3" * 64})
    new_entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")

    def _deny_remove(path: object) -> None:
        raise PermissionError(f"locked: {path}")

    monkeypatch.setattr(fragment_cache.os, "remove", _deny_remove)
    info = atomic_write_fragment_cache(new_entry, b"new-bytes")

    assert info.size_bytes == len(b"new-bytes")
    assert read_fragment_cache(new_entry) == b"new-bytes"
    assert old_entry.path.exists()


def test_concurrent_publishers_leave_a_self_consistent_entry(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, _SHA, "balanced")
    payloads = [f"payload-{index}".encode() for index in range(16)]

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda payload: atomic_write_fragment_cache(entry, payload), payloads))

    final = read_fragment_cache(entry)
    assert final in payloads
    assert inspect_fragment_cache(entry) is not None
    assert not list(tmp_path.glob("*.tmp"))
