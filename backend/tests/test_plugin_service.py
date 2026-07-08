"""
Tests for the plugin / user-script service.

All in-memory: manifests and params are plain dicts, IFC models are
authored with ifcopenshell.file(schema="IFC4"), and the sandbox is
monkeypatched for run() tests. The built-in scripts are additionally
exec()'d directly against in-memory models to prove the shipped scripts
genuinely mutate a model correctly without spawning the subprocess sandbox.
"""

from __future__ import annotations

import collections
import io
import json
import math
import re
import uuid
import zipfile

import pytest

from app.services.plugin_service import (
    BUILTIN_PLUGIN_DIR,
    MAX_PLUGIN_ZIP_BYTES,
    MAX_SCRIPT_CHARS,
    PluginService,
    PluginValidationError,
    validate_manifest,
    validate_params,
    validate_script,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SCRIPT = "result = len(model.by_type('IfcWall'))\n"


def _manifest(**overrides):
    base = {
        "id": "my-plugin",
        "name": "My Plugin",
        "description": "Counts walls.",
        "version": "1.0.0",
        "params": [
            {
                "name": "tolerance_mm",
                "label": "Tolerance (mm)",
                "type": "number",
                "default": 1.0,
                "required": False,
            }
        ],
        "requires_write": False,
    }
    base.update(overrides)
    return base


@pytest.fixture
def svc(tmp_path):
    return PluginService(user_dir=tmp_path / "plugins")


def _zip_bytes(prefix: str = "", manifest=None, include_script: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            prefix + "manifest.json",
            json.dumps(manifest if manifest is not None else _manifest(id="zipped-plugin")),
        )
        if include_script:
            zf.writestr(prefix + "script.py", SCRIPT)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Manifest validation matrix
# ---------------------------------------------------------------------------

def test_valid_manifest_normalises():
    out = validate_manifest(_manifest())
    assert out["id"] == "my-plugin"
    assert out["params"][0]["default"] == 1.0
    assert out["requires_write"] is False


def test_manifest_fills_param_defaults():
    out = validate_manifest(
        _manifest(params=[{"name": "flag", "type": "boolean"}])
    )
    param = out["params"][0]
    assert param["label"] == "flag"
    assert param["required"] is False
    assert "default" not in param


@pytest.mark.parametrize(
    "bad_id", ["X", "a", "-leading-dash", "UPPER", "has space", "a" * 65, 7, None]
)
def test_manifest_rejects_bad_id(bad_id):
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(id=bad_id))
    assert any("'id'" in e for e in exc.value.errors)


def test_manifest_rejects_empty_name():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(name="  "))
    assert any("'name'" in e for e in exc.value.errors)


def test_manifest_rejects_non_list_params():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(params={"name": "x"}))
    assert any("'params'" in e for e in exc.value.errors)


def test_manifest_rejects_bad_param_type():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(params=[{"name": "x", "type": "float"}]))
    assert any("string|number|boolean" in e for e in exc.value.errors)


def test_manifest_rejects_default_type_mismatch():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(
            _manifest(params=[{"name": "x", "type": "number", "default": "big"}])
        )
    assert any("'default'" in e for e in exc.value.errors)


def test_manifest_rejects_non_identifier_param_name():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(params=[{"name": "not valid", "type": "string"}]))
    assert any("identifier" in e for e in exc.value.errors)


def test_manifest_rejects_duplicate_param_names():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(
            _manifest(
                params=[
                    {"name": "x", "type": "string"},
                    {"name": "x", "type": "number"},
                ]
            )
        )
    assert any("duplicate" in e for e in exc.value.errors)


def test_manifest_rejects_non_bool_requires_write():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(requires_write="yes"))
    assert any("'requires_write'" in e for e in exc.value.errors)


def test_manifest_rejects_unknown_keys():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(entry_point="main"))
    assert any("unknown key 'entry_point'" in e for e in exc.value.errors)


def test_manifest_collects_all_errors():
    with pytest.raises(PluginValidationError) as exc:
        validate_manifest(_manifest(id="X", name="", requires_write="yes"))
    assert len(exc.value.errors) >= 3


def test_script_rejects_empty():
    with pytest.raises(PluginValidationError):
        validate_script("   \n")


