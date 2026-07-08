"""
System Prompt Library - named, reusable system prompts.

Sister service to tool_sets.py. The user can curate a library of named
system prompts ("Quantity Takeoff Specialist", "Edit Coach") and swap
them onto any harness or custom agent without rewriting the prompt
each time.
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
- For questions, use get_project_info, search_elements, or get_element_details.
- For highlighting or focusing on elements, use highlight_elements or isolate_elements.
- For quantity questions, use get_quantities_summary.
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
   over Pset properties or derived geometry.  Call `get_quantities_summary`
   first; only fall back to `execute_ifc_query_code` when the Qto set is
   missing for the trade in question.

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
   *Methodology: get_quantities_summary (3 trades) → get_elements_by_storey
   (each level) → get_quantities_summary per type.*

Rules:
- NEVER guess a value.  If `get_quantities_summary` returns null for a
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
