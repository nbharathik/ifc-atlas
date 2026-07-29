"""
Subprocess-isolated runner for LLM-authored Python against an IFC sandbox
file. Underlies ``execute_ifc_code`` (Invariant 4 full form).

Design notes
============

The LLM can emit arbitrary Python. We do NOT trust it. The code runs in a
**child Python process** that:

1. Opens the given sandbox ``.ifc`` via ``ifcopenshell.open`` BEFORE arming
   a ``sys.addaudithook`` guard (ifcopenshell's schema/C++ bootstrap touches
   many system files on import - arming the hook after import keeps those
   legit while blocking user-code escape attempts).
2. Executes the user code with ``exec`` in a restricted globals namespace
   that exposes ``model`` (the open handle) + ``ifcopenshell``. Stdout is
   captured into a buffer.
3. Denies - via the audit hook - any file I/O outside the sandbox path,
   any ``os.system`` / ``subprocess.Popen`` / ``socket`` / ``urllib`` /
   ``os.exec*`` / ``os.remove`` / ``os.rename`` against non-sandbox paths.
4. Writes the (possibly mutated) model back to the sandbox path.
5. Emits a single JSON blob on stdout between fixed markers so the parent
   can recover the run's stdout, result-repr, elapsed time, and any error.

The parent (``SandboxService.execute_python``) enforces a wall-clock
timeout via ``subprocess.run(timeout=...)`` - if the child hangs we kill
it with ``SIGKILL`` / ``TerminateProcess`` and surface a timeout error.

This reduces risk to the main backend process from:
- infinite loops / CPU spin
- child crashes taking down the API process
- filesystem escape (audit hook + path allowlist)
- network egress (audit hook)
- schema corruption (only the sandbox file is writable)

The child has no way to mutate the live IFC, the live ``IfcService``
handle, or any other file on disk.

This is not an OS security sandbox. Audit hooks can be bypassed by sufficiently
hostile native code, and per-process CPU/memory controls are platform-specific.
Server deployments must keep this feature disabled/trusted-only until the
worker is placed in the isolated execution boundary described in the
repository refactoring plan.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from app.core.config import CODE_EXECUTION_ENABLED

logger = logging.getLogger(__name__)


# Sentinel lines that wrap the single JSON result blob the child emits.
# Picked to be long enough that an LLM is extremely unlikely to produce
# them in normal print() output.
_RESULT_OPEN = "<<<CODE_RUNNER_RESULT_OPEN>>>"
_RESULT_CLOSE = "<<<CODE_RUNNER_RESULT_CLOSE>>>"


# Default wall-clock budget. The sandbox is a bounded preview step,
# not a batch job. The LLM can ask for more
# up to ``MAX_TIMEOUT_S`` but not beyond. 4 minutes is the hard ceiling -
# enough headroom for heavy batch geometry / relationship edits on large
# models, while still bounding a runaway child.
DEFAULT_TIMEOUT_S = 240.0
MIN_TIMEOUT_S = 1.0
MAX_TIMEOUT_S = 240.0

# Cap the code payload size. An LLM that wants to stream multi-MB of
# Python into the sandbox is either confused or trying to DoS us.
MAX_CODE_CHARS = 100_000

# Preserve only process-runtime values needed to launch Python and native
# IfcOpenShell libraries. In particular, never forward provider credentials,
# server tokens, cloud credentials, or the backend's complete environment to
# LLM-authored code.
_SANDBOX_ENV_ALLOWLIST = frozenset(
    {
        "APPDATA",
        "COMSPEC",
        "DYLD_LIBRARY_PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "LD_LIBRARY_PATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROGRAMDATA",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "TZ",
        "USERPROFILE",
        "VIRTUAL_ENV",
        "WINDIR",
    }
)


def build_sandbox_environment(
    parent_env: dict[str, str],
    sandbox_path: Path,
) -> dict[str, str]:
    """Return a minimal child environment with no application credentials."""

    env = {
        key: value
        for key, value in parent_env.items()
        if key.upper() in _SANDBOX_ENV_ALLOWLIST
    }
    env["SANDBOX_IFC_PATH"] = str(sandbox_path)
    env["PYTHONUNBUFFERED"] = "1"
    return env


@dataclass
class CodeRunResult:
    """What ``run_ifc_code`` returns to the SandboxService."""

    stdout: str
    result_repr: Optional[str]
    elapsed_ms: int
    error: Optional[str]  # Python exception message, or None
    timed_out: bool


# ──────────────────────────────────────────────────────────────────────
# Child-side script. Embedded here (instead of a separate file) so the
# parent can ship it via ``python -c`` without worrying about installed
# package layout.  The triple-quoted string is passed through unchanged.
# ──────────────────────────────────────────────────────────────────────

_CHILD_PROGRAM = r"""
import io
import json
import os
import sys
import time
import traceback
from contextlib import redirect_stdout

