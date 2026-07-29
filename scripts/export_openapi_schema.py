#!/usr/bin/env python3
"""Export the canonical FastAPI schema consumed by frontend type generation.

Run:
    python scripts/export_openapi_schema.py
    python scripts/export_openapi_schema.py --check

The generated JSON is committed so frontend-only environments can regenerate
TypeScript without installing the Python/IfcOpenShell dependency graph.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_PATH = REPO_ROOT / "backend"
DEFAULT_OUTPUT = REPO_ROOT / "frontend" / "src" / "generated" / "openapi.json"

sys.path.insert(0, str(BACKEND_PATH))


def render_schema() -> str:
    from app.main import app

    return json.dumps(
        app.openapi(),
        indent=2,
        sort_keys=True,
        ensure_ascii=False,
        allow_nan=False,
    ) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    generated = render_schema()

    if args.check:
        existing = output.read_text(encoding="utf-8") if output.exists() else ""
        if existing != generated:
            print(
                f"OpenAPI schema is stale: {output.relative_to(REPO_ROOT)}",
                file=sys.stderr,
            )
            print("Run: python scripts/export_openapi_schema.py", file=sys.stderr)
            return 1
        print(f"OpenAPI schema is current: {output.relative_to(REPO_ROOT)}")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    # Write through a sibling temporary file so readers never observe a
    # partially-written schema if generation is interrupted.
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(generated)
        temp_path = Path(handle.name)
    temp_path.replace(output)
    print(f"Wrote {output.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
