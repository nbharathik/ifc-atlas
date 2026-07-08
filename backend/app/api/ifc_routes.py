"""FastAPI routes for IFC upload, fragment conversion, model query, and inline edit.

Read endpoints call the global ``ifc_service`` synchronously (IfcOpenShell is CPU-bound
and not thread-safe); only the upload/warm load runs off-thread. The edit-apply path is
serialized via the module-level lock.
"""

import asyncio
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger(__name__)

# Serialize concurrent /apply calls so two staged edits cannot
# race the IfcOpenShell model mutation + sync-event broadcast pair. The
# second concurrent caller gets a structured 409 "edit_in_progress"
# response so the client can show a toast + auto-retry.
_apply_lock: asyncio.Lock = asyncio.Lock()

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse

from app.core.config import FRAGMENT_CACHE_DIR, MAX_IFC_UPLOAD_BYTES, UPLOAD_DIR
from app.models.ifc_models import (
    AABBBulkRequest,
    AABBBulkResponse,
    AABBCacheStatus,
    AABBResponse,
    AggregateRequest,
    AggregateResult,
    CheckpointDiffResult,
    CheckpointStatus,
    EditApplyRequest,
    EditApplyResponse,
    ElementDetail,
    ElementSummary,
    IFCCheckpoint,
    ModelMeta,
    ModelStats,
    ModelSyncEvent,
    PendingEditEnvelope,
    ProjectInfo,
    ReadinessStatus,
    ReadinessTimingsModel,
    SearchResult,
    SpatialNode,
    TileInfo,
    TileManifest,
)
from app.services.aabb_service import aabb_service
from app.services.frag_delta_service import frag_delta_service
from app.services.fragment_prebuild_service import fragment_prebuild_service
from app.services.ids_service import (
    IDS_ENGINE,
    extract_failing_ids,
    parse_ids_info,
    validate_ids_base64,
    validate_ids_base64_to_csv,
)
from app.services.ifc_checkpoint_service import ifc_checkpoint_service
from app.services.ifc_service import ifc_service
from app.services.lod_service import (
    LodUnavailable,
    get_or_build_lod_fragment,
    lod_frag_cache_path,
)
from app.services.metadata_index_service import metadata_index_service
from app.services.model_health import run_health_check
from app.services.readiness_service import broadcast_readiness_changed, readiness_service
from app.services.model_sync import model_sync_broker
from app.services.patch_generator import patch_generator
from app.services.sandbox_service import sandbox_service
from app.services.sidecar_manager import sidecar_manager
from app.services.spatial_tile_splitter import spatial_tile_splitter
from app.services.storey_splitter import storey_splitter

from app.models.metadata_index_models import NativeParseResponse

router = APIRouter(prefix="/api/ifc", tags=["ifc"])

_IFC_UPLOAD_CHUNK_BYTES = 1024 * 1024


def _format_upload_cap(size_bytes: int) -> str:
    if size_bytes <= 0:
        return "unlimited"
    mb = size_bytes / (1024 * 1024)
    return f"{mb:.0f} MB" if mb >= 1 else f"{size_bytes} B"


def _validate_ifc_upload_filename(filename: str | None) -> str:
    if not filename or Path(filename).suffix.lower() != ".ifc":
        raise HTTPException(400, "Only .ifc files are accepted")

    safe_name = Path(filename).name
    if not safe_name or safe_name.startswith("."):
        raise HTTPException(400, "Invalid filename")
    return safe_name


def _enforce_ifc_upload_size(size_bytes: int) -> None:
    if size_bytes <= 0:
        raise HTTPException(400, "Empty file body")
    if MAX_IFC_UPLOAD_BYTES > 0 and size_bytes > MAX_IFC_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"IFC file too large (max {_format_upload_cap(MAX_IFC_UPLOAD_BYTES)}).",
        )


def _copy_ifc_upload_to_disk(file: UploadFile, dest: Path) -> int:
    total = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = file.file.read(_IFC_UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                total += len(chunk)
                if MAX_IFC_UPLOAD_BYTES > 0 and total > MAX_IFC_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"IFC file too large (max {_format_upload_cap(MAX_IFC_UPLOAD_BYTES)}).",
                    )
                out.write(chunk)
    except HTTPException:
        dest.unlink(missing_ok=True)
        raise
    _enforce_ifc_upload_size(total)
    return total


async def _read_ifc_upload_bytes(file: UploadFile) -> bytes:
    _validate_ifc_upload_filename(file.filename)
    raw = await file.read()
    _enforce_ifc_upload_size(len(raw))
    return raw


def _sha256_file(path: Path) -> str:
    """Streaming SHA-256 of a file on disk (no whole-file allocation)."""
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_IFC_UPLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _build_meta(include_tree_stats: bool = True) -> ModelMeta:
    """Assemble the combined meta payload from service caches."""
    contract = ifc_service.get_model_contract()
    return ModelMeta(
        project=ifc_service.get_project_info(),
        tree=ifc_service.get_spatial_tree() if include_tree_stats else None,
        stats=ifc_service.get_model_stats() if include_tree_stats else None,
        model_version=contract["model_version"],
        model_fingerprint=contract["model_fingerprint"],
        edit_id=contract["edit_id"],
    )


