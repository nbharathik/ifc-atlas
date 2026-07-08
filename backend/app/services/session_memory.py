"""
Session Memory - per-WebSocket-connection fact accumulator for LLM agents.

Extracts structured facts from tool results and injects them as a compact
"Session memory" block into the next turn's system prompt. This eliminates
redundant tool calls (e.g., the agent doesn't need to re-call get_model_stats
if it already knows the element count from this session).

Design:
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
from typing import Any

logger = logging.getLogger(__name__)

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

        if tool_name in ("get_model_stats", "get_project_info"):
            changed |= self._extract_model_stats(result)

        elif tool_name == "get_storeys":
            storeys = result.get("storeys") or []
            if storeys:
                names = ", ".join(str(s) for s in storeys[:8])
                suffix = f" (+{len(storeys) - 8} more)" if len(storeys) > 8 else ""
                changed |= self._set("storey_names", f"Storeys: {names}{suffix}")

        elif tool_name == "search_elements":
            elements = result.get("elements") or []
            total = result.get("total_count", len(elements))
            query = result.get("query", "")
            if query:
                changed |= self._set(
                    "last_search",
                    f'Last search: "{query}" → {total:,} result{"s" if total != 1 else ""}',
                )

        elif tool_name == "search_elements_semantic":
            hits = result.get("results") or []
            query = result.get("query", "")
            if query:
                changed |= self._set(
                    "last_semantic_search",
                    f'Last semantic search: "{query}" → {len(hits)} hit{"s" if len(hits) != 1 else ""}',
                )

        elif tool_name == "get_element_details":
            name = result.get("name") or result.get("global_id", "")
            ifc_type = result.get("ifc_type", "")
            storey = result.get("storey", "")
            if name or ifc_type:
                parts = [f"Last fetched element: {name or ifc_type}"]
                if ifc_type and name:
                    parts = [f"Last fetched element: {name} ({ifc_type})"]
                if storey:
                    parts.append(f"on {storey}")
                changed |= self._set("last_element", " ".join(parts))

        elif tool_name == "get_quantities_summary":
            total_area = result.get("total_area_m2")
            total_vol = result.get("total_volume_m3")
            parts = []
            if total_area is not None:
                parts.append(f"ΣArea {total_area:.1f} m²")
            if total_vol is not None:
                parts.append(f"ΣVol {total_vol:.1f} m³")
            if parts:
                changed |= self._set("quantities", "Quantities: " + ", ".join(parts))

        elif tool_name == "get_elements_by_storey":
            storey = result.get("storey_name", "")
            count = result.get("total_count", 0)
            if storey:
                changed |= self._set(
                    f"storey_count_{storey}",
                    f'Storey "{storey}": {count:,} element{"s" if count != 1 else ""}',
                )

        elif tool_name == "get_elements_by_type":
            ifc_type = result.get("ifc_type", "")
            count = result.get("total_count", 0)
            if ifc_type:
                changed |= self._set(
                    f"type_count_{ifc_type}",
                    f"{ifc_type}: {count:,} element{'s' if count != 1 else ''} in model",
                )

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

        storeys: list[str] = result.get("storeys") or []
        if storeys:
            names = ", ".join(storeys[:6])
            suffix = f" (+{len(storeys) - 6} more)" if len(storeys) > 6 else ""
            changed |= self._set("storey_names", f"Storeys: {names}{suffix}")

        project_name = result.get("name") or result.get("project_name")
        if project_name:
            changed |= self._set("project_name", f"Project name: {project_name}")

        return changed
