"""
ModelSyncEvent type-literal coverage.

Two layers of protection:

1. Direct construction tests for the event types added most recently
   ("metadata_changed", "viewer_command") - a missing Literal member makes
   pydantic raise ValidationError at publish time, which only surfaces when
   that code path runs in production.

2. A guard test that regex-scans every .py file under backend/app/ for
   ModelSyncEvent(type="...") call sites and asserts each literal is allowed
   by the model. This turns "publishes an event type the model rejects" from
   a runtime failure on an obscure route into an immediate test failure.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from app.models.ifc_models import ModelSyncEvent

APP_DIR = Path(__file__).resolve().parent.parent / "app"

# Matches ModelSyncEvent(type="X" / ModelSyncEvent(type='X', tolerating the
# newline + indentation between the open paren and the keyword argument.
_CALL_SITE_RE = re.compile(r"ModelSyncEvent\(\s*type=([\"'])([^\"']+)\1")


def _allowed_types() -> set[str]:
    """The Literal's allowed values, read from the pydantic model at runtime."""
    annotation = ModelSyncEvent.model_fields["type"].annotation
    values = get_args(annotation)
    assert values, "ModelSyncEvent.type annotation yielded no Literal values"
    return set(values)


def _scan_call_sites() -> list[tuple[Path, str]]:
    """Every (file, type-literal) pair for ModelSyncEvent(type=...) under app/."""
    sites: list[tuple[Path, str]] = []
    for py_file in sorted(APP_DIR.rglob("*.py")):
        text = py_file.read_text(encoding="utf-8")
        for match in _CALL_SITE_RE.finditer(text):
            sites.append((py_file, match.group(2)))
    return sites


class TestEventTypeConstruction:
    def test_metadata_changed_constructs(self):
        event = ModelSyncEvent(
            type="metadata_changed", model_version=0, model_fingerprint=""
        )
        assert event.type == "metadata_changed"

    def test_viewer_command_constructs(self):
        event = ModelSyncEvent(
            type="viewer_command", model_version=0, model_fingerprint=""
        )
        assert event.type == "viewer_command"

    def test_unknown_type_rejected(self):
        """The Literal still validates: a made-up type must raise."""
        with pytest.raises(ValidationError):
            ModelSyncEvent(
                type="definitely_not_a_real_event",  # type: ignore[arg-type]
                model_version=0,
                model_fingerprint="",
            )


class TestAllowedSet:
    def test_allowed_set_contains_recent_additions(self):
        allowed = _allowed_types()
        assert "metadata_changed" in allowed
        assert "viewer_command" in allowed


class TestCallSiteGuard:
    def test_scan_finds_known_call_sites(self):
        """Sanity-check the regex itself: it must find the publishers we know
        exist (ifc_routes undo + viewer command bridge). An empty scan would
        make the guard test below pass vacuously."""
        found_types = {literal for _, literal in _scan_call_sites()}
        assert "metadata_changed" in found_types, (
            "Regex scan did not find the known metadata_changed publisher in "
            "app/api/ifc_routes.py - the call-site pattern may have drifted"
        )
        assert "viewer_command" in found_types, (
            "Regex scan did not find the known viewer_command publisher in "
            "app/api/viewer_state_routes.py - the call-site pattern may have drifted"
        )

    def test_every_published_type_is_allowed(self):
        """Each ModelSyncEvent(type="X") literal in app/ must be in the model's
        Literal, otherwise that publish raises ValidationError at runtime."""
        allowed = _allowed_types()
        offenders = [
            f"{path.relative_to(APP_DIR.parent)}: type={literal!r}"
            for path, literal in _scan_call_sites()
            if literal not in allowed
        ]
        assert not offenders, (
            "ModelSyncEvent published with a type missing from the Literal in "
            "app/models/ifc_models.py (would raise ValidationError at runtime):\n"
            + "\n".join(offenders)
        )