@router.post("/upload", response_model=ModelMeta)
async def upload_ifc(
    file: UploadFile = File(...),
    response: Literal["minimal", "full"] = Query(
        "full",
        description="minimal returns project + version contract; full also includes tree + stats.",
    ),
    prebuild_fragments: bool = Query(
        True,
        description=(
            "Eagerly warm the on-disk fragment cache after the upload "
            "completes. Set to false when the client has disabled the server "
            "fragment cache (`useServerCache=false`) - the prebuild output "
            "would never be reused and only steals CPU from interactive "
            "operations on the just-loaded model."
        ),
    ),
    prebuild_profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query(
        "balanced",
        description=(
            "Conversion profile for the eager prebuild. Must match the "
            "profile the viewer requests from POST /convert, otherwise the "
            "prebuild warms a cache entry nobody reads and the viewer's own "
            "conversion runs the sidecar a second time."
        ),
    ),
):
    """Parse an uploaded IFC and return model metadata."""
    upload_started = time.perf_counter()
    safe_name = _validate_ifc_upload_filename(file.filename)
    dest = UPLOAD_DIR / safe_name
    size_bytes = _copy_ifc_upload_to_disk(file, dest)
    logger.info(
        "IFC upload received filename=%s size=%.2fMB response=%s",
        safe_name,
        size_bytes / (1024 * 1024),
        response,
    )

    # Fingerprint the upload once, off the event loop. Reused by the stale
    # index check below, the fragment prebuild cache key, and the AABB cache
    # (a second whole-file hash used to run synchronously on the event loop
    # after the load).
    source_sha = await asyncio.to_thread(_sha256_file, dest)

    # Swap out the previous model's metadata index BEFORE readiness is
    # broadcast: the stale index would otherwise keep answering
    # GET /native-index and the Ask-mode tool gate with the old model's data
    # for the whole load window (readiness reconciles against the loaded
    # index, so it would also keep reporting "ready" for the wrong model).
    # Same-file re-uploads keep their index; a disk-cached index for the new
    # file is restored instantly instead of waiting for the background parse.
    if metadata_index_service.current_sha != source_sha:
        metadata_index_service.unload()
        metadata_index_service.hydrate_from_disk(source_sha)

    # Reset the readiness state machine for the new model BEFORE the
    # sync ifcopenshell load runs; the chip flips to "warming" immediately so
    # users see the assistant is initialising, not silent.
    # Each transition is broadcast over the model-sync WS so the
    # chat-panel chip never has to poll.
    readiness_service.reset(model_id=safe_name)
    readiness_service.mark_ifcopenshell_warming()
    await broadcast_readiness_changed()

    # ``ifc_service.load`` calls into IfcOpenShell which is CPU-bound + blocking.
    # Running it directly on the FastAPI event loop locks every other request
    # (readiness polls, fragment serves, chat WS keep-alives) for the entire
    # load - 30 s to 5 min on real-world models. Offload to a worker thread so
    # the event loop stays responsive: the viewer can keep streaming fragments
    # from cache while the semantic backend warms up in the background.
    import asyncio as _asyncio_thread
    try:
        logger.info("IFC upload: starting IfcOpenShell load filename=%s", safe_name)
        await _asyncio_thread.to_thread(ifc_service.load, dest)
    except Exception as e:
        readiness_service.mark_ifcopenshell_error(str(e))
        await broadcast_readiness_changed()
        dest.unlink(missing_ok=True)
        raise HTTPException(400, f"Failed to load IFC file: {e}")

    readiness_service.mark_ifcopenshell_ready()
    await broadcast_readiness_changed()
    logger.info(
        "IFC upload: IfcOpenShell ready filename=%s elapsed_ms=%.1f",
        safe_name,
        (time.perf_counter() - upload_started) * 1000,
    )

    # Reset checkpoint history and snapshot the initial uploaded state.
    ifc_checkpoint_service.reset()
    _snapshot_after_upload(safe_name)

    # Fire-and-forget background tasks on upload.
    # Both tasks are non-fatal: if the sidecar is down they log a warning
    # and the existing IfcOpenShell + browser-WASM path still works.
    import asyncio as _asyncio

    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if prebuild_fragments:
        prebuild_cache_path = FRAGMENT_CACHE_DIR / f"{source_sha}-{prebuild_profile}.frag"
        if prebuild_cache_path.exists():
            await fragment_prebuild_service.mark_complete(
                source_sha, prebuild_profile, size_bytes=prebuild_cache_path.stat().st_size
            )
        # A cold cache is registered inflight by the background task itself,
        # right before it starts converting. Registering it here as well made
        # the task (and any concurrent POST /convert for the same file) wait
        # out a long timeout on an entry that nobody was actually converting.
    else:
        logger.info(
            "IFC upload: skipping background fragment prebuild (client opted out of server cache) sha=%s",
            source_sha[:12],
        )

    async def _bg_tasks(path: "Path", source_sha: str) -> None:
        raw_bytes = path.read_bytes()
        # Eager fragment pre-conversion warms the on-disk cache for the
        # profile the viewer actually loads with (prebuild_profile, sent by
        # the client; balanced is the production default). Skipped entirely
        # when prebuild_fragments=False - the client said it will not consume
        # the server fragment cache, so pre-warming would just steal CPU from
        # interactive operations on the just-loaded model.
        if prebuild_fragments:
            FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            for profile in (prebuild_profile,):
                cache_path = FRAGMENT_CACHE_DIR / f"{source_sha}-{profile}.frag"
                if cache_path.exists():
                    await fragment_prebuild_service.mark_complete(
                        source_sha, profile, size_bytes=cache_path.stat().st_size
                    )
                    continue
                # Dedupe: if the viewer kicked off /convert for this same SHA
                # already, wait for it instead of running the sidecar twice.
                existing = fragment_prebuild_service.get_status(source_sha, profile)
                if existing.status == "inflight":
                    logger.info(
                        "Fragment prebuild already inflight for sha=%s - waiting for /convert to finish",
                        source_sha[:12],
                    )
                    final = await fragment_prebuild_service.wait_for(
                        source_sha, profile, timeout_s=120.0
                    )
                    if final.status == "complete" and cache_path.exists():
                        continue
                    # Inflight task failed or timed out - fall through and retry.
                await fragment_prebuild_service.register_inflight(source_sha, profile)
                try:
                    frag_bytes, _ = await sidecar_manager.convert(
                        ifc_bytes=raw_bytes,
                        profile=profile,
                        model_id=f"{source_sha[:12]}-{profile}",
                    )
                    # Same empty-fragment guard as POST /convert - refuse to cache
                    # suspicious stubs.
                    if len(frag_bytes) < 4 * 1024:
                        msg = (
                            f"sidecar produced empty fragment ({len(frag_bytes)} B) "
                            f"for {len(raw_bytes)} B IFC; skipping cache write"
                        )
                        logger.warning(msg)
                        await fragment_prebuild_service.mark_failed(source_sha, profile, error=msg)
                        continue
                    cache_path.write_bytes(frag_bytes)
                    await fragment_prebuild_service.mark_complete(
                        source_sha, profile, size_bytes=len(frag_bytes)
                    )
                    logger.info(
                        "Fragment pre-converted: sha=%s profile=%s size=%s B",
                        source_sha[:12], profile, len(frag_bytes),
                    )
                except Exception as exc:  # noqa: BLE001
                    await fragment_prebuild_service.mark_failed(
                        source_sha, profile, error=str(exc)
                    )
                    logger.warning("Fragment pre-conversion failed (profile=%s): %s", profile, exc)

        # Native metadata parse (Ask-mode, tree, properties, psets).
        readiness_service.mark_native_index_building()
        await broadcast_readiness_changed()
        try:
            index, _, _ = await metadata_index_service.build_from_bytes(raw_bytes)
            readiness_service.mark_native_index_ready(total_ms=index.stats.total_ms)
            await broadcast_readiness_changed()
            # Broadcast the ready event so the frontend can update its status.
            contract = ifc_service.get_model_contract()
            await model_sync_broker.publish(
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
            readiness_service.mark_native_index_error(str(exc))
            await broadcast_readiness_changed()
            logger.warning("Native metadata parse skipped: %s", exc)

        # Warm the real-AABB cache in the background so the tile manifest
        # (and frustum culling) get real geometry AABBs the moment the user
        # starts panning. Disk-cached → instant on warm.
        try:
            await aabb_service.compute_async(ifc_service.model, source_sha)
        except Exception as exc:  # noqa: BLE001
            logger.warning("AABB warm-up failed: %s", exc)

    _asyncio.ensure_future(_bg_tasks(dest, source_sha))

    include_tree_stats = response == "full"
    meta = _build_meta(include_tree_stats=include_tree_stats)
    await model_sync_broker.publish(
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


@router.post("/native-parse", response_model=NativeParseResponse)
async def native_parse(
    file: UploadFile = File(...),
    force: bool = Query(
        False,
        description="Skip the on-disk cache and re-parse via the sidecar.",
    ),
):
    """Parse an IFC file with the native (TypeScript sidecar) parser.

    Returns a read-only `MetadataIndex` covering schema, header, project,
    spatial tree, element catalog, type histogram, and materials. The
    response is suitable for Ask-mode chat queries - no IfcOpenShell
    required.

    This path is roughly 30x faster than the IfcOpenShell load path on the
    50 MB BasicHouse sample (~1.6 s vs ~50 s+) and the result is cached
    by SHA-256 so re-uploads are instant.
    """
    raw = await _read_ifc_upload_bytes(file)

    try:
        index, sidecar_meta, cached = await metadata_index_service.build_from_bytes(
            raw, force=force
        )
    except RuntimeError as exc:
        raise HTTPException(503, f"native parser unavailable: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 - surface unexpected failure
        logger.exception("native parse failed")
        raise HTTPException(500, f"native parse failed: {exc}") from exc

    return NativeParseResponse(cached=cached, sidecar_meta=sidecar_meta, index=index)


@router.post("/geometry")
async def extract_geometry(
    file: UploadFile = File(...),
):
    """Extract preview mesh geometry via the native parser sidecar.

    Returns per-element meshes (Float32 positions + Uint32 indices, base64-
    encoded) for elements whose geometry is an IfcExtrudedAreaSolid. The
    frontend uses these to render preview meshes immediately - before the
    slow @thatopen/fragments conversion is done - eliminating the blank-screen
    wait on large IFC files.

    Coverage: ~40-80 % of elements depending on model complexity
    (rectangle/polyline profiles). Furniture/windows/doors may be absent;
    they continue loading via the normal path in parallel.

    Response shape:
      { meshCount, attempted, skipped, geoElapsedMs, totalElapsedMs,
        meshes: [{expressId, ifcType, name, positions(b64), indices(b64), bbox}] }
    """
    raw = await _read_ifc_upload_bytes(file)

    try:
        result, sidecar_meta = await sidecar_manager.geometry(raw, model_id="geometry-api")
    except RuntimeError as exc:
        raise HTTPException(503, f"geometry sidecar unavailable: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("geometry extraction failed")
        raise HTTPException(500, f"geometry extraction failed: {exc}") from exc

    return result


@router.post(
    "/geometry/stream",
    summary="Stream preview mesh batches as NDJSON",
    response_class=StreamingResponse,
)
async def stream_geometry(
    file: UploadFile = File(...),
    batch_size: int = Query(
        100,
        ge=1,
        le=1000,
        alias="batchSize",
        description="Meshes per NDJSON batch. Smaller = faster first-paint, more overhead.",
    ),
    model_id: str = Query(
        "geometry-stream-api",
        alias="modelId",
        description="Opaque caller tag, mirrored back in stream events for client correlation.",
    ),
):
    """Chunked NDJSON streaming of preview meshes.

    Same input as ``POST /geometry``, but the response is
    ``application/x-ndjson`` over HTTP chunked transfer. The frontend
    receives mesh batches as they are produced rather than waiting for
    the full conversion to finish - first triangle on screen scales with
    ``batchSize × per-element-cost`` instead of total model size.

    **Event shapes** (one JSON object per line, terminated with ``\\n``):

    * ``{"type": "start", "modelId": ..., "batchSize": N}``
    * ``{"type": "batch", "batchIndex": N, "meshes": [...]}``
    * ``{"type": "summary", "meshCount": X, "attempted": Y, "skipped": Z,
      "batchCount": B, "geoElapsedMs": G, "totalElapsedMs": T}``
    * ``{"type": "error", "message": "..."}`` (terminal - no further events)

    Each ``meshes[]`` entry has the same shape as the non-streaming
    ``/geometry`` response (base64-encoded ``positions`` and ``indices``,
    plus ``expressId``, ``ifcType``, ``name``, ``bbox``).

    The event contract is fixed so consumers can be written against it.
    """
    raw = await _read_ifc_upload_bytes(file)

    try:
        sidecar_manager.ensure_running()
    except Exception as exc:  # noqa: BLE001 - surface 503 cleanly
        raise HTTPException(503, f"geometry sidecar unavailable: {exc}") from exc

    async def _ndjson_iter():
        try:
            async for event in sidecar_manager.geometry_stream(
                raw,
                model_id=model_id,
                batch_size=batch_size,
            ):
                yield (json.dumps(event, separators=(",", ":")) + "\n").encode("utf-8")
        except RuntimeError as exc:
            # Sidecar disappeared mid-stream. Headers are already sent →
            # we can only emit a terminal error event on the wire.
            err = {"type": "error", "message": str(exc)}
            yield (json.dumps(err, separators=(",", ":")) + "\n").encode("utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.exception("geometry stream failed")
            err = {"type": "error", "message": f"geometry stream failed: {exc}"}
            yield (json.dumps(err, separators=(",", ":")) + "\n").encode("utf-8")

    return StreamingResponse(
        _ndjson_iter(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Geometry-Batch-Size": str(batch_size),
        },
    )


@router.post("/warm-from-cache", response_model=ModelMeta, summary="Reload a previously-uploaded IFC from disk")
async def warm_from_cache(
    fingerprint: str = Query(..., description="SHA-256 of the IFC to find in uploads/"),
):
    """Re-warm the backend's IfcOpenShell handle from a previously-uploaded
    IFC file. Used by the viewer's cached-load path when the user reloads
    the page (or the backend restarted) and the model is served from the
    fragment cache, but the semantic backend has nothing loaded.

    Searches the uploads directory (``~/.ifc-atlas/uploads/``) for a file
    whose SHA-256 matches the requested fingerprint. Loads it on a worker
    thread so the event loop stays responsive. Returns the model meta on
    success.

    404 when no matching IFC exists on disk - the frontend should fall
    back to re-uploading the bytes via ``POST /api/ifc/upload``.
    """
    import asyncio as _asyncio_warm

    safe_fp = fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128].lower()

    # Already loaded with the same fingerprint? Idempotent fast-path - skip
    # the disk scan and re-load entirely.
    if ifc_service.is_loaded:
        try:
            current = ifc_service.get_model_contract().get("model_fingerprint")
        except Exception:
            current = None
        if current and current.lower() == safe_fp:
            return _build_meta(include_tree_stats=True)

    def _find_matching_file() -> Optional[Path]:
        if not UPLOAD_DIR.exists():
            return None
        for ifc_path in sorted(UPLOAD_DIR.glob("*.ifc"), key=lambda p: -p.stat().st_mtime):
            try:
                sha = hashlib.sha256(ifc_path.read_bytes()).hexdigest()
            except OSError:
                continue
            if sha == safe_fp:
                return ifc_path
        return None

    matched = await _asyncio_warm.to_thread(_find_matching_file)
    if matched is None:
        raise HTTPException(
            404,
            f"No IFC on disk matches fingerprint {safe_fp[:16]}…. Re-upload the file.",
        )

    # Same blocking-load → thread offload pattern as POST /upload.
    readiness_service.reset(model_id=matched.name)
    readiness_service.mark_ifcopenshell_warming()
    # The warm path never rebuilds the metadata index, so a stale index from
    # a previously-loaded model must be swapped for this model's disk-cached
    # one (or dropped) before readiness is broadcast - the readiness snapshot
    # reconciles against whatever index is loaded and would otherwise report
    # the old model's index as ready for the rest of the session.
    if metadata_index_service.current_sha != safe_fp:
        metadata_index_service.unload()
        metadata_index_service.hydrate_from_disk(safe_fp)
    await broadcast_readiness_changed()

    try:
        await _asyncio_warm.to_thread(ifc_service.load, matched)
    except Exception as e:
        readiness_service.mark_ifcopenshell_error(str(e))
        await broadcast_readiness_changed()
        raise HTTPException(500, f"Failed to load cached IFC: {e}")

    readiness_service.mark_ifcopenshell_ready()
    await broadcast_readiness_changed()

    ifc_checkpoint_service.reset()
    _snapshot_after_upload(matched.name)

    meta = _build_meta(include_tree_stats=True)
    await model_sync_broker.publish(
        ModelSyncEvent(
            type="metadata_patch",
            model_version=meta.model_version,
            model_fingerprint=meta.model_fingerprint,
            edit_id=meta.edit_id,
            payload={
                "bootstrap": True,
                "from_cache": True,
                "filename": matched.name,
            },
        )
    )
    return meta


@router.get("/readiness", response_model=ReadinessStatus, summary="AI backend readiness")
async def get_readiness() -> ReadinessStatus:
    """Return warm-up state of the two AI backends.

    * ``native_index`` - metadata index built by the sidecar
      on upload (Ask-mode tools depend on it).
    * ``ifcopenshell`` - semantic backend used by tier-2/3 (deep / edit)
      tools. The chat-panel chip uses this field to show a "warming"
      pulse on first upload and unmount once it reads ``ready``.

    Available for polling until ``ifcopenshell === "ready"``; transitions
    are also pushed as ``readiness_changed`` WS events.
    """
    snap = readiness_service.get_state()
    return ReadinessStatus(
        model_id=snap.model_id,
        native_index=snap.native_index,
        ifcopenshell=snap.ifcopenshell,
        timings_ms=ReadinessTimingsModel(
            native_index_built_ms=snap.timings_ms.native_index_built_ms,
            ifcopenshell_loaded_ms=snap.timings_ms.ifcopenshell_loaded_ms,
        ),
        native_index_error=snap.native_index_error,
        ifcopenshell_error=snap.ifcopenshell_error,
    )


@router.get("/native-index")
async def get_native_index(
    fingerprint: Optional[str] = Query(
        None,
        description="Optional SHA-256 the caller expects. When it does not "
        "match the currently-loaded index, the response reports "
        "``status='mismatch'`` (with ``index=null``) instead of handing back "
        "the wrong model's index.",
    ),
):
    """Serve the full, already-cached metadata index for the current model.

    This is the read-path that lets the **frontend** consume the metadata the
    sidecar already produced on upload (spatial tree, elements, property sets,
    materials, GlobalId↔ExpressId map) INSTEAD of running its own redundant
    web-ifc parse in a browser worker. It is a cheap in-memory serve - no
    IfcOpenShell call, no re-parse, no sidecar round-trip.

    Returns a status envelope:

    * ``{"status": "ready", "sha256": ..., "index": ...}`` - the index is
      available; ``index`` is the full ``MetadataIndex`` (``by_alias=True``
      so ``schema`` keeps its JSON spelling). The caller composes
      ``index.id_by_global_id`` with the FragmentsModel's localId↔GlobalId
      table to bridge ids, and reads ``element_psets`` for
      properties-on-click.
    * ``{"status": "pending", "sha256": null, "index": null}`` - no index is
      loaded yet (the background parse is still running). Poll again.
    * ``{"status": "mismatch", "sha256": <loaded sha>, "index": null}`` - an
      index is loaded but belongs to a different model than the requested
      ``fingerprint``. Poll again; the background parse for the requested
      model replaces it when finished.

    The transient states are deliberately 200s rather than errors: they are
    normal polling outcomes during the upload→parse window, and non-2xx
    responses are auto-logged by browsers on every poll.

    NOTE: the index reflects the *pristine uploaded* model. After an edit, the
    caller invalidates the changed express-ids and falls back to the
    authoritative ``GET /elements/{id}`` (IfcOpenShell) for those - so this
    route never needs to be rebuilt mid-session.
    """
    if not metadata_index_service.is_loaded:
        return {"status": "pending", "sha256": None, "index": None}
    idx = metadata_index_service.current
    assert idx is not None
    sha = metadata_index_service.current_sha
    if fingerprint and sha and fingerprint != sha:
        return {"status": "mismatch", "sha256": sha, "index": None}
    return {"status": "ready", "sha256": sha, "index": idx.model_dump(by_alias=True)}


@router.get("/meta", response_model=ModelMeta)
async def get_meta(
    response: Literal["minimal", "full"] = Query(
        "full",
        description="minimal returns project + version contract; full also includes tree + stats.",
    ),
):
    """Return model metadata for the currently-loaded model."""
    _check_loaded()
    return _build_meta(include_tree_stats=response == "full")


@router.post("/edits/apply", response_model=EditApplyResponse)
async def apply_edits(request: EditApplyRequest):
    _check_loaded()
    result = ifc_service.apply_edits(request)

    if result.status == "accepted":
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="edit_accepted",
                model_version=result.model_version,
                model_fingerprint=result.model_fingerprint,
                edit_id=result.edit_id,
                payload={
                    "changed_express_ids": result.changed_express_ids,
                    "requires_rebuild": result.requires_rebuild,
                    "message": result.message,
                },
            )
        )
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="metadata_patch",
                model_version=result.model_version,
                model_fingerprint=result.model_fingerprint,
                edit_id=result.edit_id,
                payload=result.metadata_patch.model_dump(),
            )
        )
        if result.changed_express_ids:
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="geometry_patch",
                    model_version=result.model_version,
                    model_fingerprint=result.model_fingerprint,
                    edit_id=result.edit_id,
                    payload={"changed_express_ids": result.changed_express_ids},
                )
            )
        if result.requires_rebuild:
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="rebuild_started",
                    model_version=result.model_version,
                    model_fingerprint=result.model_fingerprint,
                    edit_id=result.edit_id,
                    payload={"reason": result.message or "complex edit fallback"},
                )
            )
            # Placeholder for async rebuild worker integration.
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="rebuild_ready",
                    model_version=result.model_version,
                    model_fingerprint=result.model_fingerprint,
                    edit_id=result.edit_id,
                    payload={"status": "ready_for_hot_swap"},
                )
            )
    else:
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="edit_rejected",
                model_version=result.model_version,
                model_fingerprint=result.model_fingerprint,
                edit_id=result.edit_id,
                payload={"message": result.message or "edit rejected"},
            )
        )

    return result


