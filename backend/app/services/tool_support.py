"""Tool support services: per-turn memoization, tool sets, global settings.

Short-lived in-memory memoization cache for read-only agent tool calls.
Within a single LLM turn, read-only tools called with identical arguments
return the cached result instead of re-executing the IFC service query.
This eliminates redundant get_model_stats / get_storeys / get_project_info
calls that multi-round ReAct loops frequently repeat.

Usage:
    # At the start of each LLM turn:
    tool_memo_cache.new_turn()

    # Instead of execute_tool(name, args):
    result = tool_memo_cache.get_or_execute(name, args, execute_tool)

Tool Sets - named, reusable groupings of tools. Inspired by Claude Desktop's
Skills/Connectors model and VS Code's Copilot chat tool picker: a "tool set"
is a labelled bundle of tool names that any harness (Ask / Edit) or custom
agent can adopt with a single click. This decouples *what tools are
available* from *who is asking*, so the user can curate "IDS Tools" or
"Quantity Surveying" once and re-use them. Persistence mirrors AgentRegistry:
built-in presets in code, user-created sets in
`~/.ifc-atlas/data/tool_sets.json` (`DATA_DIR`). The registry merges them and
exposes list / get / create / update / delete.

Global tool enable/disable persistence: the Tools registry tab lets users
globally disable a tool: "don't let any agent call ``execute_ifc_code``,
regardless of the agent's per-allowlist." ``ToolSettingsService`` stores that
set in JSON on disk so the choice survives a restart.

Wire model:
- Singleton-ish ``tool_settings_service`` mirrors the pattern used by
  ``sandbox_service`` / ``patch_generator`` etc.
- Disk path: ``~/.ifc-atlas/data/tool_settings.json`` (``DATA_DIR``).
  Created lazily on first write; an absent file means "no disabled
  tools" (default).
- API surface: ``get_disabled()`` returns ``frozenset[str]``;
  ``set_disabled(names)`` overwrites the full set;
  ``add_disabled(name)`` / ``remove_disabled(name)`` are convenience
  mutators. All persist immediately.
- Routing gate: ``chat_routes.router_tool_executor`` calls
  ``is_disabled(name)`` after the per-agent allowlist; a disabled
  tool returns ``{blocked_by_global_disable: true, error: "..."}``.

Thread-safe reads; writes serialised through a single lock so two
concurrent UI toggles can't corrupt the JSON.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

# Tools safe to memoize - must be purely read-only with no side effects.
# Cache keys include the full argument dict, so every mode/part/include of a
# merged tool memoizes independently.
MEMOIZABLE_TOOLS: frozenset[str] = frozenset(
    {
        "describe_model",
        "query_elements",
        "get_element",
        "quantity_summary",
        "execute_ifc_query_code",
        "get_edit_history",
    }
)


# Legacy → merged tool-name migration for persisted user state (custom tool
# sets in tool_sets.json, custom agents' allowed_tools). Maps every
# pre-consolidation tool name to its merged successor; a ``None`` value means
# the tool was removed with no successor. Names not in this map are either
# already current or unknown - unknowns are dropped silently by
# ``migrate_tool_names`` (never an error).
LEGACY_TOOL_NAMES: dict[str, Optional[str]] = {
    "get_project_info": "describe_model",
    "get_model_stats": "describe_model",
    "get_storeys": "describe_model",
    "get_all_property_names": "describe_model",
    "search_elements": "query_elements",
    "search_elements_semantic": "query_elements",
    "get_elements_by_type": "query_elements",
    "get_elements_by_storey": "query_elements",
    "find_elements_by_type_name": "query_elements",
    "search_by_property": "query_elements",
    "filter_by_property_value": "query_elements",
    "find_nearby_elements": "query_elements",
    "get_element_details": "get_element",
    "get_element_material": "get_element",
    "get_openings_for_element": "get_element",
    "get_connected_elements": "get_element",
    "get_element_relationships": "get_element",
    "highlight_elements": "viewer_control",
    "select_element": "viewer_control",
    "isolate_elements": "viewer_control",
    "show_all_elements": "viewer_control",
    "clip_section_box_to_element": "viewer_control",
    "get_quantities_summary": "quantity_summary",
    "get_cost_summary": "quantity_summary",
    "get_carbon_summary": "quantity_summary",
    "run_model_health_check": "validate_model",
    "run_model_audit": "validate_model",
    "ids_validate": "validate_model",
    "highlight_ids_failures": "validate_model",
    "bsdd_search": "get_docs",
    "bsdd_get_class": "get_docs",
    "bsdd_get_properties": "get_docs",
    "search_document_index": "get_docs",
    "rename_element": "edit_semantic",
    "rename_elements_batch": "edit_semantic",
    "update_property_value": "edit_semantic",
    "update_properties_batch": "edit_semantic",
    "update_element_attribute": "edit_semantic",
    # propose_edit could only stage semantic ops (set_name/set_property), so
    # its capability successor is edit_semantic - mapping it to
    # edit_structural would grant create/delete powers it never had.
    "propose_edit": "edit_semantic",
    "create_wall_from_ends": "edit_structural",
    "delete_element": "edit_structural",
}


def migrate_tool_names(names: Iterable[str]) -> tuple[str, ...]:
    """Map a persisted tool-name list onto the current catalog.

    Legacy names translate through ``LEGACY_TOOL_NAMES`` (deduplicated,
    order-preserving); names mapped to ``None`` and names unknown to the
    current catalog are dropped without error.
    """
    from app.services.tools import all_tool_names  # local - avoid import cycle

    known = all_tool_names()
    out: list[str] = []
    for raw in names:
        name = LEGACY_TOOL_NAMES.get(raw, raw)
        if name is None or name not in known:
            continue
        if name not in out:
            out.append(name)
    return tuple(out)

_Key = tuple[str, str]


def _make_key(name: str, arguments: dict[str, Any]) -> _Key:
    """Return a hashable cache key for (tool_name, arguments).

    Serialised via JSON so list/dict-valued arguments (e.g. the merged
    tools' ``include`` / ``ops`` lists) key correctly instead of raising
    ``unhashable type`` at cache-probe time."""
    try:
        args_key = json.dumps(arguments, sort_keys=True, default=repr)
    except (TypeError, ValueError):
        args_key = repr(sorted((k, repr(v)) for k, v in arguments.items()))
    return (name, args_key)


class ToolMemoCache:
    """
    Ephemeral per-turn memo cache for idempotent (read-only) tool calls.

    Call ``new_turn()`` at the start of every LLM agent turn to flush stale
    results.  The ``ttl`` is a safety net for callers that forget to call
    ``new_turn()`` - any entry older than ``ttl`` seconds is silently evicted
    on the next ``get()``.
    """

    def __init__(self, ttl: float = 5.0) -> None:
        self._ttl = ttl
        self._cache: dict[_Key, tuple[dict[str, Any], float]] = {}
        self._turn_id: int = 0
        self._hits: int = 0
        self._misses: int = 0

    # -- Lifecycle --------------------------------------------------------

    def new_turn(self) -> None:
        """Evict all entries - call once per LLM agent turn."""
        self._cache.clear()
        self._turn_id += 1

    def invalidate(self) -> None:
        """Evict everything (e.g. after a write tool mutates the model)."""
        self._cache.clear()

    # -- Core get / put ---------------------------------------------------

    def get(self, name: str, arguments: dict[str, Any]) -> dict[str, Any] | None:
        """Return the cached result if still valid, else None."""
        if name not in MEMOIZABLE_TOOLS:
            return None
        key = _make_key(name, arguments)
        entry = self._cache.get(key)
        if entry is None:
            self._misses += 1
            return None
        result, ts = entry
        if time.monotonic() - ts > self._ttl:
            del self._cache[key]
            self._misses += 1
            return None
        self._hits += 1
        return result

    def put(self, name: str, arguments: dict[str, Any], result: dict[str, Any]) -> None:
        """Cache a result (only for memoizable, non-error results)."""
        if name not in MEMOIZABLE_TOOLS:
            return
        if "error" in result:
            return
        key = _make_key(name, arguments)
        self._cache[key] = (result, time.monotonic())

    def get_or_execute(
        self,
        name: str,
        arguments: dict[str, Any],
        execute_fn: Callable[[str, dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        """Return cached result or call ``execute_fn`` and cache the result."""
        cached = self.get(name, arguments)
        if cached is not None:
            return {**cached, "_memo": True}
        result = execute_fn(name, arguments)
        self.put(name, arguments, result)
        return result

    # -- Introspection ----------------------------------------------------

    @property
    def size(self) -> int:
        return len(self._cache)

    @property
    def turn_id(self) -> int:
        return self._turn_id

    @property
    def hit_rate(self) -> float:
        total = self._hits + self._misses
        return self._hits / total if total > 0 else 0.0

    def stats(self) -> dict[str, Any]:
        return {
            "turn_id": self._turn_id,
            "size": self.size,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(self.hit_rate, 3),
            "ttl": self._ttl,
        }


# Module-level singleton - shared across all streaming_agent calls in the
# same process.  ``new_turn()`` is called by llm_service at the top of each
# agent invocation so results never leak between turns.
tool_memo_cache = ToolMemoCache(ttl=5.0)


# ---------------------------------------------------------------------------
# Tool sets
# ---------------------------------------------------------------------------

_DATA_DIR = DATA_DIR
_TOOL_SETS_FILE = _DATA_DIR / "tool_sets.json"


@dataclass(frozen=True)
class ToolSet:
    id: str
    label: str
    description: str
    tools: tuple[str, ...]  # empty tuple means "all available tools"
    is_custom: bool = False
    created_at: Optional[str] = None
    icon: str = "wrench"

    @property
    def is_all_tools(self) -> bool:
        return len(self.tools) == 0


_BUILTIN: list[ToolSet] = [
    ToolSet(
        id="all",
        label="All Tools",
        description="Every registered tool. Use for a fully unrestricted agent.",
        tools=tuple(),  # sentinel for "no filter"
        icon="layers",
    ),
    ToolSet(
        id="read-only",
        label="Read Only",
        description="Read-only tools - no viewer mutations or model edits.",
        tools=(
            "describe_model",
            "query_elements",
            "get_element",
            "quantity_summary",
            "validate_model",
            "execute_ifc_query_code",
            "get_docs",
        ),
        icon="search",
    ),
    ToolSet(
        id="ask-default",
        label="Ask · Default",
        description="Read tools plus viewer controls - optimised for Q&A and exploration.",
        tools=(
            "describe_model",
            "query_elements",
            "get_element",
            "quantity_summary",
            "validate_model",
            "execute_ifc_query_code",
            "get_docs",
            "viewer_control",
        ),
        icon="message-square",
    ),
    ToolSet(
        id="viewer-only",
        label="Viewer Controls",
        description="Highlight, isolate, hide and show - no model edits or backend reads.",
        tools=("viewer_control",),
        icon="eye",
    ),
    ToolSet(
        id="ids",
        label="IDS Validation",
        description="buildingSMART IDS validation tools.",
        tools=("validate_model",),
        icon="shield",
    ),
    ToolSet(
        id="quantity",
        label="Quantity Surveying",
        description="Quantity takeoff, counts, grouped totals, cost and carbon estimates.",
        tools=(
            "describe_model",
            "query_elements",
            "quantity_summary",
        ),
        icon="ruler",
    ),
    ToolSet(
        id="edit-tools",
        label="Edit · Sandboxed",
        description="Read tools plus safe write tools (edit_semantic / execute_ifc_code).",
        tools=(
            "describe_model",
            "query_elements",
            "get_element",
            "execute_ifc_query_code",
            "get_docs",
            "viewer_control",
            "edit_semantic",
            "execute_ifc_code",
            "undo_last_edit",
            "get_edit_history",
        ),
        icon="edit",
    ),
]


class ToolSetRegistry:
    def __init__(self) -> None:
        self._builtins: dict[str, ToolSet] = {t.id: t for t in _BUILTIN}
        self._custom: dict[str, ToolSet] = {}
        self._load()

    # ---- persistence ----
    def _load(self) -> None:
        if not _TOOL_SETS_FILE.exists():
            return
        try:
            raw = json.loads(_TOOL_SETS_FILE.read_text(encoding="utf-8"))
            for d in raw:
                ts = _from_dict(d)
                if ts.id in self._builtins:
                    continue
                self._custom[ts.id] = ts
        except Exception as e:
            logger.warning("Failed to load tool sets: %s", e)

    def _save(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = [_to_dict(t) for t in self._custom.values()]
        _TOOL_SETS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # ---- read ----
    def all(self) -> list[ToolSet]:
        return list(self._builtins.values()) + list(self._custom.values())

    def get(self, set_id: str) -> Optional[ToolSet]:
        return self._builtins.get(set_id) or self._custom.get(set_id)

    def list_dicts(self) -> list[dict]:
        return [_to_dict(t) for t in self.all()]

    # ---- write (custom only) ----
    def create(self, data: dict) -> ToolSet:
        set_id = data.get("id") or _slug(data.get("label", "set"))
        base = set_id
        n = 1
        while set_id in self._builtins or set_id in self._custom:
            set_id = f"{base}-{n}"
            n += 1
        ts = ToolSet(
            id=set_id,
            label=data.get("label", "Untitled"),
            description=data.get("description", ""),
            tools=tuple(data.get("tools") or []),
            is_custom=True,
            created_at=datetime.now(tz=timezone.utc).isoformat(),
            icon=data.get("icon", "wrench"),
        )
        self._custom[set_id] = ts
        self._save()
        return ts

    def update(self, set_id: str, data: dict) -> ToolSet:
        if set_id in self._builtins:
            raise ValueError(f"Built-in tool set '{set_id}' cannot be modified.")
        if set_id not in self._custom:
            raise KeyError(f"Tool set '{set_id}' not found.")
        existing = self._custom[set_id]
        ts = ToolSet(
            id=set_id,
            label=data.get("label", existing.label),
            description=data.get("description", existing.description),
            tools=tuple(data.get("tools", existing.tools)),
            is_custom=True,
            created_at=existing.created_at,
            icon=data.get("icon", existing.icon),
        )
        self._custom[set_id] = ts
        self._save()
        return ts

    def delete(self, set_id: str) -> None:
        if set_id in self._builtins:
            raise ValueError(f"Built-in tool set '{set_id}' cannot be deleted.")
        if set_id not in self._custom:
            raise KeyError(f"Tool set '{set_id}' not found.")
        del self._custom[set_id]
        self._save()


def _slug(s: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")
    return out or f"set-{uuid.uuid4().hex[:6]}"


def _to_dict(t: ToolSet) -> dict:
    return {
        "id": t.id,
        "label": t.label,
        "description": t.description,
        "tools": list(t.tools),
        "is_custom": t.is_custom,
        "created_at": t.created_at,
        "icon": t.icon,
    }


def _from_dict(d: dict) -> ToolSet:
    raw_tools = tuple(d.get("tools") or [])
    # Persisted sets may predate the merged catalog: translate legacy names.
    # An empty tuple is the "all tools" sentinel, so a non-empty set whose
    # names all fail migration keeps its (now inert) originals rather than
    # silently widening to every tool.
    tools = migrate_tool_names(raw_tools) if raw_tools else raw_tools
    if raw_tools and not tools:
        tools = raw_tools
    return ToolSet(
        id=d["id"],
        label=d.get("label", "Untitled"),
        description=d.get("description", ""),
        tools=tools,
        is_custom=bool(d.get("is_custom", True)),
        created_at=d.get("created_at"),
        icon=d.get("icon", "wrench"),
    )


tool_set_registry = ToolSetRegistry()


# ---------------------------------------------------------------------------
# Global tool enable/disable persistence
# ---------------------------------------------------------------------------


def _default_storage_path() -> Path:
    """Pick the storage path. Honours ``TOOL_SETTINGS_PATH`` env var so
    tests can override + future Tauri runs can point at the user-data
    dir without code changes."""
    override = os.environ.get("TOOL_SETTINGS_PATH")
    if override:
        return Path(override)
    # Default sits alongside the other DATA_DIR/*.json singletons. Imported
    # lazily so this module can be loaded by tests without triggering the
    # user-home setup in app.core.config.
    from app.core.config import DATA_DIR

    return Path(DATA_DIR) / "tool_settings.json"


class ToolSettingsService:
    """Tiny JSON-backed registry of globally-disabled tool names."""

    def __init__(self, path: Path | None = None) -> None:
        self._path = path or _default_storage_path()
        self._lock = threading.Lock()
        self._disabled: set[str] = set()
        self._load()

    # ──────────────────────────────────────────────────────────────────
    # Persistence
    # ──────────────────────────────────────────────────────────────────

    def _load(self) -> None:
        try:
            if not self._path.exists():
                return
            raw = self._path.read_text(encoding="utf-8")
            data = json.loads(raw)
            disabled = data.get("disabled_tools", [])
            if isinstance(disabled, list):
                self._disabled = {str(name) for name in disabled if isinstance(name, str)}
        except (OSError, ValueError) as exc:  # corrupt JSON / read failure
            logger.warning("tool_settings load failed; defaulting empty: %s", exc)
            self._disabled = set()

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"disabled_tools": sorted(self._disabled)}
            self._path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError as exc:
            logger.warning("tool_settings save failed: %s", exc)

    # ──────────────────────────────────────────────────────────────────
    # Read API
    # ──────────────────────────────────────────────────────────────────

    def get_disabled(self) -> frozenset[str]:
        """Snapshot of the currently-disabled tool names. Thread-safe."""
        with self._lock:
            return frozenset(self._disabled)

    def is_disabled(self, name: str) -> bool:
        """True iff ``name`` is in the disabled set."""
        with self._lock:
            return name in self._disabled

    # ──────────────────────────────────────────────────────────────────
    # Write API
    # ──────────────────────────────────────────────────────────────────

    def set_disabled(self, names: Iterable[str]) -> frozenset[str]:
        """Overwrite the disabled set with ``names``. Returns the new set."""
        with self._lock:
            self._disabled = {str(n) for n in names}
            self._save()
            return frozenset(self._disabled)

    def add_disabled(self, name: str) -> frozenset[str]:
        with self._lock:
            self._disabled.add(name)
            self._save()
            return frozenset(self._disabled)

    def remove_disabled(self, name: str) -> frozenset[str]:
        with self._lock:
            self._disabled.discard(name)
            self._save()
            return frozenset(self._disabled)

    def clear(self) -> None:
        """Drop everything. Persists an empty set."""
        with self._lock:
            self._disabled.clear()
            self._save()


# Module-level singleton. Tests that need isolation construct their own
# ``ToolSettingsService(path=tmp_path / 'x.json')`` and pass it in.
tool_settings_service = ToolSettingsService()
