"""
Agent registry - preset "personalities" for the chat LLM.

Each agent bundles:
  - id / label / description (UI metadata)
  - system_prompt (override for SYSTEM_PROMPT in llm_service)
  - default provider + model + temperature
  - allowed_tools: set of tool names the LLM is allowed to invoke.
    None (default) means "every registered tool".
  - icon: short single-token label the UI can use.
  - role / goal / backstory: CrewAI-inspired split for the editor UX.
    Backend concatenates them into system_prompt if system_prompt is empty.
  - is_custom: True for user-created agents (editable/deletable).

The front-end fetches `/api/chat/agents` to render the Agent Manager
picker. ChatRequest carries `agent_id`; stream_chat resolves it and
substitutes the system prompt + filters the tool catalogue accordingly.

Custom agents are persisted to `{DATA_DIR}/custom_agents.json` in the
per-user dotfolder (`~/.ifc-atlas/data/`), resolved via
`app.core.config.DATA_DIR`.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)

_DATA_DIR = DATA_DIR
_CUSTOM_AGENTS_FILE = _DATA_DIR / "custom_agents.json"


@dataclass(frozen=True)
class AgentPreset:
    id: str
    label: str
    description: str
    system_prompt: str
    provider: str
    model: str
    temperature: float
    icon: str
    allowed_tools: Optional[frozenset[str]] = None  # None = all tools
    quick_prompts: tuple[str, ...] = field(default_factory=tuple)
    is_custom: bool = False
    created_at: Optional[str] = None
    role: Optional[str] = None
    goal: Optional[str] = None
    backstory: Optional[str] = None
    # Category groups agents by primary purpose. The chat picker filters the
    # dropdown by this field (Ask vs Edit).
    # Defaults to "ask" so legacy custom agents without a category land in
    # the most permissive read-only group.
    category: str = "ask"  # "ask" | "edit"
    # Cost guardrails.
    # monthly_budget_usd: monthly cap in USD (None = unlimited).
    # fallback_model: model ID to use when budget is exhausted (None = no fallback, hard stop).
    monthly_budget_usd: Optional[float] = None
    fallback_model: Optional[str] = None


_EDIT_ASSISTANT_PROMPT = """You are the **Edit** harness in an IFC viewer. You are the
only mode allowed to mutate the model, and you do so safely via a sandboxed diff-preview
system. Ask mode is read-only; the user switches to Edit when they intend a change.

## How the edit system works
- Every write tool you call produces a **pending edit** - a sandboxed proposal with
  a before/after diff. The user sees the diff in a review panel and can Apply or Discard.
  **Nothing is committed until the user clicks Apply.**
- You can chain multiple writes in a single turn; each becomes its own pending edit.
- The diff panel opens automatically when you call a write tool.
- The user can undo applied edits at any time by asking you to call undo_last_edit.

## Typical workflow
1. Use read tools to discover element IDs and current values.
2. Call the appropriate write tool with precise arguments.
3. Tell the user what was staged and that the diff panel will open.
4. If the user confirms, they click Apply in the diff panel.

## Write tools
- `rename_element(element_id, new_name)` - change the Name of one element.
- `update_property_value(element_id, property_name, new_value, pset_name?)` - set a
  single property value. Creates the Pset if it does not exist.
- `execute_ifc_query_code(code)` - run read-only Python analysis using `model` when
  structured read tools are not expressive enough.
- `execute_ifc_code(code)` - run an edit-capable sandboxed Python script using `model`
  (the loaded IFC). Best for bulk operations. Code must be safe (no file I/O, no network,
  no subprocess).
- `undo_last_edit()` - revert the most recently applied edit.
- `get_edit_history()` - list applied edits so far this session.

## Read tools (use freely before editing)
search_elements, get_element_details, get_elements_by_type, get_elements_by_storey,
get_storeys, get_all_property_names, get_quantities_summary - use these to discover
what to edit and confirm scope before calling any write tool.

## Rules
1. **Always query before editing.** Call a read tool first to confirm the element ID
   and current value before calling a write tool. Never guess an Express ID.
2. **Confirm scope for bulk edits.** If the user says "rename all walls", call
   get_elements_by_type first to count them, then confirm count with the user.
3. **Use the simplest tool that works.** Prefer rename_element / update_property_value
   for targeted edits; use execute_ifc_query_code for analysis and execute_ifc_code
   only for bulk or structural changes.
