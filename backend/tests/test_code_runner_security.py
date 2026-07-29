"""Security-profile tests for the arbitrary IFC code runner."""

from __future__ import annotations

import pytest

from app.services import code_runner
from app.services.code_runner import build_sandbox_environment, run_ifc_code


def test_run_refuses_when_code_execution_is_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(code_runner, "CODE_EXECUTION_ENABLED", False)

    with pytest.raises(PermissionError, match="disabled"):
        run_ifc_code(
            sandbox_path=tmp_path / "model.ifc",
            code="result = 1",
        )


def test_sandbox_environment_does_not_inherit_credentials(tmp_path):
    sandbox_path = tmp_path / "model.ifc"
    env = build_sandbox_environment(
        {
            "PATH": "/runtime/bin",
            "TEMP": str(tmp_path),
            "OPENAI_API_KEY": "must-not-leak",
            "AWS_SECRET_ACCESS_KEY": "must-not-leak",
            "IFC_ATLAS_API_TOKEN": "must-not-leak",
            "UNRELATED_SECRET": "must-not-leak",
        },
        sandbox_path,
    )

    assert env["PATH"] == "/runtime/bin"
    assert env["TEMP"] == str(tmp_path)
    assert env["SANDBOX_IFC_PATH"] == str(sandbox_path)
    assert env["PYTHONUNBUFFERED"] == "1"
    assert "OPENAI_API_KEY" not in env
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert "IFC_ATLAS_API_TOKEN" not in env
    assert "UNRELATED_SECRET" not in env
