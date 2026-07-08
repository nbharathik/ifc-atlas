"""ifc-atlas - headless command line interface for IFC Atlas.

Subcommands:
    info      Summarise an IFC file (schema, project, element counts, storeys).
    validate  Validate an IFC file against an IDS specification.
    qto       Quantity takeoff aggregation (counts, volume, area, length).
    diff      Structural diff between two IFC files.
    viewer    Drive a connected browser viewer through a running backend.
    serve     Run the backend API server on a fixed host/port.
    mcp       Run the stdio MCP server for external LLM clients.

Run ``ifc-atlas <command> --help`` for per-command options. The module is
also runnable directly: ``python -m app.cli <command> ...``.

Design notes:
    - ``info``, ``validate``, ``qto``, and ``diff`` open models with
      ``ifcopenshell.open`` directly so one-shot reads stay side-effect free
      (no working-copy mirroring, no global service state).
    - ``viewer`` talks to a running backend over HTTP (httpx) and never
      imports the application stack.
    - Exit codes: 0 success, 1 domain failure (failed IDS specs, no viewer
      connected / no answer), 2 usage or environment errors.
"""

from __future__ import annotations

import argparse
import base64
import json
import logging
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Optional

DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"

# Human-mode cap for the "info" element-type table; JSON output is never capped.
_INFO_MAX_TYPE_ROWS = 12

# Canonical display order for diff change kinds.
_CHANGE_ORDER: tuple[str, ...] = (
    "created",
    "deleted",
    "renamed",
    "retyped",
    "property_changed",
)


class CliError(Exception):
    """A user-facing CLI failure. ``exit_code`` becomes the process exit code."""

    def __init__(self, message: str, exit_code: int = 2) -> None:
        super().__init__(message)
        self.exit_code = exit_code


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _open_model(path_str: str):
    """Open an IFC file with ifcopenshell, raising CliError on any problem."""
    import ifcopenshell

    path = Path(path_str)
    if not path.is_file():
        raise CliError(f"IFC file not found: {path}")
    try:
        model = ifcopenshell.open(str(path))
    except Exception as exc:
        raise CliError(f"Could not open IFC file {path}: {exc}") from exc
    if model is None:
        raise CliError(f"Could not open IFC file {path}")
    return model


def _read_text_file(path_str: str, what: str) -> str:
    path = Path(path_str)
    if not path.is_file():
        raise CliError(f"{what} not found: {path}")
    try:
        return path.read_text(encoding="utf-8-sig")
    except Exception as exc:
        raise CliError(f"Could not read {what} {path}: {exc}") from exc


def _write_text_file(path_str: str, content: str, what: str) -> Path:
    path = Path(path_str)
    try:
        if path.parent and not path.parent.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
        # newline="" keeps CSV writers' explicit \r\n intact on Windows.
        path.write_text(content, encoding="utf-8", newline="")
    except OSError as exc:
        raise CliError(f"Could not write {what} {path}: {exc}") from exc
    return path


def _fmt_quantity(value: float) -> str:
    """Format a quantity with up to 3 decimals, trimming trailing zeros."""
    text = f"{value:.3f}".rstrip("0").rstrip(".")
    return text or "0"


def _quote_name(name: Optional[str]) -> str:
    return f"'{name}'" if name else "(unnamed)"


def _render_table(headers: list[str], rows: list[list[str]], text_columns: int) -> str:
    """Render an aligned plain-text table.

    The first ``text_columns`` columns are left-aligned, the rest right-aligned.
    """
    widths = [len(header) for header in headers]
    for row in rows:
        for index, cell in enumerate(row):
            widths[index] = max(widths[index], len(cell))

    def fmt(row: list[str]) -> str:
        cells = []
        for index, cell in enumerate(row):
            if index < text_columns:
                cells.append(cell.ljust(widths[index]))
            else:
                cells.append(cell.rjust(widths[index]))
        return "  ".join(cells).rstrip()

    lines = [fmt(headers), fmt(["-" * width for width in widths])]
    lines.extend(fmt(row) for row in rows)
    return "\n".join(lines)