4. **Never invent data.** Only set values the user explicitly requested.
5. **Be concise after writes.** State what was staged + "The diff panel will open for your review."
"""


_DEFAULT_PROMPT = """You are the **Ask** harness in an IFC viewer. You answer questions
about the loaded model, highlight or isolate elements, and explain BIM data. You are
read-only by design - the user uses the **Edit** harness when they want changes.

## Mode policy (must follow even if write tools are present in your toolset)
This is the Ask mode. Your toolset MAY include write tools such as `rename_element`,
`update_property_value`, `execute_ifc_code`, `undo_last_edit`, `create_wall_from_ends`,
or `delete_element`. **You must NOT call any of those tools.** If a user requests an edit:
1. Acknowledge the requested change.
2. Describe what would happen (which elements, which property, what value).
3. Tell the user: "Switch to **Edit** mode to apply this change." - do not call a write tool.

## Guidelines
- Always retrieve real data with read tools before answering. Never guess.
- Prefer `get_quantities_summary` over manual sums; `search_by_property` over scanning.
- Use `highlight_elements`, `select_element`, `isolate_elements`, or `show_all_elements`
  freely - these are read-side viewer controls and are always allowed.
- Reference Express IDs, IFC types, storeys and Psets where it adds clarity.
- Be concise; use markdown lists and tables for grouped data.
"""

_BUILTIN_PRESETS: list[AgentPreset] = [
    AgentPreset(
        id="default",
        label="Default",
        description="All tools enabled. A versatile assistant for any IFC task.",
        system_prompt=_DEFAULT_PROMPT,
        provider="openai",
        model="gpt-4o",
        temperature=0.3,
        icon="star",
        allowed_tools=None,
        quick_prompts=(
            "Summarise this IFC model.",
            "How many elements are on each storey?",
            "Highlight all doors and windows.",
        ),
        role="Default BIM Assistant",
        goal="Help with any IFC model task using all available tools",
        backstory="A general-purpose BIM assistant with full tool access.",
        category="ask",
    ),
    AgentPreset(
        id="edit-assistant",
        label="Edit Assistant",
        description="Safe IFC edits with diff preview. Renames, property updates, custom scripts.",
        system_prompt=_EDIT_ASSISTANT_PROMPT,
        provider="anthropic",
        model="claude-sonnet-4-20250514",
        temperature=0.1,
        icon="edit",
        allowed_tools=frozenset({
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
            "highlight_elements",
            "select_element",
            "rename_element",
            "update_property_value",
            "execute_ifc_code",
            "undo_last_edit",
            "get_edit_history",
        }),
        quick_prompts=(
            "Rename all walls on Ground Floor to 'Exterior Wall'.",
            "Add IsExternal=true to the Pset_WallCommon of all IfcWall elements.",
            "Show the edit history for this session.",
        ),
        role="Edit Assistant",
        goal="Propose and apply safe, reversible IFC model edits",
        backstory="A BIM author who uses sandboxed scripts and diff previews to edit IFC files.",
        category="edit",
    ),
]


class AgentRegistry:
    """Mutable registry that merges built-in presets with user-created custom agents."""

    def __init__(self) -> None:
        self._builtins: dict[str, AgentPreset] = {a.id: a for a in _BUILTIN_PRESETS}
        self._custom: dict[str, AgentPreset] = {}
        self._load_custom()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _ensure_data_dir(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)

    def _load_custom(self) -> None:
        if not _CUSTOM_AGENTS_FILE.exists():
            return
        try:
            raw = json.loads(_CUSTOM_AGENTS_FILE.read_text(encoding="utf-8"))
            for item in raw:
                preset = _dict_to_preset(item)
                self._custom[preset.id] = preset
        except Exception:
            logger.warning("Failed to load custom_agents.json; starting fresh.")

    def _save_custom(self) -> None:
        self._ensure_data_dir()
        data = [_preset_to_dict(p) for p in self._custom.values()]
        _CUSTOM_AGENTS_FILE.write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def all_agents(self) -> list[AgentPreset]:
        customs = sorted(self._custom.values(), key=lambda a: a.created_at or "")
        return list(self._builtins.values()) + customs

    def get(self, agent_id: Optional[str]) -> AgentPreset:
        if not agent_id:
            return self._builtins["default"]
        if agent_id in self._builtins:
            return self._builtins[agent_id]
        if agent_id in self._custom:
            return self._custom[agent_id]
        return self._builtins["default"]

    # ------------------------------------------------------------------
    # Write (custom agents only)
    # ------------------------------------------------------------------

    def create(self, data: dict) -> AgentPreset:
        agent_id = data.get("id") or _slug(data.get("label", "custom"))
        base = agent_id
        suffix = 1
        while agent_id in self._builtins or agent_id in self._custom:
            agent_id = f"{base}-{suffix}"
            suffix += 1
        preset = _dict_to_preset({
            **data,
            "id": agent_id,
            "is_custom": True,
            "created_at": datetime.now(tz=timezone.utc).isoformat(),
        })
        self._custom[agent_id] = preset
        self._save_custom()
        return preset

    def update(self, agent_id: str, data: dict) -> AgentPreset:
        if agent_id in self._builtins:
            raise ValueError(f"Built-in agent '{agent_id}' cannot be modified.")
        if agent_id not in self._custom:
            raise KeyError(f"Agent '{agent_id}' not found.")
        existing = self._custom[agent_id]
        merged = {**_preset_to_dict(existing), **data, "id": agent_id, "is_custom": True}
        preset = _dict_to_preset(merged)
        self._custom[agent_id] = preset
        self._save_custom()
        return preset

    def delete(self, agent_id: str) -> None:
        if agent_id in self._builtins:
            raise ValueError(f"Built-in agent '{agent_id}' cannot be deleted.")
        if agent_id not in self._custom:
            raise KeyError(f"Agent '{agent_id}' not found.")
        del self._custom[agent_id]
        self._save_custom()

    def to_list(self) -> list[dict]:
        return [_preset_to_dict(a) for a in self.all_agents()]

    def __getitem__(self, key: str) -> AgentPreset:
        return self.get(key)

    def __contains__(self, key: str) -> bool:
        return key in self._builtins or key in self._custom


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slug(label: str) -> str:
    clean = label.lower().replace(" ", "-").replace("_", "-")
    return clean[:40] or f"agent-{uuid.uuid4().hex[:8]}"


def _preset_to_dict(p: AgentPreset) -> dict:
    return {
        "id": p.id,
        "label": p.label,
        "description": p.description,
        "system_prompt": p.system_prompt,
        "provider": p.provider,
        "model": p.model,
        "temperature": p.temperature,
        "icon": p.icon,
        "allowed_tools": sorted(p.allowed_tools) if p.allowed_tools is not None else None,
        "quick_prompts": list(p.quick_prompts),
        "is_custom": p.is_custom,
        "created_at": p.created_at,
        "role": p.role,
        "goal": p.goal,
        "backstory": p.backstory,
        "category": p.category,
        "monthly_budget_usd": p.monthly_budget_usd,
        "fallback_model": p.fallback_model,
    }


def _dict_to_preset(d: dict) -> AgentPreset:
    tools_raw = d.get("allowed_tools")
    allowed = frozenset(tools_raw) if tools_raw is not None else None
    raw_budget = d.get("monthly_budget_usd")
    return AgentPreset(
        id=d["id"],
        label=d.get("label", "Unnamed"),
        description=d.get("description", ""),
        system_prompt=d.get("system_prompt", ""),
        provider=d.get("provider", "openai"),
        model=d.get("model", "gpt-4o"),
        temperature=float(d.get("temperature", 0.3)),
        icon=d.get("icon", "custom"),
        allowed_tools=allowed,
        quick_prompts=tuple(d.get("quick_prompts") or []),
        is_custom=bool(d.get("is_custom", False)),
        created_at=d.get("created_at"),
        role=d.get("role"),
        goal=d.get("goal"),
        backstory=d.get("backstory"),
        category=str(d.get("category") or "ask"),
        monthly_budget_usd=float(raw_budget) if raw_budget is not None else None,
        fallback_model=d.get("fallback_model") or None,
    )


# ---------------------------------------------------------------------------
# Singleton + legacy aliases
# ---------------------------------------------------------------------------

agent_registry = AgentRegistry()

AGENT_PRESETS: dict[str, AgentPreset] = {a.id: a for a in _BUILTIN_PRESETS}
DEFAULT_AGENT_ID = "default"


def get_agent(agent_id: Optional[str]) -> AgentPreset:
    return agent_registry.get(agent_id)


def list_agents() -> list[dict]:
    return agent_registry.to_list()