# The parent feeds us two things:
#   - env var SANDBOX_IFC_PATH  → path to the .ifc we may read/write
#   - stdin                      → the LLM's Python code
SANDBOX_PATH = os.environ.get("SANDBOX_IFC_PATH", "")
if not SANDBOX_PATH:
    sys.stderr.write("FATAL: SANDBOX_IFC_PATH missing\n")
    sys.exit(2)

# Normalise for comparison (audit hook uses startswith matching).
SANDBOX_ABS = os.path.abspath(SANDBOX_PATH)

# Import ifcopenshell BEFORE arming the audit hook - its C++ bootstrap
# touches schema / .wasm / system paths that we would otherwise block.
import ifcopenshell  # noqa: E402
import ifcopenshell.api  # noqa: E402
import ifcopenshell.util.element  # noqa: E402

# Common user utilities - pre-imported so the child doesn't pay the
# startup cost mid-exec and so missing-module import attempts surface
# cleanly.
import math  # noqa: E402
import statistics  # noqa: E402
import re  # noqa: E402
import json as _user_json  # noqa: E402
import collections  # noqa: E402
import uuid as _user_uuid  # noqa: E402

_BLOCKED_EVENTS = {
    # Process / shell escape
    "os.system",
    "os.exec",
    "os.posix_spawn",
    "os.spawnlp",
    "os.spawnv",
    "os.spawnve",
    "os.spawnvp",
    "os.spawnvpe",
    "os.startfile",
    "subprocess.Popen",
    "winreg.OpenKey",
    "winreg.CreateKey",
    "winreg.DeleteKey",
    # Network - any socket or urllib/urlopen
    "socket.connect",
    "socket.bind",
    "socket.gethostbyname",
    "socket.gethostbyaddr",
    "socket.getaddrinfo",
    "urllib.Request",
    # Weakening builtins at runtime
    "setattr",  # only blocked when it would override __builtins__
}

_PATH_GATED_EVENTS = {
    # Block unless the target path is within the sandbox file.
    "open",
    "os.remove",
    "os.rename",
    "os.rmdir",
    "os.mkdir",
    "os.chmod",
    "os.chown",
    "os.truncate",
    "os.link",
    "os.symlink",
    "os.unlink",
    "pathlib.Path.unlink",
    "pathlib.Path.rmdir",
    "pathlib.Path.rename",
}


def _path_is_sandbox(candidate) -> bool:
    try:
        p = os.path.abspath(str(candidate))
    except Exception:
        return False
    # ifcopenshell sometimes writes to a sibling temp file (e.g. for
    # atomic replace). Allow siblings with the same stem as the sandbox
    # path so that round-trip save never trips the hook.
    sandbox_dir = os.path.dirname(SANDBOX_ABS)
    sandbox_stem = os.path.splitext(os.path.basename(SANDBOX_ABS))[0]
    p_dir = os.path.dirname(p)
    p_stem = os.path.splitext(os.path.basename(p))[0]
    if p == SANDBOX_ABS:
        return True
    if p_dir == sandbox_dir and p_stem.startswith(sandbox_stem):
        return True
    return False