def _parse_id_list(raw: str) -> list[int]:
    ids: list[int] = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            ids.append(int(token))
        except ValueError as exc:
            raise CliError(
                f"Invalid element id {token!r} - expected a comma-separated "
                "list of integers, e.g. --ids \"12,45,103\""
            ) from exc
    if not ids:
        raise CliError("No element ids given - expected e.g. --ids \"12,45,103\"")
    return ids


# ---------------------------------------------------------------------------
# info
# ---------------------------------------------------------------------------


def _collect_info(path_str: str) -> dict[str, Any]:
    model = _open_model(path_str)

    schema = str(getattr(model, "schema_identifier", None) or model.schema)
    projects = model.by_type("IfcProject")
    project_name = None
    if projects:
        raw_name = getattr(projects[0], "Name", None)
        project_name = raw_name if isinstance(raw_name, str) and raw_name.strip() else None

    counts: Counter[str] = Counter()
    total = 0
    for entity in model.by_type("IfcProduct"):
        # Spatial structure containers are not takeoff-style elements; keep
        # IfcSpace because rooms are useful in a model overview.
        if entity.is_a("IfcSpatialStructureElement") and not entity.is_a("IfcSpace"):
            continue
        counts[entity.is_a()] += 1
        total += 1

    storeys: list[dict[str, Any]] = []
    for storey in model.by_type("IfcBuildingStorey"):
        name = getattr(storey, "Name", None)
        elevation = getattr(storey, "Elevation", None)
        storeys.append(
            {
                "name": name if isinstance(name, str) and name.strip() else "Unnamed storey",
                "elevation": float(elevation) if isinstance(elevation, (int, float)) else None,
            }
        )
    storeys.sort(key=lambda s: (s["elevation"] is None, s["elevation"] or 0.0, s["name"]))

    ordered_counts = dict(
        sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    )
    return {
        "file": str(Path(path_str)),
        "schema": schema,
        "project_name": project_name,
        "total_elements": total,
        "element_counts": ordered_counts,
        "storeys": storeys,
    }


def _cmd_info(args: argparse.Namespace) -> int:
    info = _collect_info(args.model)
    if args.json:
        print(json.dumps(info, indent=2))
        return 0

    print(f"File:     {info['file']}")
    print(f"Schema:   {info['schema']}")
    print(f"Project:  {info['project_name'] or '(unnamed)'}")
    print(f"Elements: {info['total_elements']}")

    storeys = info["storeys"]
    print(f"\nStoreys ({len(storeys)}):")
    if storeys:
        for storey in storeys:
            if storey["elevation"] is not None:
                print(f"  {storey['name']} (elevation {_fmt_quantity(storey['elevation'])})")
            else:
                print(f"  {storey['name']}")
    else:
        print("  (none)")

    counts = info["element_counts"]
    print("\nElement types:")
    if counts:
        shown = list(counts.items())[:_INFO_MAX_TYPE_ROWS]
        width = max(len(name) for name, _ in shown)
        for name, count in shown:
            print(f"  {name.ljust(width)}  {count}")
        remaining = len(counts) - len(shown)
        if remaining > 0:
            print(f"  ... and {remaining} more type{'s' if remaining != 1 else ''}")
    else:
        print("  (none)")
    return 0


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------

_STATUS_MARKERS = {"passed": "[PASS]", "failed": "[FAIL]", "no_applicable": "[N/A ]"}


