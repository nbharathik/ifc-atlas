"""Application orchestration for loading one IFC source revision.

The HTTP layer owns multipart/file transport.  This service owns model-state
transition ordering, readiness broadcasts, checkpoint rebinding, background
render-artifact prebuild, metadata indexing, and AABB warm-up.

It also hosts the two layers underneath the ingestion flow:

* The application-owned IFC conversion boundary (:class:`IfcConverter`,
  :class:`WebIfcSidecarConverter`). The active adapter delegates to the
  existing web-ifc Node sidecar. Routes use this contract so a future
  benchmark candidate can be substituted without changing upload, cache, job,
  or renderer-facing code.
* The IFC-to-render-artifact conversion workflow
  (:class:`IfcConversionService`), which owns hashing, cache lookup, in-flight
  prebuild coordination, converter invocation, artifact validation, and atomic
  publication. FastAPI routes only validate transport input and map its result
  to HTTP.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping, Optional, Protocol

from app.models.ifc_models import ModelMeta, ModelSyncEvent
from app.services.fragment_cache import (
    FragmentCacheEntry,
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    read_fragment_cache,
)
from app.services.fragment_prebuild_service import FragmentPrebuildService

logger = logging.getLogger(__name__)

BuildMeta = Callable[[bool], ModelMeta]
BroadcastReadiness = Callable[[], Awaitable[None]]
ScheduleBackground = Callable[[Awaitable[None]], None]

ConversionProfile = Literal["quality", "balanced", "performance", "ultra_fast"]

MIN_VALID_FRAGMENT_BYTES = 4 * 1024
ArtifactSource = Literal["cache", "sidecar"]


@dataclass(frozen=True)
class ConversionResult:
    data: bytes
    metadata: Mapping[str, Any]


class IfcConverter(Protocol):
    engine: str

    async def capabilities(self) -> Mapping[str, Any]:
        """Return availability and supported runtime features."""

    async def convert(
        self,
        *,
        ifc_bytes: bytes,
        profile: ConversionProfile,
        model_id: str,
    ) -> ConversionResult:
        """Convert immutable IFC bytes into one render artifact."""


class WebIfcSidecarConverter:
    """Thin adapter around the current sidecar manager."""

    engine = "web-ifc"

    def __init__(self, manager: Any) -> None:
        self._manager = manager

    async def capabilities(self) -> Mapping[str, Any]:
        return await self._manager.capabilities()

    async def convert(
        self,
        *,
        ifc_bytes: bytes,
        profile: ConversionProfile,
        model_id: str,
    ) -> ConversionResult:
        data, metadata = await self._manager.convert(
            ifc_bytes=ifc_bytes,
            profile=profile,
            model_id=model_id,
        )
        return ConversionResult(data=bytes(data), metadata=dict(metadata))


class IfcConversionError(RuntimeError):
    """Base error raised by the application conversion workflow."""


class ConverterUnavailableError(IfcConversionError):
    """The configured converter could not complete the request."""


class InvalidRenderArtifactError(IfcConversionError):
    """The converter returned an artifact that is unsafe to publish."""


@dataclass(frozen=True)
class RenderArtifact:
    data: bytes
    source: ArtifactSource
    source_sha256: str
    requested_profile: ConversionProfile
    effective_profile: str
    cache_entry: FragmentCacheEntry
    elapsed_ms: Optional[int | float | str] = None
    converter_metadata: Optional[dict[str, Any]] = None


class IfcConversionService:
    """Coordinate one IFC conversion without depending on HTTP primitives."""

    def __init__(
        self,
        *,
        cache_dir: Path,
        converter: IfcConverter,
        prebuild_service: FragmentPrebuildService,
        clear_progress: Callable[[str], None] = lambda _model_id: None,
        prebuild_wait_s: float = 30.0,
    ) -> None:
        self._cache_dir = cache_dir
        self._converter = converter
        self._prebuild_service = prebuild_service
        self._clear_progress = clear_progress
        self._prebuild_wait_s = max(0.0, prebuild_wait_s)

    async def convert(
        self,
        *,
        ifc_bytes: bytes,
        profile: ConversionProfile,
        model_id: str,
        no_cache: bool = False,
    ) -> RenderArtifact:
        started = time.perf_counter()
        source_sha = await asyncio.to_thread(
            lambda: hashlib.sha256(ifc_bytes).hexdigest()
        )
        logger.info(
            "IFC convert request: sha=%s profile=%s model_id=%s input=%.2fMB",
            source_sha[:12],
            profile,
            model_id,
            len(ifc_bytes) / (1024 * 1024),
        )
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        cache_entry = full_fragment_cache_entry(
            self._cache_dir,
            source_sha,
            profile,
        )

        if no_cache:
            logger.info(
                "IFC convert no_cache=1: sha=%s profile=%s; bypassing cache and prebuild reuse",
                source_sha[:12],
                profile,
            )
        else:
            cached = await asyncio.to_thread(read_fragment_cache, cache_entry)
            if cached is not None:
                return self._cached_artifact(
                    data=cached,
                    source_sha=source_sha,
                    profile=profile,
                    cache_entry=cache_entry,
                    started=started,
                )

            prebuild_report = self._prebuild_service.get_status(
                source_sha,
                profile,
            )
            if prebuild_report.status == "inflight":
                logger.info(
                    "IFC convert waiting for inflight prebuild: sha=%s profile=%s",
                    source_sha[:12],
                    profile,
                )
                prebuild_report = await self._prebuild_service.wait_for(
                    source_sha,
                    profile,
                    timeout_s=self._prebuild_wait_s,
                )
                cached = await asyncio.to_thread(
                    read_fragment_cache,
                    cache_entry,
                )
                if cached is not None:
                    return self._cached_artifact(
                        data=cached,
                        source_sha=source_sha,
                        profile=profile,
                        cache_entry=cache_entry,
                        started=started,
                        elapsed_ms=prebuild_report.elapsed_ms or 0,
                    )

            await self._prebuild_service.register_inflight(source_sha, profile)

        try:
            logger.info(
                "IFC convert engine start: engine=%s sha=%s profile=%s model_id=%s",
                self._converter.engine,
                source_sha[:12],
                profile,
                model_id,
            )
            converted = await self._converter.convert(
                ifc_bytes=ifc_bytes,
                profile=profile,
                model_id=model_id,
            )
        except RuntimeError as exc:
            if not no_cache:
                await self._prebuild_service.mark_failed(
                    source_sha,
                    profile,
                    error=str(exc),
                )
            raise ConverterUnavailableError(str(exc)) from exc

        fragment_bytes = converted.data
        metadata = dict(converted.metadata)
        if len(fragment_bytes) < MIN_VALID_FRAGMENT_BYTES:
            message = (
                "converter produced suspiciously small fragment "
                f"({len(fragment_bytes)} B from {len(ifc_bytes)} B IFC); "
                "likely an empty conversion artifact"
            )
            logger.warning(message)
            if not no_cache:
                await self._prebuild_service.mark_failed(
                    source_sha,
                    profile,
                    error=message,
                )
            raise InvalidRenderArtifactError(message)

        cache_persisted = False
        cache_write_error: Optional[str] = None
        if not no_cache:
            try:
                await asyncio.to_thread(
                    atomic_write_fragment_cache,
                    cache_entry,
                    fragment_bytes,
                )
                cache_persisted = True
            except (OSError, ValueError) as exc:
                cache_write_error = str(exc)
                logger.warning(
                    "Failed to persist fragment cache at %s: %s",
                    cache_entry.path,
                    exc,
                )

            if cache_persisted:
                await self._prebuild_service.mark_complete(
                    source_sha,
                    profile,
                    size_bytes=len(fragment_bytes),
                )
            else:
                await self._prebuild_service.mark_failed(
                    source_sha,
                    profile,
                    error=cache_write_error
                    or "fragment cache publication failed",
                )

        logger.info(
            "IFC convert engine done: engine=%s sha=%s profile=%s output=%.2fMB "
            "converter_ms=%s total_ms=%.1f",
            self._converter.engine,
            source_sha[:12],
            profile,
            len(fragment_bytes) / (1024 * 1024),
            metadata.get("elapsedMs", 0),
            (time.perf_counter() - started) * 1000,
        )
        self._clear_progress(model_id)
        effective_profile = str(metadata.get("effectiveProfile") or profile)
        return RenderArtifact(
            data=fragment_bytes,
            source="sidecar",
            source_sha256=source_sha,
            requested_profile=profile,
            effective_profile=effective_profile,
            cache_entry=cache_entry,
            elapsed_ms=metadata.get("elapsedMs", 0),
            converter_metadata=metadata,
        )

    @staticmethod
    def _cached_artifact(
        *,
        data: bytes,
        source_sha: str,
        profile: ConversionProfile,
        cache_entry: FragmentCacheEntry,
        started: float,
        elapsed_ms: Optional[int | float | str] = None,
    ) -> RenderArtifact:
        logger.info(
            "IFC convert cache hit: sha=%s profile=%s size=%.2fMB elapsed_ms=%.1f",
            source_sha[:12],
            profile,
            len(data) / (1024 * 1024),
            (time.perf_counter() - started) * 1000,
        )
        return RenderArtifact(
            data=data,
            source="cache",
            source_sha256=source_sha,
            requested_profile=profile,
            effective_profile=profile,
            cache_entry=cache_entry,
            elapsed_ms=elapsed_ms,
        )


class IfcIngestionError(RuntimeError):
    """The staged IFC source could not become the active semantic model."""


def _schedule_background(operation: Awaitable[None]) -> None:
    asyncio.create_task(operation)


class IfcIngestionService:
    """Coordinate one staged IFC file into the current application model."""

    def __init__(
        self,
        *,
        ifc_service: Any,
        metadata_index_service: Any,
        readiness_service: Any,
        checkpoint_service: Any,
        conversion_service: IfcConversionService,
        model_sync_broker: Any,
        aabb_service: Any,
        broadcast_readiness: BroadcastReadiness,
        build_meta: BuildMeta,
        snapshot_upload: Callable[[str], None],
        schedule_background: ScheduleBackground = _schedule_background,
    ) -> None:
        self._ifc_service = ifc_service
        self._metadata_index_service = metadata_index_service
        self._readiness_service = readiness_service
        self._checkpoint_service = checkpoint_service
        self._conversion_service = conversion_service
        self._model_sync_broker = model_sync_broker
        self._aabb_service = aabb_service
        self._broadcast_readiness = broadcast_readiness
        self._build_meta = build_meta
        self._snapshot_upload = snapshot_upload
        self._schedule_background = schedule_background

    async def ingest(
        self,
        *,
        path: Path,
        source_sha256: str,
        source_name: str,
        include_tree_stats: bool,
        prebuild_fragments: bool,
        prebuild_profile: ConversionProfile,
    ) -> ModelMeta:
        started = time.perf_counter()
        self._prepare_metadata_index(source_sha256)

        self._readiness_service.reset(model_id=source_name)
        self._readiness_service.mark_ifcopenshell_warming()
        await self._broadcast_readiness()

        try:
            logger.info(
                "IFC ingest: starting IfcOpenShell load filename=%s",
                source_name,
            )
            await asyncio.to_thread(self._ifc_service.load, path)
        except Exception as exc:
            self._readiness_service.mark_ifcopenshell_error(str(exc))
            await self._broadcast_readiness()
            raise IfcIngestionError(str(exc)) from exc

        self._readiness_service.mark_ifcopenshell_ready()
        await self._broadcast_readiness()
        logger.info(
            "IFC ingest: IfcOpenShell ready filename=%s elapsed_ms=%.1f",
            source_name,
            (time.perf_counter() - started) * 1000,
        )

        # The current IfcService remains the documented single-model adapter.
        # Capture the model object now so a later upload cannot redirect this
        # ingestion's AABB warm-up to the wrong in-memory model.
        loaded_model = self._ifc_service.model
        self._checkpoint_service.rebind(
            self._ifc_service.original_fingerprint or source_name
        )
        self._snapshot_upload(source_name)

        self._schedule_background(
            self._warm_derived_data(
                path=path,
                source_sha256=source_sha256,
                loaded_model=loaded_model,
                prebuild_fragments=prebuild_fragments,
                prebuild_profile=prebuild_profile,
            )
        )

        meta = self._build_meta(include_tree_stats)
        await self._model_sync_broker.publish(
            ModelSyncEvent(
                type="metadata_patch",
                model_version=meta.model_version,
                model_fingerprint=meta.model_fingerprint,
                edit_id=meta.edit_id,
                payload={
                    "bootstrap": True,
                    "has_tree": meta.tree is not None,
                    "has_stats": meta.stats is not None,
                },
            )
        )
        return meta

    def _prepare_metadata_index(self, source_sha256: str) -> None:
        if self._metadata_index_service.current_sha == source_sha256:
            return
        self._metadata_index_service.unload()
        self._metadata_index_service.hydrate_from_disk(source_sha256)

    async def _warm_derived_data(
        self,
        *,
        path: Path,
        source_sha256: str,
        loaded_model: Any,
        prebuild_fragments: bool,
        prebuild_profile: ConversionProfile,
    ) -> None:
        raw_bytes = await asyncio.to_thread(path.read_bytes)

        if prebuild_fragments:
            try:
                artifact = await self._conversion_service.convert(
                    ifc_bytes=raw_bytes,
                    profile=prebuild_profile,
                    model_id=f"{source_sha256[:12]}-{prebuild_profile}",
                )
                logger.info(
                    "IFC ingest: render artifact warm source=%s sha=%s "
                    "profile=%s size=%s B",
                    artifact.source,
                    source_sha256[:12],
                    prebuild_profile,
                    len(artifact.data),
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "IFC ingest: render artifact prebuild failed "
                    "(profile=%s): %s",
                    prebuild_profile,
                    exc,
                )
        else:
            logger.info(
                "IFC ingest: fragment prebuild disabled sha=%s",
                source_sha256[:12],
            )

        self._readiness_service.mark_native_index_building()
        await self._broadcast_readiness()
        try:
            index, _, _ = await self._metadata_index_service.build_from_bytes(
                raw_bytes
            )
            self._readiness_service.mark_native_index_ready(
                total_ms=index.stats.total_ms
            )
            await self._broadcast_readiness()
            contract = self._ifc_service.get_model_contract()
            await self._model_sync_broker.publish(
                ModelSyncEvent(
                    type="native_index_ready",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    payload={
                        "element_count": index.stats.element_count,
                        "storey_count": index.stats.storey_count,
                        "pset_count": len(index.all_pset_names),
                        "total_ms": index.stats.total_ms,
                    },
                )
            )
        except Exception as exc:  # noqa: BLE001
            self._readiness_service.mark_native_index_error(str(exc))
            await self._broadcast_readiness()
            logger.warning("IFC ingest: native metadata parse skipped: %s", exc)

        try:
            await self._aabb_service.compute_async(loaded_model, source_sha256)
        except Exception as exc:  # noqa: BLE001
            logger.warning("IFC ingest: AABB warm-up failed: %s", exc)


__all__ = [
    "ConversionProfile",
    "ConversionResult",
    "ConverterUnavailableError",
    "IfcConversionError",
    "IfcConversionService",
    "IfcConverter",
    "IfcIngestionError",
    "IfcIngestionService",
    "InvalidRenderArtifactError",
    "MIN_VALID_FRAGMENT_BYTES",
    "RenderArtifact",
    "WebIfcSidecarConverter",
]
