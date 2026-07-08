"""
Tests for ``execute_ifc_code`` - Invariant-4 full-form arbitrary-Python
runner. Covers:

- Read-only branch: hash matches → no envelope, stdout + result surfaced.
- Write branch: hash differs → envelope registered, diff computed, pending
  edit accessible via the SandboxService.
- Error branch: user Python raises → ``execute_error`` with trace.
- Timeout branch: infinite loop → ``timed_out=True`` surfaces.
- Sandbox isolation: user code cannot escape the sandbox to the live IFC
  or a different file on disk (audit hook).
- Apply path: the sandbox file gets swapped into the live path, the
  live handle reloads, and subsequent execute runs see the fresh state.

BasicHouse.ifc anchors (matches other test files):
  Wall #361 - 'Basic Wall:Yttervägg Paroc:1298028'
"""

from __future__ import annotations

import shutil
from pathlib import Path

import ifcopenshell
import pytest

from app.services.code_runner import MAX_CODE_CHARS, run_ifc_code
from app.services.ifc_service import IfcService
from app.services.sandbox_service import SandboxService

# Module loads the shared BasicHouse fixture via IfcOpenShell and spawns subprocesses for
# the sandbox runner. Marked so the fast pre-flight (-m "not requires_ifc_load
# and not subprocess_sandbox") can skip it on Windows + Python 3.13.
pytestmark = [pytest.mark.requires_ifc_load, pytest.mark.subprocess_sandbox]

REPO_ROOT = Path(__file__).parent.parent.parent
BASICHOUSE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"

WALL_ID = 361
WALL_ORIG_NAME = "Basic Wall:Yttervägg Paroc:1298028"


@pytest.fixture
def svc(tmp_path):
    """Per-test IfcService with its own fresh BasicHouse copy."""
    dst = tmp_path / "BasicHouse.ifc"
    shutil.copy(BASICHOUSE, dst)
    service = IfcService()
    service.load(dst)
    return service


@pytest.fixture
def sandbox():
    """A fresh SandboxService per test (singleton isn't safe to share)."""
    svc = SandboxService()
    yield svc
    svc.clear_all()


# ──────────────────────────────────────────────────────────────────────
# Read-only path (hash-unchanged)
# ──────────────────────────────────────────────────────────────────────


class TestReadOnly:
    def test_count_walls_returns_result_repr(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                "walls = model.by_type('IfcWall')\n"
                "print(f'found {len(walls)} walls')\n"
                "result = len(walls)\n"
            ),
            timeout_s=20.0,
        )
        assert out["action"] == "execute_result", out
        assert "found " in out["stdout"]
        # BasicHouse.ifc ships with a handful of walls - the exact count
        # isn't important, only that we got a positive int repr back.
        assert out["result"] and out["result"].isdigit()
        assert int(out["result"]) > 0
        # Nothing should be pending.
        assert sandbox.list_pending() == []

    def test_read_only_does_not_change_version(self, svc, sandbox):
        before = svc.model_version
        out = sandbox.execute_python(
            ifc_service=svc,
            code="result = model.by_id(361).Name",
            timeout_s=20.0,
        )
        assert out["action"] == "execute_result"
        assert WALL_ORIG_NAME in (out["result"] or "")
        assert svc.model_version == before


# ──────────────────────────────────────────────────────────────────────
# Write path (hash-changed → pending envelope)
# ──────────────────────────────────────────────────────────────────────


class TestWritePath:
    def test_rename_registers_pending_edit(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                "wall = model.by_id(361)\n"
                "wall.Name = 'ExecRename'\n"
                "result = wall.Name\n"
            ),
            summary="rename wall via execute_ifc_code",
            timeout_s=20.0,
        )
        assert out["action"] == "pending_edit", out
        edit_id = out["edit_id"]
        assert edit_id
        assert out["counts"].get("renamed") == 1

        envelope = sandbox.get_pending(edit_id)
        assert envelope is not None
        assert envelope.operations[0]["op"] == "execute_ifc_code"
        renamed = next(c for c in envelope.changes if c.express_id == WALL_ID)
        assert renamed.change == "renamed"
        assert renamed.name_before == WALL_ORIG_NAME
        assert renamed.name_after == "ExecRename"

    def test_apply_swaps_sandbox_into_live(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                "wall = model.by_id(361)\n"
                "wall.Name = 'AppliedViaExec'\n"
            ),
            timeout_s=20.0,
        )
        assert out["action"] == "pending_edit"
        before_version = svc.model_version

        sandbox.apply_pending(edit_id=out["edit_id"], ifc_service=svc)

        assert svc.model_version > before_version
        # The live handle now sees the new name.
        assert svc.model.by_id(WALL_ID).Name == "AppliedViaExec"
        # The sandbox registry is empty after apply.
        assert sandbox.list_pending() == []

    def test_hash_unchanged_when_assign_to_same_value(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code=f"model.by_id(361).Name = {WALL_ORIG_NAME!r}",
            timeout_s=20.0,
        )
        # Setting to the current value shouldn't change the STEP bytes.
        assert out["action"] == "execute_result", out


