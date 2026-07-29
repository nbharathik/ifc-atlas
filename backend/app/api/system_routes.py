"""
System API routes - user-data directory inspection + cache management.

The app keeps all writable state in a per-user dotfolder (`~/.ifc-atlas/`)
so the repo / install location stays read-only. This module exposes those
paths + their sizes to the Settings UI and provides flush operations + a
size cap so users can keep the cache bounded.

See `app.core.config` for resolution logic and `docs/user/DATA_STORAGE.md`
for the user-facing description.

This module also hosts three sibling system-level route groups, each on its
own ``APIRouter`` (identical prefixes/tags/paths as the former per-domain
modules; ``app.main`` includes all four):

* Settings routes - provider status, configuration, and per-user secrets.
  Keys are resolved fresh on every request via
  :func:`app.services.secrets_service.get_api_key` so an edit through the UI
  takes effect on the very next LLM call (no restart needed).
* MCP registry routes - read-only REST for the MCP server registry. The
  settings UI renders the catalogue so operators can see which external tool
  servers are configured, whether they are enabled, and what transport they
  use. Writes/reloads arrive in a later phase once the live client is in
  place.
* Diff routes - the working-vs-original model diff. Opening the pristine
  upload and diffing it is CPU-bound, so both routes run through
  ``asyncio.to_thread`` and share the diff service's result cache via the
  model-contract fingerprint (same pattern as the cost/carbon routes) - the
  panel fetches on every mount and the CSV export repeats the same diff.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.config import (
    BASE_DIR,
    UPLOAD_DIR,
    SNAPSHOT_DIR,
    DATA_DIR,
    CHECKPOINT_DIR,
    FRAGMENT_CACHE_DIR,
    CACHE_MAX_BYTES,
)
from app.services import secrets_service
from app.services.diff_service import diff_to_csv, working_vs_original
from app.services.ifc_service import ifc_service
from app.services.mcp_registry import mcp_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])
settings_router = APIRouter(prefix="/api/settings", tags=["settings"])
mcp_router = APIRouter(prefix="/api/mcp", tags=["mcp"])
diff_router = APIRouter(prefix="/api/diff", tags=["diff"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _dir_size_bytes(path: Path) -> int:
    """Sum of file sizes under ``path``. Returns 0 if path is missing."""
    if not path.exists():
        return 0
    total = 0
    try:
        for child in path.rglob("*"):
            if child.is_file():
                try:
                    total += child.stat().st_size
                except OSError:
                    continue
    except OSError as exc:
        logger.warning("dir-size walk failed for %s: %s", path, exc)
    return total


def _dir_entry_count(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        return sum(1 for _ in path.iterdir())
    except OSError:
        return 0


def _path_info(path: Path) -> dict[str, Any]:
    return {
        "path": str(path),
        "exists": path.exists(),
        "entries": _dir_entry_count(path),
        "size_bytes": _dir_size_bytes(path),
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class DataPathsResponse(BaseModel):
    base: str
    uploads: dict[str, Any]
    snapshots: dict[str, Any]
    data: dict[str, Any]
    checkpoints: dict[str, Any]
    fragments: dict[str, Any]
    total_size_bytes: int
    cache_max_bytes: int


class CacheConfigUpdate(BaseModel):
    cache_max_bytes: int


class CacheFlushResponse(BaseModel):
    scope: str
    bytes_freed: int
    files_removed: int


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/data-paths", response_model=DataPathsResponse)
async def get_data_paths() -> DataPathsResponse:
    """Return resolved data-dir paths, their sizes, and the cache cap.

    Used by the Settings → Storage panel to show the user exactly where
    their data lives and how much disk it's using.
    """
    uploads = _path_info(UPLOAD_DIR)
    snapshots = _path_info(SNAPSHOT_DIR)
    data = _path_info(DATA_DIR)
    checkpoints = _path_info(CHECKPOINT_DIR)
    fragments = _path_info(FRAGMENT_CACHE_DIR)
    total = (
        uploads["size_bytes"]
        + snapshots["size_bytes"]
        + data["size_bytes"]
        + checkpoints["size_bytes"]
        + fragments["size_bytes"]
    )
    return DataPathsResponse(
        base=str(BASE_DIR),
        uploads=uploads,
        snapshots=snapshots,
        data=data,
        checkpoints=checkpoints,
        fragments=fragments,
        total_size_bytes=total,
        cache_max_bytes=CACHE_MAX_BYTES,
    )


def _flush_dir(target: Path) -> tuple[int, int]:
    """Delete every file under ``target`` (preserve the dir itself).

    Returns ``(bytes_freed, files_removed)``.
    """
    if not target.exists():
        return (0, 0)
    bytes_freed = 0
    files_removed = 0
    for child in target.iterdir():
        try:
            if child.is_file():
                size = child.stat().st_size
                child.unlink()
                bytes_freed += size
                files_removed += 1
            elif child.is_dir():
                size = _dir_size_bytes(child)
                shutil.rmtree(child, ignore_errors=True)
                bytes_freed += size
                files_removed += 1
        except OSError as exc:
            logger.warning("cache-flush: failed to delete %s: %s", child, exc)
    return (bytes_freed, files_removed)


@router.delete("/cache", response_model=CacheFlushResponse)
async def flush_cache(
    scope: Literal[
        "uploads", "snapshots", "data", "checkpoints", "fragments", "all"
    ] = Query("uploads"),
) -> CacheFlushResponse:
    """Delete files in one or more cache scopes.

    Scopes:
      - ``uploads`` - uploaded IFC files (re-uploadable, safe to flush).
      - ``snapshots`` - viewpoint snapshot images (regenerated on demand).
      - ``data`` - aabb / native-index / doc-index caches. Custom agents,
        prompts, and budget state are *also* in here; flushing this drops
        them. (UI should warn.)
      - ``checkpoints`` - IFC edit history. Destructive - UI must confirm.
      - ``fragments`` - converted-fragment cache (next load re-converts).
      - ``all`` - every cache scope above.
    """
    total_bytes = 0
    total_files = 0
    targets: list[Path] = []
    if scope == "uploads":
        targets = [UPLOAD_DIR]
    elif scope == "snapshots":
        targets = [SNAPSHOT_DIR]
    elif scope == "data":
        targets = [DATA_DIR]
    elif scope == "checkpoints":
        targets = [CHECKPOINT_DIR]
    elif scope == "fragments":
        targets = [FRAGMENT_CACHE_DIR]
    elif scope == "all":
        targets = [UPLOAD_DIR, SNAPSHOT_DIR, DATA_DIR, CHECKPOINT_DIR, FRAGMENT_CACHE_DIR]
    else:
        raise HTTPException(status_code=400, detail=f"Unknown scope: {scope}")
    for t in targets:
        b, f = _flush_dir(t)
        total_bytes += b
        total_files += f
    logger.info(
        "cache flush scope=%s bytes_freed=%d files_removed=%d",
        scope,
        total_bytes,
        total_files,
    )
    return CacheFlushResponse(
        scope=scope,
        bytes_freed=total_bytes,
        files_removed=total_files,
    )


def _evict_oldest_until_under_cap(target: Path, max_bytes: int) -> tuple[int, int]:
    """LRU sweep on ``target`` by mtime. Returns ``(bytes_freed, files_removed)``."""
    if max_bytes <= 0 or not target.exists():
        return (0, 0)
    files: list[tuple[Path, int, float]] = []
    for child in target.rglob("*"):
        if child.is_file():
            try:
                st = child.stat()
                files.append((child, st.st_size, st.st_mtime))
            except OSError:
                continue
    total = sum(s for _, s, _ in files)
    if total <= max_bytes:
        return (0, 0)
    files.sort(key=lambda t: t[2])  # oldest first
    bytes_freed = 0
    files_removed = 0
    for path, size, _ in files:
        if total - bytes_freed <= max_bytes:
            break
        try:
            path.unlink()
            bytes_freed += size
            files_removed += 1
        except OSError as exc:
            logger.warning("LRU-evict: failed to delete %s: %s", path, exc)
    return (bytes_freed, files_removed)


@router.post("/cache/enforce-cap")
async def enforce_cache_cap() -> dict[str, Any]:
    """Manually run the LRU sweep on the uploads dir against ``CACHE_MAX_BYTES``.

    The Settings UI calls this after the user changes the slider and
    confirms. Returns the bytes freed and files removed.
    """
    bytes_freed, files_removed = _evict_oldest_until_under_cap(UPLOAD_DIR, CACHE_MAX_BYTES)
    return {
        "scope": "uploads",
        "cap_bytes": CACHE_MAX_BYTES,
        "bytes_freed": bytes_freed,
        "files_removed": files_removed,
    }


@router.post("/cache/config")
async def update_cache_config(update: CacheConfigUpdate) -> dict[str, Any]:
    """Set the cache cap in process memory (and the IFC_VIEWER_CACHE_MAX_BYTES env).

    Note: this is a runtime override - it does NOT persist across process
    restarts. To persist, the user must set IFC_VIEWER_CACHE_MAX_BYTES in
    ``~/.ifc-atlas/.env`` (or the shell environment).
    """
    if update.cache_max_bytes < 0:
        raise HTTPException(status_code=400, detail="cache_max_bytes must be >= 0")
    # Update both this module's imported alias AND the source constant in
    # app.core.config (plus the env var). This module reads CACHE_MAX_BYTES
    # through its own import binding, so rebinding only the source would leave
    # enforce_cache_cap and get_data_paths on the stale cap until a restart.
    import app.core.config as _cfg  # local re-import for hot mutation

    global CACHE_MAX_BYTES
    CACHE_MAX_BYTES = update.cache_max_bytes
    _cfg.CACHE_MAX_BYTES = update.cache_max_bytes
    os.environ["IFC_VIEWER_CACHE_MAX_BYTES"] = str(update.cache_max_bytes)
    bytes_freed, files_removed = _evict_oldest_until_under_cap(UPLOAD_DIR, update.cache_max_bytes)
    return {
        "cache_max_bytes": update.cache_max_bytes,
        "bytes_freed": bytes_freed,
        "files_removed": files_removed,
        "note": "Runtime-only. Set IFC_VIEWER_CACHE_MAX_BYTES in .env to persist.",
    }


# ---------------------------------------------------------------------------
# Settings - provider status, configuration, and per-user secrets
# ---------------------------------------------------------------------------


def provider_status_payload() -> dict:
    """Per-provider configuration status, embedded in /chat/manager/bootstrap.

    The frontend never sees the actual key value, only whether one resolves,
    where it comes from (``env`` vs ``file``), and a short mask for display.
    """
    secrets_status = secrets_service.status_payload()

    def _entry(provider: str, name: str, base_url: Optional[str], default_model: str) -> dict:
        s = secrets_status.get(provider, {})
        return {
            "name": name,
            "configured": bool(s.get("configured")),
            "source": s.get("source"),
            "masked": s.get("masked", ""),
            "env_var": s.get("env_var", ""),
            "base_url": base_url,
            "default_model": default_model,
        }

    return {
        "openai": _entry("openai", "OpenAI", None, "gpt-4o"),
        "anthropic": _entry("anthropic", "Anthropic", None, "claude-sonnet-4-6"),
        "openrouter": _entry(
            "openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto"
        ),
    }


class SecretsUpdateRequest(BaseModel):
    """All fields optional - only the keys present in the payload are written."""

    openai: Optional[str] = Field(default=None)
    anthropic: Optional[str] = Field(default=None)
    openrouter: Optional[str] = Field(default=None)


@settings_router.get("/secrets")
async def get_secrets_status() -> dict:
    """Status-only view of the per-user secrets file. No raw keys."""
    return {"providers": secrets_service.status_payload()}


@settings_router.put("/secrets")
async def update_secrets(payload: SecretsUpdateRequest) -> dict:
    """Merge non-empty values from ``payload`` into ``secrets.json``.

    Empty / missing fields are ignored - to remove a key use DELETE.
    Returns the refreshed status so the UI can re-render in one round trip.
    """
    updates = {k: v for k, v in payload.model_dump().items() if v}
    if updates:
        secrets_service.set_api_keys(updates)
    return {"providers": secrets_service.status_payload()}


@settings_router.delete("/secrets/{provider}")
async def delete_secret(provider: str) -> dict:
    """Remove a stored key for ``provider``, or ``provider="all"``.

    Env-var keys are never touched - they live outside this store. If the
    user wants to remove an env-var key they must edit ``.env`` / their
    shell themselves.
    """
    if provider == "all":
        removed = secrets_service.delete_all()
        return {"removed": removed, "providers": secrets_service.status_payload()}
    if provider not in secrets_service.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")
    removed_ok = secrets_service.delete_api_key(provider)
    return {
        "removed": [provider] if removed_ok else [],
        "providers": secrets_service.status_payload(),
    }


# ---------------------------------------------------------------------------
# MCP server registry (read-only)
# ---------------------------------------------------------------------------


@mcp_router.get("/servers")
async def list_servers() -> dict:
    return {
        "source": mcp_registry.source,
        "enabled": mcp_registry.enabled_server_names(),
        "servers": mcp_registry.list_servers(),
    }


@mcp_router.post("/reload")
async def reload() -> dict:
    """Re-read the config file without restarting the backend.

    Useful after the operator hand-edits mcp_servers.json - saves the
    Uvicorn reload cycle. Idempotent and safe to spam.
    """
    mcp_registry.reload()
    return {
        "source": mcp_registry.source,
        "count": len(mcp_registry.list_servers()),
    }


# ---------------------------------------------------------------------------
# Working-vs-original model diff
# ---------------------------------------------------------------------------


class DiffAddedRow(BaseModel):
    express_id: int
    ifc_type: str
    name: Optional[str] = None


class DiffChangedRow(BaseModel):
    express_id: int
    ifc_type: str
    change: str
    name_before: Optional[str] = None
    name_after: Optional[str] = None
    property_changes: list[dict[str, Any]] = []


class DiffResponse(BaseModel):
    added: list[DiffAddedRow]
    removed: list[DiffAddedRow]
    changed: list[DiffChangedRow]
    counts: dict[str, int]
    truncated: bool
    has_working_copy: bool


def _check_loaded() -> None:
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")
    if ifc_service.original_path is None:
        raise HTTPException(400, "No original upload on record for this model")


def _has_working_copy() -> bool:
    # noqa: SLF001 - internal path access mirrors sandbox_service usage
    return ifc_service.original_path != ifc_service._file_path


def _model_cache_fingerprint() -> str:
    contract = ifc_service.get_model_contract()
    return f"{contract['model_fingerprint']}:{contract['model_version']}:{contract['edit_id']}"


@diff_router.get("/working-vs-original", response_model=DiffResponse)
async def diff_working_vs_original() -> dict[str, Any]:
    """Structural diff (added / removed / changed) of the working model vs the upload."""
    _check_loaded()
    summary = await asyncio.to_thread(
        working_vs_original,
        ifc_service.model,
        str(ifc_service.original_path),
        fingerprint=_model_cache_fingerprint(),
    )
    summary["has_working_copy"] = _has_working_copy()
    return summary


@diff_router.get("/working-vs-original.csv")
async def diff_working_vs_original_csv():
    """Download the change report as CSV."""
    _check_loaded()
    summary = await asyncio.to_thread(
        working_vs_original,
        ifc_service.model,
        str(ifc_service.original_path),
        fingerprint=_model_cache_fingerprint(),
    )
    return Response(
        content=diff_to_csv(summary),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="changes.csv"'},
    )
