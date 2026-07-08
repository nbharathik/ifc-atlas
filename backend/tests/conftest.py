import os
import tempfile

# Keep the test suite from mutating the developer's real ~/.ifc-atlas: config.py
# performs dir-creation + legacy-data migration + load_dotenv at IMPORT time.
# Redirect the data root to a throwaway temp
# dir BEFORE any `app.*` import triggers that side effect. `setdefault` respects an
# explicit IFC_ATLAS_HOME if a developer already set one.
os.environ.setdefault("IFC_ATLAS_HOME", tempfile.mkdtemp(prefix="ifc-atlas-test-"))

import shutil
from pathlib import Path

import pytest

from app.services.ifc_service import IfcService

REPO_ROOT = Path(__file__).parent.parent.parent
BASICHOUSE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"


@pytest.fixture(scope="session")
def _session_ifc(tmp_path_factory):
    """Copy BasicHouse.ifc once per session into a temp directory."""
    if not BASICHOUSE.exists():
        pytest.skip(
            "sample model missing at data/fixtures/BasicHouse.ifc - download it "
            "with scripts/fetch-sample.ps1 (Windows) or scripts/fetch-sample.sh"
        )
    d = tmp_path_factory.mktemp("ifc_session")
    dst = d / "BasicHouse.ifc"
    shutil.copy(BASICHOUSE, dst)
    return dst


@pytest.fixture
def svc(_session_ifc, monkeypatch):
    """Fresh IfcService per test, loaded from the session IFC copy.
    _persist_model is patched to a no-op so tests don't write to disk.
    """
    service = IfcService()
    monkeypatch.setattr(service, "_persist_model", lambda: None)
    service.load(_session_ifc)
    return service


@pytest.fixture(autouse=True)
def _reset_module_singletons(monkeypatch):
    """Neutralise module-level singletons between tests.

    Two state-leak sources in the tool router cause cross-test interference:

    1. ``readiness_service``. ``warming_envelope`` short-circuits
       tier-2/3 tool calls when the singleton reports ``ifcopenshell != 'ready'``.
       Pytest tests that mutate that state don't reset between cases, so any
       legacy test relying on tools running can be intercepted by leftover
       ``'warming'`` / ``'cold'`` state from a prior test.
    2. ``tool_memo_cache`` (per-turn memoization for read-only tools).
       The cache key is ``(tool_name, arguments)`` and the singleton lives for
       the lifetime of the process, so any prior test that called e.g.
       ``execute_tool("get_project_info", {})`` with a mocked ifc_service will
       pin its result in the cache and a later test calling the same tool with
       a different mock gets the stale value back.

    This autouse fixture restores a sane default before each test:

    * Both readiness backends marked ``ready`` so legacy tests that expect the
      tool to run reach ``_execute_tool_raw`` instead of getting the warming
      envelope.
    * Live probes pinned to ``True`` so ``get_state()``'s reconcile-down branch
      doesn't flip ``ready`` back to ``cold`` when the underlying services
      aren't really loaded (the case in most unit tests).
    * ``tool_memo_cache`` invalidated so each test starts from an empty cache
      and mocked tool results from prior tests don't leak in.

    Tests that exercise the warming gate (test_readiness_service.py,
    test_warming_envelope_*) override the probes via their own
    ``monkeypatch.setattr`` after this fixture runs, and pytest's monkeypatch
    is per-test so the test's setattr wins. Tests that mock
    ``app.services.tools.ifc_service`` with a local patch are unaffected because
    this fixture doesn't touch the tool router's module bindings.
    """
    from app.services import readiness_service as _rs

    _rs.readiness_service.reset()
    _rs.readiness_service.mark_ifcopenshell_ready()
    _rs.readiness_service.mark_native_index_ready(total_ms=0)
    monkeypatch.setattr(_rs, "_safe_ifc_service_is_loaded", lambda: True)
    monkeypatch.setattr(_rs, "_safe_native_index_is_loaded", lambda: True)

    # Drop the per-turn memo cache so stale results from a prior test (where
    # ``ifc_service`` was mocked differently) don't leak into this one.
    try:
        from app.services import tools as _tools
        _tools.tool_memo_cache.invalidate()
    except Exception:
        # Defensive: if tools.py can't be imported (e.g. very early in a
        # collection error), don't break test discovery.
        pass

    yield
    # Post-test: drop singleton back to cold so the next test's autouse
    # invocation starts from a clean slate even if it doesn't get this fixture.
    _rs.readiness_service.reset()
