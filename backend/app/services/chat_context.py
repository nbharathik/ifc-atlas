"""Chat context services: prompt library, model context injection, session memory.

System Prompt Library - named, reusable system prompts. Sister service to
the tool sets registry. The user can curate a library of named system
prompts ("Quantity Takeoff Specialist", "Edit Coach") and swap them onto any
harness or custom agent without rewriting the prompt each time.

Model Context Injector - dynamic IFC model context for agent system prompts.
Every time stream_chat() is called the injector builds a compact (<200 token)
markdown block describing the currently loaded IFC model and prepends it to
the agent's system prompt.  This eliminates the "cold start" round-trip where
agents waste a tool call just to learn what model is loaded. The block is
cached per model fingerprint so it is only built once per unique model file,
then reused for every message in the session.

Session Memory - per-WebSocket-connection fact accumulator for LLM agents.
Extracts structured facts from tool results and injects them as a compact
"Session memory" block into the next turn's system prompt. This eliminates
redundant tool calls (e.g., the agent doesn't need to re-call get_model_stats
if it already knows the element count from this session).

Session memory design:
- One SessionMemory per WS connection (instantiated in chat_routes.py).
- Facts are keyed strings, deduplicated - a new result for the same key
  replaces the old one (no unbounded growth).
- max_facts cap (default 15) prevents the block from ballooning.
- Extraction is deterministic from structured tool results only.
- Block is emitted to the client as a "memory_update" WS event on change.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from app.core.config import DATA_DIR

if TYPE_CHECKING:
    from app.services.ifc_service import IfcService

logger = logging.getLogger(__name__)

_DATA_DIR = DATA_DIR
_PROMPTS_FILE = _DATA_DIR / "system_prompts.json"


@dataclass(frozen=True)
class SystemPromptEntry:
    id: str
    label: str
    description: str = ""
    content: str = ""
    category: str = "ask"  # ask | plan | edit | general
    is_custom: bool = False
    created_at: Optional[str] = None


_DEFAULT_ASK_PROMPT = """You are a versatile BIM assistant embedded in an IFC viewer.
You have access to every available tool: model queries, viewer controls, validation,
and safe edit operations. Help the user with anything related to the loaded IFC model.

Guidelines:
- Use tools to retrieve real data before answering. Never guess or hallucinate values.
- For questions, use describe_model, query_elements, or get_element.
- For highlighting or focusing on elements, use viewer_control (action='highlight'
  or 'isolate').
- For quantity questions, use quantity_summary (kind='qto').
- For editing, always preview changes and confirm with the user before applying.
- Be concise, use markdown lists and tables where helpful.
"""


_QUANTITY_TAKEOFF_SKILL = """\
You are the **Quantity Takeoff Specialist** for an IFC viewer.  Your job is to
produce a complete, auditable quantity report from the loaded IFC model.

Working method - always follow this order:

1. **Confirm scope**. Restate to the user: which element types, which storeys,
   which units (metric default - m² / m³ / m). If the user did not specify,
   default to ALL load-bearing trades (`IfcWall`, `IfcSlab`, `IfcBeam`,
   `IfcColumn`, `IfcWindow`, `IfcDoor`, `IfcStair`, `IfcRoof`) and call this
   out before tooling.

2. **Source quantities preferentially from IfcQuantitySet** (Qto_…) values
   over Pset properties or derived geometry.  Call `quantity_summary`
   (kind='qto') first; only fall back to `execute_ifc_query_code` when the
   Qto set is missing for the trade in question.

3. **Group by**, in this order: storey → element type → material.  Always
   show subtotals at each level and a grand total.

4. **Output the report as a markdown table** with these columns:
   `Storey | Type | Material | Count | Area (m²) | Volume (m³) | Length (m)`.
   Empty cells use `-`.  After the table, include a one-paragraph caveat:
   - Note any element types skipped (no Qto data, count = 0, etc.).
   - Note units used and any unit conversion performed.
   - Note that areas are gross / net based on the IfcQuantityArea attribute.

5. **Cite tool calls** in a "Methodology" line at the end so the user can
   reproduce the report.  Example:
   *Methodology: quantity_summary kind='qto' (3 trades) → query_elements
   mode='storey' (each level) → quantity_summary per type.*

Rules:
- NEVER guess a value.  If `quantity_summary` returns null for a
  property, mark the cell `-` and explain in the caveat.
- NEVER convert units silently.  If the model is imperial and the user
  asked for metric, do the conversion in `execute_ifc_query_code` and
  state the source unit explicitly.
