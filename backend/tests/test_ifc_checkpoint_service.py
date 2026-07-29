"""Pure unit tests for IFCCheckpointService - no IfcOpenShell, no live backend."""

from unittest.mock import patch

import pytest

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_repo(tmp_path):
    """Yield a fresh checkpoint service pointing at an isolated temp dir."""
    from app.services.ifc_checkpoint_service import IFCCheckpointService

    repo_dir = tmp_path / "ifc_history"
    svc = IFCCheckpointService(repo_dir)
    yield svc
    # Cleanup is handled by pytest tmp_path fixture automatically.


def _dummy_ifc(content: str = "VERSION=1") -> bytes:
    return content.encode()


# ---------------------------------------------------------------------------
# Availability guard (gitpython must be installed for the suite to run)
# ---------------------------------------------------------------------------

def test_git_available():
    """gitpython must be importable - the dep was added to requirements.txt."""
    import importlib
    spec = importlib.util.find_spec("git")
    assert spec is not None, "gitpython is not installed; run: pip install gitpython"


# ---------------------------------------------------------------------------
# Basic snapshot + list
# ---------------------------------------------------------------------------

def test_snapshot_creates_checkpoint(tmp_repo):
    sha = tmp_repo.snapshot(_dummy_ifc(), "first snapshot")
    assert sha is not None
    assert len(sha) == 12  # short SHA


def test_snapshot_returns_sha_string(tmp_repo):
    sha = tmp_repo.snapshot(_dummy_ifc())
    assert isinstance(sha, str)
    assert all(c in "0123456789abcdef" for c in sha)


def test_list_checkpoints_empty_before_snapshot(tmp_repo):
    checkpoints = tmp_repo.list_checkpoints()
    assert checkpoints == []


def test_list_checkpoints_after_one_snapshot(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc(), "initial load")
    checkpoints = tmp_repo.list_checkpoints()
    assert len(checkpoints) == 1
    assert checkpoints[0]["message"] == "initial load"
    assert checkpoints[0]["edit_count"] == 1
    assert checkpoints[0]["is_initial"] is True


