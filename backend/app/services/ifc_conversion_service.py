"""Application orchestration for IFC-to-render-artifact conversion.

This service owns hashing, cache lookup, in-flight prebuild coordination,
converter invocation, artifact validation, and atomic publication.  FastAPI
routes only validate transport input and map this result to HTTP.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

from app.services.fragment_cache import (
    FragmentCacheEntry,
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    read_fragment_cache,
)
from app.services.fragment_prebuild_service import FragmentPrebuildService
from app.services.ifc_converter import ConversionProfile, IfcConverter

logger = logging.getLogger(__name__)

MIN_VALID_FRAGMENT_BYTES = 4 * 1024
ArtifactSource = Literal["cache", "sidecar"]


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


__all__ = [
    "ConverterUnavailableError",
    "IfcConversionError",
    "IfcConversionService",
    "InvalidRenderArtifactError",
    "MIN_VALID_FRAGMENT_BYTES",
    "RenderArtifact",
]
