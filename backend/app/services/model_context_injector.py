"""
Model Context Injector - dynamic IFC model context for agent system prompts.

Every time stream_chat() is called the injector builds a compact (<200 token)
markdown block describing the currently loaded IFC model and prepends it to
the agent's system prompt.  This eliminates the "cold start" round-trip where
agents waste a tool call just to learn what model is loaded.

The block is cached per model fingerprint so it is only built once per
unique model file, then reused for every message in the session.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.ifc_service import IfcService

logger = logging.getLogger(__name__)

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
