"""Truncation honesty - format_tool_result envelopes + element-list caps.

Oversized tool results used to be chopped mid-token at 8,000 chars with no
signal to the model, and get_elements_by_type silently dropped everything past
the first 100 elements. These tests pin the new contract: truncation is always
visible (explicit marker + shown/total counts) and list-heavy results stay
valid JSON with the tail dropped instead of a mid-token cut.
"""

import json
from types import SimpleNamespace

from app.services import tools as tools_mod
from app.services.tools import (
    _ELEMENT_LIST_CAP,
    _capped_element_list,
    format_tool_result,
)


def _fake_elements(n: int) -> list:
    """Objects exposing model_dump(), like the pydantic element summaries."""
    return [
        SimpleNamespace(model_dump=lambda i=i: {"id": i, "name": f"Wall {i}"})
        for i in range(n)
    ]


# ── format_tool_result ───────────────────────────────────────────────────────

def test_small_result_returned_verbatim():
    result = {"elements": [{"id": 1}], "total": 1}
    text = format_tool_result(result)
    assert json.loads(text) == result
    assert "TRUNCATED" not in text


def test_large_list_drops_tail_and_keeps_valid_json():
    items = [{"id": i, "name": f"Wall number {i} with a longish name"} for i in range(500)]
    result = {"ifc_type": "IfcWall", "count": 500, "elements": items}

    text = format_tool_result(result, max_length=4000)

    assert len(text) <= 4000
    parsed = json.loads(text)  # must stay valid JSON (no mid-token chop)
    assert parsed["truncated"] is True
    assert parsed["total"] == 500
    assert parsed["shown"] == len(parsed["elements"])
    assert 0 < parsed["shown"] < 500
    # Tail entries are dropped - the prefix is preserved in order.
    assert [e["id"] for e in parsed["elements"]] == list(range(parsed["shown"]))
    # Non-list fields survive untouched.
    assert parsed["ifc_type"] == "IfcWall"
    assert parsed["count"] == 500
    # The marker tells the model what happened and how to narrow.
    assert parsed["truncation_note"].startswith("[TRUNCATED: showing first")
    assert f"{parsed['shown']} of 500" in parsed["truncation_note"]
    assert "narrow the query" in parsed["truncation_note"]


def test_largest_list_is_the_one_shrunk():
    result = {
        "storeys": [{"name": f"S{i}"} for i in range(3)],
        "elements": [{"id": i, "payload": "x" * 40} for i in range(200)],
    }
    text = format_tool_result(result, max_length=3000)
    parsed = json.loads(text)
    assert len(parsed["storeys"]) == 3, "the small list must be untouched"
    assert len(parsed["elements"]) < 200


def test_scalar_blob_falls_back_to_char_cut_with_marker():
    result = {"blob": "x" * 20000}
    text = format_tool_result(result, max_length=8000)
    total_chars = len(json.dumps(result, indent=2, default=str))
    assert text.startswith('{\n  "blob"')
    assert f"[TRUNCATED: showing first 8000 of {total_chars} chars" in text
    assert "narrow the query" in text


def test_single_giant_list_entry_falls_back_to_char_cut():
    # One entry alone exceeds the budget - there is no tail to drop, so the
    # character cut (with marker) applies instead of an empty list.
    result = {"elements": [{"id": 1, "blob": "y" * 20000}]}
    text = format_tool_result(result, max_length=2000)
    assert "[TRUNCATED: showing first 2000 of" in text


def test_legacy_silent_marker_is_gone():
    text = format_tool_result({"blob": "z" * 20000}, max_length=1000)
    assert "... (truncated)" not in text


# ── _capped_element_list (get_elements_by_type envelope) ────────────────────

def test_capped_element_list_reports_totals():
    payload = _capped_element_list(_fake_elements(250))
    assert payload["count"] == 250
    assert payload["total_count"] == 250
    assert payload["truncated"] is True
    assert payload["shown"] == _ELEMENT_LIST_CAP
    assert len(payload["elements"]) == _ELEMENT_LIST_CAP
    assert f"first {_ELEMENT_LIST_CAP} of 250" in payload["truncation_note"]


def test_capped_element_list_under_cap_not_truncated():
    payload = _capped_element_list(_fake_elements(5))
    assert payload["count"] == 5
    assert payload["total_count"] == 5
    assert payload["truncated"] is False
    assert len(payload["elements"]) == 5
    assert "truncation_note" not in payload
    assert "shown" not in payload


def test_get_elements_by_type_envelope_signals_cap(monkeypatch):
    """The tool branch itself carries total_count/truncated so the model can
    report 'N of M' instead of presenting the first 100 as the full set."""
    monkeypatch.setattr(tools_mod, "_native_index_ready", lambda: False)
    fake_svc = SimpleNamespace(
        is_loaded=True,
        get_elements_by_type=lambda ifc_type: _fake_elements(150),
    )
    monkeypatch.setattr(tools_mod, "ifc_service", fake_svc)

    out = tools_mod._execute_tool_raw("get_elements_by_type", {"ifc_type": "IfcWall"})

    assert out["total_count"] == 150
    assert out["count"] == 150
    assert out["truncated"] is True
    assert out["shown"] == 100
    assert len(out["elements"]) == 100
    assert "TRUNCATED" in out["truncation_note"]
    assert out["_source"] == "ifcopenshell"
