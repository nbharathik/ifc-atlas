"""Tests for model_health.py - rule engine (no IfcOpenShell file I/O)."""

from unittest.mock import MagicMock

from app.services.model_health import (
    run_health_check,
    _rule_missing_global_id,
    _rule_duplicate_global_id,
    _rule_missing_name,
    _rule_empty_property_sets,
    _rule_no_storey_assignment,
    _rule_duplicate_name_in_type,
    _rule_large_element_count,
    HealthIssue,
)


# ─── Mock IFC object helpers ───────────────────────────────────────────────────

def _elem(global_id: str = "abc", name: str = "Wall-01", ifc_type: str = "IfcWall", eid: int = 1):
    """Create a mock IFC element."""
    m = MagicMock()
    m.GlobalId = global_id
    m.Name = name
    m.id.return_value = eid
    m.is_a.side_effect = lambda t: t == ifc_type
    return m


def _ifc_with_elements(elements: list, by_type_map: dict | None = None):
    """Create a minimal mock ifc_model.

    When no by_type_map is given, all `by_type` calls return the full elements
    list - mirrors real IfcOpenShell behaviour where `by_type("IfcElement")`
    returns all elements and subtypes overlap.
    """
    model = MagicMock()
    if by_type_map is None:
        model.by_type.return_value = elements
    else:
        model.by_type.side_effect = lambda t: by_type_map.get(t, [])
    return model


# ─── missing_global_id ────────────────────────────────────────────────────────

def test_missing_global_id_no_elements():
    model = _ifc_with_elements([])
    result = _rule_missing_global_id(model, 50)
    assert result.count == 0
    assert result.rule_id == "missing_global_id"
    assert result.severity == "error"


def test_missing_global_id_all_ok():
    elements = [_elem("ID1", eid=1), _elem("ID2", eid=2)]
    model = _ifc_with_elements(elements)
    result = _rule_missing_global_id(model, 50)
    assert result.count == 0


def test_missing_global_id_blank():
    elements = [_elem("", "NoGuid", eid=1)]
    model = _ifc_with_elements(elements)
    result = _rule_missing_global_id(model, 50)
    assert result.count == 1
    assert result.issues[0]["severity"] == "error"


def test_missing_global_id_limit_respected():
    elements = [_elem("", f"El{i}", eid=i) for i in range(20)]
    model = _ifc_with_elements(elements)
    result = _rule_missing_global_id(model, 5)
    # The issues list is capped at limit=5; count reflects actual issues found
    assert len(result.issues) == 5
    assert result.count >= 5


# ─── duplicate_global_id ─────────────────────────────────────────────────────

def test_duplicate_global_id_none():
    elements = [_elem("A", eid=1), _elem("B", eid=2), _elem("C", eid=3)]
    model = _ifc_with_elements(elements)
    result = _rule_duplicate_global_id(model, 50)
    assert result.count == 0


def test_duplicate_global_id_detects_pair():
    elements = [_elem("SAME", eid=1), _elem("SAME", eid=2), _elem("OTHER", eid=3)]
    model = _ifc_with_elements(elements)
    result = _rule_duplicate_global_id(model, 50)
    # Both elements sharing "SAME" are reported
    assert result.count == 2
    assert len(result.issues) == 2


def test_duplicate_global_id_message_contains_count():
    elements = [_elem("X", eid=1), _elem("X", eid=2)]
    model = _ifc_with_elements(elements)
    result = _rule_duplicate_global_id(model, 50)
    assert "2" in result.issues[0]["message"]


# ─── missing_name ─────────────────────────────────────────────────────────────

def test_missing_name_no_structural():
    model = MagicMock()
    model.by_type.return_value = []
    result = _rule_missing_name(model, 50)
    assert result.count == 0
    assert result.severity == "warning"


def test_missing_name_detects_blank():
    wall_no_name = _elem("ID1", "", ifc_type="IfcWall", eid=10)
    model = MagicMock()
    model.by_type.side_effect = lambda t: [wall_no_name] if t == "IfcWall" else []
    result = _rule_missing_name(model, 50)
    assert result.count == 1
    assert "IfcWall" in result.issues[0]["message"]


def test_missing_name_named_elements_not_flagged():
    wall = _elem("ID1", "Wall A", ifc_type="IfcWall", eid=10)
    model = MagicMock()
    model.by_type.side_effect = lambda t: [wall] if t == "IfcWall" else []
    result = _rule_missing_name(model, 50)
    assert result.count == 0


# ─── empty_property_sets ──────────────────────────────────────────────────────

def test_empty_property_sets_all_good():
    pset = MagicMock()
    pset.Name = "Pset_WallCommon"
    pset.HasProperties = [MagicMock()]  # 1 property
    pset.id.return_value = 99
    model = MagicMock()
    model.by_type.side_effect = lambda t: [pset] if t == "IfcPropertySet" else []
    result = _rule_empty_property_sets(model, 50)
    assert result.count == 0


def test_empty_property_sets_detects_empty():
    pset = MagicMock()
    pset.Name = "EmptyPset"
    pset.HasProperties = []
    pset.id.return_value = 77
    model = MagicMock()
    model.by_type.side_effect = lambda t: [pset] if t == "IfcPropertySet" else []
    result = _rule_empty_property_sets(model, 50)
    assert result.count == 1
    assert result.issues[0]["element_name"] == "EmptyPset"


# ─── no_storey_assignment ─────────────────────────────────────────────────────

