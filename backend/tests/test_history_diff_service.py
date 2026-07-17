"""Semantic history diff (ifcdiff wrapper, plan C3) - no-mock tests."""

from __future__ import annotations

import pytest

ifcopenshell = pytest.importorskip("ifcopenshell")
pytest.importorskip("ifcdiff")

from app.services import element_factory, history_diff_service
from app.services.project_template_service import create_blank_project


@pytest.fixture(autouse=True)
def _fresh_cache():
    history_diff_service.clear_cache()
    yield
    history_diff_service.clear_cache()


# One shared baseline per test module: mutations must derive from the SAME
# bytes (same GlobalIds), otherwise everything diffs as added+deleted - the
# way two independently generated templates would.
BASE_BYTES = create_blank_project("single_storey")


def _mutated(mutate) -> bytes:
    """BASE_BYTES with *mutate(model)* applied, re-serialized."""
    import tempfile
    from pathlib import Path

    p = Path(tempfile.mktemp(suffix=".ifc"))
    p.write_bytes(BASE_BYTES)
    model = ifcopenshell.open(str(p))
    mutate(model)
    model.write(str(p))
    out = p.read_bytes()
    p.unlink(missing_ok=True)
    return out


def test_identical_payloads_diff_empty():
    result = history_diff_service.compute_diff(BASE_BYTES, BASE_BYTES, old_key="a", new_key="a2")
    assert result["total"] == 0
    assert result["entries"] == []


def test_added_wall_is_reported():
    edited = _mutated(
        lambda m: element_factory.create_wall(m, start=[0, 0], end=[4, 0], name="Diff Wall")
    )
    result = history_diff_service.compute_diff(BASE_BYTES, edited, old_key="base", new_key="edited")
    added = [e for e in result["entries"] if e["change"] == "added" and e["ifc_type"] == "IfcWall"]
    assert added and added[0]["name"] == "Diff Wall"
    assert isinstance(added[0]["express_id"], int)
    # Only the wall was added - the unchanged scaffold must NOT diff.
    assert result["deleted"] == 0


def test_rename_is_reported_as_change():
    def _rename(m):
        m.by_type("IfcBuildingStorey")[0].Name = "Renamed Storey"

    edited = _mutated(_rename)
    result = history_diff_service.compute_diff(BASE_BYTES, edited, old_key="b1", new_key="b2")
    assert result["changed"] >= 1
    changed = [e for e in result["entries"] if e["change"] == "changed"]
    assert any(e["name"] == "Renamed Storey" for e in changed)


def test_deletion_is_reported_with_old_model_identity():
    with_wall = _mutated(
        lambda m: element_factory.create_wall(m, start=[0, 0], end=[4, 0], name="Doomed Wall")
    )
    # Diff in the "deleting" direction: base(with wall) → plain base.
    result = history_diff_service.compute_diff(with_wall, BASE_BYTES, old_key="w", new_key="p")
    deleted = [e for e in result["entries"] if e["change"] == "deleted" and e["ifc_type"] == "IfcWall"]
    assert deleted and deleted[0]["name"] == "Doomed Wall"


def test_results_are_cached_by_key():
    data = BASE_BYTES
    r1 = history_diff_service.compute_diff(data, data, old_key="k1", new_key="k2")
    r2 = history_diff_service.compute_diff(b"garbage", b"garbage", old_key="k1", new_key="k2")
    assert r2 is r1, "same key pair must hit the cache (bytes not reparsed)"


def test_unparseable_payload_raises_value_error():
    with pytest.raises(ValueError, match="Could not parse"):
        history_diff_service.compute_diff(
            b"not an ifc", b"also not", old_key="x", new_key="y"
        )
