"""Tests for the ifc-atlas CLI (app.cli).

Every test drives ``main([...])`` in-process. Models are authored with
ifcopenshell.api and written to a temp directory, so the suite needs no
external fixture file. Viewer commands run against a monkeypatched HTTP
client factory (``app.cli._make_client``) - no backend process is started,
and the ``serve`` / ``mcp`` subcommands are only tested for argument wiring.
"""

from __future__ import annotations

import base64
import csv
import io
import json

import httpx
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import pytest

import app.cli as cli
from app.cli import build_parser, main

# ---------------------------------------------------------------------------
# Model + IDS authoring helpers
# ---------------------------------------------------------------------------


def _api(verb: str, model, **kwargs):
    return ifcopenshell.api.run(verb, model, **kwargs)


def _add_wall(model, storey, name: str, quantities: dict):
    wall = _api("root.create_entity", model, ifc_class="IfcWall", name=name)
    _api("spatial.assign_container", model, products=[wall], relating_structure=storey)
    qto = _api("pset.add_qto", model, product=wall, name="Qto_WallBaseQuantities")
    _api("pset.edit_qto", model, qto=qto, properties=quantities)
    return wall


def _build_house():
    """IFC4 project with SI units, one storey, and two walls with quantities."""
    model = ifcopenshell.file(schema="IFC4")
    project = _api("root.create_entity", model, ifc_class="IfcProject", name="CLI House")
    length = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    area = model.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE")
    volume = model.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    project.UnitsInContext = model.create_entity(
        "IfcUnitAssignment", Units=[length, area, volume]
    )
    site = _api("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = _api("root.create_entity", model, ifc_class="IfcBuilding", name="Building")
    _api("aggregate.assign_object", model, products=[site], relating_object=project)
    _api("aggregate.assign_object", model, products=[building], relating_object=site)
    storey = _api(
        "root.create_entity", model, ifc_class="IfcBuildingStorey", name="Ground Floor"
    )
    _api("aggregate.assign_object", model, products=[storey], relating_object=building)

    wall1 = _add_wall(
        model, storey, "W1", {"NetVolume": 2.0, "GrossSideArea": 8.0, "Length": 4.0}
    )
    wall2 = _add_wall(
        model, storey, "W2", {"NetVolume": 3.0, "GrossSideArea": 10.0, "Length": 5.0}
    )
    for wall in (wall1, wall2):
        pset = _api("pset.add_pset", model, product=wall, name="Pset_WallCommon")
        _api("pset.edit_pset", model, pset=pset, properties={"FireRating": "F30"})
    return model, wall1


def _make_ids_xml(spec_name: str, prop: str) -> str:
    """One-spec IDS: every IfcWall must carry Pset_WallCommon.<prop>."""
    import ifctester.facet as facet_mod
    import ifctester.ids as ids_mod

    ids = ids_mod.Ids(title="CLI Test IDS")
    spec = ids_mod.Specification(
        name=spec_name, ifcVersion=["IFC2X3", "IFC4", "IFC4X3_ADD2"]
    )
    spec.applicability.append(facet_mod.Entity(name="IfcWall"))
    spec.requirements.append(
        facet_mod.Property(propertySet="Pset_WallCommon", baseName=prop)
    )
    ids.specifications.append(spec)
    return ids.to_string()


# ---------------------------------------------------------------------------
# Fixtures (module-scoped: author + write once)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def work_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("cli_models")


@pytest.fixture(scope="module")
def house(work_dir):
    """Two on-disk variants of the same model: b renames wall W1."""
    model, wall1 = _build_house()
    path_a = work_dir / "house_a.ifc"
    model.write(str(path_a))
    wall1_id = wall1.id()
    wall1.Name = "W1-renamed"
    path_b = work_dir / "house_b.ifc"
    model.write(str(path_b))
    return {"a": path_a, "b": path_b, "wall1_id": wall1_id}


@pytest.fixture(scope="module")
def ids_pass_path(work_dir):
    path = work_dir / "pass.ids"
    path.write_text(_make_ids_xml("Walls have FireRating", "FireRating"), encoding="utf-8")
    return path


@pytest.fixture(scope="module")
def ids_fail_path(work_dir):
    path = work_dir / "fail.ids"
    path.write_text(
        _make_ids_xml("Walls have AcousticRating", "AcousticRating"), encoding="utf-8"
    )
    return path


# ---------------------------------------------------------------------------
# Fake HTTP client for viewer commands
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status_code: int = 200, payload: dict | None = None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, response: _FakeResponse | None = None, error: Exception | None = None):
        self.response = response or _FakeResponse()
        self.error = error
        self.requests: list[tuple[str, str, object]] = []
        self.closed = False

    def get(self, path, **kwargs):
        return self._handle("GET", path, None)

    def post(self, path, json=None, **kwargs):
        return self._handle("POST", path, json)

    def _handle(self, method, path, body):
        self.requests.append((method, path, body))
        if self.error is not None:
            raise self.error
        return self.response

    def close(self):
        self.closed = True