- Stop and ask the user if the model has no `IfcQuantitySet` data at all -
  do not silently regenerate quantities from geometry without explicit
  confirmation (the user might want CAD-derived takeoff vs as-modeled).
- After every quantity report, suggest one follow-up:
  "Want me to break this down by IfcMaterial?", or "Want a per-storey
  takeoff?" - whichever is the most natural next slice the user did not
  already ask for.
"""


_BUILTIN: list[SystemPromptEntry] = [
    SystemPromptEntry(
        id="default-ask",
        label="Default · Ask",
        description="Versatile BIM assistant. Good general-purpose Q&A starting point.",
        content=_DEFAULT_ASK_PROMPT,
        category="ask",
    ),
    SystemPromptEntry(
        id="quantity-takeoff-specialist",
        label="Quantity Takeoff Specialist",
        description=(
            "Auditable QTO report - sourced from IfcQuantitySet first, grouped "
            "by storey → type → material, with a methodology citation."
        ),
        content=_QUANTITY_TAKEOFF_SKILL,
        category="ask",
    ),
]
# Only two built-in entries ship with the library. Other personas (BIM
# Analyst, Quantity Surveyor, Model Inspector, IDS Auditor, Workflow Planner,
# Edit Assistant) are not shipped as presets; users author detailed skills
# here instead.


class PromptLibrary:
    def __init__(self) -> None:
        self._builtins: dict[str, SystemPromptEntry] = {p.id: p for p in _BUILTIN}
        self._custom: dict[str, SystemPromptEntry] = {}
        self._load()

    def _load(self) -> None:
        if not _PROMPTS_FILE.exists():
            return
        try:
            raw = json.loads(_PROMPTS_FILE.read_text(encoding="utf-8"))
            for d in raw:
                p = _from_dict(d)
                if p.id in self._builtins:
                    continue
                self._custom[p.id] = p
        except Exception as e:
            logger.warning("Failed to load prompt library: %s", e)

    def _save(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = [_to_dict(p) for p in self._custom.values()]
        _PROMPTS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def all(self) -> list[SystemPromptEntry]:
        return list(self._builtins.values()) + list(self._custom.values())

    def get(self, prompt_id: str) -> Optional[SystemPromptEntry]:
        return self._builtins.get(prompt_id) or self._custom.get(prompt_id)

    def list_dicts(self) -> list[dict]:
        return [_to_dict(p) for p in self.all()]

    def create(self, data: dict) -> SystemPromptEntry:
        prompt_id = data.get("id") or _slug(data.get("label", "prompt"))
        base = prompt_id
        n = 1
        while prompt_id in self._builtins or prompt_id in self._custom:
            prompt_id = f"{base}-{n}"
            n += 1
        p = SystemPromptEntry(
            id=prompt_id,
            label=data.get("label", "Untitled"),
            description=data.get("description", ""),
            content=data.get("content", ""),
            category=data.get("category", "ask"),
            is_custom=True,
            created_at=datetime.now(tz=timezone.utc).isoformat(),
        )
        self._custom[prompt_id] = p
        self._save()
        return p

    def update(self, prompt_id: str, data: dict) -> SystemPromptEntry:
        if prompt_id in self._builtins:
            raise ValueError(f"Built-in prompt '{prompt_id}' cannot be modified.")
        if prompt_id not in self._custom:
            raise KeyError(f"Prompt '{prompt_id}' not found.")
        existing = self._custom[prompt_id]
        p = SystemPromptEntry(
            id=prompt_id,
            label=data.get("label", existing.label),
            description=data.get("description", existing.description),
            content=data.get("content", existing.content),
            category=data.get("category", existing.category),
            is_custom=True,
            created_at=existing.created_at,
        )
        self._custom[prompt_id] = p
        self._save()
        return p

    def delete(self, prompt_id: str) -> None:
        if prompt_id in self._builtins:
            raise ValueError(f"Built-in prompt '{prompt_id}' cannot be deleted.")
        if prompt_id not in self._custom:
            raise KeyError(f"Prompt '{prompt_id}' not found.")
        del self._custom[prompt_id]
        self._save()


def _slug(s: str) -> str:
    out = "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")
    return out or f"prompt-{uuid.uuid4().hex[:6]}"


def _to_dict(p: SystemPromptEntry) -> dict:
    return {
        "id": p.id,
        "label": p.label,
        "description": p.description,
        "content": p.content,
        "category": p.category,
        "is_custom": p.is_custom,
        "created_at": p.created_at,
    }


def _from_dict(d: dict) -> SystemPromptEntry:
    return SystemPromptEntry(
        id=d["id"],
        label=d.get("label", "Untitled"),
        description=d.get("description", ""),
        content=d.get("content", ""),
        category=d.get("category", "ask"),
        is_custom=bool(d.get("is_custom", True)),
        created_at=d.get("created_at"),
    )


prompt_library = PromptLibrary()


# ---------------------------------------------------------------------------
# Model Context Injector
# ---------------------------------------------------------------------------

# Maximum characters for the description field (truncated to keep context small)
_MAX_DESC = 200
# Maximum number of element types to list
_MAX_TYPES = 8
# Maximum number of materials to list
_MAX_MATS = 6


class ModelContextInjector:
    """Builds and caches per-model context blocks for agent system prompts."""

    def __init__(self) -> None:
        # fingerprint → context_block string. Bounded LRU: only the current
        # model's block is ever served, so keeping the last few prevents unbounded
        # growth - every edit/reload mints a new fingerprint.
        self._cache: "OrderedDict[str, str]" = OrderedDict()
        self._cache_limit = 2

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_context_block(self, ifc_service: "IfcService") -> str:
        """Return a compact markdown context block for the loaded model.

        Returns an empty string when no model is loaded.  Cached per
        model fingerprint so repeated calls are O(1) after the first.
        """
        if ifc_service._model is None:
            return ""

        fp = ifc_service._model_fingerprint
        if fp and fp in self._cache:
            self._cache.move_to_end(fp)
            return self._cache[fp]

        block = self._build(ifc_service)
        if fp:
            self._cache[fp] = block
            while len(self._cache) > self._cache_limit:
                self._cache.popitem(last=False)
        return block

    def inject(self, system_prompt: str, context_block: str) -> str:
        """Prepend context_block to system_prompt, separated by a divider.

        If context_block is empty the original system_prompt is returned
        unchanged.
        """
        if not context_block:
            return system_prompt
        return f"{context_block}\n\n---\n\n{system_prompt}"

    def invalidate(self, fingerprint: str) -> None:
        """Remove a cached context block (call after a model edit)."""
        self._cache.pop(fingerprint, None)

    # ------------------------------------------------------------------
    # Internal build
    # ------------------------------------------------------------------

    def _build(self, ifc_service: "IfcService") -> str:
        lines: list[str] = ["## Loaded IFC Model"]

        # --- Project info ---
        try:
            info = ifc_service.get_project_info()
            name = info.name or "(unnamed)"
            lines.append(f"- **Project**: {name}")
            if info.schema_version:
                lines.append(f"- **IFC schema**: {info.schema_version}")
            if info.author:
                lines.append(f"- **Author**: {info.author}")
            if info.description:
                desc = info.description[:_MAX_DESC]
                if len(info.description) > _MAX_DESC:
                    desc += "…"
                lines.append(f"- **Description**: {desc}")
        except Exception:
            logger.debug("model_context_injector: get_project_info failed", exc_info=True)

        # --- Model stats ---
        try:
            stats = ifc_service.get_model_stats()
            lines.append(f"- **Total elements**: {stats.total_elements:,}")

            if stats.by_type:
                top = sorted(stats.by_type.items(), key=lambda kv: -kv[1])[:_MAX_TYPES]
                type_parts = [f"{k} ({v})" for k, v in top]
                lines.append(f"- **Top element types**: {', '.join(type_parts)}")

            if stats.storeys:
                lines.append(f"- **Storeys ({len(stats.storeys)})**: {', '.join(stats.storeys[:10])}")

            if stats.materials:
                mats = stats.materials[:_MAX_MATS]
                suffix = f" + {len(stats.materials) - _MAX_MATS} more" if len(stats.materials) > _MAX_MATS else ""
                lines.append(f"- **Materials**: {', '.join(mats)}{suffix}")
        except Exception:
            logger.debug("model_context_injector: get_model_stats failed", exc_info=True)

        lines.append(
            "\n*Use the provided tools to query specific elements, properties, and quantities.*"
        )
        return "\n".join(lines)


# Singleton - imported by chat_routes and llm_service
model_context_injector = ModelContextInjector()


# ---------------------------------------------------------------------------
# Session Memory
# ---------------------------------------------------------------------------

# Maximum number of distinct fact keys to retain per session.
_MAX_FACTS = 15


class SessionMemory:
    """Accumulate per-session facts and produce a compact context block."""

    def __init__(self) -> None:
        # Ordered dict: key → human-readable fact line.
        # Insertion order matters so the block is stable across updates.
        self._facts: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, tool_name: str, result: Any) -> bool:
        """Extract facts from a tool result. Returns True if memory changed."""
        if not result:
            return False
        try:
            if isinstance(result, str):
                try:
                    result = json.loads(result)
                except json.JSONDecodeError:
                    return False
            if not isinstance(result, dict):
                return False
            return self._extract(tool_name, result)
        except Exception:
            logger.debug("session_memory.update failed", exc_info=True)
            return False

    def get_block(self) -> str:
        """Return a compact markdown block (empty string if < 2 facts known)."""
        if len(self._facts) < 2:
            return ""
        lines = ["## Session memory (facts learned this session)"]
        for line in list(self._facts.values())[:_MAX_FACTS]:
            lines.append(f"- {line}")
        return "\n".join(lines)

    def get_facts_list(self) -> list[str]:
        """Return raw fact lines for the frontend memory_update event."""
        return list(self._facts.values())[:_MAX_FACTS]

    def clear(self) -> None:
        self._facts.clear()

    # ------------------------------------------------------------------
    # Extraction rules
    # ------------------------------------------------------------------

    def _set(self, key: str, value: str) -> bool:
        """Set or update a fact. Returns True if it changed."""
        old = self._facts.get(key)
        self._facts[key] = value
        return old != value

    def _extract(self, tool_name: str, result: dict[str, Any]) -> bool:
        changed = False

        if tool_name == "describe_model":
            # Covers every part: project / stats read total_elements, by_type
            # and the project name; the storeys part carries a storeys list
            # (handled inside _extract_model_stats too).
            changed |= self._extract_model_stats(result)

        elif tool_name == "query_elements":
            # Result shapes vary per mode; each carries enough to log the
            # last search (text/semantic/type_name), a storey count, or a
            # per-type count.
            elements = result.get("elements") or []
            query = result.get("query", "")
            if query:
                total = result.get("total") or result.get("total_count", len(elements))
                changed |= self._set(
                    "last_search",
                    f'Last search: "{query}" → {total:,} result{"s" if total != 1 else ""}',
                )
            storey = result.get("storey_name", "")
            if storey:
                count = result.get("total_count", result.get("count", 0))
                changed |= self._set(
                    f"storey_count_{storey}",
                    f'Storey "{storey}": {count:,} element{"s" if count != 1 else ""}',
                )
            ifc_type = result.get("ifc_type", "")
            if ifc_type and not query:
                count = result.get("total_count", result.get("count", 0))
                changed |= self._set(
                    f"type_count_{ifc_type}",
                    f"{ifc_type}: {count:,} element{'s' if count != 1 else ''} in model",
                )

        elif tool_name == "get_element":
            # Details-only calls return the element fields at the top level;
            # multi-include calls nest them under "details".
            detail = result.get("details") if isinstance(result.get("details"), dict) else result
            name = detail.get("name") or detail.get("global_id", "")
            ifc_type = detail.get("ifc_type", "")
            storey = detail.get("storey", "")
            if name or ifc_type:
                parts = [f"Last fetched element: {name or ifc_type}"]
                if ifc_type and name:
                    parts = [f"Last fetched element: {name} ({ifc_type})"]
                if storey:
                    parts.append(f"on {storey}")
                changed |= self._set("last_element", " ".join(parts))

        elif tool_name == "quantity_summary":
            total_area = result.get("total_area_m2")
            total_vol = result.get("total_volume_m3")
            parts = []
            if total_area is not None:
                parts.append(f"ΣArea {total_area:.1f} m²")
            if total_vol is not None:
                parts.append(f"ΣVol {total_vol:.1f} m³")
            if parts:
                changed |= self._set("quantities", "Quantities: " + ", ".join(parts))

        return changed

    def _extract_model_stats(self, result: dict[str, Any]) -> bool:
        changed = False

        total = result.get("total_elements")
        if total is not None:
            changed |= self._set("element_count", f"Total elements: {total:,}")

        by_type: dict[str, int] = result.get("by_type") or {}
        if by_type:
            top = sorted(by_type.items(), key=lambda kv: -kv[1])[:4]
            parts = [f"{k} ({v})" for k, v in top]
            changed |= self._set("top_types", f"Top types: {', '.join(parts)}")

        storeys: list = result.get("storeys") or []
        if storeys:
            names = ", ".join(
                str(s.get("name")) if isinstance(s, dict) else str(s)
                for s in storeys[:6]
            )
            suffix = f" (+{len(storeys) - 6} more)" if len(storeys) > 6 else ""
            changed |= self._set("storey_names", f"Storeys: {names}{suffix}")

        project_name = result.get("name") or result.get("project_name")
        if project_name:
            changed |= self._set("project_name", f"Project name: {project_name}")

        return changed