def test_script_rejects_too_long():
    with pytest.raises(PluginValidationError):
        validate_script("x" * (MAX_SCRIPT_CHARS + 1))


# ---------------------------------------------------------------------------
# validate_params matrix
# ---------------------------------------------------------------------------

def _params_manifest():
    return validate_manifest(
        _manifest(
            params=[
                {"name": "tolerance_mm", "type": "number", "default": 1.0},
                {"name": "label_text", "type": "string", "default": "x"},
                {"name": "dry_run", "type": "boolean", "default": False},
                {"name": "code", "type": "string", "required": True},
            ]
        )
    )


def test_params_defaults_applied():
    out = validate_params(_params_manifest(), {"code": "A1"})
    assert out == {
        "tolerance_mm": 1.0,
        "label_text": "x",
        "dry_run": False,
        "code": "A1",
    }


def test_params_missing_required_rejected():
    with pytest.raises(PluginValidationError) as exc:
        validate_params(_params_manifest(), {})
    assert "param 'code': required" in exc.value.errors


def test_params_unknown_key_rejected():
    with pytest.raises(PluginValidationError) as exc:
        validate_params(_params_manifest(), {"code": "A1", "bogus": 1})
    assert "param 'bogus': unknown parameter" in exc.value.errors


@pytest.mark.parametrize(
    "raw,expected",
    [(True, True), ("true", True), ("1", True), (1, True),
     (False, False), ("false", False), ("0", False), (0, False)],
)
def test_params_boolean_coercion(raw, expected):
    out = validate_params(_params_manifest(), {"code": "A1", "dry_run": raw})
    assert out["dry_run"] is expected


@pytest.mark.parametrize(
    "raw,expected", [("3.5", 3.5), ("2", 2), (7, 7), (1.5, 1.5)]
)
def test_params_number_coercion(raw, expected):
    out = validate_params(_params_manifest(), {"code": "A1", "tolerance_mm": raw})
    assert out["tolerance_mm"] == expected


def test_params_number_rejects_bool_and_text():
    with pytest.raises(PluginValidationError) as exc:
        validate_params(_params_manifest(), {"code": "A1", "tolerance_mm": True})
    assert "param 'tolerance_mm': expected number" in exc.value.errors
    with pytest.raises(PluginValidationError) as exc:
        validate_params(_params_manifest(), {"code": "A1", "tolerance_mm": "wide"})
    assert "param 'tolerance_mm': expected number" in exc.value.errors


def test_params_string_rejects_non_string():
    with pytest.raises(PluginValidationError) as exc:
        validate_params(_params_manifest(), {"code": 42})
    assert "param 'code': expected string" in exc.value.errors


def test_params_collects_all_errors():
    with pytest.raises(PluginValidationError) as exc:
        validate_params(
            _params_manifest(),
            {"tolerance_mm": "wide", "dry_run": "maybe", "bogus": 1},
        )
    assert len(exc.value.errors) == 4  # two coercions + unknown + missing required


# ---------------------------------------------------------------------------
# Service CRUD + built-in discovery
# ---------------------------------------------------------------------------

def test_builtins_discovered(svc):
    plugins = svc.list_plugins()
    by_id = {p["id"]: p for p in plugins}
    for builtin_id in (
        "set_storey_elevations",
        "merge_duplicate_walls",
        "assign_classification",
    ):
        assert builtin_id in by_id
        assert by_id[builtin_id]["builtin"] is True
        assert by_id[builtin_id]["requires_write"] is True


def test_get_builtin_returns_script(svc):
    record = svc.get_plugin("merge_duplicate_walls")
    assert record["builtin"] is True
    assert "remove_product" in record["script"]


def test_get_unknown_plugin_raises(svc):
    with pytest.raises(KeyError):
        svc.get_plugin("does-not-exist")


def test_install_get_list_roundtrip(svc, tmp_path):
    installed = svc.install(_manifest(), SCRIPT)
    assert installed["builtin"] is False
    record = svc.get_plugin("my-plugin")
    assert record["script"] == SCRIPT
    assert record["builtin"] is False
    assert any(p["id"] == "my-plugin" for p in svc.list_plugins())
    # Persists on disk: a fresh service over the same dir sees it.
    again = PluginService(user_dir=tmp_path / "plugins")
    assert again.get_plugin("my-plugin")["script"] == SCRIPT