def test_list_checkpoints_multiple_ordered_newest_first(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"), "edit 1")
    # Need different content to avoid 'nothing changed' skip.
    tmp_repo.snapshot(_dummy_ifc("v2"), "edit 2")
    tmp_repo.snapshot(_dummy_ifc("v3"), "edit 3")

    checkpoints = tmp_repo.list_checkpoints()
    assert len(checkpoints) == 3
    # Newest first.
    assert checkpoints[0]["message"] == "edit 3"
    assert checkpoints[1]["message"] == "edit 2"
    assert checkpoints[2]["message"] == "edit 1"


def test_list_checkpoints_edit_count_increments(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"), "a")
    tmp_repo.snapshot(_dummy_ifc("v2"), "b")
    checkpoints = tmp_repo.list_checkpoints()
    # edit_count reflects position (newest = highest).
    counts = [c["edit_count"] for c in checkpoints]
    assert counts == sorted(counts, reverse=True)


def test_list_checkpoints_last_is_initial(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"), "first")
    tmp_repo.snapshot(_dummy_ifc("v2"), "second")
    checkpoints = tmp_repo.list_checkpoints()
    assert checkpoints[-1]["is_initial"] is True
    assert checkpoints[0]["is_initial"] is False


def test_list_checkpoints_has_timestamp_iso(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc(), "ts test")
    cp = tmp_repo.list_checkpoints()[0]
    ts = cp["timestamp"]
    # Rough ISO-8601 sanity: contains 'T' separator.
    assert "T" in ts


def test_list_checkpoints_has_sha_key(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc(), "sha test")
    cp = tmp_repo.list_checkpoints()[0]
    assert "sha" in cp
    assert len(cp["sha"]) == 12


def test_list_checkpoints_respects_limit(tmp_repo):
    for i in range(5):
        tmp_repo.snapshot(_dummy_ifc(f"v{i}"), f"edit {i}")
    checkpoints = tmp_repo.list_checkpoints(limit=3)
    assert len(checkpoints) == 3


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

def test_restore_returns_original_bytes(tmp_repo):
    original = _dummy_ifc("IFC content v1")
    tmp_repo.snapshot(original, "baseline")
    checkpoints = tmp_repo.list_checkpoints()
    restored = tmp_repo.restore(checkpoints[0]["sha"])
    assert restored == original


def test_restore_correct_version_from_multiple(tmp_repo):
    v1 = _dummy_ifc("content version 1")
    v2 = _dummy_ifc("content version 2")
    tmp_repo.snapshot(v1, "v1")
    tmp_repo.snapshot(v2, "v2")

    checkpoints = tmp_repo.list_checkpoints()
    # checkpoints[0] is newest (v2), checkpoints[1] is oldest (v1).
    assert tmp_repo.restore(checkpoints[0]["sha"]) == v2
    assert tmp_repo.restore(checkpoints[1]["sha"]) == v1


def test_restore_unknown_sha_returns_none(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc(), "init")
    result = tmp_repo.restore("deadbeef1234")
    assert result is None


def test_restore_before_any_snapshot_returns_none(tmp_repo):
    result = tmp_repo.restore("abc123456789")
    assert result is None


# ---------------------------------------------------------------------------
# Identical content skip
# ---------------------------------------------------------------------------

def test_identical_content_returns_existing_sha(tmp_repo):
    data = _dummy_ifc("same")
    sha1 = tmp_repo.snapshot(data, "first")
    sha2 = tmp_repo.snapshot(data, "second (identical)")
    # Should return the same SHA - no new commit.
    assert sha1 == sha2
    assert len(tmp_repo.list_checkpoints()) == 1


# ---------------------------------------------------------------------------
# Reset
# ---------------------------------------------------------------------------

def test_reset_clears_history(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc(), "before reset")
    assert len(tmp_repo.list_checkpoints()) == 1
    tmp_repo.reset()
    assert tmp_repo.list_checkpoints() == []


def test_reset_allows_fresh_snapshots(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"), "initial")
    tmp_repo.reset()
    tmp_repo.snapshot(_dummy_ifc("v2"), "after reset")
    checkpoints = tmp_repo.list_checkpoints()
    assert len(checkpoints) == 1
    assert checkpoints[0]["message"] == "after reset"


# ---------------------------------------------------------------------------
# is_available property
# ---------------------------------------------------------------------------

def test_is_available_true_when_gitpython_installed(tmp_repo):
    assert tmp_repo.is_available is True


def test_is_available_false_when_gitpython_missing(tmp_path):
    """Simulate gitpython not installed by patching _GIT_AVAILABLE."""
    from app.services import ifc_checkpoint_service as mod
    from app.services.ifc_checkpoint_service import IFCCheckpointService

    with patch.object(mod, "_GIT_AVAILABLE", False):
        svc = IFCCheckpointService(tmp_path / "hist")
        assert svc.is_available is False


def test_snapshot_returns_none_without_gitpython(tmp_path):
    from app.services import ifc_checkpoint_service as mod
    from app.services.ifc_checkpoint_service import IFCCheckpointService

    with patch.object(mod, "_GIT_AVAILABLE", False):
        svc = IFCCheckpointService(tmp_path / "hist")
        assert svc.snapshot(b"data") is None


def test_list_checkpoints_returns_empty_without_gitpython(tmp_path):
    from app.services import ifc_checkpoint_service as mod
    from app.services.ifc_checkpoint_service import IFCCheckpointService

    with patch.object(mod, "_GIT_AVAILABLE", False):
        svc = IFCCheckpointService(tmp_path / "hist")
        assert svc.list_checkpoints() == []


def test_restore_returns_none_without_gitpython(tmp_path):
    from app.services import ifc_checkpoint_service as mod
    from app.services.ifc_checkpoint_service import IFCCheckpointService

    with patch.object(mod, "_GIT_AVAILABLE", False):
        svc = IFCCheckpointService(tmp_path / "hist")
        assert svc.restore("abc123456789") is None


# ---------------------------------------------------------------------------
# Auto-generated default messages
# ---------------------------------------------------------------------------

def test_snapshot_default_message_edit_1(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"))
    cp = tmp_repo.list_checkpoints()[0]
    assert cp["message"] == "Edit #1"


def test_snapshot_default_message_increments(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"))
    tmp_repo.snapshot(_dummy_ifc("v2"))
    tmp_repo.snapshot(_dummy_ifc("v3"))
    messages = [c["message"] for c in reversed(tmp_repo.list_checkpoints())]
    assert messages == ["Edit #1", "Edit #2", "Edit #3"]


def test_snapshot_explicit_message_not_overridden(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"), "custom msg")
    cp = tmp_repo.list_checkpoints()[0]
    assert cp["message"] == "custom msg"


# ---------------------------------------------------------------------------
# Edge cases: reset without prior snapshot, repo persistence after re-open
# ---------------------------------------------------------------------------

def test_reset_without_prior_snapshot_is_safe(tmp_repo):
    # Reset on a fresh service should not raise.
    tmp_repo.reset()
    assert tmp_repo.list_checkpoints() == []


def test_snapshot_after_reset_counter_restarts(tmp_repo):
    tmp_repo.snapshot(_dummy_ifc("v1"))
    tmp_repo.snapshot(_dummy_ifc("v2"))
    tmp_repo.reset()
    tmp_repo.snapshot(_dummy_ifc("v3"))
    cp = tmp_repo.list_checkpoints()[0]
    # Counter resets to 1 after reset.
    assert cp["message"] == "Edit #1"


def test_snapshot_sha_consistent_with_list(tmp_repo):
    returned_sha = tmp_repo.snapshot(_dummy_ifc("data"), "match test")
    listed_sha = tmp_repo.list_checkpoints()[0]["sha"]
    assert returned_sha == listed_sha


def test_list_checkpoints_sha_is_12_chars(tmp_repo):
    for i in range(3):
        tmp_repo.snapshot(_dummy_ifc(f"v{i}"), f"edit {i}")
    for cp in tmp_repo.list_checkpoints():
        assert len(cp["sha"]) == 12


def test_snapshot_large_bytes(tmp_repo):
    large_data = b"A" * 1_000_000
    sha = tmp_repo.snapshot(large_data, "large file")
    assert sha is not None
    restored = tmp_repo.restore(sha)
    assert restored == large_data


# ---------------------------------------------------------------------------
# get_diff - mocked IfcOpenShell entities
# ---------------------------------------------------------------------------

class _FakeEntity:
    """Minimal mock for an IfcOpenShell entity."""
    def __init__(self, global_id: str, ifc_type: str, **attrs):
        self.GlobalId = global_id
        self._type = ifc_type
        for k, v in attrs.items():
            setattr(self, k, v)

    def is_a(self) -> str:
        return self._type

    def id(self) -> int:
        return hash(self.GlobalId) & 0xFFFF


class _FakeModel:
    def __init__(self, entities: list):
        self._entities = entities

    def by_type(self, ifc_type: str):
        return self._entities


def _make_snapshot_with_entities(tmp_repo, entities: list[_FakeEntity], label: str = "snap") -> str:
    """Commit arbitrary bytes so we get a real SHA; patch restore to return a fake."""
    data = b"IFC4\nDATA;\nENDDATA;" + label.encode()
    sha = tmp_repo.snapshot(data, label)
    return sha


def test_get_diff_returns_none_without_gitpython(tmp_path):
    from app.services import ifc_checkpoint_service as mod
    from app.services.ifc_checkpoint_service import IFCCheckpointService
    with patch.object(mod, "_GIT_AVAILABLE", False):
        svc = IFCCheckpointService(tmp_path / "h")
        assert svc.get_diff("abc123456789", _FakeModel([])) is None


def test_get_diff_returns_none_for_unknown_sha(tmp_repo):
    result = tmp_repo.get_diff("deadbeef1234", _FakeModel([]))
    assert result is None


def test_get_diff_detects_added_entity(tmp_repo, monkeypatch):
    """Entity in current model but not in snapshot → added."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")

    snap_model = _FakeModel([])
    curr_model = _FakeModel([
        _FakeEntity("GUID-NEW-001", "IfcWall", Name="New Wall"),
    ])

    import app.services.ifc_checkpoint_service as mod

    # Patch ifcopenshell.open to return the snap_model without touching disk.
    monkeypatch.setattr(mod, "tempfile", __import__("tempfile"))
    monkeypatch.setattr("ifcopenshell.open", lambda path: snap_model)

    result = tmp_repo.get_diff(sha, curr_model)
    assert result is not None
    assert result["added"] == 1
    assert result["removed"] == 0
    assert result["changed"] == 0
    assert result["entries"][0]["change"] == "added"
    assert result["entries"][0]["global_id"] == "GUID-NEW-001"


def test_get_diff_detects_removed_entity(tmp_repo, monkeypatch):
    """Entity in snapshot but not in current model → removed."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")

    snap_model = _FakeModel([
        _FakeEntity("GUID-OLD-001", "IfcWall", Name="Old Wall"),
    ])
    curr_model = _FakeModel([])

    monkeypatch.setattr("ifcopenshell.open", lambda path: snap_model)
    result = tmp_repo.get_diff(sha, curr_model)
    assert result is not None
    assert result["removed"] == 1
    assert result["added"] == 0
    assert result["entries"][0]["change"] == "removed"


def test_get_diff_detects_changed_entity(tmp_repo, monkeypatch):
    """Entity in both models with different Name → changed."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")

    snap_model = _FakeModel([
        _FakeEntity("GUID-001", "IfcWall", Name="Old Name"),
    ])
    curr_model = _FakeModel([
        _FakeEntity("GUID-001", "IfcWall", Name="New Name"),
    ])

    monkeypatch.setattr("ifcopenshell.open", lambda path: snap_model)
    result = tmp_repo.get_diff(sha, curr_model)
    assert result is not None
    assert result["changed"] == 1
    entry = result["entries"][0]
    assert entry["change"] == "changed"
    assert any(ac["attribute"] == "Name" for ac in entry["attribute_changes"])


def test_get_diff_no_changes_returns_zero_total(tmp_repo, monkeypatch):
    """Identical entities in both models → total == 0."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")

    entities = [_FakeEntity("GUID-001", "IfcWall", Name="Wall")]
    snap_model = _FakeModel(entities[:])
    curr_model = _FakeModel([_FakeEntity("GUID-001", "IfcWall", Name="Wall")])

    monkeypatch.setattr("ifcopenshell.open", lambda path: snap_model)
    result = tmp_repo.get_diff(sha, curr_model)
    assert result is not None
    assert result["total"] == 0
    assert result["entries"] == []


def test_get_diff_truncation(tmp_repo, monkeypatch):
    """More than max_entries differences → truncated=True."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")

    # 110 added entities (well above default max_entries=100).
    curr_model = _FakeModel([
        _FakeEntity(f"GUID-{i:05d}", "IfcWall", Name=f"Wall {i}")
        for i in range(110)
    ])
    snap_model = _FakeModel([])

    monkeypatch.setattr("ifcopenshell.open", lambda path: snap_model)
    result = tmp_repo.get_diff(sha, curr_model, max_entries=100)
    assert result is not None
    assert result["truncated"] is True
    assert len(result["entries"]) == 100


def test_get_diff_result_has_required_keys(tmp_repo, monkeypatch):
    """Result dict always has sha, added, removed, changed, total, truncated, entries."""
    snap_data = b"IFC4\nDATA;\nENDDATA;"
    sha = tmp_repo.snapshot(snap_data, "baseline")
    monkeypatch.setattr("ifcopenshell.open", lambda path: _FakeModel([]))
    result = tmp_repo.get_diff(sha, _FakeModel([]))
    for key in ("sha", "added", "removed", "changed", "total", "truncated", "entries"):
        assert key in result, f"missing key: {key}"
    assert result["sha"] == sha


# ---------------------------------------------------------------------------
# rebind() - per-model repos that survive reloads (ADR 004, plan R3)
# ---------------------------------------------------------------------------

def test_rebind_same_key_preserves_history(tmp_repo):
    """Reloading the same model must NOT destroy its checkpoints (the old
    load path rmtree'd the one global repo on every load)."""
    tmp_repo.rebind("fp-model-a")
    tmp_repo.snapshot(_dummy_ifc("A1"), "first")
    tmp_repo.snapshot(_dummy_ifc("A2"), "second")
    assert len(tmp_repo.list_checkpoints()) == 2

    # Simulate a reload of the same file.
    tmp_repo.rebind("fp-model-a")
    assert len(tmp_repo.list_checkpoints()) == 2, "history must survive rebind"
    # And it can keep committing.
    tmp_repo.snapshot(_dummy_ifc("A3"), "third")
    assert len(tmp_repo.list_checkpoints()) == 3


def test_rebind_different_key_isolates_histories(tmp_repo):
    tmp_repo.rebind("fp-model-a")
    tmp_repo.snapshot(_dummy_ifc("A1"), "model A")
    tmp_repo.rebind("fp-model-b")
    assert tmp_repo.list_checkpoints() == [], "model B starts with its own empty history"
    tmp_repo.snapshot(_dummy_ifc("B1"), "model B snap")
    assert len(tmp_repo.list_checkpoints()) == 1

    # Back to model A - its history is intact.
    tmp_repo.rebind("fp-model-a")
    cps = tmp_repo.list_checkpoints()
    assert len(cps) == 1
    assert cps[0]["message"] == "model A"


def test_rebind_sanitizes_hostile_keys(tmp_repo):
    """Path-hostile fingerprints must not escape the base dir."""
    tmp_repo.rebind("../../evil/../key with spaces!")
    sha = tmp_repo.snapshot(_dummy_ifc(), "safe")
    assert sha is not None
    # The repo landed inside the base dir.
    assert str(tmp_repo._repo_dir).startswith(str(tmp_repo._base_dir))


def test_reset_still_wipes_current_repo(tmp_repo):
    tmp_repo.rebind("fp-model-a")
    tmp_repo.snapshot(_dummy_ifc(), "snap")
    tmp_repo.reset()
    assert tmp_repo.list_checkpoints() == []
