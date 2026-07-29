"""
Tests for ToolMemoCache - per-turn memoization of read-only agent tool calls.

All tests use a fresh ToolMemoCache instance (not the singleton) so they
are fully isolated from one another and from the production cache state.
"""

import time


from app.services.tool_memo import (
    MEMOIZABLE_TOOLS,
    ToolMemoCache,
    _make_key,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cache(ttl: float = 5.0) -> ToolMemoCache:
    return ToolMemoCache(ttl=ttl)


def _fake_exec(name: str, args: dict) -> dict:
    """Simulated execute_tool that returns a deterministic result."""
    return {"tool": name, "args": args, "result": "ok"}


# ---------------------------------------------------------------------------
# _make_key
# ---------------------------------------------------------------------------

class TestMakeKey:
    def test_empty_args_is_hashable(self):
        key = _make_key("get_model_stats", {})
        assert isinstance(key, tuple)
        hash(key)  # must not raise

    def test_same_args_same_key(self):
        k1 = _make_key("search_elements", {"query": "wall", "limit": 10})
        k2 = _make_key("search_elements", {"limit": 10, "query": "wall"})
        assert k1 == k2

    def test_different_args_different_key(self):
        k1 = _make_key("search_elements", {"query": "wall"})
        k2 = _make_key("search_elements", {"query": "door"})
        assert k1 != k2

    def test_different_names_different_key(self):
        k1 = _make_key("get_model_stats", {})
        k2 = _make_key("get_project_info", {})
        assert k1 != k2


# ---------------------------------------------------------------------------
# ToolMemoCache.get / put
# ---------------------------------------------------------------------------

class TestGetPut:
    def test_miss_on_empty_cache(self):
        c = _make_cache()
        assert c.get("get_model_stats", {}) is None

    def test_put_then_get_returns_cached(self):
        c = _make_cache()
        result = {"total": 42}
        c.put("get_model_stats", {}, result)
        assert c.get("get_model_stats", {}) == result

    def test_non_memoizable_tool_is_ignored(self):
        c = _make_cache()
        c.put("rename_element", {"element_id": 1, "name": "X"}, {"success": True})
        assert c.get("rename_element", {"element_id": 1, "name": "X"}) is None

    def test_error_result_is_not_cached(self):
        c = _make_cache()
        c.put("get_model_stats", {}, {"error": "no model loaded"})
        assert c.get("get_model_stats", {}) is None

    def test_ttl_expiry(self):
        c = _make_cache(ttl=0.05)  # 50 ms
        c.put("get_storeys", {}, {"storeys": []})
        time.sleep(0.1)
        assert c.get("get_storeys", {}) is None

    def test_within_ttl_hit(self):
        c = _make_cache(ttl=5.0)
        c.put("get_storeys", {}, {"storeys": ["L1"]})
        assert c.get("get_storeys", {}) == {"storeys": ["L1"]}

    def test_size_reflects_entries(self):
        c = _make_cache()
        assert c.size == 0
        c.put("get_model_stats", {}, {"total": 1})
        assert c.size == 1
        c.put("get_storeys", {}, {"storeys": []})
        assert c.size == 2


# ---------------------------------------------------------------------------
# ToolMemoCache.new_turn / invalidate
# ---------------------------------------------------------------------------

class TestLifecycle:
    def test_new_turn_clears_cache(self):
        c = _make_cache()
        c.put("get_model_stats", {}, {"total": 5})
        assert c.size == 1
        c.new_turn()
        assert c.size == 0

    def test_new_turn_increments_turn_id(self):
        c = _make_cache()
        assert c.turn_id == 0
        c.new_turn()
        assert c.turn_id == 1
        c.new_turn()
        assert c.turn_id == 2

    def test_invalidate_clears_cache(self):
        c = _make_cache()
        c.put("get_storeys", {}, {"storeys": []})
        c.invalidate()
        assert c.size == 0


# ---------------------------------------------------------------------------
# ToolMemoCache.get_or_execute
# ---------------------------------------------------------------------------

class TestGetOrExecute:
    def test_miss_calls_executor(self):
        c = _make_cache()
        calls = []

        def exec_fn(name, args):
            calls.append((name, args))
            return {"data": "fresh"}

        result = c.get_or_execute("get_model_stats", {}, exec_fn)
        assert result == {"data": "fresh"}
        assert len(calls) == 1

    def test_second_call_is_cached(self):
        c = _make_cache()
        calls = []

        def exec_fn(name, args):
            calls.append(name)
            return {"data": "value"}

        c.get_or_execute("get_model_stats", {}, exec_fn)
        result = c.get_or_execute("get_model_stats", {}, exec_fn)

        assert len(calls) == 1            # executor called only once
        assert result.get("_memo") is True  # cache-hit tag present

    def test_different_args_call_executor_separately(self):
        c = _make_cache()
        calls = []

        def exec_fn(name, args):
            calls.append(args.get("query"))
            return {"hits": []}

        c.get_or_execute("search_elements", {"query": "wall"}, exec_fn)
        c.get_or_execute("search_elements", {"query": "door"}, exec_fn)

        assert len(calls) == 2

    def test_error_result_not_cached(self):
        c = _make_cache()
        call_count = [0]

        def exec_fn(name, args):
            call_count[0] += 1
            return {"error": "no model"}

        c.get_or_execute("get_model_stats", {}, exec_fn)
        c.get_or_execute("get_model_stats", {}, exec_fn)

        assert call_count[0] == 2  # never cached

    def test_non_memoizable_always_calls_executor(self):
        c = _make_cache()
        calls = [0]

        def exec_fn(name, args):
            calls[0] += 1
            return {"success": True}

        c.get_or_execute("rename_element", {"element_id": 1, "name": "X"}, exec_fn)
        c.get_or_execute("rename_element", {"element_id": 1, "name": "X"}, exec_fn)

        assert calls[0] == 2


# ---------------------------------------------------------------------------
# hit_rate / stats
# ---------------------------------------------------------------------------

class TestStats:
    def test_hit_rate_zero_on_fresh_cache(self):
        c = _make_cache()
        assert c.hit_rate == 0.0

    def test_hit_rate_after_miss(self):
        c = _make_cache()
        c.get("get_model_stats", {})
        # 1 miss → hit_rate = 0/1
        assert c.hit_rate == 0.0

    def test_hit_rate_after_hit(self):
        c = _make_cache()
        c.put("get_model_stats", {}, {"total": 1})
        c.get("get_model_stats", {})  # hit
        assert c.hit_rate == 1.0

    def test_stats_dict_keys(self):
        c = _make_cache()
        s = c.stats()
        for key in ("turn_id", "size", "hits", "misses", "hit_rate", "ttl"):
            assert key in s


# ---------------------------------------------------------------------------
# MEMOIZABLE_TOOLS membership
# ---------------------------------------------------------------------------

class TestMemoizableTools:
    def test_read_tools_are_memoizable(self):
        for tool in (
            "get_project_info",
            "get_model_stats",
            "get_storeys",
            "search_elements",
            "get_element_details",
            "execute_ifc_query_code",
        ):
            assert tool in MEMOIZABLE_TOOLS, f"{tool} should be memoizable"

    def test_write_tools_are_not_memoizable(self):
        for tool in (
            "rename_element",
            "update_property_value",
            "propose_edit",
            "execute_ifc_code",
            "delete_element",
        ):
            assert tool not in MEMOIZABLE_TOOLS, f"{tool} must not be memoizable"