def test_install_duplicate_raises(svc):
    svc.install(_manifest(), SCRIPT)
    with pytest.raises(FileExistsError):
        svc.install(_manifest(), SCRIPT)


def test_install_builtin_id_raises(svc):
    with pytest.raises(PermissionError):
        svc.install(_manifest(id="merge_duplicate_walls"), SCRIPT)


def test_install_invalid_manifest_and_script_collects_both(svc):
    with pytest.raises(PluginValidationError) as exc:
        svc.install(_manifest(id="BAD ID"), "")
    assert any("'id'" in e for e in exc.value.errors)
    assert any("script" in e for e in exc.value.errors)


def test_update_script(svc):
    svc.install(_manifest(), SCRIPT)
    updated = svc.update("my-plugin", script="result = 1\n")
    assert updated["script"] == "result = 1\n"
    assert svc.get_plugin("my-plugin")["script"] == "result = 1\n"


def test_update_builtin_raises_permission(svc):
    with pytest.raises(PermissionError):
        svc.update("set_storey_elevations", script="result = 1\n")


def test_update_unknown_raises(svc):
    with pytest.raises(KeyError):
        svc.update("does-not-exist", script="result = 1\n")


def test_update_cannot_change_id(svc):
    svc.install(_manifest(), SCRIPT)
    with pytest.raises(PluginValidationError) as exc:
        svc.update("my-plugin", manifest=_manifest(id="other-id"))
    assert any("cannot be changed" in e for e in exc.value.errors)


def test_delete(svc):
    svc.install(_manifest(), SCRIPT)
    svc.delete("my-plugin")
    with pytest.raises(KeyError):
        svc.get_plugin("my-plugin")


def test_delete_builtin_raises_permission(svc):
    with pytest.raises(PermissionError):
        svc.delete("assign_classification")
    # still listed afterwards
    assert any(p["id"] == "assign_classification" for p in svc.list_plugins())


def test_delete_unknown_raises(svc):
    with pytest.raises(KeyError):
        svc.delete("does-not-exist")


# ---------------------------------------------------------------------------
# install_zip
# ---------------------------------------------------------------------------

def test_install_zip_root_layout(svc):
    installed = svc.install_zip(_zip_bytes())
    assert installed["id"] == "zipped-plugin"
    assert svc.get_plugin("zipped-plugin")["script"] == SCRIPT


def test_install_zip_single_folder_layout(svc):
    installed = svc.install_zip(_zip_bytes(prefix="my-folder/"))
    assert installed["id"] == "zipped-plugin"


def test_install_zip_missing_script_rejected(svc):
    with pytest.raises(PluginValidationError) as exc:
        svc.install_zip(_zip_bytes(include_script=False))
    assert any("manifest.json and script.py" in e for e in exc.value.errors)


def test_install_zip_not_a_zip_rejected(svc):
    with pytest.raises(PluginValidationError) as exc:
        svc.install_zip(b"definitely not a zip")
    assert any("not a valid zip" in e for e in exc.value.errors)


def test_install_zip_oversize_rejected(svc):
    with pytest.raises(PluginValidationError) as exc:
        svc.install_zip(b"0" * (MAX_PLUGIN_ZIP_BYTES + 1))
    assert any("size cap" in e for e in exc.value.errors)


def test_install_zip_bad_manifest_json_rejected(svc):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("manifest.json", "{not json")
        zf.writestr("script.py", SCRIPT)
    with pytest.raises(PluginValidationError) as exc:
        svc.install_zip(buf.getvalue())
    assert any("not valid JSON" in e for e in exc.value.errors)


# ---------------------------------------------------------------------------
# run() with the sandbox monkeypatched
# ---------------------------------------------------------------------------

def _patch_sandbox(monkeypatch, captured, result):
    from app.services import plugin_service as ps_mod

    def fake_execute_python(**kwargs):
        captured.update(kwargs)
        return dict(result)

    monkeypatch.setattr(ps_mod.sandbox_service, "execute_python", fake_execute_python)