@router.get("/edits/pending", response_model=list[PendingEditEnvelope])
async def list_pending_edits():
    """List all sandboxed pending edits awaiting Apply/Discard."""
    _check_loaded()
    return sandbox_service.list_pending()


@router.get("/edits/pending/{edit_id}", response_model=PendingEditEnvelope)
async def get_pending_edit(edit_id: str):
    _check_loaded()
    envelope = sandbox_service.get_pending(edit_id)
    if envelope is None:
        raise HTTPException(404, f"Pending edit {edit_id} not found")
    return envelope


@router.post("/edits/pending/{edit_id}/apply", response_model=PendingEditEnvelope)
async def apply_pending_edit(edit_id: str):
    """Promote a sandbox to the live model. Fires tiered sync events.

    Serialised: if another /apply is already in flight, this
    call returns HTTP 409 with ``{detail: {status: "edit_in_progress",
    retry_after_ms: 1500}}`` so the client can show a transient toast
    + auto-retry on the next ``pending_applied`` WS event (or after the
    retry timeout, whichever fires first).
    """
    _check_loaded()
    if _apply_lock.locked():
        raise HTTPException(
            status_code=409,
            detail={
                "status": "edit_in_progress",
                "message": (
                    "A previous edit is still being applied to the model. "
                    "Retrying in a moment..."
                ),
                "edit_id": edit_id,
                "retry_after_ms": 1500,
            },
        )
    async with _apply_lock:
        return await _apply_pending_edit_locked(edit_id)


