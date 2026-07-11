"""
Tool Sets - named, reusable groupings of tools.

Inspired by Claude Desktop's Skills/Connectors model and VS Code's Copilot
chat tool picker: a "tool set" is a labelled bundle of tool names that any
harness (Ask / Edit) or custom agent can adopt with a single click.
This decouples *what tools are available* from *who is asking*, so the user
can curate "IDS Tools" or "Quantity Surveying" once and re-use them.

Persistence mirrors AgentRegistry: built-in presets in code, user-created
sets in `~/.ifc-atlas/data/tool_sets.json` (`DATA_DIR`). The registry
merges them and exposes list / get / create / update / delete.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

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
            "get_project_info",
            "get_model_stats",
            "search_elements",
            "get_element_details",
            "get_elements_by_type",
            "get_elements_by_storey",
            "get_storeys",
            "search_by_property",
            "get_all_property_names",
            "get_quantities_summary",
            "get_cost_summary",
            "get_carbon_summary",
            "get_element_relationships",
            "run_model_audit",
            "execute_ifc_query_code",
            "get_docs",
            "bsdd_search",
            "bsdd_get_class",
            "bsdd_get_properties",
        ),
        icon="search",
    ),
    ToolSet(
        id="ask-default",
        label="Ask · Default",
        description="Read tools plus viewer controls - optimised for Q&A and exploration.",
        tools=(
            "get_project_info",
            "get_model_stats",
            "search_elements",
            "get_element_details",
            "get_elements_by_type",
            "get_elements_by_storey",
            "get_storeys",
            "search_by_property",
            "get_all_property_names",
            "get_quantities_summary",
            "get_cost_summary",
            "get_carbon_summary",
            "get_element_relationships",
            "run_model_audit",
            "execute_ifc_query_code",
            "get_docs",
            "bsdd_search",
            "bsdd_get_class",
            "bsdd_get_properties",
            "highlight_elements",
            "select_element",
            "isolate_elements",
            "show_all_elements",
        ),
        icon="message-square",
    ),
    ToolSet(
        id="viewer-only",
        label="Viewer Controls",
        description="Highlight, isolate, hide and show - no model edits or backend reads.",
        tools=(
            "highlight_elements",
            "select_element",
            "isolate_elements",
            "show_all_elements",
        ),
        icon="eye",
    ),
    ToolSet(
        id="ids",
        label="IDS Validation",
        description="buildingSMART IDS validation tools.",
        tools=("ids_validate",),
        icon="shield",
    ),
    ToolSet(
        id="quantity",
        label="Quantity Surveying",
        description="Quantity takeoff, counts, grouped totals, cost and carbon estimates.",
        tools=(
            "get_project_info",
            "get_model_stats",
            "get_quantities_summary",
            "get_cost_summary",
            "get_carbon_summary",
            "get_elements_by_type",
            "get_elements_by_storey",
            "get_storeys",
            "search_by_property",
        ),
        icon="ruler",
    ),
    ToolSet(
        id="edit-tools",
        label="Edit · Sandboxed",
        description="Read tools plus safe write tools (rename / update / execute_ifc_code).",
        tools=(
            "get_project_info",
            "get_model_stats",
            "search_elements",
            "get_element_details",
            "get_elements_by_type",
            "get_elements_by_storey",
            "get_storeys",
            "search_by_property",
            "get_all_property_names",
            "execute_ifc_query_code",
            "get_docs",
            "bsdd_search",
            "bsdd_get_class",
            "bsdd_get_properties",
            "highlight_elements",
            "select_element",
            "rename_element",
            "update_property_value",
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
    return ToolSet(
        id=d["id"],
        label=d.get("label", "Untitled"),
        description=d.get("description", ""),
        tools=tuple(d.get("tools") or []),
        is_custom=bool(d.get("is_custom", True)),
        created_at=d.get("created_at"),
        icon=d.get("icon", "wrench"),
    )


tool_set_registry = ToolSetRegistry()
