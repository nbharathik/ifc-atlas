#!/usr/bin/env python3
"""
Auto-generate docs/api/REST.md from the FastAPI OpenAPI spec and
docs/api/WEBSOCKET.md from WS event docstrings in chat_routes.py.

Run: python scripts/generate_api_doc.py
Run before mkdocs build to keep the generated docs in sync.

Note: The script imports the FastAPI app to extract the OpenAPI spec.
It requires all backend dependencies to be installed.
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
BACKEND_PATH = REPO_ROOT / "backend"
REST_OUTPUT = REPO_ROOT / "docs" / "api" / "REST.md"
WS_OUTPUT = REPO_ROOT / "docs" / "api" / "WEBSOCKET.md"
CHAT_ROUTES_PATH = BACKEND_PATH / "app" / "api" / "chat_routes.py"

sys.path.insert(0, str(BACKEND_PATH))


def _normalise_generated_text(text: str) -> str:
    """Normalise volatile generated-doc fields for --check comparisons."""
    normalised = text.replace("\r\n", "\n")
    return re.sub(
        r"_Last regenerated: \d{4}-\d{2}-\d{2}\.",
        "_Last regenerated: <date>.",
        normalised,
    )


def _matches_existing(generated_path: Path, existing_path: Path) -> bool:
    if not generated_path.exists() or not existing_path.exists():
        return False
    generated = _normalise_generated_text(generated_path.read_text(encoding="utf-8"))
    existing = _normalise_generated_text(existing_path.read_text(encoding="utf-8"))
    return generated == existing


# ---------------------------------------------------------------------------
# REST doc generation from OpenAPI spec
# ---------------------------------------------------------------------------

def _method_badge(method: str) -> str:
    return f"`{method.upper()}`"


def _params_section(params: list[dict]) -> str:
    if not params:
        return ""
    path_params = [p for p in params if p.get("in") == "path"]
    query_params = [p for p in params if p.get("in") == "query"]
    lines = []
    if path_params:
        lines.append("**Path parameters:**\n")
        lines.append("| Name | Type | Required | Description |")
        lines.append("|---|---|---|---|")
        for p in path_params:
            schema = p.get("schema", {})
            typ = schema.get("type", "string")
            req = "✓" if p.get("required") else ""
            desc = p.get("description", "")
            lines.append(f"| `{p['name']}` | {typ} | {req} | {desc} |")
        lines.append("")
    if query_params:
        lines.append("**Query parameters:**\n")
        lines.append("| Name | Type | Required | Description |")
        lines.append("|---|---|---|---|")
        for p in query_params:
            schema = p.get("schema", {})
            typ = schema.get("type", "string")
            req = "✓" if p.get("required") else ""
            desc = p.get("description", "")
            lines.append(f"| `{p['name']}` | {typ} | {req} | {desc} |")
        lines.append("")
    return "\n".join(lines)


def generate_rest_doc(output_path: Path) -> int:
    """Return number of endpoints written."""
    try:
        from app.main import app
    except Exception as exc:
        print(f"WARN: Could not import FastAPI app: {exc}", file=sys.stderr)
        print("  REST doc will not be regenerated.", file=sys.stderr)
        return 0

    spec = app.openapi()
    paths = spec.get("paths", {})
    components = spec.get("components", {})

    # Group by tag (first tag on each operation).
    from collections import defaultdict
    by_tag: dict[str, list[tuple[str, str, dict]]] = defaultdict(list)

    for path, methods in sorted(paths.items()):
        for method, op in methods.items():
            if method in ("head", "options"):
                continue
            tags = op.get("tags", ["Other"])
            tag = tags[0]
            by_tag[tag].append((path, method, op))

    lines: list[str] = [
        "# REST API\n",
        '!!! info "Auto-generated"\n',
        "    This page is regenerated automatically by `scripts/generate_api_doc.py`\n",
        "    from the FastAPI OpenAPI spec. Do not edit manually.\n",
        "    To add a new endpoint, add a route in `backend/app/api/`.\n",
        "\n---\n\n",
    ]

    count = 0
    for tag, ops in sorted(by_tag.items()):
        lines.append(f"## {tag}\n\n")
        for path, method, op in ops:
            summary = op.get("summary", path)
            description = op.get("description", "")
            params = op.get("parameters", [])

            lines.append(f"### {_method_badge(method)} `{path}`\n\n")
            lines.append(f"{summary}\n\n")
            if description and description != summary:
                lines.append(f"{description}\n\n")

            params_text = _params_section(params)
            if params_text:
                lines.append(params_text)

            # Request body
            req_body = op.get("requestBody", {})
            if req_body:
                content = req_body.get("content", {})
                if "application/json" in content:
                    schema_ref = content["application/json"].get("schema", {})
                    if "$ref" in schema_ref:
                        ref_name = schema_ref["$ref"].split("/")[-1]
                        lines.append(
                            f"**Request body:** `{ref_name}` (JSON)\n\n"
                        )
                    else:
                        lines.append("**Request body:** JSON\n\n")
                elif "multipart/form-data" in content:
                    lines.append("**Request body:** `multipart/form-data`\n\n")

            # Responses
            responses = op.get("responses", {})
            if "200" in responses:
                desc = responses["200"].get("description", "")
                if desc:
                    lines.append(f"**Response:** {desc}\n\n")

            lines.append("---\n\n")
            count += 1

    from datetime import date
    today = date.today().isoformat()
    lines.append(
        f"_Last regenerated: {today}. "
        "Run `python scripts/generate_api_doc.py` to refresh._\n"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(lines), encoding="utf-8")
    return count


# ---------------------------------------------------------------------------
# WS event doc extraction from chat_routes.py
# ---------------------------------------------------------------------------

_EVENT_PATTERN = re.compile(
    r'#\s*WS_EVENT:\s*(?P<name>\w+)\s*\n'
    r'(?P<body>(?:#[^\n]*\n)+)',
    re.MULTILINE,
)


def generate_ws_doc(output_path: Path) -> int:
    """
    Extract WS event documentation from structured comments in chat_routes.py.

    Comments must follow this pattern (immediately preceding the emit code):

        # WS_EVENT: chunk
        # Streamed text fragment from the LLM.
        # Schema: {"type": "chunk", "content": "<text>"}

    Returns number of events documented.
    """
    if not CHAT_ROUTES_PATH.exists():
        print(f"WARN: {CHAT_ROUTES_PATH} not found - WS doc not regenerated", file=sys.stderr)
        return 0

    source = CHAT_ROUTES_PATH.read_text(encoding="utf-8", errors="replace")
    events = []
    for m in _EVENT_PATTERN.finditer(source):
        name = m.group("name")
        body_lines = [
            line.lstrip("#").strip()
            for line in m.group("body").strip().splitlines()
        ]
        events.append((name, body_lines))

    if not events:
        # No structured comments found - keep existing file unchanged.
        print("WARN: No WS_EVENT comments found in chat_routes.py.", file=sys.stderr)
        print("  Add '# WS_EVENT: <name>' comments above each emit to auto-generate.", file=sys.stderr)
        return 0

    lines: list[str] = [
        "# WebSocket Protocol\n\n",
        "The main chat streaming interface uses a WebSocket connection at `/api/chat/ws`.\n\n",
        '!!! info "Auto-generated"\n',
        "    This page is regenerated automatically by `scripts/generate_api_doc.py`\n",
        "    from structured comments in `chat_routes.py`.\n\n",
        "---\n\n",
        "## Events\n\n",
    ]

    for name, body in events:
        lines.append(f"### `{name}`\n\n")
        for line in body:
            if line.lower().startswith("schema:"):
                schema_str = line[len("schema:"):].strip()
                lines.append(f"```json\n{schema_str}\n```\n\n")
            else:
                lines.append(f"{line}\n\n")
        lines.append("---\n\n")

    from datetime import date
    today = date.today().isoformat()
    lines.append(
        f"_Last regenerated: {today}. "
        "Run `python scripts/generate_api_doc.py` to refresh._\n"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(lines), encoding="utf-8")
    return len(events)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate API reference docs.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Generate docs into a temporary directory and fail if tracked docs differ.",
    )
    args = parser.parse_args()

    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            rest_tmp = tmp_dir / "REST.md"
            ws_tmp = tmp_dir / "WEBSOCKET.md"
            rest_count = generate_rest_doc(rest_tmp)
            ws_count = generate_ws_doc(ws_tmp)

            ok = True
            if rest_count and not _matches_existing(rest_tmp, REST_OUTPUT):
                print(f"ERROR: {REST_OUTPUT} is out of date. Run scripts/generate_api_doc.py.")
                ok = False
            if ws_count and not _matches_existing(ws_tmp, WS_OUTPUT):
                print(f"ERROR: {WS_OUTPUT} is out of date. Run scripts/generate_api_doc.py.")
                ok = False
            if ok:
                print("generate_api_doc: check passed")
            sys.exit(0 if ok else 1)

    rest_count = generate_rest_doc(REST_OUTPUT)
    if rest_count:
        print(f"generate_api_doc: wrote {rest_count} REST endpoints -> {REST_OUTPUT}")
    else:
        print("generate_api_doc: REST doc skipped (see warnings above)")

    ws_count = generate_ws_doc(WS_OUTPUT)
    if ws_count:
        print(f"generate_api_doc: wrote {ws_count} WS events -> {WS_OUTPUT}")
    else:
        print("generate_api_doc: WS doc skipped (no WS_EVENT comments found)")