async def _apply_pending_edit_locked(edit_id: str) -> PendingEditEnvelope:
    """Body of /apply, executed under ``_apply_lock``.

    Split into its own coroutine purely to keep the locked region clean;
    every WS broadcast + IfcOpenShell mutation in here is
    serialised against any other /apply call.
    """
    try:
        envelope = sandbox_service.apply_pending(
            edit_id=edit_id, ifc_service=ifc_service
        )
    except ValueError as e:
        raise HTTPException(409, str(e))

    contract = ifc_service.get_model_contract()
    counts = envelope.counts or {}
    has_geometry = bool(counts.get("deleted", 0) or counts.get("created", 0) or counts.get("retyped", 0))

    await model_sync_broker.publish(
        ModelSyncEvent(
            type="pending_applied",
            model_version=contract["model_version"],
            model_fingerprint=contract["model_fingerprint"],
            edit_id=envelope.edit_id,
            payload={
                "summary": envelope.summary,
                "counts": envelope.counts,
            },
        )
    )

    # Emit the typed ifc_patch event.
    # Runs alongside the legacy metadata_patch / rebuild_started events;
    # both are live during the migration window so existing consumers
    # keep working while new consumers switch to ifc_patch.
    if envelope.changes:
        patch_batch = patch_generator.generate(
            envelope.changes,
            source_sha256=contract["model_fingerprint"],
            actor="agent",
            agent_id=None,
            edit_id=envelope.edit_id,
        )
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="ifc_patch",
                model_version=contract["model_version"],
                model_fingerprint=contract["model_fingerprint"],
                edit_id=envelope.edit_id,
                payload={"patches": [p.model_dump() for p in patch_batch.patches]},
            )
        )

    # Pick the cheapest sync tier per Invariant 5.
    # Only metadata → metadata_patch; any geometry churn → bootstrap reload.
    if has_geometry:
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="rebuild_started",
                model_version=contract["model_version"],
                model_fingerprint=contract["model_fingerprint"],
                edit_id=envelope.edit_id,
                payload={"reason": "sandbox geometry change"},
            )
        )
    else:
        changed_ids = [c.express_id for c in envelope.changes]
        updated_elements = []
        for cid in changed_ids:
            try:
                entity = ifc_service.model.by_id(cid)
            except RuntimeError:
                continue
            if entity is None or entity.is_a("IfcOpeningElement"):
                continue
            if not hasattr(entity, "GlobalId"):
                continue
            updated_elements.append(ifc_service._entity_to_summary(entity).model_dump())  # noqa: SLF001

        await model_sync_broker.publish(
            ModelSyncEvent(
                type="metadata_patch",
                model_version=contract["model_version"],
                model_fingerprint=contract["model_fingerprint"],
                edit_id=envelope.edit_id,
                payload={
                    "updated_elements": updated_elements,
                    "removed_element_ids": [
                        c.express_id for c in envelope.changes if c.change == "deleted"
                    ],
                    "touched_storeys": [],
                    "stats_delta": {},
                },
            )
        )

    # Register the applied edit so the frag-delta endpoint can
    # serve geometry patches for any element_ids the patch referenced.
    # Best-effort; failure here must not break the apply.
    try:
        applied_ids = sorted({c.express_id for c in envelope.changes})
        if applied_ids:
            frag_delta_service.register(
                edit_id=envelope.edit_id,
                express_ids=applied_ids,
                model_fingerprint=contract["model_fingerprint"],
            )
    except Exception:
        logger.exception("Failed to register frag-delta record")

    # Git snapshot - fire-and-forget; failure must not break the edit flow.
    _snapshot_after_edit(envelope.summary or f"edit {envelope.edit_id[:8]}")

    return envelope


@router.get("/frag-delta/{edit_id}")
async def get_frag_delta(edit_id: str):
    """Geometry patch endpoint.

    Returns ``{representations: {<expressId>: <RawRepresentation>}}`` for
    the elements touched by the named applied edit. The frontend's
    ``fragmentDeltaLoader`` consumes this to apply per-element geometry
    updates via ``Editor.edit()`` instead of triggering a full reload.

    **v1.0 scope** - the route returns the correct shape but with an
    empty ``representations`` map. The frontend loader iterates, finds
    no matching repData per express id, and returns ``updatedCount=0``;
    the existing ``rebuild_started`` full-reload path then takes over.

    **v1.1** will populate the ``representations`` map with
    @thatopen/fragments-compatible ``RawRepresentation`` blobs built
    from the live IfcOpenShell geometry - at which point edits update
    in-place under 100 ms instead of triggering the multi-second
    reload.
    """
    record = frag_delta_service.get(edit_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"No frag-delta record for edit {edit_id} - it may have been "
                f"evicted from the recent-edits cache or never existed."
            ),
        )
    # v1.0 - empty representations map. v1.1 will fill this in.
    return {
        "edit_id": record.edit_id,
        "express_ids": record.express_ids,
        "model_fingerprint": record.model_fingerprint,
        "representations": {},
    }


def _snapshot_after_edit(message: str) -> None:
    """Write current IFC bytes as a git checkpoint (best-effort)."""
    try:
        ifc_bytes = ifc_service.read_bytes()
        if ifc_bytes is None:
            return
        ifc_checkpoint_service.snapshot(ifc_bytes, message)
    except Exception:
        logger.exception("Git snapshot after edit failed")


def _snapshot_after_upload(filename: str) -> None:
    """Snapshot the freshly-uploaded model as the baseline checkpoint."""
    try:
        ifc_bytes = ifc_service.read_bytes()
        if ifc_bytes is None:
            return
        ifc_checkpoint_service.snapshot(ifc_bytes, f"Baseline: {filename}")
    except Exception:
        logger.exception("Git baseline snapshot after upload failed")


@router.post("/edits/pending/{edit_id}/discard", response_model=PendingEditEnvelope)
async def discard_pending_edit(edit_id: str):
    _check_loaded()
    try:
        envelope = sandbox_service.discard_pending(edit_id)
    except ValueError as e:
        raise HTTPException(404, str(e))

    contract = ifc_service.get_model_contract()
    await model_sync_broker.publish(
        ModelSyncEvent(
            type="pending_discarded",
            model_version=contract["model_version"],
            model_fingerprint=contract["model_fingerprint"],
            edit_id=envelope.edit_id,
            payload={"summary": envelope.summary},
        )
    )
    return envelope


@router.post("/undo")
async def undo_last_edit():
    """Revert the most recently applied committed edit.

    Pops the top entry off the service undo stack and emits a
    ``metadata_changed`` sync event so open viewer sessions update live.
    Returns ``{"undone": false}`` (200) when the stack is already empty.
    """
    _check_loaded()
    result = ifc_service.undo_last_edit()
    if result.get("undone"):
        contract = ifc_service.get_model_contract()
        await model_sync_broker.publish(
            ModelSyncEvent(
                type="metadata_changed",
                model_version=contract["model_version"],
                model_fingerprint=contract["model_fingerprint"],
                edit_id=result.get("reverted_edit_id", ""),
                payload={
                    "changed_ids": result.get("changed_ids", []),
                    "description": result.get("description", ""),
                    "issues": result.get("issues", []),
                },
            )
        )
    return result


@router.get("/edit-history")
async def get_edit_history():
    """Return the committed edit history (newest first, without inverse ops)."""
    _check_loaded()
    return ifc_service.get_edit_history()


@router.websocket("/sync/ws")
async def model_sync_ws(websocket: WebSocket):
    await websocket.accept()
    queue = await model_sync_broker.subscribe()
    try:
        if ifc_service.is_loaded:
            contract = ifc_service.get_model_contract()
            await websocket.send_json(
                ModelSyncEvent(
                    type="metadata_patch",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=contract["edit_id"],
                    payload={"bootstrap": True},
                ).model_dump()
            )
        while True:
            event = await queue.get()
            await websocket.send_json(event.model_dump())
    except WebSocketDisconnect:
        pass
    finally:
        await model_sync_broker.unsubscribe(queue)


@router.get("/project", response_model=ProjectInfo)
async def get_project():
    _check_loaded()
    return ifc_service.get_project_info()


@router.get("/tree", response_model=SpatialNode)
async def get_spatial_tree():
    _check_loaded()
    return ifc_service.get_spatial_tree()


@router.get("/elements", response_model=list[ElementSummary])
async def get_elements(
    ifc_type: Optional[str] = Query(None),
    storey_id: Optional[int] = Query(None),
):
    _check_loaded()
    if storey_id is not None:
        return ifc_service.get_elements_by_storey(storey_id)
    if ifc_type:
        return ifc_service.get_elements_by_type(ifc_type)
    return ifc_service.get_all_elements()


@router.get("/elements/{element_id}", response_model=ElementDetail)
async def get_element(element_id: int):
    _check_loaded()
    try:
        return ifc_service.get_element(element_id)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except RuntimeError as e:
        logger.warning("IFC element detail unavailable element_id=%s error=%s", element_id, e)
        raise HTTPException(409, f"IFC model metadata is not ready: {e}")
    except Exception as e:
        logger.exception("IFC element detail failed element_id=%s", element_id)
        raise HTTPException(500, f"Failed to read IFC element {element_id}: {e}")


@router.get("/elements/{element_id}/relations")
async def get_element_relations(element_id: int):
    """Return connectivity, material, and openings for an element.

    Combines the three new spatial-query tools into one round-trip so the
    PropertiesPanel can lazy-load a "Relations" section without three separate
    API calls.
    """
    _check_loaded()
    try:
        return {
            "element_id": element_id,
            "material": ifc_service.get_element_material(element_id),
            "connections": ifc_service.get_connected_elements(element_id),
            "openings": ifc_service.get_openings_for_element(element_id),
        }
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/stats", response_model=ModelStats)
async def get_stats():
    _check_loaded()
    return ifc_service.get_model_stats()


@router.get("/storeys", response_model=list[ElementSummary])
async def get_storeys():
    _check_loaded()
    return ifc_service.get_storeys()


@router.get("/search", response_model=SearchResult)
async def search(
    q: str = Query(..., min_length=1),
    ifc_type: Optional[str] = Query(None),
    storey: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
):
    _check_loaded()
    return ifc_service.search(q, ifc_type=ifc_type, storey=storey, limit=limit)


@router.post("/aggregate", response_model=AggregateResult)
async def aggregate_elements(request: AggregateRequest):
    """Aggregate quantities + histograms for a set of express IDs.

    Accepts up to 2000 IDs. Returns ΣArea, ΣVolume (from IfcElementQuantity),
    material histogram, and type histogram.
    """
    _check_loaded()
    if len(request.express_ids) > 2000:
        from fastapi import HTTPException as _HTTPException
        raise _HTTPException(status_code=400, detail="Too many IDs - max 2000")
    result = ifc_service.get_aggregate(request.express_ids)
    return AggregateResult(**result)


@router.get("/file")
async def get_ifc_file():
    """Return the raw IFC file for frontend 3D rendering."""
    _check_loaded()
    from fastapi.responses import FileResponse

    return FileResponse(
        ifc_service._file_path,
        media_type="application/octet-stream",
        filename=ifc_service._file_path.name,
    )


