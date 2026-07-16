"""Versioned, validated, atomically-published server fragment cache.

The public HTTP API addresses fragments by IFC fingerprint and graphics
profile.  Those two values are not enough to identify a render artifact: a
sidecar upgrade, a fragments/web-ifc dependency change, or a profile-setting
change can all produce different bytes for the same IFC input.

This module keeps that additional identity behind the existing API.  Physical
filenames include a short digest of a canonical artifact descriptor, and every
``.frag`` is accompanied by a checksum manifest.  Writers publish through a
temporary file plus ``os.replace``; readers reject legacy, partial, stale, or
corrupt entries instead of passing them to the viewer.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Optional


FRAGMENT_ARTIFACT_SCHEMA_VERSION = 2
DEFAULT_LOD_RATIO = 0.35
DEFAULT_LOD_ERROR = 0.05

_DEPENDENCY_NAMES = (
    "@thatopen/components",
    "@thatopen/fragments",
    "meshoptimizer",
    "three",
    "web-ifc",
)

# Publishing the artifact and its manifest requires two atomic renames. Stripe
# writes by logical key so concurrent requests in this process cannot interleave
# those two renames and leave a mismatched pair. Cross-process interleaving is
# still safe for readers: checksum validation turns it into a cache miss rather
# than serving corrupt bytes.
_PUBLICATION_LOCKS = tuple(threading.Lock() for _ in range(64))


def safe_cache_component(value: str, *, max_length: int = 128) -> str:
    """Return a filename-safe component while preserving existing URL rules."""

    cleaned = value.replace("/", "").replace("\\", "").replace("..", "")
    cleaned = "".join(ch for ch in cleaned if ch.isalnum() or ch in ("-", "_", "."))
    return cleaned[:max_length] or "unknown"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _hash_named_files(paths: list[Path], root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda candidate: candidate.as_posix()):
        if not path.is_file():
            continue
        try:
            name = path.relative_to(root).as_posix()
        except ValueError:
            name = path.name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        digest.update(b"\0")
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


@lru_cache(maxsize=1)
def sidecar_artifact_provenance() -> dict[str, Any]:
    """Describe the converter that the backend will actually execute.

    ``SidecarManager`` prefers the bundled ``dist/index.cjs`` when present, so
    the cache identity follows the same rule.  The bundle digest captures the
    converter implementation and bundled JavaScript dependencies; the staged
    web-ifc WASM digest covers the external runtime binary.  In source mode we
    hash the conversion sources and read exact installed versions from the
    lockfile.  An environment namespace gives packagers an explicit cache-bust
    escape hatch without changing API routes.
    """

    backend_dir = Path(__file__).resolve().parents[2]
    sidecar_dir = Path(
        os.environ.get("SIDECAR_DIR", str(backend_dir / "sidecar"))
    ).resolve()
    package_json = _read_json(sidecar_dir / "package.json")
    package_lock = _read_json(sidecar_dir / "package-lock.json")
    lock_packages = package_lock.get("packages")
    if not isinstance(lock_packages, dict):
        lock_packages = {}

    dependencies: dict[str, str] = {}
    package_dependencies = package_json.get("dependencies")
    if not isinstance(package_dependencies, dict):
        package_dependencies = {}
    for name in _DEPENDENCY_NAMES:
        locked = lock_packages.get(f"node_modules/{name}")
        version = locked.get("version") if isinstance(locked, dict) else None
        if not isinstance(version, str):
            fallback = package_dependencies.get(name)
            version = fallback if isinstance(fallback, str) else "unknown"
        dependencies[name] = version

    dist_dir = sidecar_dir / "dist"
    bundle = dist_dir / "index.cjs"
    if bundle.is_file():
        runtime_files = [bundle]
        runtime_files.extend(sorted(dist_dir.glob("web-ifc*.wasm")))
        runtime_mode = "bundle"
        runtime_sha256 = _hash_named_files(runtime_files, sidecar_dir)
        # The profile implementation is embedded in the exact runtime bundle.
        profile_settings_sha256 = _sha256_file(bundle)
    else:
        source_dir = sidecar_dir / "src"
        conversion_sources = [
            source_dir / "converter.ts",
            source_dir / "profiles.ts",
            source_dir / "index.ts",
            source_dir / "decimate.ts",
            source_dir / "fragmentIdentity.ts",
            source_dir / "subset.ts",
            sidecar_dir / "package-lock.json",
        ]
        runtime_mode = "source"
        runtime_sha256 = _hash_named_files(conversion_sources, sidecar_dir)
        profiles_path = source_dir / "profiles.ts"
        profile_settings_sha256 = (
            _sha256_file(profiles_path) if profiles_path.is_file() else runtime_sha256
        )

    return {
        "name": str(package_json.get("name") or "ifc-atlas-sidecar"),
        "version": str(package_json.get("version") or "unknown"),
        "runtime_mode": runtime_mode,
        "runtime_sha256": runtime_sha256,
        "profile_settings_sha256": profile_settings_sha256,
        "dependencies": dependencies,
        "namespace": os.environ.get("IFC_FRAGMENT_CACHE_NAMESPACE", "default"),
    }


def _normalise_lod_ratio(value: Optional[float]) -> float:
    if value is None or not math.isfinite(value):
        return DEFAULT_LOD_RATIO
    return min(0.99, max(0.01, float(value)))


def _normalise_lod_error(value: Optional[float]) -> float:
    if value is None or not math.isfinite(value):
        return DEFAULT_LOD_ERROR
    return max(0.0, float(value))


@dataclass(frozen=True)
class FragmentCacheKey:
    source_fingerprint: str
    profile: str
    artifact_kind: str
    settings: Mapping[str, Any]
    provenance: Mapping[str, Any]
    digest: str

    @property
    def short_digest(self) -> str:
        return self.digest[:16]

    def descriptor(self) -> dict[str, Any]:
        return {
            "schema_version": FRAGMENT_ARTIFACT_SCHEMA_VERSION,
            "source_fingerprint": self.source_fingerprint,
            "profile": self.profile,
            "artifact_kind": self.artifact_kind,
            "settings": dict(self.settings),
            "provenance": dict(self.provenance),
        }


@dataclass(frozen=True)
class FragmentCacheEntry:
    key: FragmentCacheKey
    path: Path

    @property
    def manifest_path(self) -> Path:
        return self.path.with_name(f"{self.path.name}.manifest.json")


@dataclass(frozen=True)
class CachedFragmentInfo:
    size_bytes: int
    sha256: str
    preprocessing: Mapping[str, Any] = field(default_factory=dict)


def fragments_format_version(entry: FragmentCacheEntry) -> str:
    """Return the producing ``@thatopen/fragments`` package version."""

    dependencies = entry.key.provenance.get("dependencies")
    if not isinstance(dependencies, Mapping):
        return "unknown"
    version = dependencies.get("@thatopen/fragments")
    return version if isinstance(version, str) and version else "unknown"


def build_fragment_cache_key(
    source_fingerprint: str,
    profile: str,
    *,
    artifact_kind: str = "full",
    settings: Optional[Mapping[str, Any]] = None,
    provenance: Optional[Mapping[str, Any]] = None,
) -> FragmentCacheKey:
    """Build the complete logical key for one render artifact."""

    safe_source = safe_cache_component(source_fingerprint)
    safe_profile = safe_cache_component(profile, max_length=32)
    normalized_settings: dict[str, Any] = {
        "profile": safe_profile,
        "coordinate_to_origin": True,
    }
    if settings:
        normalized_settings.update(settings)
    actual_provenance = dict(provenance or sidecar_artifact_provenance())
    descriptor = {
        "schema_version": FRAGMENT_ARTIFACT_SCHEMA_VERSION,
        "source_fingerprint": safe_source,
        "profile": safe_profile,
        "artifact_kind": artifact_kind,
        "settings": normalized_settings,
        "provenance": actual_provenance,
    }
    digest = _sha256_bytes(_canonical_json(descriptor))
    return FragmentCacheKey(
        source_fingerprint=safe_source,
        profile=safe_profile,
        artifact_kind=artifact_kind,
        settings=normalized_settings,
        provenance=actual_provenance,
        digest=digest,
    )


def full_fragment_cache_entry(
    cache_dir: Path,
    source_fingerprint: str,
    profile: str,
) -> FragmentCacheEntry:
    key = build_fragment_cache_key(source_fingerprint, profile)
    filename = (
        f"{key.source_fingerprint}-{key.profile}-"
        f"v{FRAGMENT_ARTIFACT_SCHEMA_VERSION}-{key.short_digest}.frag"
    )
    return FragmentCacheEntry(key=key, path=cache_dir / filename)


def storey_fragment_cache_entry(
    cache_dir: Path,
    source_fingerprint: str,
    storey_index: int,
    *,
    profile: str = "balanced",
) -> FragmentCacheEntry:
    key = build_fragment_cache_key(
        source_fingerprint,
        profile,
        artifact_kind="storey",
        settings={"storey_index": int(storey_index), "subset": "ifc-storey"},
    )
    filename = (
        f"{key.source_fingerprint}-s{int(storey_index)}-"
        f"v{FRAGMENT_ARTIFACT_SCHEMA_VERSION}-{key.short_digest}.frag"
    )
    return FragmentCacheEntry(key=key, path=cache_dir / filename)


def subset_fragment_cache_entry(
    cache_dir: Path,
    source_fingerprint: str,
    profile: str,
    *,
    subset_kind: str,
    subset_id: str,
    element_ids: list[int],
) -> FragmentCacheEntry:
    """Return the cache entry for an ID-preserving spatial/storey subset."""

    normalized_ids = sorted(set(int(element_id) for element_id in element_ids))
    full_key = build_fragment_cache_key(source_fingerprint, profile)
    key = build_fragment_cache_key(
        source_fingerprint,
        profile,
        artifact_kind="spatial-subset",
        settings={
            "subset_kind": safe_cache_component(subset_kind, max_length=32),
            "subset_id": safe_cache_component(subset_id, max_length=96),
            "element_count": len(normalized_ids),
            "element_ids_sha256": _sha256_bytes(_canonical_json(normalized_ids)),
            "input_artifact_key": full_key.digest,
            "algorithm": "fragments-get-subset-buffer-v1",
            "identity_mapping": "guid-then-local-id",
        },
    )
    safe_kind = safe_cache_component(subset_kind, max_length=24)
    safe_subset_id = safe_cache_component(subset_id, max_length=48)
    filename = (
        f"{key.source_fingerprint}-{key.profile}-{safe_kind}-{safe_subset_id}-"
        f"v{FRAGMENT_ARTIFACT_SCHEMA_VERSION}-{key.short_digest}.frag"
    )
    return FragmentCacheEntry(key=key, path=cache_dir / filename)


def lod_fragment_cache_entry(
    cache_dir: Path,
    source_fingerprint: str,
    profile: str,
    *,
    ratio: Optional[float] = None,
    error: Optional[float] = None,
) -> FragmentCacheEntry:
    normalized_ratio = _normalise_lod_ratio(ratio)
    normalized_error = _normalise_lod_error(error)
    full_key = build_fragment_cache_key(source_fingerprint, profile)
    key = build_fragment_cache_key(
        source_fingerprint,
        profile,
        artifact_kind="lod",
        settings={
            "ratio": normalized_ratio,
            "error": normalized_error,
            "input_artifact_key": full_key.digest,
            "algorithm": "meshoptimizer-simplify-sloppy",
        },
    )
    filename = (
        f"{key.source_fingerprint}-{key.profile}-lod-"
        f"v{FRAGMENT_ARTIFACT_SCHEMA_VERSION}-{key.short_digest}.frag"
    )
    return FragmentCacheEntry(key=key, path=cache_dir / filename)


# Every filename this module mints ends with "-v{schema}-{digest}.frag"; the
# greedy prefix therefore captures the logical identity (source fingerprint,
# profile and, where present, the storey/subset/lod marker).
_VERSIONED_FRAGMENT_NAME = re.compile(
    r"^(?P<prefix>.+)-v(?P<schema>\d+)-(?P<digest>[0-9a-f]{8,64})\.frag$"
)


def _unlink_quietly(path: Path) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _garbage_collect_superseded(entry: FragmentCacheEntry) -> None:
    """Delete files this module minted earlier for the same logical artifact.

    Attribution is filename-based only: a sibling qualifies when it shares the
    published entry's logical prefix and carries the module's own versioned
    suffix with a different digest, or is the pre-versioned ``{prefix}.frag``
    name. Files that cannot be positively attributed are left alone, and
    deletion failures never fail the publish.
    """

    published = _VERSIONED_FRAGMENT_NAME.match(entry.path.name)
    if published is None:
        return
    prefix = published.group("prefix")
    try:
        candidates = list(entry.path.parent.glob(f"{prefix}-v*.frag"))
    except OSError:
        return
    stale = [entry.path.parent / f"{prefix}.frag"]
    for candidate in candidates:
        if candidate.name == entry.path.name:
            continue
        sibling = _VERSIONED_FRAGMENT_NAME.match(candidate.name)
        # The glob can over-match subset names whose kind segment starts with
        # "v"; the prefix comparison rejects those.
        if sibling is None or sibling.group("prefix") != prefix:
            continue
        stale.append(candidate)
    for path in stale:
        _unlink_quietly(path)
        _unlink_quietly(path.with_name(f"{path.name}.manifest.json"))


def _write_temp(path: Path, data: bytes) -> Path:
    fd, raw_path = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temp_path = Path(raw_path)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise
    return temp_path


def _manifest_payload(
    entry: FragmentCacheEntry,
    *,
    size_bytes: int,
    sha256: str,
    preprocessing: Mapping[str, Any],
) -> bytes:
    preprocessing_bytes = _canonical_json(dict(preprocessing))
    manifest = {
        "schema_version": FRAGMENT_ARTIFACT_SCHEMA_VERSION,
        "cache_key": entry.key.digest,
        "fragments_format_version": fragments_format_version(entry),
        "identity": entry.key.descriptor(),
        "artifact": {
            "filename": entry.path.name,
            "size_bytes": size_bytes,
            "sha256": sha256,
            "preprocessing": json.loads(preprocessing_bytes),
            "preprocessing_sha256": hashlib.sha256(preprocessing_bytes).hexdigest(),
        },
    }
    return _canonical_json(manifest) + b"\n"


def atomic_write_fragment_cache(
    entry: FragmentCacheEntry,
    data: bytes,
    *,
    preprocessing: Optional[Mapping[str, Any]] = None,
) -> CachedFragmentInfo:
    """Validate and atomically publish fragment bytes plus checksum manifest."""

    payload = bytes(data)
    if not payload:
        raise ValueError("fragment cache payload is empty")
    # Canonical JSON is both validation (no NaN/non-JSON values) and a deep,
    # immutable-by-convention copy of sidecar preprocessing telemetry.
    normalized_preprocessing = json.loads(
        _canonical_json(dict(preprocessing or {}))
    )
    entry.path.parent.mkdir(parents=True, exist_ok=True)
    expected_sha256 = _sha256_bytes(payload)
    lock_index = int(entry.key.digest[:8], 16) % len(_PUBLICATION_LOCKS)
    with _PUBLICATION_LOCKS[lock_index]:
        artifact_temp: Optional[Path] = None
        manifest_temp: Optional[Path] = None
        try:
            artifact_temp = _write_temp(entry.path, payload)
            if artifact_temp.stat().st_size != len(payload):
                raise OSError("temporary fragment cache file has the wrong size")
            if _sha256_file(artifact_temp) != expected_sha256:
                raise OSError("temporary fragment cache checksum mismatch")

            manifest_temp = _write_temp(
                entry.manifest_path,
                _manifest_payload(
                    entry,
                    size_bytes=len(payload),
                    sha256=expected_sha256,
                    preprocessing=normalized_preprocessing,
                ),
            )
            os.replace(artifact_temp, entry.path)
            artifact_temp = None
            os.replace(manifest_temp, entry.manifest_path)
            manifest_temp = None
        finally:
            if artifact_temp is not None:
                artifact_temp.unlink(missing_ok=True)
            if manifest_temp is not None:
                manifest_temp.unlink(missing_ok=True)

    _validated_file_digest.cache_clear()
    _garbage_collect_superseded(entry)
    return CachedFragmentInfo(
        size_bytes=len(payload),
        sha256=expected_sha256,
        preprocessing=normalized_preprocessing,
    )


def _read_matching_manifest(entry: FragmentCacheEntry) -> Optional[dict[str, Any]]:
    manifest = _read_json(entry.manifest_path)
    if not manifest:
        return None
    if manifest.get("schema_version") != FRAGMENT_ARTIFACT_SCHEMA_VERSION:
        return None
    if manifest.get("cache_key") != entry.key.digest:
        return None
    if manifest.get("fragments_format_version") != fragments_format_version(entry):
        return None
    if manifest.get("identity") != entry.key.descriptor():
        return None
    artifact = manifest.get("artifact")
    if not isinstance(artifact, dict) or artifact.get("filename") != entry.path.name:
        return None
    preprocessing = artifact.get("preprocessing", {})
    if not isinstance(preprocessing, dict):
        return None
    preprocessing_sha256 = artifact.get("preprocessing_sha256")
    if preprocessing or preprocessing_sha256 is not None:
        if not isinstance(preprocessing_sha256, str):
            return None
        try:
            actual_metadata_sha256 = hashlib.sha256(
                _canonical_json(preprocessing)
            ).hexdigest()
        except (TypeError, ValueError):
            return None
        if actual_metadata_sha256 != preprocessing_sha256:
            return None
    return artifact


def _expected_fragment_info(entry: FragmentCacheEntry) -> Optional[CachedFragmentInfo]:
    """Read validated manifest metadata without touching the artifact bytes."""

    artifact = _read_matching_manifest(entry)
    if artifact is None:
        return None
    expected_size = artifact.get("size_bytes")
    expected_sha256 = artifact.get("sha256")
    preprocessing = artifact.get("preprocessing", {})
    if not isinstance(expected_size, int) or expected_size <= 0:
        return None
    if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
        return None
    return CachedFragmentInfo(
        size_bytes=expected_size,
        sha256=expected_sha256,
        preprocessing=preprocessing,
    )


@lru_cache(maxsize=256)
def _validated_file_digest(
    path_string: str,
    size_bytes: int,
    mtime_ns: int,
) -> str:
    del size_bytes, mtime_ns
    return _sha256_file(Path(path_string))


def inspect_fragment_cache(entry: FragmentCacheEntry) -> Optional[CachedFragmentInfo]:
    """Return validated metadata, or ``None`` for stale/corrupt/partial entries."""

    expected = _expected_fragment_info(entry)
    if expected is None:
        return None
    try:
        stat = entry.path.stat()
    except OSError:
        return None
    if stat.st_size != expected.size_bytes:
        return None
    try:
        actual_sha256 = _validated_file_digest(
            str(entry.path.resolve()),
            stat.st_size,
            stat.st_mtime_ns,
        )
    except OSError:
        return None
    if actual_sha256 != expected.sha256:
        return None
    return expected


def read_fragment_cache(entry: FragmentCacheEntry) -> Optional[bytes]:
    """Read and validate a cache entry with one artifact read/checksum pass."""

    expected = _expected_fragment_info(entry)
    if expected is None:
        return None
    try:
        before = entry.path.stat()
        if before.st_size != expected.size_bytes:
            return None
        payload = entry.path.read_bytes()
        after = entry.path.stat()
    except OSError:
        return None
    if (
        before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
        or before.st_ino != after.st_ino
        or len(payload) != expected.size_bytes
        or _sha256_bytes(payload) != expected.sha256
    ):
        return None
    return payload


__all__ = [
    "CachedFragmentInfo",
    "DEFAULT_LOD_ERROR",
    "DEFAULT_LOD_RATIO",
    "FRAGMENT_ARTIFACT_SCHEMA_VERSION",
    "FragmentCacheEntry",
    "FragmentCacheKey",
    "atomic_write_fragment_cache",
    "build_fragment_cache_key",
    "full_fragment_cache_entry",
    "fragments_format_version",
    "inspect_fragment_cache",
    "lod_fragment_cache_entry",
    "read_fragment_cache",
    "safe_cache_component",
    "sidecar_artifact_provenance",
    "storey_fragment_cache_entry",
    "subset_fragment_cache_entry",
]