def _audit(event, args):
    if event in _BLOCKED_EVENTS:
        raise PermissionError(
            f"execute_ifc_code: blocked audit event '{event}' - this is a "
            f"sandbox, system access is not allowed"
        )
    if event in _PATH_GATED_EVENTS:
        path = args[0] if args else None
        if not _path_is_sandbox(path):
            raise PermissionError(
                f"execute_ifc_code: blocked '{event}' on '{path}' - only "
                f"the sandbox IFC path is writable here"
            )


sys.addaudithook(_audit)

# ----- read user code from stdin -----
USER_CODE = sys.stdin.read()

# ----- load the sandbox model -----
model = ifcopenshell.open(SANDBOX_ABS)

# ----- restricted exec namespace -----
# Keep most builtins available so idiomatic Python works. The audit hook
# above is what actually enforces safety - restricting __builtins__ alone
# is famously leaky (e.g. object.__subclasses__ tricks).
exec_globals = {
    "__builtins__": __builtins__,
    "__name__": "__llm_sandbox__",
    # Objects the LLM is expected to touch
    "model": model,
    "ifc": model,  # alias - common convention in ifcopenshell examples
    "ifcopenshell": ifcopenshell,
    "math": math,
    "statistics": statistics,
    "re": re,
    "json": _user_json,
    "collections": collections,
    "uuid": _user_uuid,
}
exec_locals: dict = {}

_stdout_buffer = io.StringIO()
_err_msg = None
_result_repr = None

_start = time.monotonic()
try:
    with redirect_stdout(_stdout_buffer):
        _compiled = compile(USER_CODE, "<llm-code>", "exec")
        exec(_compiled, exec_globals, exec_locals)
    # Convention: if the LLM wants to surface a value, it assigns to
    # ``result``. We repr it (truncated) so the chat summary can quote it.
    _captured = exec_locals.get("result", exec_globals.get("result"))
    if _captured is not None:
        try:
            _result_repr = repr(_captured)
            if len(_result_repr) > 2000:
                _result_repr = _result_repr[:2000] + " …(truncated)"
        except Exception:
            _result_repr = "<unrepresentable>"
except BaseException as e:  # noqa: BLE001 - LLM code, catch everything
    _err_msg = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"

# ----- persist potentially-mutated model back to sandbox path -----
# Even if the user code raised, we still write - the partial mutation is
# informative for the LLM, and the parent's hash-diff will show exactly
# what was churned. If write itself fails, surface that too.
try:
    model.write(SANDBOX_ABS)
except Exception as write_exc:  # noqa: BLE001
    if _err_msg is None:
        _err_msg = f"Sandbox write failed: {write_exc}"
    else:
        _err_msg += f"\nAdditionally, sandbox write failed: {write_exc}"

_elapsed_ms = int((time.monotonic() - _start) * 1000)

_payload = {
    "stdout": _stdout_buffer.getvalue(),
    "result_repr": _result_repr,
    "elapsed_ms": _elapsed_ms,
    "error": _err_msg,
}