# ────────────────────────────────────────────────────────────────────
# Save As - export current edited bytes to a user-chosen filename
#
# Edits never overwrite the original upload: ifc_service.load() copies
# the source into a hidden .working/<name>.ifc sidecar and persists every
# mutation against that file. /save-as streams the current working bytes
# back to the client with the user's requested filename, so the browser's
# native "Save File" dialog (or showSaveFilePicker on the frontend) puts
# a clean copy wherever they want. The original on disk is untouched.
# ────────────────────────────────────────────────────────────────────

_SAFE_FILENAME_RE = __import__("re").compile(r"[^\w.\-]+")


def _sanitize_save_filename(name: str) -> str:
    candidate = (name or "").strip()
    if not candidate:
        raise HTTPException(400, "filename is required")
    # Strip any path traversal - only keep the basename.
    candidate = Path(candidate).name
    if not candidate.lower().endswith(".ifc"):
        candidate = candidate + ".ifc"
    safe = _SAFE_FILENAME_RE.sub("_", candidate)
    # Guard against an all-separator filename collapsing to ".ifc".
    if safe == ".ifc" or not safe.strip("._-"):
        raise HTTPException(400, "filename must include at least one alphanumeric character")
    return safe


@router.get("/save-as")
async def save_ifc_as(filename: str = Query(..., min_length=1, max_length=255)):
    """Stream the current edited IFC bytes as a downloadable file.

    The user picks where the bytes land via their browser's save dialog
    (showSaveFilePicker on Chromium, "Save target as…" on Firefox). The
    original uploaded IFC on the server is never modified - only a hidden
    working copy carries edits. After the download succeeds the frontend
    calls /api/ifc/edit-state to reset the dirty flag.
    """
    _check_loaded()
    from fastapi.responses import FileResponse

    safe = _sanitize_save_filename(filename)
    file_path = ifc_service._file_path  # noqa: SLF001 - working file
    if file_path is None or not file_path.exists():
        raise HTTPException(409, "No IFC file currently available on disk")
    return FileResponse(
        file_path,
        media_type="application/octet-stream",
        filename=safe,
    )


@router.post("/save-as/ack")
async def acknowledge_save_as():
    """Frontend calls this once the browser confirms the download landed.

    Resets the dirty flag so the UI can drop the "unsaved changes" badge
    and Word/Excel-style close prompts. We can't observe the download from
    the server side, so the frontend is responsible for calling this on
    success.
    """
    _check_loaded()
    ifc_service.mark_clean()
    return {"dirty": ifc_service.dirty}


@router.get("/edit-state")
async def get_edit_state():
    """Return safe-edit state: dirty flag + original/working filenames.

    Used by the Save As menu item to decide whether to show the unsaved
    badge and the post-save "Close model?" prompt.
    """
    if not ifc_service.is_loaded:
        return {"loaded": False, "dirty": False}
    original = ifc_service.original_path
    working = ifc_service._file_path  # noqa: SLF001
    return {
        "loaded": True,
        "dirty": ifc_service.dirty,
        "original_filename": ifc_service.original_filename,
        "working_filename": working.name if working else None,
        "original_protected": bool(original and working and original != working),
        "model_version": ifc_service.model_version,
        "model_fingerprint": ifc_service.model_fingerprint,
    }


# ────────────────────────────────────────────────────────────────────
# IDS 1.0 validation - standalone REST endpoint
# Complements the `ids_validate` chat tool; accepts IDS via file upload
# or base64, returns JSON (default) or CSV (format=csv).
# ────────────────────────────────────────────────────────────────────

from pydantic import BaseModel as _BaseModel  # noqa: E402


class IdsValidateRequest(_BaseModel):
    ids_base64: str
    format: Literal["json", "csv"] = "json"
    limit_per_spec: int = 25


class HealthCheckRequest(_BaseModel):
    limit_per_rule: int = 50


@router.post("/health", summary="Run model quality health check")
async def health_check_endpoint(req: HealthCheckRequest = HealthCheckRequest()):
    """Run the built-in IFC model quality rules against the loaded model.

    Returns a structured report listing issues grouped by rule, each tagged
    with a severity (``error``, ``warning``, ``info``).  At most
    ``limit_per_rule`` issue records are returned per rule; the ``count``
    field gives the true total.  A ``duration_ms`` field reports wall-clock
    time spent running all rules.

    Rules checked:

    - ``missing_global_id`` - elements with a blank or null GlobalId
    - ``duplicate_global_id`` - elements sharing a GlobalId (data corruption)
    - ``missing_name`` - structural elements with no Name attribute
    - ``empty_property_sets`` - IfcPropertySet with zero properties
    - ``no_storey_assignment`` - walls/slabs/columns/beams outside any storey
    - ``duplicate_name_in_type`` - same name used for multiple doors/windows/spaces
    - ``large_element_count`` - informational notice when >10 000 elements
    """
    import time as _time
    _check_loaded()
    model = ifc_service.model
    t0 = _time.perf_counter()
    result = run_health_check(model, limit_per_rule=req.limit_per_rule)
    result["duration_ms"] = round((_time.perf_counter() - t0) * 1000, 1)
    return result


@router.post("/ids-validate")
async def ids_validate_endpoint(req: IdsValidateRequest):
    """Validate the currently-loaded IFC model against an IDS document.

    Accepts the IDS XML base64-encoded in the request body.  Returns a
    structured JSON report or a CSV file of all failures depending on
    ``format``.

    The engine used is reported in the response header
    ``X-IDS-Engine`` (``ifctester`` or ``v0``).
    """
    _check_loaded()
    model = ifc_service.model
    headers = {"X-IDS-Engine": IDS_ENGINE}
    try:
        if req.format == "csv":
            csv_text = validate_ids_base64_to_csv(model, req.ids_base64)
            return Response(
                content=csv_text,
                media_type="text/csv",
                headers={**headers, "Content-Disposition": 'attachment; filename="ids_failures.csv"'},
            )
        report = validate_ids_base64(model, req.ids_base64, limit_per_spec=req.limit_per_spec)
        report = {**report, "all_failing_ids": extract_failing_ids(report)}
        from fastapi.responses import JSONResponse
        return JSONResponse(content=report, headers=headers)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/ids-info")
async def ids_info_endpoint(req: IdsValidateRequest):
    """Parse IDS header metadata without running full validation.

    Useful for showing the IDS title / author / spec count in the UI
    immediately after the user attaches an IDS file.
    """
    try:
        import base64 as _b64
        raw = _b64.b64decode(req.ids_base64).decode("utf-8", errors="replace")
        info = parse_ids_info(raw)
        return info
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc


def _check_loaded():
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded. Upload a file first.")


# ────────────────────────────────────────────────────────────────────
# Per-storey fragment streaming - manifest endpoint
# Returns element-ID manifest so the frontend can progressively reveal
# the model one storey at a time. GET /fragments/storey below serves
# the actual per-storey byte blobs for separate FragmentsModel loads.
# ────────────────────────────────────────────────────────────────────

@router.post("/storey-manifest")
async def get_storey_manifest():
    """Return per-storey element-ID manifest for the loaded model.

    Clients use the manifest to implement progressive storey reveal:
    show the ground floor immediately after model load completes, then
    add subsequent storeys at a controlled pace so the user perceives
    faster time-to-first-render without requiring separate IFC uploads.

    Response shape::

        {
          "source_sha256": "abc...",
          "total_elements": 149,
          "storeys": [
            { "idx": 0, "name": "Ground Floor", "elevation": 0.0,
              "element_ids": [123, 456, ...], "element_count": 87 },
            ...
          ]
        }
    """
    _check_loaded()
    sha = ifc_service._model_fingerprint  # noqa: SLF001
    manifest = storey_splitter.get_manifest(ifc_service.model, sha)
    return {
        "source_sha256": manifest.source_sha256,
        "total_elements": manifest.total_elements,
        "storeys": [
            {
                "idx": s.idx,
                "name": s.name,
                "elevation": s.elevation,
                "element_ids": s.element_ids,
                "element_count": s.element_count,
            }
            for s in manifest.storeys
        ],
    }


# ────────────────────────────────────────────────────────────────────
# Spatial tile streaming
# Returns a per-storey NxN XY grid partition of the model's elements
# so the frontend can stream only the tiles intersecting the camera
# frustum.  Placement-origin "point AABBs" are the best-effort fallback
# heuristic; real geometry-derived AABBs are used once the AABB cache
# is warm. Per-tile .frag byte conversion is not implemented yet.
# ────────────────────────────────────────────────────────────────────

@router.get("/tile-manifest", response_model=TileManifest)
async def get_tile_manifest(
    grid: int = Query(2, ge=1, le=16, description="NxN grid resolution per storey"),
):
    """Return the spatial tile manifest for the loaded model.

    The frontend uses this to drive frustum-based tile streaming: each
    tile's AABB is intersected against the camera frustum, and only the
    tiles inside (or near) the view load their geometry.

    Current limitations:

    - When the geometry AABB cache is cold, element-to-tile assignment
      falls back to placement-origin point AABBs, not real geometry.
      Models with all elements sharing the same placement (e.g.
      BasicHouse.ifc) will then collapse to one tile per storey.
    - Per-tile fragment bytes are NOT yet produced; the manifest reports
      element assignment only.
    """
    _check_loaded()
    sha = ifc_service._model_fingerprint  # noqa: SLF001
    storey_manifest = storey_splitter.get_manifest(ifc_service.model, sha)
    # Feed the AABB cache when warm; the splitter transparently falls
    # back to placement-origin point AABBs for any element missing from
    # the cache.
    aabb_lookup = aabb_service.get_all_aabbs(sha) if sha else {}
    manifest = spatial_tile_splitter.get_manifest(
        ifc_service.model,
        storey_manifest,
        sha,
        grid_resolution=grid,
        aabb_lookup=aabb_lookup or None,
    )
    aabb_source = spatial_tile_splitter.aabb_source(sha, grid)
    return TileManifest(
        source_sha256=manifest.source_sha256,
        grid_resolution=manifest.grid_resolution,
        world_aabb_min=manifest.world_aabb_min,
        world_aabb_max=manifest.world_aabb_max,
        total_elements=manifest.total_elements,
        total_tiles=manifest.total_tiles,
        aabb_source=aabb_source,  # type: ignore[arg-type]
        tiles=[
            TileInfo(
                tile_id=t.tile_id,
                storey_idx=t.storey_idx,
                cell_x=t.cell_x,
                cell_y=t.cell_y,
                aabb_min=t.aabb_min,
                aabb_max=t.aabb_max,
                element_ids=t.element_ids,
                element_count=t.element_count,
            )
            for t in manifest.tiles
        ],
    )