def _cmd_validate(args: argparse.Namespace) -> int:
    from app.services.ids_service import validate_ids, validate_ids_to_csv

    model = _open_model(args.model)
    ids_xml = _read_text_file(args.ids_path, "IDS file")

    try:
        report = validate_ids(model, ids_xml, limit_per_spec=args.limit_per_spec)
    except ValueError as exc:
        raise CliError(f"IDS validation failed: {exc}") from exc

    title = report.get("ids_title") or Path(args.ids_path).name
    print(f"IDS:    {title}")
    print(f"Model:  {args.model}")
    print(
        f"Specifications: {report.get('total_specifications', 0)} "
        f"(passed {report.get('passed', 0)}, failed {report.get('failed', 0)}, "
        f"no applicable {report.get('no_applicable', 0)})"
    )
    print()
    for spec in report.get("specifications", []):
        marker = _STATUS_MARKERS.get(spec.get("status", ""), "[????]")
        print(
            f"{marker} {spec.get('name', '(unnamed spec)')}: "
            f"applied {spec.get('applied_to', 0)}, "
            f"passed {spec.get('passed', 0)}, failed {spec.get('failed', 0)}"
        )
        for failing in spec.get("failing_elements", []):
            express_id = failing.get("id")
            print(
                f"    #{express_id} {failing.get('ifc_type', '?')} "
                f"{_quote_name(failing.get('name'))} "
                f"[{failing.get('facet_type', '?')}] {failing.get('reason', '')}"
            )
        if spec.get("failing_truncated"):
            print(f"    ... more failures truncated at {args.limit_per_spec} per spec")

    if args.csv:
        csv_text = validate_ids_to_csv(model, ids_xml)
        written = _write_text_file(args.csv, csv_text, "CSV report")
        print(f"\nWrote failure CSV: {written}")
    if args.json_out:
        written = _write_text_file(
            args.json_out, json.dumps(report, indent=2), "JSON report"
        )
        print(f"\nWrote JSON report: {written}")

    failed = int(report.get("failed", 0))
    if failed > 0:
        total = int(report.get("total_specifications", 0))
        print(f"\nResult: FAILED ({failed} of {total} specifications failed)")
        return 1
    print("\nResult: PASSED (no specification failed)")
    return 0


# ---------------------------------------------------------------------------
# qto
# ---------------------------------------------------------------------------


def _cmd_qto(args: argparse.Namespace) -> int:
    from app.services.qto_service import compute_qto, qto_to_csv

    model = _open_model(args.model)
    fields = [field.strip() for field in args.group_by.split(",") if field.strip()]
    try:
        result = compute_qto(model, fields, include_ids=args.include_ids)
    except ValueError as exc:
        raise CliError(str(exc)) from exc

    if args.csv:
        written = _write_text_file(args.csv, qto_to_csv(result), "CSV report")
        if not args.json:
            print(f"Wrote CSV: {written}")

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    group_fields: list[str] = result["group_by"]
    headers = [*group_fields, "count", "volume_m3", "area_m2", "length_m"]
    rows: list[list[str]] = []
    for group in result["groups"]:
        row = [str(group["key"][field]) for field in group_fields]
        row.append(str(group["count"]))
        quantities = group["quantities"]
        coverage = group["coverage"]
        for quantity_key, coverage_key in (
            ("volume_m3", "volume"),
            ("area_m2", "area"),
            ("length_m", "length"),
        ):
            if coverage[coverage_key] > 0:
                row.append(_fmt_quantity(quantities[quantity_key]))
            else:
                row.append("-")
        rows.append(row)

    overall = result["overall"]
    total_row = ["TOTAL"] + [""] * (len(group_fields) - 1)
    total_row.append(str(overall["count"]))
    for key in ("volume_m3", "area_m2", "length_m"):
        total_row.append(_fmt_quantity(overall["quantities"][key]))
    rows.append(total_row)

    print(_render_table(headers, rows, text_columns=len(group_fields)))
    if result.get("truncated"):
        print("\nNote: group list truncated - narrow the grouping to see everything.")
    return 0


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