def test_run_builds_params_preamble_and_read_only(svc, monkeypatch):
    captured: dict = {}
    _patch_sandbox(
        monkeypatch,
        captured,
        {"action": "execute_result", "stdout": "", "result": "3", "elapsed_ms": 1.0},
    )
    svc.install(_manifest(id="counter"), SCRIPT)
    sentinel = object()

    out = svc.run("counter", {"tolerance_mm": "2.5"}, ifc_service=sentinel)

    first_line, rest = captured["code"].split("\n", 1)
    assert first_line.startswith("params = json.loads(")
    literal = first_line[len("params = json.loads(") : -1]
    assert json.loads(json.loads(literal)) == {"tolerance_mm": 2.5}
    assert rest == SCRIPT
    assert captured["read_only"] is True  # requires_write False
    assert captured["timeout_s"] == 120
    assert captured["summary"] == "Plugin: My Plugin"
    assert captured["ifc_service"] is sentinel
    assert out["plugin_id"] == "counter"
    assert out["plugin_name"] == "My Plugin"
    assert out["result_repr"] == "3"
    assert out["action"] == "execute_result"


def test_run_write_plugin_not_read_only(svc, monkeypatch):
    captured: dict = {}
    _patch_sandbox(
        monkeypatch,
        captured,
        {
            "action": "pending_edit",
            "edit_id": "e1",
            "summary": "s",
            "counts": {"total": 1},
            "changes": [],
        },
    )
    out = svc.run(
        "merge_duplicate_walls", {"tolerance_mm": 2}, ifc_service=object()
    )
    assert captured["read_only"] is False
    assert out["plugin_id"] == "merge_duplicate_walls"
    assert out["plugin_name"] == "Merge Duplicate Walls"
    assert out["action"] == "pending_edit"


def test_run_unknown_plugin_raises(svc):
    with pytest.raises(KeyError):
        svc.run("does-not-exist", {}, ifc_service=object())


def test_run_invalid_params_raises_before_sandbox(svc, monkeypatch):
    captured: dict = {}
    _patch_sandbox(monkeypatch, captured, {"action": "execute_result"})
    with pytest.raises(PluginValidationError) as exc:
        svc.run("assign_classification", {}, ifc_service=object())
    assert "param 'code': required" in exc.value.errors
    assert captured == {}  # sandbox never invoked


# ---------------------------------------------------------------------------
# Built-in script logic, exec'd directly against in-memory models
# ---------------------------------------------------------------------------

def _exec_builtin(plugin_id: str, model, params: dict):
    import ifcopenshell

    script = (BUILTIN_PLUGIN_DIR / plugin_id / "script.py").read_text(encoding="utf-8")
    namespace = {
        "model": model,
        "ifcopenshell": ifcopenshell,
        "json": json,
        "re": re,
        "math": math,
        "collections": collections,
        "uuid": uuid,
        "params": params,
    }
    exec(compile(script, plugin_id, "exec"), namespace)
    return namespace


def _placement(model, x=0.0, y=0.0, z=0.0):
    import ifcopenshell  # noqa: F401 - createIfc* lives on the model handle

    point = model.createIfcCartesianPoint((float(x), float(y), float(z)))
    axis = model.createIfcAxis2Placement3D(point, None, None)
    return model.createIfcLocalPlacement(None, axis), point


def test_set_storey_elevations_script():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    placement_a, point_a = _placement(model, z=0.0)
    ground = model.createIfcBuildingStorey(
        GlobalId=ifcopenshell.guid.new(),
        Name="Ground",
        ObjectPlacement=placement_a,
        Elevation=0.0,
    )
    placement_b, point_b = _placement(model, z=3.0)
    level1 = model.createIfcBuildingStorey(
        GlobalId=ifcopenshell.guid.new(),
        Name="Level 1",
        ObjectPlacement=placement_b,
        Elevation=3.0,
    )

    ns = _exec_builtin(
        "set_storey_elevations",
        model,
        {"elevations_json": json.dumps({"Level 1": 3.5, "Missing": 9.9})},
    )

    assert level1.Elevation == 3.5
    assert point_b.Coordinates[2] == 3.5
    assert ground.Elevation == 0.0
    assert point_a.Coordinates[2] == 0.0
    assert ns["result"] == 1


