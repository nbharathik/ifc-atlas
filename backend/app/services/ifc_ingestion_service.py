"""Application orchestration for loading one IFC source revision.

The HTTP layer owns multipart/file transport.  This service owns model-state
transition ordering, readiness broadcasts, checkpoint rebinding, background
render-artifact prebuild, metadata indexing, and AABB warm-up.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from app.models.ifc_models import ModelMeta, ModelSyncEvent
from app.services.ifc_conversion_service import IfcConversionService
from app.services.ifc_converter import ConversionProfile

logger = logging.getLogger(__name__)

BuildMeta = Callable[[bool], ModelMeta]
BroadcastReadiness = Callable[[], Awaitable[None]]
ScheduleBackground = Callable[[Awaitable[None]], None]


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


__all__ = ["IfcIngestionError", "IfcIngestionService"]