# ────────────────────────────────────────────────────────────────────
# Real per-element AABBs
# Background-computed via ifcopenshell.geom.create_shape on upload,
# cached to disk under DATA_DIR/aabb-cache/{sha}.json.
# Consumed by /tile-manifest (which falls back to placement origins for
# elements missing from the cache) and by frontend frustum culling.
# ────────────────────────────────────────────────────────────────────

@router.get("/aabb/status", response_model=AABBCacheStatus)
async def get_aabb_status():
    """Return the live state of the AABB warm-up for the loaded model."""
    _check_loaded()
    sha = ifc_service._model_fingerprint  # noqa: SLF001
    st = aabb_service.status(sha)
    return AABBCacheStatus(
        sha=st.sha,
        state=st.state,  # type: ignore[arg-type]
        count=st.count,
        total_expected=st.total_expected,
        total_ms=st.total_ms,
        error=st.error,
    )


@router.get("/aabb/{express_id}", response_model=AABBResponse)
async def get_aabb_one(express_id: int):
    """Return the world-space AABB for one element. 404 when not cached."""
    _check_loaded()
    sha = ifc_service._model_fingerprint  # noqa: SLF001
    box = aabb_service.get_aabb(sha, express_id)
    if box is None:
        raise HTTPException(404, f"AABB not available for express id {express_id}")
    mn, mx = box
    return AABBResponse(express_id=express_id, aabb_min=mn, aabb_max=mx)


@router.post("/aabb/bulk", response_model=AABBBulkResponse)
async def get_aabbs_bulk(payload: AABBBulkRequest):
    """Return AABBs for a list of express IDs.

    Missing IDs (not yet computed, or skipped for geometry reasons) come
    back in the `missing` field rather than failing the whole request.
    """
    _check_loaded()
    sha = ifc_service._model_fingerprint  # noqa: SLF001
    requested = list(payload.express_ids)
    cached = aabb_service.get_aabbs_bulk(sha, requested)
    missing = [eid for eid in requested if int(eid) not in cached]
    return AABBBulkResponse(
        sha=sha,
        aabbs=[
            AABBResponse(express_id=eid, aabb_min=mn, aabb_max=mx)
            for eid, (mn, mx) in cached.items()
        ],
        missing=missing,
    )


@router.delete("/aabb/cache")
async def clear_aabb_cache(sha: Optional[str] = Query(None), disk: bool = Query(False)):
    """Evict the in-memory AABB cache (and optionally the on-disk JSON)."""
    aabb_service.clear(sha)
    removed = 0
    if disk:
        removed = aabb_service.clear_disk(sha)
    return {"cleared": sha or "all", "disk_files_removed": removed}


# ────────────────────────────────────────────────────────────────────
# Per-storey fragment streaming - byte endpoint
# Produces actual sub-IFC bytes per storey (via copy_deep) + converts
# them through the Node sidecar for true <500 ms TTFR on first storey.
# ────────────────────────────────────────────────────────────────────

@router.get("/fragments/storey")
async def get_storey_fragment(
    sha: str = Query(..., description="SHA-256 fingerprint of the loaded IFC model"),
    idx: int = Query(..., description="Zero-based storey index (elevation-sorted)", ge=0),
):
    """Return binary fragment bytes for one IfcBuildingStorey.

    Workflow (fastest first):
    1. **Disk cache hit** - returns cached ``.frag`` bytes instantly (<20 ms).
    2. **Sidecar convert** - serializes the storey to a sub-IFC via
       ``copy_deep``, sends to the Node sidecar, caches result, returns binary.
    3. **Sub-IFC fallback** - when the sidecar is unavailable, returns raw
       sub-IFC bytes so the frontend can convert via ``IfcConvertWorker``.

    Response codes:

    - ``200`` - binary bytes (check ``X-Fragment-Source`` for cache/sidecar/sub-ifc)
    - ``204`` - storey has no elements (no bytes to send)
    - ``400`` - no model loaded
    - ``404`` - SHA mismatch or storey index out of range
    - ``503`` - serialization failed (IfcOpenShell error)

    Response headers:

    - ``X-Fragment-Source`` - ``cache`` | ``sidecar`` | ``sub-ifc``
    - ``X-Fragment-Storey-Idx`` - storey index (mirrors ``idx``)
    - ``X-Fragment-Storey-Name`` - IfcBuildingStorey.Name
    - ``X-Fragment-Elapsed-Ms`` - sidecar convert time (sidecar path only)
    """
    _check_loaded()

    # Verify SHA matches the currently-loaded model.
    current_sha: str = ifc_service._model_fingerprint  # noqa: SLF001
    if sha != current_sha:
        raise HTTPException(
            404,
            detail=f"SHA mismatch: loaded model is {current_sha[:16]}…, "
            f"requested {sha[:16]}…",
        )

    # Fetch manifest (cached) to validate idx + check element count.
    manifest = storey_splitter.get_manifest(ifc_service.model, current_sha)

    if idx >= len(manifest.storeys):
        raise HTTPException(
            404,
            detail=f"Storey index {idx} out of range "
            f"(model has {len(manifest.storeys)} storeys)",
        )

    storey_info = manifest.storeys[idx]
    if storey_info.element_count == 0:
        return Response(status_code=204)

    # Check on-disk fragment cache.
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    frag_cache_path = FRAGMENT_CACHE_DIR / f"{current_sha}-s{idx}.frag"

    if frag_cache_path.exists():
        return Response(
            content=frag_cache_path.read_bytes(),
            media_type="application/octet-stream",
            headers={
                "X-Fragment-Source": "cache",
                "X-Fragment-Storey-Idx": str(idx),
                "X-Fragment-Storey-Name": storey_info.name,
            },
        )

    # Serialize the storey to a minimal sub-IFC.
    try:
        sub_ifc_bytes = storey_splitter.serialize_storey(ifc_service.model, idx, current_sha)
    except IndexError as exc:
        raise HTTPException(404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, detail=f"Serialization error: {exc}") from exc

    # Attempt sidecar conversion (converts sub-IFC → fragment binary).
    caps = await sidecar_manager.capabilities()
    if caps.get("available"):
        try:
            frag_bytes, meta = await sidecar_manager.convert(
                ifc_bytes=sub_ifc_bytes,
                profile="balanced",
                model_id=f"storey-{current_sha[:8]}-s{idx}",
            )
            try:
                frag_cache_path.write_bytes(frag_bytes)
            except OSError:
                pass
            return Response(
                content=frag_bytes,
                media_type="application/octet-stream",
                headers={
                    "X-Fragment-Source": "sidecar",
                    "X-Fragment-Storey-Idx": str(idx),
                    "X-Fragment-Storey-Name": storey_info.name,
                    "X-Fragment-Elapsed-Ms": str(meta.get("elapsedMs", 0)),
                },
            )
        except RuntimeError:
            pass  # sidecar failed - fall through to raw sub-IFC fallback

    # Fallback: return raw sub-IFC bytes (frontend converts via IfcConvertWorker).
    return Response(
        content=sub_ifc_bytes,
        media_type="application/octet-stream",
        headers={
            "X-Fragment-Source": "sub-ifc",
            "X-Fragment-Storey-Idx": str(idx),
            "X-Fragment-Storey-Name": storey_info.name,
        },
    )


# ────────────────────────────────────────────────────────────────────
# Server-side fragment pre-conversion
# (fragment cache lives at config.FRAGMENT_CACHE_DIR, imported above;
# tests monkeypatch `app.api.ifc_routes.FRAGMENT_CACHE_DIR`)
# ────────────────────────────────────────────────────────────────────


@router.get("/features")
async def get_ifc_features():
    """Capability probe called by the frontend at startup to decide
    whether to use the server-side convert path or fall back to live
    browser parse.

    Part of the server-side convert path. See docs/architecture/AI_NATIVE_ENGINE.md.
    """
    started = time.perf_counter()
    logger.debug("IFC features probe: checking sidecar capabilities")
    try:
        caps = await sidecar_manager.capabilities()
    except Exception as exc:  # defensive: readiness probes should never 500
        logger.exception("IFC features probe failed")
        caps = {
            "server_convert": False,
            "available": False,
            "recoverable": True,
            "reason": f"{type(exc).__name__}: {exc}",
        }
    logger.debug(
        "IFC features probe: result=%s elapsed_ms=%.1f",
        caps,
        (time.perf_counter() - started) * 1000,
    )
    return caps