def _describe_change(change) -> str:
    prefix = f"#{change.express_id} {change.ifc_type}"
    if change.change == "created":
        return f"{prefix} created: {_quote_name(change.name_after)}"
    if change.change == "deleted":
        return f"{prefix} deleted: {_quote_name(change.name_before)}"
    if change.change == "renamed":
        return (
            f"{prefix} renamed: {_quote_name(change.name_before)} -> "
            f"{_quote_name(change.name_after)}"
        )
    if change.change == "retyped":
        before = change.ifc_type_before or "?"
        after = change.ifc_type_after or change.ifc_type
        return (
            f"#{change.express_id} retyped: {before} -> {after} "
            f"(name {_quote_name(change.name_before)} -> {_quote_name(change.name_after)})"
        )
    count = len(change.property_changes)
    return (
        f"{prefix} property_changed: {_quote_name(change.name_before)} "
        f"({count} propert{'y' if count == 1 else 'ies'})"
    )


def _cmd_diff(args: argparse.Namespace) -> int:
    from app.services.sandbox_service import _compute_diff

    base = _open_model(args.model_a)
    other = _open_model(args.model_b)
    changes = _compute_diff(base, other)

    if args.json_out:
        payload = json.dumps([change.model_dump() for change in changes], indent=2)
        written = _write_text_file(args.json_out, payload, "JSON diff")
        print(f"Wrote JSON diff: {written}")

    if not changes:
        print("No differences detected.")
        return 0

    counts = Counter(change.change for change in changes)
    summary = ", ".join(
        f"{kind} {counts[kind]}" for kind in _CHANGE_ORDER if counts.get(kind)
    )
    total = len(changes)
    print(f"{total} change{'s' if total != 1 else ''}: {summary}")
    for change in changes:
        print(f"  {_describe_change(change)}")
    return 0


# ---------------------------------------------------------------------------
# viewer
# ---------------------------------------------------------------------------


def _make_client(base_url: str, timeout: float):
    """Build the HTTP client for viewer commands. Tests monkeypatch this."""
    import httpx

    return httpx.Client(base_url=base_url, timeout=timeout)


def _viewer_call(
    url: str,
    method: str,
    path: str,
    json_body: Optional[dict[str, Any]] = None,
    timeout: float = 10.0,
) -> dict[str, Any]:
    import httpx

    base = url.rstrip("/")
    client = _make_client(base, timeout)
    try:
        try:
            if method == "GET":
                response = client.get(path)
            else:
                response = client.post(path, json=json_body)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise CliError(
                f"Backend not reachable at {base} - is IFC Atlas running?",
                exit_code=2,
            ) from exc
        except httpx.TimeoutException as exc:
            raise CliError(
                f"Backend at {base} did not respond within {timeout:g}s.",
                exit_code=2,
            ) from exc
        except httpx.HTTPError as exc:
            raise CliError(f"Request to {base}{path} failed: {exc}", exit_code=2) from exc

        if response.status_code == 409:
            raise CliError("No viewer connected", exit_code=1)
        if response.status_code == 504:
            raise CliError("Viewer did not answer", exit_code=1)
        if response.status_code >= 400:
            detail = ""
            try:
                detail = str(response.json().get("detail", ""))
            except Exception:
                pass
            message = f"Backend returned HTTP {response.status_code}"
            if detail:
                message += f": {detail}"
            raise CliError(message, exit_code=2)
        try:
            return response.json()
        except ValueError as exc:
            raise CliError(
                f"Backend returned a non-JSON response from {path}", exit_code=2
            ) from exc
    finally:
        client.close()


def _print_delivery(data: dict[str, Any]) -> None:
    delivered = int(data.get("delivered_to", 0))
    line = f"Command delivered to {delivered} viewer{'s' if delivered != 1 else ''}"
    if delivered == 0:
        line += " - no viewer appears to be connected"
    print(line)


def _cmd_viewer_state(args: argparse.Namespace) -> int:
    data = _viewer_call(args.url, "GET", "/api/viewer/state")
    print(f"Connected viewers: {data.get('connected_clients', 0)}")
    state = data.get("state")
    if state is None:
        print("No viewer state reported yet.")
    else:
        print(json.dumps(state, indent=2))
    return 0


