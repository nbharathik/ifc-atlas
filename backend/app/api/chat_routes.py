"""Chat WebSocket endpoint and tool router.

Streams multi-provider LLM responses to the frontend and dispatches IFC query/edit
tool calls (server-side via ``tools``/``ifc_service``, or client-side over the socket).
"""

import asyncio
import json
import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File

from fastapi import HTTPException
from pydantic import BaseModel

from app.models.ifc_models import ChatRequest, ModelSyncEvent
from app.core.config import EDIT_MODE_ENABLED
from app.api.settings_routes import provider_status_payload
from app.services.agent_registry import agent_registry, list_agents
from app.services.agent_graph import graph_manager
from app.services.ifc_service import ifc_service
from app.services.llm_service import stream_chat
from app.services.mcp_registry import mcp_registry
from app.services.model_context_injector import model_context_injector
from app.services.model_registry import model_registry
from app.services.model_sync import model_sync_broker
from app.services.prompt_library import prompt_library
from app.services.snippet_service import snippet_service
from app.services.sandbox_service import sandbox_service
from app.services.tool_sets import tool_set_registry
from app.services.tools import execute_tool, tool_tier, tool_where, get_tool_catalog
from app.services.tool_settings_service import tool_settings_service
from app.services.session_memory import SessionMemory

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)


def check_global_disable_block(tool_name: str) -> Optional[dict]:
    """Pure helper for the global tool-disable gate.

    The Tools registry tab lets users globally disable a tool
    regardless of any agent's allow-list. This check runs in
    ``router_tool_executor`` AFTER the ask-vs-write mode gate but
    BEFORE the per-agent allow-list, so a globally-disabled tool is
    refused even for the unrestricted Default agent.

    Returns ``{error, blocked_by_global_disable: True, tool}`` when
    disabled; ``None`` otherwise.
    """
    if tool_settings_service.is_disabled(tool_name):
        return {
            "error": (
                f"Tool '{tool_name}' has been globally disabled in the "
                f"Chat Manager > Tools tab. Re-enable it there to allow "
                f"agents to call it."
            ),
            "blocked_by_global_disable": True,
            "tool": tool_name,
        }
    return None


def check_allowlist_block(agent: Any, tool_name: str) -> Optional[dict]:
    """Pure helper for the runtime allowlist gate.

    Returns a ``{error, blocked_by_allowlist: True}`` envelope when the
    agent has an explicit allow-list and ``tool_name`` is not in it.
    Returns ``None`` when the call should proceed (no allow-list, or the
    tool is allowed).

    The provider streamers already filter the schema via
    ``_filter_tools(...)``; this check is defence-in-depth for prompt
    injection / history drift cases where a disallowed tool name slips
    through.
    """
    if agent is None:
        return None
    allowed = getattr(agent, "allowed_tools", None)
    if allowed is None:
        return None
    if tool_name in allowed:
        return None
    return {
        "error": (
            f"Tool '{tool_name}' is not in agent "
            f"'{getattr(agent, 'id', '?')}'s allow-list. Update the "
            f"agent's Tool Access settings to enable it."
        ),
        "blocked_by_allowlist": True,
    }


class AgentCreateRequest(BaseModel):
    label: str
    description: str = ""
    system_prompt: str = ""
    provider: str = "openai"
    model: str = "gpt-4o"
    temperature: float = 0.3
    icon: str = "custom"
    allowed_tools: list[str] | None = None
    quick_prompts: list[str] = []
    role: str | None = None
    goal: str | None = None
    backstory: str | None = None
    category: str = "ask"  # "ask" | "edit"
    monthly_budget_usd: float | None = None
    fallback_model: str | None = None


@router.get("/agents")
async def get_agents():
    """Return the catalogue of agent presets for the UI picker."""
    return {"agents": list_agents()}


@router.post("/agents")
async def create_agent(body: AgentCreateRequest):
    """Create a new custom agent preset."""
    preset = agent_registry.create(body.model_dump())
    return {"agent": _preset_response(preset)}


@router.put("/agents/{agent_id}")
async def update_agent(agent_id: str, body: AgentCreateRequest):
    """Update an existing custom agent preset."""
    try:
        preset = agent_registry.update(agent_id, body.model_dump(exclude_none=False))
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"agent": _preset_response(preset)}