@router.post("/convert")
async def convert_ifc_to_fragments(
    request: Request,
    profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query(
        "balanced"
    ),
    model_id: str = Query("sidecar-model", alias="modelId"),
    no_cache: bool = Query(False),
):
    """Accepts IFC bytes, proxies to the Node sidecar, returns fragment
    binary. Content-hashes the input so repeat uploads of the same file
    are served from the on-disk fragment cache instantly.

    Content-Type: `application/octet-stream`.
    Query params: `profile`, `modelId`.
    Response: binary `.frag` bytes.
    Response headers:
      - `X-Fragment-Source`: "cache" | "sidecar"
      - `X-Fragment-Profile`: resolved profile
      - `X-Fragment-Elapsed-Ms`: sidecar conversion time (only when fresh)
      - `X-Fragment-Source-Sha256`: sha256 of the input IFC
    """
    started = time.perf_counter()
    ifc_bytes = await request.body()
    if not ifc_bytes:
        raise HTTPException(400, "empty body; POST the IFC bytes as octet-stream")
    _enforce_ifc_upload_size(len(ifc_bytes))

    source_sha = hashlib.sha256(ifc_bytes).hexdigest()
    logger.info(
        "IFC convert request: sha=%s profile=%s model_id=%s input=%.2fMB",
        source_sha[:12],
        profile,
        model_id,
        len(ifc_bytes) / (1024 * 1024),
    )
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = FRAGMENT_CACHE_DIR / f"{source_sha}-{profile}.frag"

    if no_cache:
        logger.info(
            "IFC convert no_cache=1: sha=%s profile=%s - bypassing cache read/write and prebuild reuse",
            source_sha[:12],
            profile,
        )

    if not no_cache and cache_path.exists():
        logger.info(
            "IFC convert cache hit: sha=%s profile=%s size=%.2fMB elapsed_ms=%.1f",
            source_sha[:12],
            profile,
            cache_path.stat().st_size / (1024 * 1024),
            (time.perf_counter() - started) * 1000,
        )
        return Response(
            content=cache_path.read_bytes(),
            media_type="application/octet-stream",
            headers={
                "X-Fragment-Source": "cache",
                "X-Fragment-Profile": profile,
                "X-Fragment-Source-Sha256": source_sha,
            },
        )

    prebuild_report = fragment_prebuild_service.get_status(source_sha, profile)
    if not no_cache and prebuild_report.status == "inflight":
        logger.info(
            "IFC convert waiting for inflight prebuild: sha=%s profile=%s",
            source_sha[:12],
            profile,
        )
        prebuild_report = await fragment_prebuild_service.wait_for(
            source_sha, profile, timeout_s=30.0
        )
        if cache_path.exists():
            logger.info(
                "IFC convert prebuild hit: sha=%s profile=%s size=%.2fMB elapsed_ms=%.1f",
                source_sha[:12],
                profile,
                cache_path.stat().st_size / (1024 * 1024),
                (time.perf_counter() - started) * 1000,
            )
            return Response(
                content=cache_path.read_bytes(),
                media_type="application/octet-stream",
                headers={
                    "X-Fragment-Source": "cache",
                    "X-Fragment-Profile": profile,
                    "X-Fragment-Elapsed-Ms": str(prebuild_report.elapsed_ms or 0),
                    "X-Fragment-Source-Sha256": source_sha,
                },
            )

    # Register this conversion as in-flight so the upload route's `_bg_tasks`
    # (or a concurrent `/convert` for the same SHA) sees the work and waits
    # instead of running a duplicate sidecar conversion. `register_inflight`
    # is idempotent - if another caller already won the race, this is a no-op
    # and we still run our own conversion (the cache writes are idempotent).
    if not no_cache:
        await fragment_prebuild_service.register_inflight(source_sha, profile)

    try:
        logger.info(
            "IFC convert sidecar start: sha=%s profile=%s model_id=%s",
            source_sha[:12],
            profile,
            model_id,
        )
        frag_bytes, meta = await sidecar_manager.convert(
            ifc_bytes=ifc_bytes,
            profile=profile,
            model_id=model_id,
        )
    except RuntimeError as exc:
        await fragment_prebuild_service.mark_failed(source_sha, profile, error=str(exc))
        raise HTTPException(503, f"sidecar error: {exc}") from exc

    # Sanity check: the sidecar sometimes returns a tiny (~100 B) zlib stub
    # when conversion silently fails on geometry it can't handle. We refuse
    # to cache or serve those - caching them poisons future requests for the
    # same SHA, and the frontend wastes retries trying to load empty bytes.
    # Threshold is 4 KB: a real fragment with even one element is larger.
    _MIN_VALID_FRAG_BYTES = 4 * 1024
    if len(frag_bytes) < _MIN_VALID_FRAG_BYTES:
        err = (
            f"sidecar produced suspiciously small fragment "
            f"({len(frag_bytes)} B from {len(ifc_bytes)} B IFC) - likely "
            "an empty stub from a conversion failure"
        )
        logger.warning(err)
        await fragment_prebuild_service.mark_failed(source_sha, profile, error=err)
        raise HTTPException(422, err)

    # Persist for next time. Best-effort; a write failure is not fatal.
    # When no_cache=1 we skip the write so the toggle truly disables reuse
    # (otherwise the next "uncached" request would still see this file in
    # cache_path on a subsequent toggle-on).
    if not no_cache:
        try:
            cache_path.write_bytes(frag_bytes)
        except OSError:
            pass

    # Notify any waiters (the upload `_bg_tasks` for the same SHA) that the
    # conversion is done and the cache is hot. With no_cache=1 we never
    # wrote the cache, so there is nothing for waiters to consume.
    if not no_cache:
        await fragment_prebuild_service.mark_complete(
            source_sha, profile, size_bytes=len(frag_bytes)
        )
    logger.info(
        "IFC convert sidecar done: sha=%s profile=%s output=%.2fMB sidecar_ms=%s total_ms=%.1f",
        source_sha[:12],
        profile,
        len(frag_bytes) / (1024 * 1024),
        meta.get("elapsedMs", 0),
        (time.perf_counter() - started) * 1000,
    )

    # Drop the progress snapshot now that we're done so a follow-up
    # poll returns None (the conversion is over) instead of stale 100 %.
    sidecar_manager.clear_progress(model_id)

    return Response(
        content=frag_bytes,
        media_type="application/octet-stream",
        headers={
            "X-Fragment-Source": "sidecar",
            "X-Fragment-Profile": meta.get("effectiveProfile") or profile,
            "X-Fragment-Elapsed-Ms": str(meta.get("elapsedMs", 0)),
            "X-Fragment-Source-Sha256": source_sha,
        },
    )


@router.get("/convert/progress/{model_id}")
async def get_convert_progress(model_id: str):
    """Latest sidecar progress snapshot for an in-flight conversion.

    The frontend's serverConvert helper polls this in parallel with the
    main ``POST /convert`` so the loader UI can show real percent +
    stage ("lex"/"parse"/"index"/"geometry"/"serialise") instead of
    stalling at "70 %".

    Returns:
      - ``200 OK`` with ``{model_id, stage, progress, updated_at,
        in_flight: true}`` while the sidecar reports progress.
      - ``200 OK`` with ``{model_id, in_flight: false}`` when no
        snapshot is known (conversion not started, finished, or
        evicted from the 64-entry LRU).

    No 404: a missing snapshot is a normal state in the polling
    lifecycle, not an error.
    """
    snap = sidecar_manager.get_progress(model_id)
    if snap is None:
        return {"model_id": model_id, "in_flight": False}
    return {
        "model_id": snap.model_id,
        "stage": snap.stage,
        "progress": snap.progress,
        "updated_at": snap.updated_at,
        "in_flight": True,
    }


# ────────────────────────────────────────────────────────────────────
# Fragment manifest - let the frontend skip re-uploading IFC bytes
# when the server already has cached fragments for the model.
# ────────────────────────────────────────────────────────────────────

@router.get("/fragment-manifest")
async def get_fragment_manifest(
    fingerprint: str = Query(..., description="SHA-256 of the IFC file (from model contract)"),
    profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query("balanced"),
):
    """Check whether pre-built fragments are cached on disk for a given IFC fingerprint.

    The frontend stores the model fingerprint from the upload contract. On remount
    it can call this endpoint with just the fingerprint (no 50 MB IFC re-upload)
    to discover whether `/api/ifc/fragments/serve` can serve the fragments
    directly - skipping both the IFC download and re-upload.

    Response:
      - ``cached`` - whether the disk cache entry exists
      - ``size_bytes`` - file size of the cached fragment (only when cached)
      - ``serve_url`` - URL the frontend can GET to fetch the fragment bytes
    """
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    safe_fp = fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]
    cache_path = FRAGMENT_CACHE_DIR / f"{safe_fp}-{profile}.frag"
    cached = cache_path.exists()
    return {
        "cached": cached,
        "fingerprint": safe_fp,
        "profile": profile,
        "size_bytes": cache_path.stat().st_size if cached else None,
        "serve_url": (
            f"/api/ifc/fragments/serve?fingerprint={safe_fp}&profile={profile}"
            if cached
            else None
        ),
    }


@router.get("/convert-status")
async def get_convert_status(
    fingerprint: str = Query(..., description="SHA-256 of the IFC file (from model contract)"),
    profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query("balanced"),
    wait_ms: int = Query(
        0,
        ge=0,
        le=30_000,
        description=(
            "If > 0, block until the in-flight pre-build resolves or this many "
            "milliseconds pass - bounded so the request can never wedge the "
            "client. 0 (default) returns the current snapshot immediately."
        ),
    ),
):
    """Report the state of the fingerprint's fragment pre-build task.

    Background: ``POST /api/ifc/upload`` schedules a fire-and-forget pre-build
    of the uploaded IFC into ``.frag`` bytes for the ``balanced`` profile.
    There is a short window where the manifest cache
    file has not yet been written but the conversion is already running. Without
    this endpoint, the viewer's cold-load path falls back to a wasteful 50 MB
    re-upload via ``/convert``.

    Response (``status`` is one of ``idle | inflight | complete | failed``):

    * ``idle``     - registry has no record; frontend should issue ``/convert``.
    * ``inflight`` - pre-build running; ``elapsed_ms`` populated.
    * ``complete`` - fragment cached on disk; ``serve_url`` ready to fetch.
    * ``failed``   - pre-build raised; ``error`` populated. Caller may still
                     try ``/convert`` (transient sidecar failures are common).

    If ``wait_ms > 0`` the call blocks until the task reaches a terminal state
    or the timeout fires; the same payload shape is returned either way.
    """
    safe_fp = fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]
    FRAGMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def _cache_exists(fp: str, prof: str) -> bool:
        return (FRAGMENT_CACHE_DIR / f"{fp}-{prof}.frag").exists()

    def _cached_size(fp: str, prof: str) -> Optional[int]:
        path = FRAGMENT_CACHE_DIR / f"{fp}-{prof}.frag"
        return path.stat().st_size if path.exists() else None

    if wait_ms > 0:
        await fragment_prebuild_service.wait_for(
            safe_fp, profile, timeout_s=wait_ms / 1000.0
        )

    report = fragment_prebuild_service.get_status(
        safe_fp,
        profile,
        cache_exists=_cache_exists,
        cached_size=_cached_size(safe_fp, profile),
    )
    payload = report.as_dict()
    if report.status == "complete":
        payload["serve_url"] = (
            f"/api/ifc/fragments/serve?fingerprint={safe_fp}&profile={profile}"
        )
    else:
        payload["serve_url"] = None
    return payload


