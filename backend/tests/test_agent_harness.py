"""
Tests for the Agent Harness subsystem:
  - ModelContextInjector (pure logic, no IFC file load)
  - Built-in agent presets (default + edit-assistant)
"""

from unittest.mock import MagicMock


# ---------------------------------------------------------------------------
# ModelContextInjector
# ---------------------------------------------------------------------------

class TestModelContextInjector:
    def _make_injector(self):
        from app.services.chat_context import ModelContextInjector
        return ModelContextInjector()

    def _make_mock_service(self, *, has_model=True, fingerprint="fp123"):
        svc = MagicMock()
        svc._model = MagicMock() if has_model else None
        svc._model_fingerprint = fingerprint

        from app.models.ifc_models import ProjectInfo, ModelStats
        svc.get_project_info.return_value = ProjectInfo(
            name="Test Project",
            schema_version="IFC4",
            author="Alice",
            description="A test building",
        )
        svc.get_model_stats.return_value = ModelStats(
            total_elements=149,
            by_type={"IfcWall": 50, "IfcDoor": 20, "IfcWindow": 15, "IfcBeam": 10},
            storeys=["Ground Floor", "First Floor"],
            materials=["Concrete", "Steel", "Glass"],
        )
        return svc

    def test_no_model_returns_empty(self):
        inj = self._make_injector()
        svc = self._make_mock_service(has_model=False)
        assert inj.get_context_block(svc) == ""

    def test_context_block_contains_project_name(self):
        inj = self._make_injector()
        svc = self._make_mock_service()
        block = inj.get_context_block(svc)
        assert "Test Project" in block

    def test_context_block_contains_element_count(self):
        inj = self._make_injector()
        svc = self._make_mock_service()
        block = inj.get_context_block(svc)
        assert "149" in block

    def test_context_block_contains_top_types(self):
        inj = self._make_injector()
        svc = self._make_mock_service()
        block = inj.get_context_block(svc)
        assert "IfcWall" in block

    def test_context_block_contains_storeys(self):
        inj = self._make_injector()
        svc = self._make_mock_service()
        block = inj.get_context_block(svc)
        assert "Ground Floor" in block

    def test_context_block_contains_materials(self):
        inj = self._make_injector()
        svc = self._make_mock_service()
        block = inj.get_context_block(svc)
        assert "Concrete" in block

    def test_cached_after_first_call(self):
        inj = self._make_injector()
        svc = self._make_mock_service(fingerprint="abc")
        block1 = inj.get_context_block(svc)
        block2 = inj.get_context_block(svc)
        # Should only call get_project_info once
        assert svc.get_project_info.call_count == 1
        assert block1 == block2

    def test_cache_per_fingerprint(self):
        inj = self._make_injector()
        svc_a = self._make_mock_service(fingerprint="fp-a")
        svc_b = self._make_mock_service(fingerprint="fp-b")
        svc_b.get_project_info.return_value.__class__ = type(svc_a.get_project_info.return_value)
        block_a = inj.get_context_block(svc_a)
        block_b = inj.get_context_block(svc_b)
        # Both should be non-empty (different models can produce the same content but both cached)
        assert block_a != "" and block_b != ""

    def test_invalidate_clears_cache(self):
        inj = self._make_injector()
        svc = self._make_mock_service(fingerprint="x")
        inj.get_context_block(svc)
        inj.invalidate("x")
        inj.get_context_block(svc)
        assert svc.get_project_info.call_count == 2

    def test_inject_prepends_block(self):
        inj = self._make_injector()
        result = inj.inject("My system prompt.", "## Model Context\n- Name: Foo")
        assert result.startswith("## Model Context")
        assert "My system prompt." in result

    def test_inject_with_empty_block_returns_original(self):
        inj = self._make_injector()
        original = "My system prompt."
        assert inj.inject(original, "") == original

    def test_project_info_error_does_not_crash(self):
        inj = self._make_injector()
        svc = MagicMock()
        svc._model = MagicMock()
        svc._model_fingerprint = "err"
        svc.get_project_info.side_effect = RuntimeError("boom")
        svc.get_model_stats.side_effect = RuntimeError("boom")
        block = inj.get_context_block(svc)
        # Should still produce something (even if just the header/footer)
        assert isinstance(block, str)


# ---------------------------------------------------------------------------
# Built-in agent presets
# ---------------------------------------------------------------------------

class TestBuiltinAgentPresets:
    def test_only_default_and_edit_assistant_builtins(self):
        from app.services.agent_registry import _BUILTIN_PRESETS
        ids = {p.id for p in _BUILTIN_PRESETS}
        assert ids == {"default", "edit-assistant"}, f"Unexpected built-ins: {ids}"

    def test_unknown_agent_falls_back_to_default(self):
        from app.services.agent_registry import agent_registry
        agent = agent_registry.get("no-such-agent")
        assert agent.id == "default"

    def test_missing_agent_id_falls_back_to_default(self):
        from app.services.agent_registry import agent_registry
        agent = agent_registry.get(None)
        assert agent.id == "default"

    def test_edit_assistant_has_write_tools(self):
        from app.services.agent_registry import agent_registry
        agent = agent_registry.get("edit-assistant")
        assert agent.allowed_tools is not None
        assert "edit_semantic" in agent.allowed_tools
        assert "execute_ifc_code" in agent.allowed_tools
        assert agent.category == "edit"

    def test_default_agent_is_unrestricted_ask(self):
        from app.services.agent_registry import agent_registry
        agent = agent_registry.get("default")
        assert agent.allowed_tools is None  # all tools
        assert agent.category == "ask"