def test_merge_duplicate_walls_script():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    placement1, _ = _placement(model, 0.0, 0.0)
    wall1 = model.createIfcWall(
        GlobalId=ifcopenshell.guid.new(), Name="W", ObjectPlacement=placement1
    )
    # 0.2 mm away from wall1 - inside the 1 mm tolerance.
    placement2, _ = _placement(model, 0.0002, 0.0)
    wall2 = model.createIfcWall(
        GlobalId=ifcopenshell.guid.new(), Name="W", ObjectPlacement=placement2
    )
    placement3, _ = _placement(model, 5.0, 0.0)
    wall3 = model.createIfcWall(
        GlobalId=ifcopenshell.guid.new(), Name="W", ObjectPlacement=placement3
    )
    storey = model.createIfcBuildingStorey(
        GlobalId=ifcopenshell.guid.new(), Name="S"
    )
    containment = model.createIfcRelContainedInSpatialStructure(
        GlobalId=ifcopenshell.guid.new(),
        RelatedElements=[wall1, wall2, wall3],
        RelatingStructure=storey,
    )
    keep_ids = {wall1.id(), wall3.id()}

    ns = _exec_builtin("merge_duplicate_walls", model, {"tolerance_mm": 1.0})

    assert ns["result"] == 1
    remaining = model.by_type("IfcWall")
    assert {w.id() for w in remaining} == keep_ids
    # The containment relationship was cleaned, not orphaned.
    assert {e.id() for e in containment.RelatedElements} == keep_ids


def test_merge_duplicate_walls_keeps_distinct_names():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    placement1, _ = _placement(model, 0.0, 0.0)
    model.createIfcWall(
        GlobalId=ifcopenshell.guid.new(), Name="A", ObjectPlacement=placement1
    )
    placement2, _ = _placement(model, 0.0, 0.0)
    model.createIfcWall(
        GlobalId=ifcopenshell.guid.new(), Name="B", ObjectPlacement=placement2
    )

    ns = _exec_builtin("merge_duplicate_walls", model, {"tolerance_mm": 1.0})

    assert ns["result"] == 0
    assert len(model.by_type("IfcWall")) == 2


def test_assign_classification_script():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    wall1 = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="W1")
    wall2 = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="W2")
    model.createIfcDoor(GlobalId=ifcopenshell.guid.new(), Name="D1")

    ns = _exec_builtin(
        "assign_classification",
        model,
        {
            "pattern": "IfcWall.*",
            "system": "Uniclass",
            "code": "Ss_25_10",
            "title": "Walls",
        },
    )

    assert ns["result"] == 2
    classifications = model.by_type("IfcClassification")
    assert len(classifications) == 1
    assert classifications[0].Name == "Uniclass"
    references = model.by_type("IfcClassificationReference")
    assert len(references) == 1
    assert references[0].Identification == "Ss_25_10"
    assert references[0].Name == "Walls"
    assert references[0].ReferencedSource == classifications[0]
    rels = model.by_type("IfcRelAssociatesClassification")
    assert len(rels) == 1
    assert {e.id() for e in rels[0].RelatedObjects} == {wall1.id(), wall2.id()}


def test_assign_classification_reuses_existing_system():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="W1")
    existing = model.create_entity("IfcClassification", Name="Uniclass")

    ns = _exec_builtin(
        "assign_classification",
        model,
        {"pattern": "IfcWall.*", "system": "Uniclass", "code": "Ss_30", "title": ""},
    )

    assert ns["result"] == 1
    classifications = model.by_type("IfcClassification")
    assert len(classifications) == 1
    assert classifications[0] == existing
    # title omitted: reference Name falls back to the code
    assert model.by_type("IfcClassificationReference")[0].Name == "Ss_30"


def test_assign_classification_no_match_is_noop():
    import ifcopenshell

    model = ifcopenshell.file(schema="IFC4")
    model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="W1")

    ns = _exec_builtin(
        "assign_classification",
        model,
        {"pattern": "IfcBeam.*", "system": "Uniclass", "code": "X", "title": ""},
    )

    assert ns["result"] == 0
    assert len(model.by_type("IfcClassification")) == 0
    assert len(model.by_type("IfcRelAssociatesClassification")) == 0
