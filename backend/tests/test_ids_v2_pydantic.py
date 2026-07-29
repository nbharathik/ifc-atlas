"""
Tests for IDS validator v2 - Pydantic models + extract_failing_ids helper.

Pure Python / in-memory tests.  No disk I/O; no SIGSEGV risk on Windows.
"""
from __future__ import annotations



# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _make_report(specs: list[dict]) -> dict:
    """Build a minimal validate_ids-style report dict."""
    return {
        "total_specifications": len(specs),
        "passed": 0,
        "failed": len(specs),
        "no_applicable": 0,
        "specifications": specs,
        "ids_title": "test",
        "engine": "v0",
    }


def _failing_spec(name: str, ids: list[int]) -> dict:
    return {
        "name": name,
        "status": "failed",
        "applied_to": len(ids),
        "passed": 0,
        "failed": len(ids),
        "failing_elements": [
            {"id": eid, "global_id": None, "ifc_type": "IfcWall", "facet_type": "Property", "reason": "missing"}
            for eid in ids
        ],
        "failing_truncated": False,
    }


def _passing_spec(name: str) -> dict:
    return {
        "name": name,
        "status": "passed",
        "applied_to": 3,
        "passed": 3,
        "failed": 0,
        "failing_elements": [],
        "failing_truncated": False,
    }


# ─────────────────────────────────────────────────────────────────────
# extract_failing_ids
# ─────────────────────────────────────────────────────────────────────

class TestExtractFailingIds:
    def test_empty_report_returns_empty(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([])
        assert extract_failing_ids(report) == []

    def test_all_passing_returns_empty(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([_passing_spec("PassSpec")])
        assert extract_failing_ids(report) == []

    def test_single_spec_single_element(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([_failing_spec("S1", [42])])
        assert extract_failing_ids(report) == [42]

    def test_multiple_specs_merged_and_deduplicated(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([
            _failing_spec("S1", [10, 20]),
            _failing_spec("S2", [20, 30]),
        ])
        ids = extract_failing_ids(report)
        assert sorted(ids) == [10, 20, 30]

    def test_filter_by_spec_name(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([
            _failing_spec("SpecA", [1, 2]),
            _failing_spec("SpecB", [3, 4]),
        ])
        assert sorted(extract_failing_ids(report, spec_name="SpecA")) == [1, 2]
        assert sorted(extract_failing_ids(report, spec_name="SpecB")) == [3, 4]

    def test_filter_by_unknown_spec_returns_empty(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([_failing_spec("X", [5, 6])])
        assert extract_failing_ids(report, spec_name="NoSuchSpec") == []

    def test_none_id_is_skipped(self):
        from app.services.ids_service import extract_failing_ids
        spec = _failing_spec("X", [1])
        spec["failing_elements"].append(
            {"id": None, "global_id": None, "ifc_type": "IfcWall", "facet_type": "Property", "reason": "x"}
        )
        report = _make_report([spec])
        assert extract_failing_ids(report) == [1]

    def test_mixed_passing_failing_specs(self):
        from app.services.ids_service import extract_failing_ids
        report = _make_report([
            _passing_spec("Pass"),
            _failing_spec("Fail", [99]),
        ])
        assert extract_failing_ids(report) == [99]


# ─────────────────────────────────────────────────────────────────────
# Pydantic models - IdsFailingElement
# ─────────────────────────────────────────────────────────────────────

class TestIdsFailingElement:
    def test_minimal_round_trip(self):
        from app.models.ifc_models import IdsFailingElement
        elem = IdsFailingElement(
            id=42,
            ifc_type="IfcWall",
            facet_type="Property",
            reason="FireRating missing",
        )
        assert elem.id == 42
        assert elem.global_id is None
        assert elem.name is None

    def test_full_fields(self):
        from app.models.ifc_models import IdsFailingElement
        elem = IdsFailingElement(
            id=7,
            global_id="abc123",
            ifc_type="IfcDoor",
            name="Main Door",
            facet_type="Attribute",
            reason="Name mismatch",
        )
        d = elem.model_dump()
        assert d["ifc_type"] == "IfcDoor"
        assert d["global_id"] == "abc123"


# ─────────────────────────────────────────────────────────────────────
# Pydantic models - IdsSpecResult
# ─────────────────────────────────────────────────────────────────────

class TestIdsSpecResult:
    def test_minimal_defaults(self):
        from app.models.ifc_models import IdsSpecResult
        spec = IdsSpecResult(
            name="Wall check",
            status="failed",
            applied_to=5,
            passed=3,
            failed=2,
        )
        assert spec.description == ""
        assert spec.failing_elements == []
        assert spec.failing_truncated is False

    def test_with_failing_elements(self):
        from app.models.ifc_models import IdsFailingElement, IdsSpecResult
        spec = IdsSpecResult(
            name="Door check",
            status="failed",
            applied_to=2,
            passed=1,
            failed=1,
            failing_elements=[
                IdsFailingElement(id=10, ifc_type="IfcDoor", facet_type="Property", reason="x")
            ],
        )
        assert len(spec.failing_elements) == 1
        assert spec.failing_elements[0].id == 10


# ─────────────────────────────────────────────────────────────────────
# Pydantic models - IdsValidationResult
# ─────────────────────────────────────────────────────────────────────

class TestIdsValidationResult:
    def test_minimal(self):
        from app.models.ifc_models import IdsValidationResult
        result = IdsValidationResult(
            total_specifications=2,
            passed=1,
            failed=1,
            no_applicable=0,
            engine="ifctester",
        )
        assert result.all_failing_ids == []
        assert result.ids_title == ""

    def test_with_all_failing_ids(self):
        from app.models.ifc_models import IdsValidationResult
        result = IdsValidationResult(
            total_specifications=1,
            passed=0,
            failed=1,
            no_applicable=0,
            engine="ifctester",
            all_failing_ids=[10, 20, 30],
        )
        assert len(result.all_failing_ids) == 3
        assert 20 in result.all_failing_ids

    def test_json_schema_includes_all_failing_ids(self):
        from app.models.ifc_models import IdsValidationResult
        schema = IdsValidationResult.model_json_schema()
        assert "all_failing_ids" in schema["properties"]


# ─────────────────────────────────────────────────────────────────────
# _ui_action_events - ids_highlight action
# ─────────────────────────────────────────────────────────────────────

class TestUiActionEventsIdsHighlight:
    def test_ids_highlight_emits_highlight_event(self):
        from app.services.llm_service import _ui_action_events
        result = {
            "action": "ids_highlight",
            "element_ids": [1, 2, 3],
            "total_specifications": 1,
            "passed": 0,
        }
        events = _ui_action_events(result)
        assert len(events) == 1
        assert events[0]["type"] == "highlight"
        assert events[0]["element_ids"] == [1, 2, 3]

    def test_ids_highlight_empty_ids_still_emits(self):
        from app.services.llm_service import _ui_action_events
        events = _ui_action_events({"action": "ids_highlight", "element_ids": []})
        assert events[0]["element_ids"] == []

    def test_highlight_action_still_works(self):
        from app.services.llm_service import _ui_action_events
        events = _ui_action_events({"action": "highlight", "element_ids": [5]})
        assert events[0]["type"] == "highlight"

    def test_no_action_returns_empty(self):
        from app.services.llm_service import _ui_action_events
        assert _ui_action_events({"total_specifications": 1}) == []