def test_no_storey_assignment_with_storey():
    wall = MagicMock()
    wall.Name = "Wall"
    wall.id.return_value = 5
    wall.is_a.side_effect = lambda t: t == "IfcWall"
    rel = MagicMock()
    storey = MagicMock()
    storey.is_a.side_effect = lambda t: t == "IfcBuildingStorey"
    rel.RelatingStructure = storey
    wall.ContainedInStructure = [rel]
    model = MagicMock()
    model.by_type.side_effect = lambda t: [wall] if t == "IfcWall" else []
    result = _rule_no_storey_assignment(model, 50)
    assert result.count == 0


def test_no_storey_assignment_without_storey():
    wall = MagicMock()
    wall.Name = "OrphanWall"
    wall.id.return_value = 6
    wall.is_a.side_effect = lambda t: t == "IfcWall"
    wall.ContainedInStructure = []  # nothing
    model = MagicMock()
    model.by_type.side_effect = lambda t: [wall] if t == "IfcWall" else []
    result = _rule_no_storey_assignment(model, 50)
    assert result.count == 1
    assert "storey" in result.issues[0]["message"].lower()


# ─── duplicate_name_in_type ──────────────────────────────────────────────────

def test_duplicate_name_in_type_unique_names():
    d1 = _elem("X", "Door A", "IfcDoor", 1)
    d2 = _elem("Y", "Door B", "IfcDoor", 2)
    model = MagicMock()
    model.by_type.side_effect = lambda t: [d1, d2] if t == "IfcDoor" else []
    result = _rule_duplicate_name_in_type(model, 50)
    assert result.count == 0


def test_duplicate_name_in_type_detects_dupes():
    d1 = _elem("X", "DoorA", "IfcDoor", 1)
    d2 = _elem("Y", "DoorA", "IfcDoor", 2)
    d3 = _elem("Z", "DoorA", "IfcDoor", 3)
    model = MagicMock()
    model.by_type.side_effect = lambda t: [d1, d2, d3] if t == "IfcDoor" else []
    result = _rule_duplicate_name_in_type(model, 50)
    assert result.count == 3
    assert "3" in result.issues[0]["message"]


def test_duplicate_name_in_type_severity_info():
    result = _rule_duplicate_name_in_type(MagicMock(), 50)
    assert result.severity == "info"


# ─── large_element_count ──────────────────────────────────────────────────────

def test_large_element_count_small_model():
    model = MagicMock()
    model.by_type.return_value = [MagicMock()] * 500
    result = _rule_large_element_count(model, 50)
    assert result.count == 0


def test_large_element_count_large_model():
    model = MagicMock()
    model.by_type.return_value = [MagicMock()] * 15_000
    result = _rule_large_element_count(model, 50)
    assert result.count == 1
    assert "15,000" in result.issues[0]["message"]


# ─── run_health_check ─────────────────────────────────────────────────────────

def test_run_health_check_returns_correct_keys():
    model = MagicMock()
    model.by_type.return_value = []
    report = run_health_check(model)
    assert "total_issues" in report
    assert "by_severity" in report
    assert "rules" in report
    assert isinstance(report["rules"], list)


def test_run_health_check_severity_keys():
    model = MagicMock()
    model.by_type.return_value = []
    report = run_health_check(model)
    sevs = report["by_severity"]
    assert "error" in sevs
    assert "warning" in sevs
    assert "info" in sevs


def test_run_health_check_clean_model_no_errors():
    model = MagicMock()
    # All elements have GlobalIds, names, no empty psets, etc.
    good_wall = _elem("GUID1", "Wall 1", "IfcWall", 1)
    storey = MagicMock()
    storey.is_a.side_effect = lambda t: t == "IfcBuildingStorey"
    rel = MagicMock()
    rel.RelatingStructure = storey
    good_wall.ContainedInStructure = [rel]
    pset = MagicMock()
    pset.Name = "Pset_WallCommon"
    pset.HasProperties = [MagicMock()]
    pset.id.return_value = 2
    model.by_type.side_effect = lambda t: {
        "IfcElement": [good_wall],
        "IfcWall": [good_wall],
        "IfcPropertySet": [pset],
        "IfcDoor": [], "IfcWindow": [], "IfcSpace": [],
        "IfcSlab": [], "IfcColumn": [], "IfcBeam": [],
    }.get(t, [])
    report = run_health_check(model)
    # No errors expected on a clean model
    assert report["by_severity"]["error"] == 0


def test_run_health_check_rule_individual_failure_does_not_abort():
    """A rule that raises an exception is silently skipped."""
    model = MagicMock()
    model.by_type.side_effect = RuntimeError("boom")
    # Should not raise
    report = run_health_check(model)
    assert "total_issues" in report


def test_health_issue_to_dict():
    issue = HealthIssue(
        rule_id="test",
        severity="error",
        element_id=42,
        element_name="Wall",
        message="No GlobalId",
    )
    d = issue.to_dict()
    assert d["rule_id"] == "test"
    assert d["element_id"] == 42
    assert d["severity"] == "error"


def test_run_health_check_limit_per_rule_forwarded():
    elements = [_elem("", f"El{i}", eid=i) for i in range(100)]
    model = MagicMock()
    model.by_type.side_effect = lambda t: elements if t == "IfcElement" else []
    report = run_health_check(model, limit_per_rule=3)
    missing_gid = next(r for r in report["rules"] if r["rule_id"] == "missing_global_id")
    assert len(missing_gid["issues"]) <= 3