@router.delete("/agents/{agent_id}")
async def delete_agent(agent_id: str):
    """Delete a custom agent preset."""
    try:
        agent_registry.delete(agent_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": agent_id}


def _preset_response(preset) -> dict:
    from app.services.agent_registry import _preset_to_dict
    return _preset_to_dict(preset)


@router.get("/budget/summary")
async def get_budget_summary():
    """Return the current-month USD spend per agent.

    Response shape:
      {
        "month": "2026-05",
        "agents": [
          {"agent_id": "...", "label": "...", "spent_usd": 0.123, "budget_usd": 5.0, "status": "ok"}
        ]
      }
    """
    from app.services.budget_tracker import budget_tracker

    all_spent = budget_tracker.get_all_spent()
    agents = list_agents()

    rows = []
    for ag in agents:
        spent = all_spent.get(ag["id"], 0.0)
        budget_usd = ag.get("monthly_budget_usd")
        check = budget_tracker.check_budget(ag["id"], budget_usd)
        rows.append({
            "agent_id": ag["id"],
            "label": ag["label"],
            "spent_usd": round(spent, 6),
            "budget_usd": budget_usd,
            "status": check["status"],
        })

    # Only include agents with any spend or a budget cap set
    active = [r for r in rows if r["spent_usd"] > 0 or r["budget_usd"] is not None]

    return {
        "month": budget_tracker._month_key,
        "agents": active,
    }


@router.delete("/budget/{agent_id}", status_code=200)
async def reset_agent_budget(agent_id: str):
    """Reset the current-month spend counter for a single agent.

    Useful for correcting erroneous charges or for testing.  Does not modify
    the agent's monthly_budget_usd cap - only the accumulated spend.
    Returns ``{"reset": agent_id, "previous_spent_usd": float}``.
    """
    from app.services.budget_tracker import budget_tracker

    previous = budget_tracker.get_spent(agent_id)
    budget_tracker.reset_agent(agent_id)
    return {"reset": agent_id, "previous_spent_usd": round(previous, 6)}


# ---------------------------------------------------------------------------
# Tool Sets - named, reusable bundles of tool names
# ---------------------------------------------------------------------------

class ToolSetRequest(BaseModel):
    label: str
    description: str = ""
    tools: list[str] = []
    icon: str = "wrench"


@router.get("/tool-sets")
async def get_tool_sets():
    return {"tool_sets": tool_set_registry.list_dicts()}


@router.post("/tool-sets")
async def create_tool_set(body: ToolSetRequest):
    ts = tool_set_registry.create(body.model_dump())
    return {"tool_set": _ts_dict(ts)}


@router.put("/tool-sets/{set_id}")
async def update_tool_set(set_id: str, body: ToolSetRequest):
    try:
        ts = tool_set_registry.update(set_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"tool_set": _ts_dict(ts)}


@router.delete("/tool-sets/{set_id}")
async def delete_tool_set(set_id: str):
    try:
        tool_set_registry.delete(set_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": set_id}


def _ts_dict(ts) -> dict:
    from app.services.tool_sets import _to_dict
    return _to_dict(ts)


# ---------------------------------------------------------------------------
# System Prompt Library
# ---------------------------------------------------------------------------

class PromptRequest(BaseModel):
    label: str
    description: str = ""
    content: str = ""
    category: str = "ask"  # ask | plan | edit | general


@router.get("/prompts")
async def get_prompts():
    return {"prompts": prompt_library.list_dicts()}


@router.post("/prompts")
async def create_prompt(body: PromptRequest):
    p = prompt_library.create(body.model_dump())
    return {"prompt": _prompt_dict(p)}


@router.put("/prompts/{prompt_id}")
async def update_prompt(prompt_id: str, body: PromptRequest):
    try:
        p = prompt_library.update(prompt_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"prompt": _prompt_dict(p)}


@router.delete("/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str):
    try:
        prompt_library.delete(prompt_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": prompt_id}


def _prompt_dict(p) -> dict:
    from app.services.prompt_library import _to_dict
    return _to_dict(p)


# ---------------------------------------------------------------------------
# Model Registry - UI-configurable catalogue of LLM models
# ---------------------------------------------------------------------------

class ModelRequest(BaseModel):
    provider: str = "openai"          # openai | anthropic | openrouter
    model_id: str = ""
    display_name: str = ""
    use_case: str = "fast_chat"
    temperature: float = 0.3
    top_p: float | None = None
    max_output_tokens: int | None = None
    # Normalised reasoning shape: null | {"effort": "..."} | {"budget_tokens": N}
    reasoning: dict | None = None
    supports_tools: bool = True
    supports_vision: bool = False
    supports_structured_output: bool = True
    cost_tier: str = "medium"         # free | low | medium | high
    speed_tier: str = "medium"        # slow | medium | fast
    # Approximate USD per 1M tokens; drives cost telemetry + budget caps.
    # None = unknown (cost omitted from usage events).
    input_cost_per_1m: float | None = None
    output_cost_per_1m: float | None = None
    notes: str = ""
    enabled: bool = True


class ModelReorderRequest(BaseModel):
    order: list[str] = []


@router.get("/models")
async def get_models():
    """Return the full model catalogue (enabled + disabled) for the Models tab."""
    return {"models": model_registry.list_dicts()}


@router.post("/models")
async def create_model(body: ModelRequest):
    m = model_registry.create(body.model_dump())
    return {"model": _model_dict(m)}


@router.put("/models/reorder")
async def reorder_models(body: ModelReorderRequest):
    """Persist a new display order. Body: ``{order: [entry_id, ...]}``."""
    models = model_registry.reorder(body.order)
    from app.services.model_registry import _to_dict
    return {"models": [_to_dict(m) for m in models]}


@router.put("/models/{model_id}")
async def update_model(model_id: str, body: ModelRequest):
    try:
        m = model_registry.update(model_id, body.model_dump())
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"model": _model_dict(m)}


@router.delete("/models/{model_id}")
async def delete_model(model_id: str):
    try:
        model_registry.delete(model_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": model_id}


def _model_dict(m) -> dict:
    from app.services.model_registry import _to_dict
    return _to_dict(m)


# ---------------------------------------------------------------------------
# Prompt Snippets - user-message templates for the chat panel
# ---------------------------------------------------------------------------

class SnippetRequest(BaseModel):
    title: str
    body: str
    tags: list[str] = []


@router.get("/snippets")
async def get_snippets():
    """Return all prompt snippets (built-ins + custom)."""
    return {"snippets": snippet_service.list_dicts()}


@router.post("/snippets", status_code=201)
async def create_snippet(body: SnippetRequest):
    """Create a new custom prompt snippet."""
    s = snippet_service.create(body.model_dump())
    return {"snippet": _snippet_dict(s)}


@router.put("/snippets/{snippet_id}")
async def update_snippet(snippet_id: str, body: SnippetRequest):
    """Update a custom prompt snippet."""
    try:
        s = snippet_service.update(snippet_id, body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"snippet": _snippet_dict(s)}


@router.delete("/snippets/{snippet_id}")
async def delete_snippet(snippet_id: str):
    """Delete a custom prompt snippet."""
    try:
        snippet_service.delete(snippet_id)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"deleted": snippet_id}


def _snippet_dict(s) -> dict:
    from app.services.snippet_service import _to_dict
    return _to_dict(s)


@router.get("/manager/bootstrap")
async def get_manager_bootstrap():
    """Return all Chat Manager data in one payload.

    The frontend uses this to avoid multiple parallel REST calls when opening
    the manager modal, which significantly reduces perceived load latency.
    """
    return {
        "tool_sets": tool_set_registry.list_dicts(),
        "prompts": prompt_library.list_dicts(),
        "tools": get_tool_catalog(),
        "snippets": snippet_service.list_dicts(),
        "agents": list_agents(),
        "models": model_registry.list_dicts(),
        "mcp": {
            "source": mcp_registry.source,
            "enabled": mcp_registry.enabled_server_names(),
            "servers": mcp_registry.list_servers(),
        },
        "providers": provider_status_payload(),
    }


# ---------------------------------------------------------------------------
# Model context endpoint - returns what the injector would prepend
# ---------------------------------------------------------------------------

@router.get("/tools")
async def get_tools():
    """Return the full tool catalog enriched with tier metadata for the Agent Manager UI."""
    return {"tools": get_tool_catalog()}


class ToolSettingsPayload(BaseModel):
    disabled_tools: list[str] = []


@router.get("/tools/settings")
async def get_tool_settings():
    """Read the global tool enable/disable settings.

    Returns ``{disabled_tools: [name, ...]}`` (sorted, deduplicated).
    Frontend Tools registry tab reads this to render toggles.
    """
    return {"disabled_tools": sorted(tool_settings_service.get_disabled())}


@router.put("/tools/settings")
async def set_tool_settings(payload: ToolSettingsPayload):
    """Overwrite the global tool enable/disable settings.

    The frontend sends the full disabled set on every toggle (idempotent).
    The service persists immediately + returns the canonical sorted set.
    """
    updated = tool_settings_service.set_disabled(payload.disabled_tools)
    return {"disabled_tools": sorted(updated)}


def _selection_context_block(selected_ids: list[int], cap: int = 20) -> str:
    """Markdown block describing the user's CURRENT viewer selection (D6).

    Client-authoritative ids enriched with type/name from the loaded model
    when available. Empty string when nothing is selected. Never raises -
    selection context is a convenience, not a dependency.
    """
    if not selected_ids:
        return ""
    lines: list[str] = []
    try:
        model = ifc_service.model if ifc_service.is_loaded else None
    except Exception:  # noqa: BLE001
        model = None
    for eid in selected_ids[:cap]:
        try:
            entity = model.by_id(int(eid)) if model is not None else None
        except (RuntimeError, ValueError, TypeError):
            entity = None
        if entity is None:
            lines.append(f"- #{eid}")
            continue
        name = getattr(entity, "Name", None) or "Unnamed"
        lines.append(f"- #{eid} {entity.is_a()} '{name}'")
    suffix = ""
    if len(selected_ids) > cap:
        suffix = f"\n(+{len(selected_ids) - cap} more selected)"
    return (
        "## Current selection (3D viewer)\n"
        "The user has these elements selected right now; \"the selected "
        "element/wall/etc.\" refers to them:\n" + "\n".join(lines) + suffix
    )


@router.get("/context")
async def get_model_context():
    """Return the context block currently injected into agent system prompts.

    The frontend Agent Harness panel displays this so users know exactly
    what model metadata the agents receive automatically.
    """
    block = model_context_injector.get_context_block(ifc_service)
    return {
        "context_block": block,
        "has_model": ifc_service._model is not None,
    }


# ── Graph thread state ───────────────────────────────────────────────────────

@router.get("/thread/{thread_id}/state")
async def get_thread_state(thread_id: str):
    """Return the latest checkpoint for a LangGraph thread.

    The frontend can call this on reconnect to restore conversation history
    without the user needing to repeat themselves.

    When no checkpoint exists yet (fresh thread, graph_mode was False, or
    LangGraph isn't installed), an empty-state payload is returned with HTTP
    200 instead of 404. The frontend always asks once on mount; returning an
    empty payload keeps the browser console quiet for the common "new thread"
    case without changing observable behaviour (frontend treats missing
    history as no-op either way).
    """
    state = graph_manager.load_thread(thread_id)
    if state is None:
        return {
            "thread_id": thread_id,
            "messages": [],
            "pending_edit": None,
            "session_summary": "",
            "graph_available": graph_manager.available,
        }

    def _norm_content(c) -> str:
        """Normalize LangGraph message content to a plain string."""
        if isinstance(c, list):
            return " ".join(
                block.get("text", "") if isinstance(block, dict) else str(block)
                for block in c
            )
        return str(c) if c is not None else ""

    raw_msgs = state.get("messages", [])
    messages = [
        {
            "role": m.get("role", "assistant") if isinstance(m, dict) else getattr(m, "type", "assistant"),
            "content": _norm_content(m.get("content", "") if isinstance(m, dict) else getattr(m, "content", "")),
        }
        for m in raw_msgs
    ]

    return {
        "thread_id": thread_id,
        "messages": messages,
        "pending_edit": state.get("pending_edit"),
        "session_summary": state.get("session_summary", ""),
        "graph_available": graph_manager.available,
    }


@router.delete("/thread/{thread_id}/state")
async def delete_thread_state(thread_id: str):
    """Clear the checkpoint for a thread (user explicitly starts fresh)."""
    graph_manager.delete_thread(thread_id)
    return {"deleted": thread_id}


# ── Document Index ────────────────────────────────────────────────────────────

_ALLOWED_MIME = {"application/pdf", "text/markdown", "text/plain", "text/x-markdown"}
_ALLOWED_EXT = {".pdf", ".md", ".txt", ".markdown"}


@router.get("/docs")
async def list_docs():
    """Return all indexed document metadata, newest first."""
    from app.services.document_index_service import document_index_service
    return {"docs": document_index_service.list_docs()}


@router.post("/docs/upload")
async def upload_doc(file: UploadFile = File(...)):
    """Upload a PDF or Markdown file and index it for agent search."""
    from pathlib import Path
    from app.services.document_index_service import document_index_service

    fname = file.filename or "document"
    ext = Path(fname).suffix.lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{ext}'. Allowed: PDF, MD, TXT.",
        )

    content = await file.read()
    if len(content) > 20 * 1024 * 1024:  # 20 MB hard cap
        raise HTTPException(status_code=413, detail="File too large (max 20 MB).")

    try:
        meta = document_index_service.index_document(fname, content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    return {"doc": meta}


@router.delete("/docs/{doc_id}")
async def delete_doc(doc_id: str):
    """Remove a document from the index."""
    from app.services.document_index_service import document_index_service
    found = document_index_service.delete_doc(doc_id)
    if not found:
        raise HTTPException(status_code=404, detail=f"Document '{doc_id}' not found.")
    return {"deleted": doc_id}


@router.get("/docs/semantic-status")
async def doc_semantic_status():
    """Return the current semantic-search status for the document index.

    Reports whether fastembed + hnswlib are available, whether the HNSW
    index has been built, the model in use, and the current chunk count.
    Useful for the frontend to surface 'Semantic search active' / 'BM25 only'
    badges without additional client-side detection logic.
    """
    from app.services.document_index_service import document_index_service
    return document_index_service.semantic_status()


@router.get("/reference-docs/status")
async def reference_docs_status():
    """Status of the AI reference-docs index (IfcOpenShell API, IFC schema).

    Drives the Chat Manager "Knowledge" tab: how many reference documents are
    indexed and whether semantic search is active. Distinct from ``/docs`` which
    manages the *user's* uploaded documents; reference docs are the API/schema
    knowledge the ``get_docs`` tool consults.
    """
    from app.services.reference_docs_service import reference_docs_service
    return reference_docs_service.status()


@router.post("/reference-docs/fetch")
async def reference_docs_fetch(source: str = "ifcopenshell"):
    """(Re)build the reference-docs index from installed sources.

    Currently indexes the installed IfcOpenShell Python API docstrings (grouped
    per API domain). Runs off the event loop - importing and walking the package
    takes a few seconds - so the chat WebSocket stays responsive. Returns the
    index result (indexed domain count, ifcopenshell version). Idempotent: a
    re-fetch clears and rebuilds.
    """
    import asyncio

    from app.services.reference_docs_service import reference_docs_service

    if source not in ("ifcopenshell", "all"):
        return {"ok": False, "error": f"unknown source '{source}'. Use 'ifcopenshell' or 'all'."}
    return await asyncio.to_thread(reference_docs_service.index_ifcopenshell_api)


# How long a single client-executed tool call may take before the
# router gives up and injects an error into the LLM loop. Keeps a slow
# or frozen browser from stalling the whole chat turn.
CLIENT_TOOL_TIMEOUT_SECONDS = 30.0


# ---------------------------------------------------------------------------
# WebSocket event vocabulary for /api/chat/ws.
#
# The structured WS_EVENT comment blocks below are the source of truth for
# docs/api/WEBSOCKET.md - scripts/generate_api_doc.py extracts them. Keep
# them in sync with the emit sites in chat_websocket() below: every event
# type that can reach the client must have a block here, and nothing else.
# ---------------------------------------------------------------------------

# WS_EVENT: chat_request
# Client -> server. Starts an agent turn. Any JSON object whose "type" is not "tool_result" is parsed as a ChatRequest; a "type" field is optional and ignored. Malformed payloads get an "error" event back.
# Only "message" is required. "tool_mode" is one of "server" | "client" | "hybrid". "model_registry_id" (when set) resolves provider/model/sampling from the Model Registry and overrides "provider"/"model"/"temperature". "use_graph" + "thread_id" opt in to server-side conversation checkpointing.
# Schema: {"message": "How many walls are on the ground floor?", "history": [{"role": "user", "content": "..."}], "provider": "openai", "model": "gpt-4o", "temperature": 0.3, "tool_mode": "hybrid", "agent_id": "default", "attachments": [], "tool_set_id": null, "prompt_id": null, "model_registry_id": null, "use_graph": false, "thread_id": null}

# WS_EVENT: chunk
# Server -> client. A streamed text fragment from the LLM.
# Schema: {"type": "chunk", "content": "There are 42 walls "}

# WS_EVENT: tool_call
# Server -> client. The agent is invoking a tool.
# Schema: {"type": "tool_call", "name": "search_elements", "arguments": {"query": "wall"}}

# WS_EVENT: tool_result
# Server -> client. The result of a tool call. "executed_on" is "server" or "client".
# When a write tool stages a sandboxed edit, "result" carries {"action": "pending_edit", "edit_id": "...", ...}; the pending_edit / pending_applied / pending_discarded broadcasts themselves go out on the separate model-sync WebSocket at /api/ifc/sync/ws, not on this socket.
# Schema: {"type": "tool_result", "name": "search_elements", "result": {"elements": [], "total": 42}, "executed_on": "server"}

# WS_EVENT: tool_call_request
# Server -> client. Asks the browser to execute a client-side tool (viewer-state tools in "client"/"hybrid" tool mode). The client must reply within 30 seconds with a tool_result ack: {"type": "tool_result", "tool_call_id": "<same id>", "result": {...}}.
# Schema: {"type": "tool_call_request", "tool_call_id": "a1b2c3", "name": "get_camera_state", "arguments": {}}

# WS_EVENT: memory_update
# Server -> client. The per-connection session memory accumulated new facts from tool results.
# Schema: {"type": "memory_update", "facts": ["Model has 42 walls"]}

# WS_EVENT: highlight
# Server -> client. Viewer command: highlight the given elements.
# Schema: {"type": "highlight", "element_ids": [123, 456]}

# WS_EVENT: select
# Server -> client. Viewer command: select one element.
# Schema: {"type": "select", "element_id": 123}

# WS_EVENT: isolate
# Server -> client. Viewer command: isolate the given elements (hide everything else).
# Schema: {"type": "isolate", "element_ids": [123, 456]}

# WS_EVENT: show_all
# Server -> client. Viewer command: clear isolation and show the full model.
# Schema: {"type": "show_all"}

# WS_EVENT: clip_section_box
# Server -> client. Viewer command: fit a clipping section box around one element.
# Schema: {"type": "clip_section_box", "element_id": 123}

# WS_EVENT: metadata_changed
# Server -> client. A committed edit changed element metadata. "renamed" is optional ({"id", "old_name", "new_name"}-style payload) and only present for rename edits.
# Schema: {"type": "metadata_changed", "changed_ids": [123], "description": "Renamed wall", "renamed": null}

# WS_EVENT: entity_delta
# Server -> client. Partial model update signal: which entities changed and which dependent entities are now dirty. "delta_type" is "metadata" or "geometry".
# Schema: {"type": "entity_delta", "changed_ids": [123], "dirty_ids": [456], "delta_type": "metadata"}

# WS_EVENT: usage
# Server -> client. Per-turn token + cost telemetry. "cost_usd" is present only when pricing is known for the model. The cache fields (cache_read_tokens, cache_creation_tokens, cache_hit_ratio, cached_cost_usd) are present only when prompt caching was active.
# Schema: {"type": "usage", "model": "gpt-4o", "provider": "openai", "input_tokens": 1200, "output_tokens": 300, "cost_usd": 0.0105}

# WS_EVENT: model_fallback
# Server -> client. The agent's monthly budget cap was reached, so this turn runs on the agent's configured fallback model instead of the requested one.
# Schema: {"type": "model_fallback", "original_model": "gpt-4o", "fallback_model": "gpt-4o-mini", "reason": "budget_cap", "used_usd": 5.01, "budget_usd": 5.0}

# WS_EVENT: budget_warning
# Server -> client. The agent's monthly spend is near or over its budget cap. "at_cap" is true once the cap is exceeded.
# Schema: {"type": "budget_warning", "used_usd": 4.61, "budget_usd": 5.0, "ratio": 0.92, "agent_id": "default", "at_cap": false}

# WS_EVENT: done
# Server -> client. The agent finished its response; "content" is the full assembled assistant text.
# Schema: {"type": "done", "content": "There are 42 walls on the ground floor."}

# WS_EVENT: error
# Server -> client. An error occurred (invalid chat payload, in-band stream error, or an unhandled exception during the turn).
# Schema: {"type": "error", "content": "Invalid chat payload: ..."}


@router.websocket("/ws")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()

    # Per-connection inbox for chat requests from the browser.
    chat_queue: asyncio.Queue[Optional[ChatRequest]] = asyncio.Queue()

    # Per-connection session memory - accumulates facts from tool results
    # so the agent avoids redundant info-gathering tool calls.
    session_mem = SessionMemory()

    # Pending futures for in-flight client-side tool calls, keyed by the
    # server-generated tool_call_id.
    pending_tool_calls: dict[str, asyncio.Future] = {}

    async def receive_loop() -> None:
        """Continuously drain the WS so client tool_result acks can
        arrive while the main chat loop is awaiting a tool_executor."""
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("chat WS received non-JSON payload")
                    continue

                if not isinstance(payload, dict):
                    continue

                msg_type = payload.get("type")
                if msg_type == "tool_result":
                    tool_call_id = payload.get("tool_call_id")
                    fut = pending_tool_calls.get(tool_call_id) if tool_call_id else None
                    if fut and not fut.done():
                        fut.set_result(payload.get("result"))
                    continue

                # Anything else is treated as a chat request. Fail loudly
                # on malformed payloads so the client sees an error.
                try:
                    request = ChatRequest(**payload)
                except Exception as e:
                    await websocket.send_json({
                        "type": "error",
                        "content": f"Invalid chat payload: {e}",
                    })
                    continue
                await chat_queue.put(request)
        except WebSocketDisconnect:
            pass
        finally:
            # Signal the chat loop to stop and unblock any pending tool
            # calls so they can clean up without hanging.
            await chat_queue.put(None)
            for fut in list(pending_tool_calls.values()):
                if not fut.done():
                    fut.cancel()

    async def call_client_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Send a tool_call_request over the WS and await the ack."""
        tool_call_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        pending_tool_calls[tool_call_id] = fut
        try:
            await websocket.send_json({
                "type": "tool_call_request",
                "tool_call_id": tool_call_id,
                "name": name,
                "arguments": args,
            })
            try:
                result = await asyncio.wait_for(fut, timeout=CLIENT_TOOL_TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                return {
                    "_executed_on_client": True,
                    "error": f"Client tool '{name}' did not respond within "
                             f"{int(CLIENT_TOOL_TIMEOUT_SECONDS)}s.",
                }
            except asyncio.CancelledError:
                return {
                    "_executed_on_client": True,
                    "error": f"Client tool '{name}' was cancelled (client disconnected?).",
                }

            # Normalise: a well-behaved client sends a dict; anything else
            # is wrapped so the LLM always sees structured JSON.
            if not isinstance(result, dict):
                result = {"result": result}
            # Stamp the result so the UI (and the chat history log) show
            # this as a client-executed tool.
            result["_executed_on_client"] = True
            return result
        finally:
            pending_tool_calls.pop(tool_call_id, None)

    async def chat_loop() -> None:
        while True:
            request = await chat_queue.get()
            if request is None:  # disconnect signal
                return

            async def router_tool_executor(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
                """Route each tool call based on its declared `where` and
                the request's tool_mode."""
                # Runtime gate: write (mutating) tools are refused when either
                # (a) the agent is an ask-category agent, or (b) the v1 Edit
                # surface is gated off (EDIT_MODE_ENABLED is False). This is
                # defence-in-depth against prompt injection / history replay
                # slipping a write call past the schema filter in stream_chat.
                # Backend wiring stays in place; flip EDIT_MODE_ENABLED (env) +
                # the frontend flag to re-enable the Edit surface.
                _agent = agent_registry.get(request.agent_id)
                tier_id, _ = tool_tier(name)
                if tier_id == "write_edit" and (
                    not EDIT_MODE_ENABLED or (_agent and _agent.category == "ask")
                ):
                    return {
                        "error": (
                            f"Tool '{name}' is a write tool, but model editing is "
                            "disabled in this version."
                            if not EDIT_MODE_ENABLED
                            else f"Tool '{name}' is a write tool. Ask mode is "
                            "read-only - switch to Edit mode to make changes."
                        ),
                        "blocked_by_mode": True,
                    }

                # Global tool-disable gate (Tools registry tab).
                _global_block = check_global_disable_block(name)
                if _global_block is not None:
                    return _global_block

                # Defence-in-depth allowlist check.
                _allowlist_block = check_allowlist_block(_agent, name)
                if _allowlist_block is not None:
                    return _allowlist_block

                effective_mode = request.tool_mode
                target = tool_where(name)
                if effective_mode == "server":
                    target = "server"
                elif effective_mode == "client" and target == "server":
                    return {
                        "error": (
                            f"Tool '{name}' is marked server-only but the "
                            f"client requested tool_mode='client'."
                        ),
                    }
                # "hybrid" leaves `target` at whatever the tool declared.
                if target == "client":
                    return await call_client_tool(name, arguments)
                # Off-loop so slow tools (bSDD WAN calls, sandbox runs) don't
                # freeze the chat WebSocket; write tools serialize on the
                # shared edit lock inside the wrapper.
                from app.services.tools import execute_tool_off_loop

                result = await execute_tool_off_loop(name, arguments)

                # Sandbox-first edit contract: when a write tool stages a sandboxed diff,
                # fan a `pending_edit` event out on the model-sync WS so
                # any open DiffPreviewPanel (even in a different tab)
                # lights up without polling.
                if result.get("action") == "pending_edit":
                    edit_id = result.get("edit_id")
                    envelope = (
                        sandbox_service.get_pending(edit_id) if edit_id else None
                    )
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

            try:
                full_response = ""
                _context_block = model_context_injector.get_context_block(ifc_service)
                # Merge session memory block (if enough facts accumulated) with
                # the model context block so the agent gets both without an
                # extra tool call.
                _mem_block = session_mem.get_block()
                if _mem_block:
                    _context_block = (
                        _context_block + "\n\n" + _mem_block
                        if _context_block
                        else _mem_block
                    )
                # Current viewer selection (D6): per-turn, client-authoritative,
                # NOT cached with the per-model context (selection changes
                # every click).
                _sel_block = _selection_context_block(request.selected_ids)
                if _sel_block:
                    _context_block = (
                        _context_block + "\n\n" + _sel_block
                        if _context_block
                        else _sel_block
                    )
                async for event in stream_chat(
                    message=request.message,
                    history=request.history,
                    provider=request.provider,
                    model=request.model,
                    temperature=request.temperature,
                    tool_executor=router_tool_executor,
                    agent_id=request.agent_id,
                    attachments=request.attachments,
                    context_block=_context_block,
                    tool_set_id=request.tool_set_id,
                    prompt_id=request.prompt_id,
                    model_registry_id=request.model_registry_id,
                ):
                    event_type = event.get("type")

                    if event_type == "chunk":
                        full_response += event["content"]
                        await websocket.send_json({
                            "type": "chunk",
                            "content": event["content"],
                        })
                    elif event_type == "tool_call":
                        await websocket.send_json({
                            "type": "tool_call",
                            "name": event["name"],
                            "arguments": event["arguments"],
                        })
                    elif event_type == "tool_result":
                        result_data = event.get("result")
                        tool_result_name = event.get("name", "")
                        await websocket.send_json({
                            "type": "tool_result",
                            "name": tool_result_name,
                            "result": result_data,
                            "executed_on": event.get("executed_on"),
                        })
                        # Update session memory and emit memory_update if changed.
                        if tool_result_name and session_mem.update(tool_result_name, result_data):
                            await websocket.send_json({
                                "type": "memory_update",
                                "facts": session_mem.get_facts_list(),
                            })
                    elif event_type == "highlight":
                        await websocket.send_json({
                            "type": "highlight",
                            "element_ids": event["element_ids"],
                        })
                    elif event_type == "select":
                        await websocket.send_json({
                            "type": "select",
                            "element_id": event["element_id"],
                        })
                    elif event_type == "isolate":
                        await websocket.send_json({
                            "type": "isolate",
                            "element_ids": event["element_ids"],
                        })
                    elif event_type == "show_all":
                        await websocket.send_json({"type": "show_all"})
                    elif event_type == "clip_section_box":
                        await websocket.send_json({
                            "type": "clip_section_box",
                            "element_id": event["element_id"],
                        })
                    elif event_type == "metadata_changed":
                        await websocket.send_json({
                            "type": "metadata_changed",
                            "changed_ids": event.get("changed_ids", []),
                            "description": event.get("description", ""),
                            "renamed": event.get("renamed"),
                        })
                    elif event_type == "entity_delta":
                        # Partial model update signal.
                        await websocket.send_json({
                            "type": "entity_delta",
                            "changed_ids": event.get("changed_ids", []),
                            "dirty_ids": event.get("dirty_ids", []),
                            "delta_type": event.get("delta_type", "metadata"),
                        })
                    elif event_type == "usage":
                        # Per-turn cost + cache telemetry.
                        await websocket.send_json(event)
                    elif event_type == "error":
                        # In-band stream errors (e.g. the agent stream was
                        # interrupted mid-turn). llm_service emits these under
                        # "message"; the client reads "content" - normalise.
                        await websocket.send_json({
                            "type": "error",
                            "content": event.get("message") or event.get("content") or "Chat stream error.",
                        })
                    elif event_type in ("model_fallback", "budget_warning"):
                        await websocket.send_json(event)

                await websocket.send_json({
                    "type": "done",
                    "content": full_response,
                })

                # Graph checkpoint - persist turn state when client opts in.
                if request.use_graph and request.thread_id:
                    # Build the full message list for this thread:
                    # existing history + user turn + assistant reply.
                    checkpoint_messages = [
                        {"role": m.role, "content": m.content}
                        for m in request.history
                    ]
                    checkpoint_messages.append({"role": "user", "content": request.message})
                    if full_response:
                        checkpoint_messages.append({"role": "assistant", "content": full_response})

                    # session_memory stores display-formatted strings, not
                    # structured dicts - it never carries pending_edit
                    # payloads, so leave it as None here. (The previous
                    # ``fact.get("tool")`` loop assumed dict facts and crashed
                    # the chat turn with 'str' object has no attribute 'get'
                    # the moment any session fact accumulated.)
                    _pending = None

                    # The answer is already delivered ("done" sent above); a
                    # checkpoint failure must not surface as a chat error that
                    # replaces it client-side. Log and move on.
                    try:
                        graph_manager.save_turn(
                            thread_id=request.thread_id,
                            messages=checkpoint_messages,
                            pending_edit=_pending,
                            session_summary=session_mem.get_block(),
                            provider=request.provider,
                            model_id=request.model or "gpt-4o",
                            temperature=request.temperature or 0.3,
                            agent_id=request.agent_id,
                        )
                    except Exception:
                        logger.exception("post-turn checkpoint failed (answer already delivered)")

            except Exception as e:
                logger.exception("chat loop error")
                try:
                    await websocket.send_json({
                        "type": "error",
                        "content": str(e),
                    })
                except Exception:
                    pass

    receive_task = asyncio.create_task(receive_loop(), name="chat-ws-recv")
    chat_task = asyncio.create_task(chat_loop(), name="chat-ws-loop")
    try:
        await chat_task
    finally:
        receive_task.cancel()
        try:
            await receive_task
        except (asyncio.CancelledError, Exception):
            pass