def _patch_client(monkeypatch, fake: _FakeClient) -> dict:
    captured: dict = {}

    def factory(base_url: str, timeout: float):
        captured["base_url"] = base_url
        captured["timeout"] = timeout
        return fake

    monkeypatch.setattr(cli, "_make_client", factory)
    return captured


# ---------------------------------------------------------------------------
# info
# ---------------------------------------------------------------------------


def test_info_human_output(house, capsys):
    assert main(["info", str(house["a"])]) == 0
    out = capsys.readouterr().out
    assert "IFC4" in out
    assert "CLI House" in out
    assert "Ground Floor" in out
    assert "IfcWall" in out


def test_info_json_output(house, capsys):
    assert main(["info", str(house["a"]), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["schema"].startswith("IFC4")
    assert data["project_name"] == "CLI House"
    assert data["total_elements"] == 2
    assert data["element_counts"] == {"IfcWall": 2}
    assert [storey["name"] for storey in data["storeys"]] == ["Ground Floor"]


def test_info_missing_file_exits_2(tmp_path, capsys):
    assert main(["info", str(tmp_path / "nope.ifc")]) == 2
    assert "not found" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def test_validate_all_pass_exits_0(house, ids_pass_path, capsys):
    assert main(["validate", str(house["a"]), "--ids", str(ids_pass_path)]) == 0
    out = capsys.readouterr().out
    assert "[PASS]" in out
    assert "Result: PASSED" in out


def test_validate_failure_exits_1(house, ids_fail_path, capsys):
    assert main(["validate", str(house["a"]), "--ids", str(ids_fail_path)]) == 1
    out = capsys.readouterr().out
    assert "[FAIL]" in out
    assert "Result: FAILED" in out
    # Both walls fail the AcousticRating requirement and get listed.
    assert "W1" in out
    assert "W2" in out


def test_validate_writes_csv_and_json(house, ids_fail_path, tmp_path):
    out_csv = tmp_path / "failures.csv"
    out_json = tmp_path / "report.json"
    rc = main(
        [
            "validate",
            str(house["a"]),
            "--ids",
            str(ids_fail_path),
            "--csv",
            str(out_csv),
            "--json",
            str(out_json),
        ]
    )
    assert rc == 1

    rows = list(csv.reader(io.StringIO(out_csv.read_text(encoding="utf-8"))))
    assert rows[0] == [
        "spec_name",
        "express_id",
        "global_id",
        "ifc_type",
        "name",
        "facet_type",
        "reason",
    ]
    assert len(rows) == 3  # header + two failing walls

    report = json.loads(out_json.read_text(encoding="utf-8"))
    assert report["failed"] == 1
    assert report["specifications"][0]["status"] == "failed"


def test_validate_invalid_ids_exits_2(house, tmp_path, capsys):
    bad = tmp_path / "bad.ids"
    bad.write_text("definitely not xml <<<", encoding="utf-8")
    assert main(["validate", str(house["a"]), "--ids", str(bad)]) == 2
    assert "IDS validation failed" in capsys.readouterr().err


def test_validate_missing_ids_file_exits_2(house, tmp_path, capsys):
    assert main(["validate", str(house["a"]), "--ids", str(tmp_path / "nope.ids")]) == 2
    assert "not found" in capsys.readouterr().err


def test_validate_limit_per_spec_wiring():
    args = build_parser().parse_args(
        ["validate", "m.ifc", "--ids", "s.ids", "--limit-per-spec", "5"]
    )
    assert args.limit_per_spec == 5


# ---------------------------------------------------------------------------
# qto
# ---------------------------------------------------------------------------


def test_qto_table_output(house, capsys):
    assert main(["qto", str(house["a"])]) == 0
    out = capsys.readouterr().out
    assert "ifc_class" in out
    assert "IfcWall" in out
    assert "TOTAL" in out
    assert "volume_m3" in out


def test_qto_json_output(house, capsys):
    assert main(["qto", str(house["a"]), "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["group_by"] == ["ifc_class"]
    assert data["overall"]["count"] == 2
    wall_group = data["groups"][0]
    assert wall_group["label"] == "IfcWall"
    assert wall_group["count"] == 2
    assert wall_group["quantities"]["volume_m3"] == pytest.approx(5.0)
    assert wall_group["quantities"]["area_m2"] == pytest.approx(18.0)
    assert wall_group["quantities"]["length_m"] == pytest.approx(9.0)


def test_qto_include_ids_in_json(house, capsys):
    assert main(["qto", str(house["a"]), "--json", "--include-ids"]) == 0
    data = json.loads(capsys.readouterr().out)
    ids = data["groups"][0]["element_ids"]
    assert len(ids) == 2
    assert all(isinstance(express_id, int) for express_id in ids)


def test_qto_csv_output(house, tmp_path, capsys):
    out_csv = tmp_path / "qto.csv"
    rc = main(
        ["qto", str(house["a"]), "--group-by", "ifc_class,storey", "--csv", str(out_csv)]
    )
    assert rc == 0
    rows = list(csv.reader(io.StringIO(out_csv.read_text(encoding="utf-8"))))
    assert rows[0] == ["ifc_class", "storey", "count", "volume_m3", "area_m2", "length_m"]
    assert rows[1][:3] == ["IfcWall", "Ground Floor", "2"]
    assert "Wrote CSV" in capsys.readouterr().out


def test_qto_invalid_group_by_exits_2(house, capsys):
    assert main(["qto", str(house["a"]), "--group-by", "bogus"]) == 2
    assert "group_by" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


def test_diff_detects_rename(house, capsys):
    assert main(["diff", str(house["a"]), str(house["b"])]) == 0
    out = capsys.readouterr().out
    assert "renamed 1" in out
    assert "'W1' -> 'W1-renamed'" in out
    assert f"#{house['wall1_id']}" in out


def test_diff_json_output(house, tmp_path):
    out_json = tmp_path / "diff.json"
    assert main(["diff", str(house["a"]), str(house["b"]), "--json", str(out_json)]) == 0
    changes = json.loads(out_json.read_text(encoding="utf-8"))
    assert len(changes) == 1
    change = changes[0]
    assert change["change"] == "renamed"
    assert change["express_id"] == house["wall1_id"]
    assert change["ifc_type"] == "IfcWall"
    assert change["name_before"] == "W1"
    assert change["name_after"] == "W1-renamed"


def test_diff_identical_files(house, capsys):
    assert main(["diff", str(house["a"]), str(house["a"])]) == 0
    assert "No differences detected." in capsys.readouterr().out


def test_diff_missing_file_exits_2(house, tmp_path, capsys):
    assert main(["diff", str(house["a"]), str(tmp_path / "nope.ifc")]) == 2
    assert "not found" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# viewer (monkeypatched HTTP client)
# ---------------------------------------------------------------------------


def test_viewer_select_posts_command(monkeypatch, capsys):
    fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 1}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "select", "--ids", "10, 11,12"]) == 0
    assert fake.requests == [
        ("POST", "/api/viewer/command", {"action": "select", "element_ids": [10, 11, 12]})
    ]
    assert "delivered to 1 viewer" in capsys.readouterr().out
    assert fake.closed


def test_viewer_isolate_and_highlight_actions(monkeypatch):
    for action in ("isolate", "highlight"):
        fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 1}))
        _patch_client(monkeypatch, fake)
        assert main(["viewer", action, "--ids", "7"]) == 0
        assert fake.requests[0][2] == {"action": action, "element_ids": [7]}


