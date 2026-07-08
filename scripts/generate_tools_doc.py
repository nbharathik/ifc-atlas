#!/usr/bin/env python3
"""
Auto-generate docs/agent/TOOLS_REFERENCE.md from backend TOOL_DEFINITIONS.

Run: python scripts/generate_tools_doc.py
Run before mkdocs build to keep the generated docs in sync.
"""

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

# Resolve repo root relative to this script.
REPO_ROOT = Path(__file__).parent.parent
BACKEND_PATH = REPO_ROOT / "backend"
OUTPUT_PATH = REPO_ROOT / "docs" / "agent" / "TOOLS_REFERENCE.md"

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


def _json_type(schema: dict) -> str:
    """Render a JSON schema node as a readable type string."""
    t = schema.get("type", "any")
    if t == "array":
        items = schema.get("items", {})
        inner = _json_type(items) if items else "any"
        return f"array[{inner}]"
    return t


def _params_table(parameters: dict) -> str:
    """Render a parameters object as a markdown table."""
    props = parameters.get("properties", {})
    required = set(parameters.get("required", []))
    if not props:
        return "_No parameters._\n"

    lines = [
        "| Name | Type | Required | Description |",
        "|---|---|---|---|",
    ]
    for name, schema in props.items():
        req = "✓" if name in required else ""
        typ = _json_type(schema)
        desc = schema.get("description", "")
        lines.append(f"| `{name}` | {typ} | {req} | {desc} |")
    return "\n".join(lines) + "\n"


def _tier_heading(tier_id: str, tier_label: str) -> str:
    tier_docs = {
        "read_model": (
            "Tools in this tier query the loaded IFC model. They are safe for read-only "
            "access and are always exposed via the MCP server."
        ),
        "read_viewer": (
            "Tools in this tier control what is visible in the 3D viewport. "
            "They execute client-side in the browser and are **not** exposed via the MCP server."
        ),
        "validate": (
            "Tools in this tier validate the model against external specifications such as IDS."
        ),
        "write_edit": (
            "Tools in this tier modify the IFC model. They require the **Edit** pill to be active "
            "in the chat panel. Write tools are off by default in the MCP server "
            "(enable with `MCP_ALLOW_WRITES=1`)."
        ),
    }
    desc = tier_docs.get(tier_id, "")
    return f"## {tier_label}\n\n{desc}\n"


def generate(output_path: Path) -> int:
    """Return number of tools written."""
    try:
        from app.services.tools import TOOL_DEFINITIONS, _TOOL_TIERS
    except ImportError as exc:
        print(f"ERROR: Could not import tools: {exc}", file=sys.stderr)
        print("  Run from repo root with PYTHONPATH=backend or via:", file=sys.stderr)
        print("  cd backend && python ../scripts/generate_tools_doc.py", file=sys.stderr)
        return 0

    # Group tools by tier, preserving order within tier.
    tier_order = ["read_model", "read_viewer", "validate", "write_edit"]
    tier_label_map: dict[str, str] = {}
    grouped: dict[str, list[dict]] = {t: [] for t in tier_order}

    for tool in TOOL_DEFINITIONS:
        name = tool["name"]
        tier_id, tier_label = _TOOL_TIERS.get(name, ("read_model", "Read - Model"))
        tier_label_map[tier_id] = tier_label
        if tier_id not in grouped:
            grouped[tier_id] = []
            tier_order.append(tier_id)
        grouped[tier_id].append(tool)

    lines: list[str] = [
        "# Tools Reference\n",
        '!!! info "Auto-generated"\n',
        "    This page is regenerated automatically by `scripts/generate_tools_doc.py`\n",
        "    Do not edit manually - changes will be overwritten.\n",
        "    To add a new tool, update `TOOL_DEFINITIONS` in `backend/app/services/tools.py`.\n",
        "\n---\n\n",
    ]

    count = 0
    for tier_id in tier_order:
        tools = grouped.get(tier_id, [])
        if not tools:
            continue
        tier_label = tier_label_map.get(tier_id, tier_id)
        lines.append(_tier_heading(tier_id, tier_label))
        lines.append("\n")

        for tool in tools:
            name = tool["name"]
            description = tool.get("description", "")
            parameters = tool.get("parameters", {})
            where = tool.get("where", "server")

            lines.append(f"### `{name}`\n\n")
            lines.append(f"{description}\n\n")

            if where == "client":
                lines.append('!!! note "Client-side"\n')
                lines.append(
                    "    This tool executes in the browser (metadata worker). "
                    "Results arrive via the tool_result WS event.\n\n"
                )

            lines.append("**Parameters:**\n\n")
            lines.append(_params_table(parameters))
            lines.append("\n---\n\n")
            count += 1

    from datetime import date
    today = date.today().isoformat()
    lines.append(
        f"_Last regenerated: {today}. "
        "Run `python scripts/generate_tools_doc.py` to refresh._\n"
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(lines), encoding="utf-8")
    return count


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate agent tools reference docs.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Generate docs into a temporary directory and fail if tracked docs differ.",
    )
    args = parser.parse_args()

    if args.check:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp) / "TOOLS_REFERENCE.md"
            n = generate(tmp_path)
            if not n:
                sys.exit(1)
            if not _matches_existing(tmp_path, OUTPUT_PATH):
                print(f"ERROR: {OUTPUT_PATH} is out of date. Run scripts/generate_tools_doc.py.")
                sys.exit(1)
            print("generate_tools_doc: check passed")
            sys.exit(0)

    n = generate(OUTPUT_PATH)
    if n:
        print(f"generate_tools_doc: wrote {n} tools -> {OUTPUT_PATH}")
    else:
        sys.exit(1)