@router.get("/fragments/serve")
async def serve_fragment_by_fingerprint(
    fingerprint: str = Query(..., description="SHA-256 of the IFC file"),
    profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query("balanced"),
):
    """Serve cached fragment bytes by fingerprint - no IFC re-upload required.

    Only succeeds when the disk cache already holds the fragment (i.e.
    ``/api/ifc/fragment-manifest`` returned ``cached: true``). Returns 404
    otherwise; the caller should fall back to the full ``/api/ifc/convert``
    upload path.
    """
    safe_fp = fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]
    cache_path = FRAGMENT_CACHE_DIR / f"{safe_fp}-{profile}.frag"
    if not cache_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Fragment not in disk cache for fingerprint {safe_fp[:16]}… profile={profile}",
        )
    return Response(
        content=cache_path.read_bytes(),
        media_type="application/octet-stream",
        headers={
            "X-Fragment-Source": "manifest-cache",
            "X-Fragment-Profile": profile,
            "X-Fragment-Source-Sha256": safe_fp,
        },
    )


# ────────────────────────────────────────────────────────────────────
# LOD (decimated) fragment serving.
# A low-poly proxy shown during navigation, full model at rest. Built once
# from the cached full frag via the sidecar /decimate endpoint, then served
# from disk. Absent when there is no backend (BROWSER_ONLY) - the frontend
# treats "no LOD" as "just use the full model".
# ────────────────────────────────────────────────────────────────────

@router.get("/lod")
async def get_lod_fragment(
    fingerprint: str = Query(..., description="SHA-256 of the IFC file (from the model contract)"),
    profile: Literal["quality", "balanced", "performance", "ultra_fast"] = Query("balanced"),
    ratio: Optional[float] = Query(
        None,
        ge=0.05,
        le=0.95,
        description=(
            "Target fraction of each shell's original triangle count. Lower = "
            "fewer triangles + faster navigation. Omit for the sidecar default (0.35)."
        ),
    ),
    error: Optional[float] = Query(
        None,
        ge=0.0,
        le=1.0,
        description="Relative error ceiling for the sloppy simplifier. Omit for the default (0.1).",
    ),
):
    """Serve a decimated (LOD) fragment for a previously-converted model.

    Reuses the full ``.frag`` the convert path already cached
    (``{sha}-{profile}.frag``), decimates it via the Node sidecar's
    ``/decimate`` endpoint, and caches the result as
    ``{sha}-{profile}-lod.frag``. The first call builds + caches (a few
    seconds); subsequent calls serve from disk (<20 ms).

    The decimated frag preserves element identity (localIds + GUIDs + spatial
    structure), so the frontend can swap it in during camera motion and swap the
    full model back at rest without re-bridging picking.

    Response codes:

    - ``200`` - binary LOD ``.frag`` bytes (``Content-Type: application/octet-stream``)
    - ``503`` - no LOD available yet: the full frag is not cached, the sidecar is
      unavailable, or decimation failed. The frontend treats any non-200 as
      "just use the full model".

    Response headers:

    - ``X-Fragment-Source`` - ``lod-cache`` (served from disk) | ``lod-sidecar`` (freshly built)
    - ``X-Fragment-Profile`` - the resolved profile
    - ``X-Fragment-Source-Sha256`` - the requested fingerprint (sanitised)
    """
    safe_fp = fingerprint.replace("/", "").replace("\\", "").replace("..", "")[:128]
    served_from = "lod-cache" if lod_frag_cache_path(safe_fp, profile).exists() else "lod-sidecar"
    try:
        lod_bytes = await get_or_build_lod_fragment(safe_fp, profile, ratio=ratio, error=error)
    except LodUnavailable as exc:
        raise HTTPException(503, detail=str(exc)) from exc

    return Response(
        content=lod_bytes,
        media_type="application/octet-stream",
        headers={
            "X-Fragment-Source": served_from,
            "X-Fragment-Profile": profile,
            "X-Fragment-Source-Sha256": safe_fp,
        },
    )


# ---------------------------------------------------------------------------
# IFC edit checkpoints (git-backed history)
# ---------------------------------------------------------------------------


@router.get("/checkpoints", response_model=CheckpointStatus)
async def get_checkpoints(limit: int = Query(50, ge=1, le=200)):
    """List git-backed IFC edit checkpoints newest-first."""
    raw = ifc_checkpoint_service.list_checkpoints(limit=limit)
    checkpoints = [IFCCheckpoint(**c) for c in raw]
    return CheckpointStatus(
        available=ifc_checkpoint_service.is_available,
        count=len(checkpoints),
        checkpoints=checkpoints,
    )


@router.post("/checkpoints/rollback/{sha}", response_model=dict)
async def rollback_to_checkpoint(sha: str):
    """Restore the IFC model to a previous git checkpoint.

    Emits a ``metadata_changed`` WS event so connected clients reload.
    Returns ``{sha, model_version, model_fingerprint}`` on success.
    """
    _check_loaded()
    ifc_bytes = ifc_checkpoint_service.restore(sha)
    if ifc_bytes is None:
        raise HTTPException(404, f"Checkpoint '{sha}' not found")

    # Write bytes back to the working file (NOT the pristine upload) and
    # reload the IfcOpenShell handle in place. We can't call load() here:
    # load() now treats its argument as a fresh upload and would create a
    # nested .working/.working/ sidecar.
    file_path = ifc_service._file_path  # noqa: SLF001 - working file
    if file_path is None:
        raise HTTPException(409, "No IFC file currently loaded")

    try:
        file_path.write_bytes(ifc_bytes)
        ifc_service.reload_after_sandbox(edit_id=f"rollback_{sha[:8]}")
    except Exception as exc:
        raise HTTPException(500, f"Rollback failed: {exc}") from exc

    contract = ifc_service.get_model_contract()
    await model_sync_broker.publish(
        ModelSyncEvent(
            type="metadata_changed",
            model_version=contract["model_version"],
            model_fingerprint=contract["model_fingerprint"],
            edit_id=None,
            payload={"reason": f"rollback to checkpoint {sha}"},
        )
    )
    return {
        "sha": sha,
        "model_version": contract["model_version"],
        "model_fingerprint": contract["model_fingerprint"],
    }


@router.get("/checkpoints/{sha}/diff", response_model=CheckpointDiffResult)
async def get_checkpoint_diff(sha: str):
    """Diff checkpoint *sha* against the current loaded model.

    Returns a ``CheckpointDiffResult`` describing which IfcProduct entities
    were added, removed, or changed (by Name / Description / ObjectType)
    between the snapshot and the live model.  At most 100 entries are
    returned; when there are more, ``truncated=true`` is set.
    """
    _check_loaded()
    if not ifc_checkpoint_service.is_available:
        raise HTTPException(503, "gitpython not installed - checkpoints unavailable")

    model = ifc_service.model
    if model is None:
        raise HTTPException(409, "No model currently loaded")

    result = ifc_checkpoint_service.get_diff(sha, model)
    if result is None:
        raise HTTPException(404, f"Checkpoint '{sha}' not found or diff failed")

    return CheckpointDiffResult(**result)


@router.get(
    "/export/properties",
    summary="Export model properties as CSV or JSON",
    response_class=Response,
)
async def export_properties(
    format: Literal["csv", "json"] = Query("csv", description="Output format"),
    ifc_type: Optional[str] = Query(None, description="Filter by IFC class, e.g. 'IfcWall'"),
    include_quantities: bool = Query(False, description="Include IfcElementQuantity columns"),
    max_elements: int = Query(5000, ge=1, le=50_000, description="Max elements to export"),
):
    """Export all (or type-filtered) IFC elements with their property sets as CSV or JSON.

    CSV columns: ``express_id, global_id, name, ifc_type, storey, <PsetName.PropName> ...``
    Each unique (property set, property) pair becomes its own column.  Quantity columns
    use a ``Qty.`` prefix when ``include_quantities=true``.

    JSON returns a list of flat dicts with the same column structure as CSV.
    """
    _check_loaded()

    csv_text = ifc_service.export_properties_csv(
        ifc_type=ifc_type or None,
        include_quantities=include_quantities,
        max_elements=max_elements,
    )

    if format == "json":
        import csv as _csv
        import io
        import json

        reader = _csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        return Response(
            content=json.dumps(rows, ensure_ascii=False),
            media_type="application/json",
        )

    filename = f"ifc-export-{ifc_type or 'all'}.csv"
    return Response(
        content=csv_text.encode("utf-8"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/elements/{element_id}/nearby", summary="Find nearby elements by placement distance")
async def get_nearby_elements(
    element_id: int,
    radius_m: float = Query(5.0, gt=0, le=500, description="Search radius in metres"),
    ifc_types: Optional[str] = Query(None, description="Comma-separated IFC types, e.g. IfcWall,IfcColumn"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
):
    """Return elements within *radius_m* metres of a reference element.

    Uses IfcLocalPlacement origin coordinates - no full geometry processing.
    Results are sorted by distance ascending.
    """
    _check_loaded()
    parsed_types = [t.strip() for t in ifc_types.split(",") if t.strip()] if ifc_types else None
    return ifc_service.find_nearby_elements(
        element_id=element_id,
        radius_m=radius_m,
        ifc_types=parsed_types,
        limit=limit,
    )


class PropertyFilterRequest(_BaseModel):
    property_name: str
    operator: str
    value: str
    ifc_type: Optional[str] = None
    storey: Optional[str] = None
    pset_name: Optional[str] = None
    limit: int = 100


@router.post("/elements/filter-by-property", summary="Filter elements by property value condition")
async def filter_elements_by_property(req: PropertyFilterRequest):
    """Filter IFC elements by a property value condition.

    Operators: ``eq``, ``neq``, ``contains``, ``startswith``, ``gt``, ``lt``, ``gte``, ``lte``.
    Returns matching element IDs and details.
    """
    _check_loaded()
    limit = min(req.limit, 500)
    return ifc_service.filter_by_property_value(
        property_name=req.property_name,
        operator=req.operator,
        value=req.value,
        ifc_type=req.ifc_type or None,
        storey=req.storey or None,
        pset_name=req.pset_name or None,
        limit=limit,
    )