# ──────────────────────────────────────────────────────────────────────
# Error path
# ──────────────────────────────────────────────────────────────────────


class TestErrorPath:
    def test_user_code_exception_surfaces(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code="raise ValueError('boom')",
            timeout_s=20.0,
        )
        assert out["action"] == "execute_error"
        assert "boom" in out["error"]
        assert out["timed_out"] is False
        # No envelope registered.
        assert sandbox.list_pending() == []

    def test_blank_code_rejected(self, svc, sandbox):
        with pytest.raises(ValueError):
            sandbox.execute_python(
                ifc_service=svc,
                code="",
                timeout_s=20.0,
            )

    def test_oversize_code_rejected(self, svc, sandbox):
        big = "# " + ("x" * (MAX_CODE_CHARS + 10))
        with pytest.raises(ValueError):
            sandbox.execute_python(ifc_service=svc, code=big, timeout_s=20.0)


# ──────────────────────────────────────────────────────────────────────
# Timeout path
# ──────────────────────────────────────────────────────────────────────


class TestTimeout:
    def test_infinite_loop_killed(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code="while True:\n    pass\n",
            timeout_s=2.0,
        )
        assert out["action"] == "execute_error"
        assert out["timed_out"] is True
        assert sandbox.list_pending() == []


# ──────────────────────────────────────────────────────────────────────
# Sandbox isolation (audit hook)
# ──────────────────────────────────────────────────────────────────────


class TestIsolation:
    def test_cannot_open_arbitrary_file(self, svc, sandbox, tmp_path):
        secret = tmp_path / "secret.txt"
        secret.write_text("do not read")
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                f"with open({str(secret)!r}) as f:\n"
                "    data = f.read()\n"
                "result = data\n"
            ),
            timeout_s=20.0,
        )
        assert out["action"] == "execute_error"
        assert "blocked" in out["error"].lower() or "permission" in out["error"].lower()
        assert sandbox.list_pending() == []

    def test_cannot_write_live_ifc(self, svc, sandbox):
        live = str(svc._file_path)  # noqa: SLF001
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                f"with open({live!r}, 'wb') as f:\n"
                "    f.write(b'sabotage')\n"
            ),
            timeout_s=20.0,
        )
        assert out["action"] == "execute_error"
        # Live file must still be readable as IFC.
        ifcopenshell.open(live)

    def test_cannot_run_subprocess(self, svc, sandbox):
        out = sandbox.execute_python(
            ifc_service=svc,
            code=(
                "import subprocess\n"
                "subprocess.Popen(['echo', 'oops'])\n"
            ),
            timeout_s=20.0,
        )
        assert out["action"] == "execute_error"
        assert "blocked" in out["error"].lower() or "permission" in out["error"].lower()


# ──────────────────────────────────────────────────────────────────────
# run_ifc_code unit-level sanity (doesn't need a live IfcService)
# ──────────────────────────────────────────────────────────────────────


class TestRunnerUnit:
    def test_run_returns_stdout(self, tmp_path):
        dst = tmp_path / "BasicHouse.ifc"
        shutil.copy(BASICHOUSE, dst)
        res = run_ifc_code(
            sandbox_path=dst,
            code="print('hello')\nresult = 42\n",
            timeout_s=20.0,
        )
        assert res.error is None, res.error
        assert "hello" in res.stdout
        assert res.result_repr == "42"
        assert res.timed_out is False

    def test_run_timeout_clamps(self, tmp_path):
        dst = tmp_path / "BasicHouse.ifc"
        shutil.copy(BASICHOUSE, dst)
        # timeout_s=0.5 is below MIN_TIMEOUT_S=1 → clamp to 1s.
        res = run_ifc_code(
            sandbox_path=dst,
            code="while True:\n    pass",
            timeout_s=0.1,
        )
        assert res.timed_out is True