def _cmd_viewer_elements(args: argparse.Namespace) -> int:
    """select / isolate / highlight - all take an element id list."""
    element_ids = _parse_id_list(args.ids)
    data = _viewer_call(
        args.url,
        "POST",
        "/api/viewer/command",
        json_body={"action": args.viewer_action, "element_ids": element_ids},
    )
    _print_delivery(data)
    return 0


def _cmd_viewer_show_all(args: argparse.Namespace) -> int:
    data = _viewer_call(
        args.url, "POST", "/api/viewer/command", json_body={"action": "show_all"}
    )
    _print_delivery(data)
    return 0


def _cmd_viewer_camera(args: argparse.Namespace) -> int:
    data = _viewer_call(
        args.url,
        "POST",
        "/api/viewer/command",
        json_body={"action": "camera_preset", "preset": args.preset},
    )
    _print_delivery(data)
    return 0


def _cmd_viewer_zoom(args: argparse.Namespace) -> int:
    data = _viewer_call(
        args.url,
        "POST",
        "/api/viewer/command",
        json_body={"action": "zoom_to_element", "element_id": args.id},
    )
    _print_delivery(data)
    return 0


def _cmd_viewer_snapshot(args: argparse.Namespace) -> int:
    timeout_s = max(args.timeout, 1.0)
    data = _viewer_call(
        args.url,
        "GET",
        f"/api/viewer/snapshot?timeout_s={timeout_s:g}",
        timeout=timeout_s + 10.0,
    )
    image_b64 = data.get("image_base64")
    if not image_b64:
        raise CliError("Backend returned no snapshot image", exit_code=2)
    try:
        raw = base64.b64decode(image_b64)
    except Exception as exc:
        raise CliError(f"Snapshot image could not be decoded: {exc}", exit_code=2) from exc

    out_path = Path(args.out)
    try:
        if out_path.parent and not out_path.parent.exists():
            out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(raw)
    except OSError as exc:
        raise CliError(f"Could not write snapshot {out_path}: {exc}") from exc
    print(str(out_path.resolve()))
    return 0


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )
    return 0


# ---------------------------------------------------------------------------
# mcp
# ---------------------------------------------------------------------------


