"""
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
"""

import time
from typing import Any, Callable

# Tools safe to memoize - must be purely read-only with no side effects.
MEMOIZABLE_TOOLS: frozenset[str] = frozenset(
    {
        "get_project_info",
        "get_model_stats",
        "get_storeys",
        "get_all_property_names",
        "get_quantities_summary",
        "search_elements",
        "get_element_details",
        "get_elements_by_type",
        "get_elements_by_storey",
        "search_by_property",
        "execute_ifc_query_code",
        "get_connected_elements",
        "get_element_material",
        "get_openings_for_element",
        "find_elements_by_type_name",
        "find_nearby_elements",
        "filter_by_property_value",
        "search_elements_semantic",
        "run_model_health_check",
        "get_edit_history",
    }
)

_Key = tuple[str, tuple[tuple[str, Any], ...]]


def _make_key(name: str, arguments: dict[str, Any]) -> _Key:
    """Return a hashable cache key for (tool_name, arguments)."""
    try:
        sorted_args: tuple[tuple[str, Any], ...] = tuple(sorted(arguments.items()))
    except TypeError:
        sorted_args = tuple(sorted((k, repr(v)) for k, v in arguments.items()))
    return (name, sorted_args)


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