def test_viewer_show_all(monkeypatch, capsys):
    fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 2}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "show-all"]) == 0
    assert fake.requests[0][2] == {"action": "show_all"}
    assert "delivered to 2 viewers" in capsys.readouterr().out


def test_viewer_camera_preset(monkeypatch):
    fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 1}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "camera", "--preset", "iso"]) == 0
    assert fake.requests[0][2] == {"action": "camera_preset", "preset": "iso"}


def test_viewer_camera_invalid_preset_exits_2(capsys):
    assert main(["viewer", "camera", "--preset", "sideways"]) == 2


def test_viewer_zoom(monkeypatch):
    fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 1}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "zoom", "--id", "42"]) == 0
    assert fake.requests[0][2] == {"action": "zoom_to_element", "element_id": 42}


def test_viewer_state_pretty_print(monkeypatch, capsys):
    fake = _FakeClient(
        response=_FakeResponse(
            payload={"connected_clients": 2, "state": {"selected_id": 5}}
        )
    )
    captured = _patch_client(monkeypatch, fake)
    assert main(["viewer", "state", "--url", "http://localhost:9001/"]) == 0
    assert fake.requests == [("GET", "/api/viewer/state", None)]
    assert captured["base_url"] == "http://localhost:9001"
    out = capsys.readouterr().out
    assert "Connected viewers: 2" in out
    assert '"selected_id": 5' in out


def test_viewer_state_no_report_yet(monkeypatch, capsys):
    fake = _FakeClient(
        response=_FakeResponse(payload={"connected_clients": 0, "state": None})
    )
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "state"]) == 0
    assert "No viewer state reported yet." in capsys.readouterr().out


