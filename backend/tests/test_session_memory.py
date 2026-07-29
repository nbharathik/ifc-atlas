"""Tests for SessionMemory - per-WS fact accumulator."""
import json
from app.services.chat_context import SessionMemory


def mem() -> SessionMemory:
    return SessionMemory()


# ---------------------------------------------------------------------------
# update() basic
# ---------------------------------------------------------------------------

def test_update_returns_false_on_empty_result():
    m = mem()
    assert m.update("describe_model", None) is False
    assert m.update("describe_model", {}) is False


def test_update_accepts_json_string():
    m = mem()
    payload = json.dumps({"total_elements": 149, "storeys": ["Ground Floor"]})
    changed = m.update("describe_model", payload)
    assert changed is True


def test_update_extracts_element_count():
    m = mem()
    m.update("describe_model", {"total_elements": 149})
    block = m.get_block()
    # Not enough facts yet (only 1)
    assert block == ""
    # Add another fact
    m.update("describe_model", {"storeys": ["Ground Floor", "First Floor"]})
    block = m.get_block()
    assert "149" in block


def test_update_extracts_storeys():
    m = mem()
    m.update("describe_model", {"total_elements": 50, "storeys": ["L1", "L2"]})
    block = m.get_block()
    assert "L1" in block
    assert "L2" in block


def test_update_extracts_top_types():
    m = mem()
    m.update("describe_model", {
        "total_elements": 50,
        "by_type": {"IfcWall": 20, "IfcSlab": 5, "IfcWindow": 3},
        "storeys": ["G"],
    })
    block = m.get_block()
    assert "IfcWall" in block


def test_update_deduplicates_by_key():
    m = mem()
    m.update("describe_model", {"total_elements": 100, "storeys": ["A"]})
    m.update("describe_model", {"total_elements": 200, "storeys": ["A"]})
    block = m.get_block()
    assert "200" in block
    assert "100" not in block


def test_update_search_elements():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("query_elements", {"query": "walls near exit", "elements": [], "total_count": 5})
    block = m.get_block()
    assert "walls near exit" in block
    assert "5" in block


def test_update_search_elements_semantic():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("query_elements", {"query": "load-bearing", "results": [1, 2, 3]})
    block = m.get_block()
    assert "load-bearing" in block


def test_update_get_element_details():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("get_element", {
        "name": "BasicWall:001",
        "ifc_type": "IfcWall",
        "storey": "Ground Floor",
    })
    block = m.get_block()
    assert "BasicWall" in block


def test_update_quantities_summary():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("quantity_summary", {"total_area_m2": 120.5, "total_volume_m3": 60.0})
    block = m.get_block()
    assert "120.5" in block


def test_update_elements_by_storey():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("query_elements", {"storey_name": "Ground Floor", "total_count": 80})
    block = m.get_block()
    assert "Ground Floor" in block
    assert "80" in block


def test_update_elements_by_type():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.update("query_elements", {"ifc_type": "IfcDoor", "total_count": 12})
    block = m.get_block()
    assert "IfcDoor" in block
    assert "12" in block


# ---------------------------------------------------------------------------
# get_block() format
# ---------------------------------------------------------------------------

def test_block_empty_when_less_than_two_facts():
    m = mem()
    m.update("describe_model", {"total_elements": 10})
    assert m.get_block() == ""


def test_block_has_header():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    block = m.get_block()
    assert "Session memory" in block


def test_block_uses_bullet_lines():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    block = m.get_block()
    assert block.count("- ") >= 1


# ---------------------------------------------------------------------------
# get_facts_list()
# ---------------------------------------------------------------------------

def test_get_facts_list_returns_list():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    fl = m.get_facts_list()
    assert isinstance(fl, list)
    assert len(fl) >= 1


def test_get_facts_list_capped_at_max():
    m = mem()
    # inject 20 distinct type counts
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    for i in range(20):
        m.update("query_elements", {"ifc_type": f"IfcFake{i}", "total_count": i})
    facts = m.get_facts_list()
    assert len(facts) <= 15


# ---------------------------------------------------------------------------
# clear()
# ---------------------------------------------------------------------------

def test_clear_resets_facts():
    m = mem()
    m.update("describe_model", {"total_elements": 10, "storeys": ["G"]})
    m.clear()
    assert m.get_block() == ""
    assert m.get_facts_list() == []


# ---------------------------------------------------------------------------
# returns_false_when_unchanged
# ---------------------------------------------------------------------------

def test_update_returns_false_when_same_value():
    m = mem()
    first = m.update("describe_model", {"storeys": ["Ground Floor"]})
    second = m.update("describe_model", {"storeys": ["Ground Floor"]})
    assert first is True
    assert second is False
