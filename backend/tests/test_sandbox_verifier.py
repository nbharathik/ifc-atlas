"""D4 verifier: health delta + geometry sanity on sandbox proposals."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

ifcopenshell = pytest.importorskip("ifcopenshell")

from app.services import element_factory
from app.services.project_template_service import create_blank_project
from app.services.sandbox_service import (
    _HEALTH_BASELINE_CACHE,
    _geometry_sanity,
    _verifier_note,
    _verify_sandbox,
)


@pytest.fixture(autouse=True)
def _fresh_baseline_cache():
    _HEALTH_BASELINE_CACHE.clear()
    yield
    _HEALTH_BASELINE_CACHE.clear()


def _model():
    data = create_blank_project("single_storey")
    p = Path(tempfile.mktemp(suffix=".ifc"))
    p.write_bytes(data)
    try:
        return ifcopenshell.open(str(p))
    finally:
        p.unlink(missing_ok=True)


class _Change:
    def __init__(self, express_id: int, change: str = "created"):
        self.express_id = express_id
        self.change = change


def test_clean_wall_creation_verdict_passes():
    live = _model()
    sandbox = _model()
    wall = element_factory.create_wall(sandbox, start=[0, 0], end=[4, 0])
    verdict = _verify_sandbox(sandbox, live, "fp-live", [_Change(wall.id())])
    assert verdict is not None
    assert verdict["status"] in ("pass", "warn"), verdict
    assert verdict["geometry"]["checked"] == 1
    assert verdict["geometry"]["failures"] == []


def test_geometry_sanity_flags_missing_representation_body():
    """A created product whose representation cannot tessellate is flagged -
    exactly the failure mode of the old broken wall recipe."""
    sandbox = _model()
    import ifcopenshell.api.root

    wall = ifcopenshell.api.root.create_entity(sandbox, ifc_class="IfcWall", name="Broken")
    # Attach an empty shape representation: create_shape will fail on it.
    ctx = element_factory.get_body_context(sandbox)
    rep = sandbox.createIfcShapeRepresentation(ctx, "Body", "SweptSolid", [])
    import ifcopenshell.api.geometry

    ifcopenshell.api.geometry.assign_representation(sandbox, product=wall, representation=rep)

    result = _geometry_sanity(sandbox, [_Change(wall.id())])
    assert result["checked"] == 1
    assert result["failures"], "empty representation must be flagged"


def test_products_without_representation_are_not_flagged():
    sandbox = _model()
    storey = element_factory.create_storey(sandbox, name="L2", elevation=3.0)
    result = _geometry_sanity(sandbox, [_Change(storey.id())])
    assert result["checked"] == 0
    assert result["failures"] == []


def test_verifier_note_guides_self_repair():
    assert _verifier_note(None) == ""
    assert "PASS" in _verifier_note({"status": "pass"})
    fail_note = _verifier_note({"status": "fail", "note": "1 degenerate element"})
    assert "FAIL" in fail_note
    assert "corrected" in fail_note


def test_verifier_failure_returns_none_not_raise(monkeypatch):
    import app.services.sandbox_service as sb

    def _boom(*a, **k):
        raise RuntimeError("health check exploded")

    monkeypatch.setattr("app.services.model_health.run_health_check", _boom)
    live = _model()
    verdict = sb._verify_sandbox(live, live, "fp", [])
    assert verdict is None


def test_propose_edit_envelope_carries_verdict(tmp_path):
    """End-to-end: a staged create_wall proposal ships a verifier verdict."""
    from app.services.ifc_service import IfcService
    from app.services.sandbox_service import SandboxService

    path = tmp_path / "m.ifc"
    path.write_bytes(create_blank_project("single_storey"))
    svc = IfcService()
    svc.load(path)

    sandbox = SandboxService()
    envelope = sandbox.propose_edit(
        ifc_service=svc,
        operations=[{"op": "create_wall", "start": [0, 0], "end": [3, 0]}],
        summary="verifier e2e",
    )
    assert envelope is not None
    assert envelope.verifier_verdict is not None
    assert envelope.verifier_verdict["status"] in ("pass", "warn", "fail")
    assert envelope.verifier_verdict["geometry"]["checked"] >= 1
