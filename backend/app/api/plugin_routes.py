"""FastAPI routes for the plugin / user-script system.

CRUD over named, saved Python scripts plus a run endpoint that executes
them through the IFC code sandbox. Write-capable plugin runs stage a
pending edit and fan the same ``pending_edit`` model-sync event out as
the chat write tools, so the existing Diff Preview panel lights up.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.models.ifc_models import ModelSyncEvent
from app.services.ifc_service import ifc_service
from app.services.model_sync import model_sync_broker
from app.services.plugin_service import (
    MAX_PLUGIN_ZIP_BYTES,
    PluginValidationError,
    plugin_service,
)
from app.services.sandbox_service import sandbox_service

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class PluginCreateRequest(BaseModel):
    manifest: dict[str, Any]
    script: str


class PluginUpdateRequest(BaseModel):
    manifest: Optional[dict[str, Any]] = None
    script: Optional[str] = None


class PluginRunRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)


@router.get("")
async def list_plugins():
    """All installed plugins (built-ins first), manifest plus ``builtin`` flag."""
    return {"plugins": plugin_service.list_plugins()}


@router.post("", status_code=201)
async def create_plugin(req: PluginCreateRequest):
    """Install a new user plugin from an inline manifest + script."""
    try:
        return plugin_service.install(req.manifest, req.script)
    except PluginValidationError as exc:
        raise HTTPException(422, exc.errors) from exc
    except (FileExistsError, PermissionError) as exc:
        raise HTTPException(409, "Plugin id already exists") from exc


@router.post("/install-zip", status_code=201)
async def install_plugin_zip(file: UploadFile = File(...)):
    """Install a plugin from a zip holding manifest.json + script.py."""
    data = await file.read()
    if len(data) > MAX_PLUGIN_ZIP_BYTES:
        raise HTTPException(413, "Plugin zip too large (max 1 MB)")
    try:
        return await asyncio.to_thread(plugin_service.install_zip, data)
    except PluginValidationError as exc:
        raise HTTPException(422, exc.errors) from exc
    except (FileExistsError, PermissionError) as exc:
        raise HTTPException(409, "Plugin id already exists") from exc


@router.get("/{plugin_id}")
async def get_plugin(plugin_id: str):
    """Full plugin record: manifest, script source, and built-in flag."""
    try:
        return plugin_service.get_plugin(plugin_id)
    except KeyError as exc:
        raise HTTPException(404, f"Unknown plugin '{plugin_id}'") from exc


@router.put("/{plugin_id}")
async def update_plugin(plugin_id: str, req: PluginUpdateRequest):
    """Rewrite a user plugin's manifest and/or script."""
    try:
        return plugin_service.update(plugin_id, manifest=req.manifest, script=req.script)
    except PermissionError as exc:
        raise HTTPException(403, "Built-in plugins are read-only") from exc
    except KeyError as exc:
        raise HTTPException(404, f"Unknown plugin '{plugin_id}'") from exc
    except PluginValidationError as exc:
        raise HTTPException(422, exc.errors) from exc


@router.delete("/{plugin_id}")
async def delete_plugin(plugin_id: str):
    """Remove a user plugin from disk."""
    try:
        plugin_service.delete(plugin_id)
    except PermissionError as exc:
        raise HTTPException(403, "Built-in plugins are read-only") from exc
    except KeyError as exc:
        raise HTTPException(404, f"Unknown plugin '{plugin_id}'") from exc
    return {"deleted": True}


@router.post("/{plugin_id}/run")
async def run_plugin(plugin_id: str, req: PluginRunRequest):
    """Run a plugin in the IFC code sandbox with validated params.

    Read-only plugins return the sandbox execute_result/execute_error dict;
    write plugins stage a pending edit that flows through the existing
    preview/apply UI. Every result carries plugin_id + plugin_name.
    """
    if not ifc_service.is_loaded:
        raise HTTPException(400, "No IFC model loaded")
    try:
        # The sandbox spawns + blocks on a child process; keep it off the loop.
        result = await asyncio.to_thread(
            plugin_service.run, plugin_id, req.params, ifc_service=ifc_service
        )
    except KeyError as exc:
        raise HTTPException(404, f"Unknown plugin '{plugin_id}'") from exc
    except PluginValidationError as exc:
        raise HTTPException(422, exc.errors) from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        # Sandbox preconditions: pending-edit backlog full, oversized code, ...
        raise HTTPException(400, str(exc)) from exc

    # Sandbox-first edit contract: when a plugin stages a sandboxed diff,
    # fan a `pending_edit` event out on the model-sync WS so any open
    # DiffPreviewPanel (even in a different tab) lights up without polling.
    # Mirrors the chat write-tool publish in chat_routes.
    if result.get("action") == "pending_edit":
        edit_id = result.get("edit_id")
        envelope = sandbox_service.get_pending(edit_id) if edit_id else None
        if envelope is not None:
            contract = ifc_service.get_model_contract()
            await model_sync_broker.publish(
                ModelSyncEvent(
                    type="pending_edit",
                    model_version=contract["model_version"],
                    model_fingerprint=contract["model_fingerprint"],
                    edit_id=envelope.edit_id,
                    payload=envelope.model_dump(),
                )
            )
    return result