# Write the single structured blob to the real stdout, wrapped in
# sentinel markers so the parent can slice it out even if the user's
# printed output contains unusual characters.
sys.stdout.write("\n<<<CODE_RUNNER_RESULT_OPEN>>>\n")
sys.stdout.write(json.dumps(_payload))
sys.stdout.write("\n<<<CODE_RUNNER_RESULT_CLOSE>>>\n")
sys.stdout.flush()
"""


def run_ifc_code(
    *,
    sandbox_path: Path,
    code: str,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> CodeRunResult:
    """Run ``code`` against ``sandbox_path`` in an isolated subprocess.

    Always returns a ``CodeRunResult`` - timeouts and child crashes are
    folded into the ``timed_out`` / ``error`` fields rather than raising,
    so the caller can surface them to the LLM.
    """
    if not CODE_EXECUTION_ENABLED:
        raise PermissionError(
            "Free-form IFC code execution is disabled for this deployment. "
            "Use structured operations or an isolated trusted worker."
        )
    if not code or not isinstance(code, str):
        raise ValueError("execute_ifc_code: `code` must be a non-empty string")
    if len(code) > MAX_CODE_CHARS:
        raise ValueError(
            f"execute_ifc_code: `code` is {len(code)} chars, cap is {MAX_CODE_CHARS}"
        )

    clamped_timeout = max(MIN_TIMEOUT_S, min(MAX_TIMEOUT_S, float(timeout_s)))

    import os as _os  # local import to avoid polluting module namespace
    env = build_sandbox_environment(dict(_os.environ), sandbox_path)
    # When frozen, the child is THIS onefile exe re-invoked (--run-ifc-sandbox).
    # PyInstaller's bootloader sets these env vars in the running process; if the
    # child inherits them it may think extraction already happened and point at
    # the PARENT's _MEIPASS, causing wrong-path / ModuleNotFound failures. Scrub
    # them so the child bootloader does a clean extraction of its own.
    for _pyi_var in (
        "_MEIPASS2",
        "_PYI_ARCHIVE_FILE",
        "_PYI_APPLICATION_HOME_DIR",
        "_PYI_PARENT_PROCESS_LEVEL",
    ):
        env.pop(_pyi_var, None)

    # In a frozen PyInstaller build, sys.executable is the ifc-backend exe (not a
    # Python interpreter), so `-I -c <program>` would be parsed by run.py's
    # argparse and fail. Re-enter the exe with --run-ifc-sandbox instead - run.py
    # intercepts that flag before argparse and runs this same _CHILD_PROGRAM with
    # the bundled interpreter + ifcopenshell (code still arrives on stdin, sandbox
    # path via env). The dev path keeps using a real interpreter with -I -c.
    if getattr(sys, "frozen", False):
        child_cmd = [sys.executable, "--run-ifc-sandbox"]
    else:
        child_cmd = [sys.executable, "-I", "-c", _CHILD_PROGRAM]

    start = time.monotonic()
    try:
        proc = subprocess.run(
            child_cmd,
            input=code,
            env=env,
            capture_output=True,
            text=True,
            timeout=clamped_timeout,
            # Don't inherit parent's stdin; `input=` above feeds a pipe.
        )
    except subprocess.TimeoutExpired as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        stdout_tail = (exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or ""))[-2000:]
        return CodeRunResult(
            stdout=stdout_tail,
            result_repr=None,
            elapsed_ms=elapsed_ms,
            error=(
                f"execute_ifc_code: wall-clock timeout after "
                f"{clamped_timeout:.1f}s - the child was killed. Simplify "
                f"the code or raise `timeout_s`."
            ),
            timed_out=True,
        )

    # Parse the structured blob out of the child's stdout.
    stdout_raw = proc.stdout or ""
    open_idx = stdout_raw.find(_RESULT_OPEN)
    close_idx = stdout_raw.find(_RESULT_CLOSE)

    # Fallback: the child crashed before reaching the emit step (e.g.
    # segfault during ``ifcopenshell.open``). Surface whatever stderr we
    # got so the LLM can debug.
    if open_idx < 0 or close_idx < 0 or close_idx < open_idx:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        err_bits: list[str] = []
        if proc.returncode != 0:
            err_bits.append(f"child exit code {proc.returncode}")
        if proc.stderr:
            err_bits.append(proc.stderr.strip()[-2000:])
        return CodeRunResult(
            stdout=stdout_raw[-2000:],
            result_repr=None,
            elapsed_ms=elapsed_ms,
            error="execute_ifc_code: child died before producing a result"
            + (" - " + "; ".join(err_bits) if err_bits else ""),
            timed_out=False,
        )

    blob = stdout_raw[open_idx + len(_RESULT_OPEN) : close_idx].strip()
    try:
        payload = json.loads(blob)
    except json.JSONDecodeError as e:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return CodeRunResult(
            stdout=stdout_raw[-2000:],
            result_repr=None,
            elapsed_ms=elapsed_ms,
            error=f"execute_ifc_code: corrupt result blob from child: {e}",
            timed_out=False,
        )

    return CodeRunResult(
        stdout=payload.get("stdout", ""),
        result_repr=payload.get("result_repr"),
        elapsed_ms=int(payload.get("elapsed_ms") or 0),
        error=payload.get("error"),
        timed_out=False,
    )