def _cmd_mcp(args: argparse.Namespace) -> int:
    # stdout belongs to the MCP wire protocol in this subcommand: every
    # human-facing message below goes to stderr.
    import asyncio
    import os

    if args.allow_writes:
        # Must happen before the server module import so any import-time
        # configuration observes the flag.
        os.environ["MCP_ALLOW_WRITES"] = "1"
        print("MCP write tools enabled (MCP_ALLOW_WRITES=1).", file=sys.stderr)

    if args.model:
        model_path = Path(args.model)
        if not model_path.is_file():
            raise CliError(f"IFC file not found: {model_path}")
        from app.services.ifc_service import ifc_service

        try:
            project = ifc_service.load(model_path)
        except Exception as exc:
            raise CliError(f"Could not load IFC file {model_path}: {exc}") from exc
        print(
            f"Loaded model: {model_path.name} "
            f"(project {project.name!r}, schema {project.schema_version})",
            file=sys.stderr,
        )

    from mcp import stdio_server

    from app.mcp_server.server import server

    print(
        "ifc-atlas MCP server running on stdio. Connect an MCP client "
        "(e.g. Claude Desktop); press Ctrl+C to stop.",
        file=sys.stderr,
    )

    async def _run() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(
                read_stream,
                write_stream,
                server.create_initialization_options(),
            )

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        print("MCP server stopped.", file=sys.stderr)
    return 0


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ifc-atlas",
        description="Headless command line interface for IFC Atlas.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable INFO-level logging on stderr.",
    )
    sub = parser.add_subparsers(dest="command", metavar="<command>", required=True)

    # info -------------------------------------------------------------
    info_parser = sub.add_parser(
        "info",
        help="Summarise an IFC file: schema, project, element counts, storeys.",
        description="Summarise an IFC file: schema, project, element counts, storeys.",
    )
    info_parser.add_argument("model", help="Path to the IFC file.")
    info_parser.add_argument(
        "--json", action="store_true", help="Print a JSON object instead of text."
    )
    info_parser.set_defaults(handler=_cmd_info)

    # validate ----------------------------------------------------------
    validate_parser = sub.add_parser(
        "validate",
        help="Validate an IFC file against an IDS specification.",
        description=(
            "Validate an IFC file against an IDS specification. Exit code 1 "
            "when any specification failed, 0 when everything passed or had "
            "no applicable elements."
        ),
    )
    validate_parser.add_argument("model", help="Path to the IFC file.")
    validate_parser.add_argument(
        "--ids", dest="ids_path", required=True, help="Path to the IDS XML file."
    )
    validate_parser.add_argument(
        "--csv", metavar="OUT", help="Write a CSV of all failing elements to OUT."
    )
    validate_parser.add_argument(
        "--json",
        dest="json_out",
        metavar="OUT",
        help="Write the full validation report as JSON to OUT.",
    )
    validate_parser.add_argument(
        "--limit-per-spec",
        type=int,
        default=25,
        metavar="N",
        help="Cap on listed failing elements per specification (default 25).",
    )
    validate_parser.set_defaults(handler=_cmd_validate)

    # qto ----------------------------------------------------------------
    qto_parser = sub.add_parser(
        "qto",
        help="Quantity takeoff: counts, volume, area, length per group.",
        description=(
            "Aggregate element counts and base quantities. Group fields: "
            "ifc_class, storey, material, type_object, classification."
        ),
    )
    qto_parser.add_argument("model", help="Path to the IFC file.")
    qto_parser.add_argument(
        "--group-by",
        default="ifc_class",
        metavar="FIELDS",
        help="Comma-separated group fields (default: ifc_class).",
    )
    qto_parser.add_argument(
        "--include-ids",
        action="store_true",
        help="Include element ids per group (visible in --json output).",
    )
    qto_parser.add_argument(
        "--csv", metavar="OUT", help="Write the takeoff table as CSV to OUT."
    )
    qto_parser.add_argument(
        "--json", action="store_true", help="Print the full result as JSON."
    )
    qto_parser.set_defaults(handler=_cmd_qto)

    # diff ----------------------------------------------------------------
    diff_parser = sub.add_parser(
        "diff",
        help="Structural diff between two IFC files.",
        description=(
            "Compare two IFC files element by element (matched on express id) "
            "and report created / deleted / renamed / retyped / "
            "property-changed elements. Differences are reported, not treated "
            "as a failure: the exit code is 0 either way."
        ),
    )
    diff_parser.add_argument("model_a", help="Path to the base IFC file.")
    diff_parser.add_argument("model_b", help="Path to the changed IFC file.")
    diff_parser.add_argument(
        "--json",
        dest="json_out",
        metavar="OUT",
        help="Write the change list as JSON to OUT.",
    )
    diff_parser.set_defaults(handler=_cmd_diff)

    # viewer --------------------------------------------------------------
    viewer_parser = sub.add_parser(
        "viewer",
        help="Drive a connected browser viewer through a running backend.",
        description=(
            "Send commands to the viewer connected to a running IFC Atlas "
            "backend, or read the state it last reported."
        ),
    )
    viewer_sub = viewer_parser.add_subparsers(
        dest="viewer_action", metavar="<action>", required=True
    )

    url_parent = argparse.ArgumentParser(add_help=False)
    url_parent.add_argument(
        "--url",
        default=DEFAULT_BACKEND_URL,
        help=f"Backend base URL (default: {DEFAULT_BACKEND_URL}).",
    )

    state_parser = viewer_sub.add_parser(
        "state", parents=[url_parent], help="Show the last reported viewer state."
    )
    state_parser.set_defaults(handler=_cmd_viewer_state)

    for action, verb in (
        ("select", "Select"),
        ("isolate", "Isolate"),
        ("highlight", "Highlight"),
    ):
        action_parser = viewer_sub.add_parser(
            action, parents=[url_parent], help=f"{verb} elements by express id."
        )
        action_parser.add_argument(
            "--ids",
            required=True,
            help='Comma-separated express ids, e.g. --ids "12,45,103".',
        )
        action_parser.set_defaults(handler=_cmd_viewer_elements, viewer_action=action)

    show_all_parser = viewer_sub.add_parser(
        "show-all", parents=[url_parent], help="Clear isolation and show everything."
    )
    show_all_parser.set_defaults(handler=_cmd_viewer_show_all)

    camera_parser = viewer_sub.add_parser(
        "camera", parents=[url_parent], help="Move the camera to a preset view."
    )
    camera_parser.add_argument(
        "--preset",
        required=True,
        choices=["front", "back", "left", "right", "top", "iso", "fit"],
        help="Camera preset to apply.",
    )
    camera_parser.set_defaults(handler=_cmd_viewer_camera)

    zoom_parser = viewer_sub.add_parser(
        "zoom", parents=[url_parent], help="Zoom the camera to one element."
    )
    zoom_parser.add_argument(
        "--id", type=int, required=True, help="Express id of the element."
    )
    zoom_parser.set_defaults(handler=_cmd_viewer_zoom)

    snapshot_parser = viewer_sub.add_parser(
        "snapshot", parents=[url_parent], help="Capture a viewport screenshot."
    )
    snapshot_parser.add_argument(
        "--out", default="viewer.jpg", help="Output image path (default: viewer.jpg)."
    )
    snapshot_parser.add_argument(
        "--timeout",
        type=float,
        default=6.0,
        metavar="N",
        help="Seconds to wait for the viewer to answer (default: 6).",
    )
    snapshot_parser.set_defaults(handler=_cmd_viewer_snapshot)

    # serve -----------------------------------------------------------------
    serve_parser = sub.add_parser(
        "serve",
        help="Run the IFC Atlas backend API server on a fixed host/port.",
        description=(
            "Run the IFC Atlas backend with uvicorn on a fixed host and port. "
            "The desktop launcher manages its own dynamic port selection; this "
            "command is the simple fixed-port path for development and "
            "self-hosting."
        ),
    )
    serve_parser.add_argument(
        "--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)."
    )
    serve_parser.add_argument(
        "--port", type=int, default=8000, help="Bind port (default: 8000)."
    )
    serve_parser.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        help="Uvicorn log level (default: info).",
    )
    serve_parser.set_defaults(handler=_cmd_serve)

    # mcp ---------------------------------------------------------------------
    mcp_parser = sub.add_parser(
        "mcp",
        help="Run the stdio MCP server for external LLM clients.",
        description=(
            "Run the Model Context Protocol server over stdio so external LLM "
            "clients (e.g. Claude Desktop) can use IFC Atlas tools. stdout "
            "carries the MCP protocol; all status messages go to stderr."
        ),
    )
    mcp_parser.add_argument(
        "--model",
        metavar="PATH",
        help="IFC file to load before starting, so clients see a loaded model.",
    )
    mcp_parser.add_argument(
        "--allow-writes",
        action="store_true",
        help="Expose write and management tools (sets MCP_ALLOW_WRITES=1).",
    )
    mcp_parser.set_defaults(handler=_cmd_mcp)

    return parser


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse exits 0 for --help and 2 for usage errors; surface that as
        # a return value so in-process callers (tests, [project.scripts]
        # wrappers) get an int instead of an exception.
        code = exc.code
        if isinstance(code, int):
            return code
        return 0 if code is None else 2

    if args.verbose:
        logging.basicConfig(
            level=logging.INFO,
            stream=sys.stderr,
            format="%(levelname)s %(name)s: %(message)s",
        )

    try:
        return args.handler(args)
    except CliError as exc:
        print(str(exc), file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
