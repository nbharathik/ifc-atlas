"""Unit tests for the COBie-lite service (pure summary + CSV over extracted dicts)."""

from app.services.cobie_service import cobie_to_csv, summarize_cobie


def _cobie():
    return {
        "facility": {"name": "Test Building", "project": "P1", "site": "S1", "building": "Test Building"},
        "floors": [{"name": "Ground", "elevation": "0", "global_id": "g1"}],
        "spaces": [
            {"name": "Office", "floor": "Ground", "category": "", "area": "20", "global_id": "s1"},
            {"name": "", "floor": "Ground", "category": "", "area": "", "global_id": "s2"},
        ],
        "types": [
            {"name": "Door A", "ifc_class": "IfcDoorType", "category": "", "manufacturer": "Acme", "model": "D-1", "global_id": "t1"},
            {"name": "Wall A", "ifc_class": "IfcWallType", "category": "", "manufacturer": "", "model": "", "global_id": "t2"},
        ],
        "components": [
            {"name": "Door 1", "type": "Door A", "space": "Office", "ifc_class": "IfcDoor", "global_id": "c1"},
            {"name": "Wall 1", "type": "", "space": "", "ifc_class": "IfcWall", "global_id": "c2"},
        ],
    }


def test_summary_counts():
    summary = summarize_cobie(_cobie())
    assert summary["counts"] == {"floors": 1, "spaces": 2, "types": 2, "components": 2}


def test_completeness_percentages():
    items = {i["label"]: i for i in summarize_cobie(_cobie())["completeness"]}
    # 1 of 2 components linked to a type
    assert items["Components linked to a Type"]["pct"] == 50.0
    # 1 of 2 types has a manufacturer
    assert items["Types with Manufacturer"]["pct"] == 50.0
    # 1 of 2 spaces named
    assert items["Spaces named"]["pct"] == 50.0


def test_completeness_empty_is_zero_not_crash():
    empty = {"facility": {}, "floors": [], "spaces": [], "types": [], "components": []}
    items = {i["label"]: i for i in summarize_cobie(empty)["completeness"]}
    assert items["Components linked to a Type"]["pct"] == 0.0
    assert summarize_cobie(empty)["counts"]["components"] == 0


def test_csv_has_all_sheet_sections():
    csv_text = cobie_to_csv(_cobie())
    for marker in ("# Facility", "# Floor", "# Space", "# Type", "# Component"):
        assert marker in csv_text
    assert "Door 1" in csv_text
    assert "Acme" in csv_text
