"""
Prompt Snippet Service - user-message templates for the AI chat panel.

Distinct from PromptLibrary (which stores *system* prompts / personas).
Snippets are short reusable user messages the operator clicks to insert
into the chat textarea ("How many walls?", "Highlight all doors", etc.).

Built-in snippets cover the most common BIM query patterns; the user can
add/edit/delete custom ones.  Custom snippets persist to
``~/.ifc-atlas/data/snippets.json`` (``DATA_DIR``); built-ins are
code-only and never mutated.
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
_SNIPPETS_FILE = _DATA_DIR / "snippets.json"


@dataclass(frozen=True)
class SnippetEntry:
    id: str
    title: str
    body: str
    tags: list[str] = field(default_factory=list)
    is_builtin: bool = False
    created_at: Optional[str] = None


_BUILTIN_SNIPPETS: list[SnippetEntry] = [
    SnippetEntry(
        id="snip-model-summary",
        title="Model Summary",
        body="Give me a summary of this IFC model including element counts by type and storeys.",
        tags=["overview", "model"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-quantity-totals",
        title="Quantity Totals",
        body="Use get_quantities_summary to give me total area, volume, and length grouped by IFC type.",
        tags=["quantities", "analysis"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-find-walls",
        title="Find All Walls",
        body="How many walls are in this model? List them by storey with element counts.",
        tags=["elements", "walls"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-highlight-doors",
        title="Highlight All Doors",
        body="Find all doors in this model and highlight them in the 3D viewer.",
        tags=["elements", "doors", "highlight"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-storey-breakdown",
        title="Per-Storey Breakdown",
        body="Give me the total area and element count for each storey in this model.",
        tags=["quantities", "storeys"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-missing-psets",
        title="Find Missing Property Sets",
        body="Which elements are missing standard property sets like Pset_WallCommon or Pset_DoorCommon? List up to 20.",
        tags=["quality", "psets"],
        is_builtin=True,
    ),
    SnippetEntry(
        id="snip-material-breakdown",
        title="Material Breakdown",
        body="What materials are used in this model? Give me a count of elements per material.",
        tags=["materials", "analysis"],
        is_builtin=True,
    ),
]


class SnippetService:
    def __init__(self) -> None:
        self._builtins: dict[str, SnippetEntry] = {s.id: s for s in _BUILTIN_SNIPPETS}
        self._custom: dict[str, SnippetEntry] = {}
        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        if not _SNIPPETS_FILE.exists():
            return
        try:
            raw = json.loads(_SNIPPETS_FILE.read_text(encoding="utf-8"))
            for d in raw:
                s = _from_dict(d)
                if s.id in self._builtins:
                    continue
                self._custom[s.id] = s
        except Exception as e:
            logger.warning("Failed to load snippets: %s", e)

    def _save(self) -> None:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        data = [_to_dict(s) for s in self._custom.values()]
        _SNIPPETS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list_all(self) -> list[SnippetEntry]:
        """Return built-ins first, then custom snippets sorted by creation date."""
        custom_sorted = sorted(
            self._custom.values(),
            key=lambda s: s.created_at or "",
        )
        return list(self._builtins.values()) + custom_sorted

    def list_dicts(self) -> list[dict]:
        return [_to_dict(s) for s in self.list_all()]

    def get(self, snippet_id: str) -> Optional[SnippetEntry]:
        return self._builtins.get(snippet_id) or self._custom.get(snippet_id)

    def create(self, data: dict) -> SnippetEntry:
        snippet_id = data.get("id") or f"snip-{uuid.uuid4().hex[:8]}"
        base = snippet_id
        n = 1
        while snippet_id in self._builtins or snippet_id in self._custom:
            snippet_id = f"{base}-{n}"
            n += 1
        s = SnippetEntry(
            id=snippet_id,
            title=data.get("title", "Untitled"),
            body=data.get("body", ""),
            tags=list(data.get("tags") or []),
            is_builtin=False,
            created_at=datetime.now(tz=timezone.utc).isoformat(),
        )
        self._custom[snippet_id] = s
        self._save()
        return s

    def update(self, snippet_id: str, data: dict) -> SnippetEntry:
        if snippet_id in self._builtins:
            raise ValueError(f"Built-in snippet '{snippet_id}' cannot be modified.")
        if snippet_id not in self._custom:
            raise KeyError(f"Snippet '{snippet_id}' not found.")
        existing = self._custom[snippet_id]
        s = SnippetEntry(
            id=snippet_id,
            title=data.get("title", existing.title),
            body=data.get("body", existing.body),
            tags=list(data.get("tags") or existing.tags),
            is_builtin=False,
            created_at=existing.created_at,
        )
        self._custom[snippet_id] = s
        self._save()
        return s

    def delete(self, snippet_id: str) -> None:
        if snippet_id in self._builtins:
            raise ValueError(f"Built-in snippet '{snippet_id}' cannot be deleted.")
        if snippet_id not in self._custom:
            raise KeyError(f"Snippet '{snippet_id}' not found.")
        del self._custom[snippet_id]
        self._save()


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _to_dict(s: SnippetEntry) -> dict:
    return {
        "id": s.id,
        "title": s.title,
        "body": s.body,
        "tags": list(s.tags),
        "is_builtin": s.is_builtin,
        "created_at": s.created_at,
    }


def _from_dict(d: dict) -> SnippetEntry:
    return SnippetEntry(
        id=d["id"],
        title=d.get("title", "Untitled"),
        body=d.get("body", ""),
        tags=list(d.get("tags") or []),
        is_builtin=bool(d.get("is_builtin", False)),
        created_at=d.get("created_at"),
    )


snippet_service = SnippetService()