def test_viewer_snapshot_writes_file(monkeypatch, tmp_path, capsys):
    image = b"not-really-a-jpeg"
    fake = _FakeClient(
        response=_FakeResponse(
            payload={
                "image_base64": base64.b64encode(image).decode(),
                "mime": "image/jpeg",
            }
        )
    )
    captured = _patch_client(monkeypatch, fake)
    out_file = tmp_path / "snap.jpg"
    assert main(["viewer", "snapshot", "--out", str(out_file), "--timeout", "3"]) == 0
    method, path, _ = fake.requests[0]
    assert method == "GET"
    assert path.startswith("/api/viewer/snapshot?timeout_s=3")
    assert captured["timeout"] == pytest.approx(13.0)  # request timeout + 10s margin
    assert out_file.read_bytes() == image
    assert "snap.jpg" in capsys.readouterr().out


def test_viewer_snapshot_409_no_viewer(monkeypatch, tmp_path, capsys):
    fake = _FakeClient(response=_FakeResponse(status_code=409, payload={"detail": "x"}))
    _patch_client(monkeypatch, fake)
    rc = main(["viewer", "snapshot", "--out", str(tmp_path / "s.jpg")])
    assert rc == 1
    assert "No viewer connected" in capsys.readouterr().err


def test_viewer_snapshot_504_no_answer(monkeypatch, tmp_path, capsys):
    fake = _FakeClient(response=_FakeResponse(status_code=504, payload={"detail": "x"}))
    _patch_client(monkeypatch, fake)
    rc = main(["viewer", "snapshot", "--out", str(tmp_path / "s.jpg")])
    assert rc == 1
    assert "Viewer did not answer" in capsys.readouterr().err


def test_viewer_connection_refused_exits_2(monkeypatch, capsys):
    fake = _FakeClient(error=httpx.ConnectError("connection refused"))
    _patch_client(monkeypatch, fake)
    rc = main(["viewer", "show-all"])
    assert rc == 2
    err = capsys.readouterr().err
    assert "Backend not reachable at http://127.0.0.1:8000" in err
    assert "is IFC Atlas running?" in err


def test_viewer_unexpected_http_error_exits_2(monkeypatch, capsys):
    fake = _FakeClient(response=_FakeResponse(status_code=500, payload={"detail": "boom"}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "show-all"]) == 2
    assert "HTTP 500" in capsys.readouterr().err


def test_viewer_bad_ids_value_exits_2(monkeypatch, capsys):
    fake = _FakeClient(response=_FakeResponse(payload={"delivered_to": 1}))
    _patch_client(monkeypatch, fake)
    assert main(["viewer", "select", "--ids", "abc"]) == 2
    assert "Invalid element id" in capsys.readouterr().err
    assert fake.requests == []  # never reached the network


# ---------------------------------------------------------------------------
# serve / mcp - argument wiring only (never run a server in tests)
# ---------------------------------------------------------------------------


def test_serve_defaults_wiring():
    args = build_parser().parse_args(["serve"])
    assert args.host == "127.0.0.1"
    assert args.port == 8000
    assert args.log_level == "info"
    assert args.handler is cli._cmd_serve


def test_serve_custom_args_wiring():
    args = build_parser().parse_args(
        ["serve", "--host", "0.0.0.0", "--port", "9100", "--log-level", "debug"]
    )
    assert args.host == "0.0.0.0"
    assert args.port == 9100
    assert args.log_level == "debug"


def test_mcp_wiring():
    args = build_parser().parse_args(["mcp"])
    assert args.model is None
    assert args.allow_writes is False
    assert args.handler is cli._cmd_mcp

    args = build_parser().parse_args(["mcp", "--model", "x.ifc", "--allow-writes"])
    assert args.model == "x.ifc"
    assert args.allow_writes is True


def test_serve_help_exits_0(capsys):
    assert main(["serve", "--help"]) == 0
    out = capsys.readouterr().out
    assert "dynamic port" in out


def test_mcp_help_exits_0(capsys):
    assert main(["mcp", "--help"]) == 0
    out = capsys.readouterr().out
    assert "stdio" in out
    assert "--allow-writes" in out


# ---------------------------------------------------------------------------
# Top-level behaviour
# ---------------------------------------------------------------------------


def test_top_level_help_exits_0(capsys):
    assert main(["--help"]) == 0
    out = capsys.readouterr().out
    assert "ifc-atlas" in out
    for command in ("info", "validate", "qto", "diff", "viewer", "serve", "mcp"):
        assert command in out


def test_unknown_command_exits_2(capsys):
    assert main(["frobnicate"]) == 2
    assert "invalid choice" in capsys.readouterr().err


def test_no_command_exits_2(capsys):
    assert main([]) == 2
