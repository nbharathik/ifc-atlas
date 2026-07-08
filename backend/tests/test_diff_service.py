"""Unit tests for the working-vs-original diff service (pure bucketing + CSV)."""

from app.models.ifc_models import PendingEditElement
from app.services.diff_service import diff_to_csv, summarize_changes


def _changes():
    return [
        PendingEditElement(express_id=1, ifc_type="IfcWall", change="created", name_after="New Wall"),
        PendingEditElement(express_id=2, ifc_type="IfcDoor", change="deleted", name_before="Old Door"),
        PendingEditElement(
            express_id=3, ifc_type="IfcWall", change="renamed", name_before="A", name_after="B"
        ),
        PendingEditElement(
            express_id=4,
            ifc_type="IfcSlab",
            change="property_changed",
            name_before="Slab",
            name_after="Slab",
            property_changes=[
                {"property_set": "Pset_SlabCommon", "property_name": "IsExternal", "before": False, "after": True}
            ],
        ),
        PendingEditElement(
            express_id=5, ifc_type="IfcBeam", change="retyped", ifc_type_before="IfcColumn", ifc_type_after="IfcBeam"
        ),
    ]


def test_buckets_added_removed_changed():
    summary = summarize_changes(_changes())
    assert summary["counts"] == {"added": 1, "removed": 1, "changed": 3}
    assert summary["added"][0]["express_id"] == 1
    assert summary["removed"][0]["name"] == "Old Door"
    # renamed, property_changed, retyped all fall under "changed"
    changes = {r["express_id"]: r["change"] for r in summary["changed"]}
    assert changes == {3: "renamed", 4: "property_changed", 5: "retyped"}


def test_truncation_flag():
    many = [
        PendingEditElement(express_id=i, ifc_type="IfcWall", change="created", name_after=f"W{i}")
        for i in range(10)
    ]
    summary = summarize_changes(many, max_items=3)
    assert summary["truncated"] is True
    assert len(summary["added"]) == 3
    assert summary["counts"]["added"] == 10


def test_no_changes_is_empty_not_truncated():
    summary = summarize_changes([])
    assert summary["counts"] == {"added": 0, "removed": 0, "changed": 0}
    assert summary["truncated"] is False


def test_csv_includes_property_detail():
    csv_text = diff_to_csv(summarize_changes(_changes()))
    lines = csv_text.strip().splitlines()
    assert lines[0] == "change,express_id,ifc_type,before,after,detail"
    assert any("IsExternal" in line and "True" in line for line in lines)
    assert any(line.startswith("added,1,IfcWall") for line in lines)
    assert any(line.startswith("removed,2,IfcDoor") for line in lines)


# ---------------------------------------------------------------------------
# Result cache (working_vs_original re-opens the pristine upload from disk,
# so repeat calls with the same model-contract fingerprint must be served
# from the cache instead of re-parsing the original IFC).
# ---------------------------------------------------------------------------


def _stub_diff_engine(monkeypatch):
    from app.services import diff_service

    diff_service._RESULT_CACHE.clear()
    opens = {"n": 0}

    def fake_open(path):
        opens["n"] += 1
        return object()

    monkeypatch.setattr(diff_service.ifcopenshell, "open", fake_open)
    monkeypatch.setattr(diff_service, "_compute_diff", lambda original, working: _changes())
    return diff_service, opens


def test_working_vs_original_caches_by_fingerprint(monkeypatch):
    diff_service, opens = _stub_diff_engine(monkeypatch)

    first = diff_service.working_vs_original(object(), "x.ifc", fingerprint="fp1")
    second = diff_service.working_vs_original(object(), "x.ifc", fingerprint="fp1")
    assert opens["n"] == 1
    assert second == first

    # A different fingerprint (edit applied / new model) recomputes.
    diff_service.working_vs_original(object(), "x.ifc", fingerprint="fp2")
    assert opens["n"] == 2
    diff_service._RESULT_CACHE.clear()


def test_working_vs_original_returns_fresh_copies(monkeypatch):
    diff_service, _ = _stub_diff_engine(monkeypatch)

    first = diff_service.working_vs_original(object(), "x.ifc", fingerprint="fp1")
    # The route adds has_working_copy to the returned dict; that must never
    # contaminate the cached entry.
    first["has_working_copy"] = True
    again = diff_service.working_vs_original(object(), "x.ifc", fingerprint="fp1")
    assert "has_working_copy" not in again
    diff_service._RESULT_CACHE.clear()


def test_working_vs_original_without_fingerprint_recomputes(monkeypatch):
    diff_service, opens = _stub_diff_engine(monkeypatch)

    diff_service.working_vs_original(object(), "x.ifc")
    diff_service.working_vs_original(object(), "x.ifc")
    assert opens["n"] == 2
    assert len(diff_service._RESULT_CACHE) == 0
