#!/usr/bin/env python3
"""
Build the reference-documentation index the AI consults via the `get_docs` tool.

Currently indexes the installed IfcOpenShell Python API docstrings (grouped one
document per API domain). Version-matched by construction - it reads the
installed package, so no network or git clone is needed. Future sources (IFC4x3
schema HTML, etc.) plug in as extra `--source` handlers.

Run:
    python scripts/fetch_reference_docs.py                 # index everything
    python scripts/fetch_reference_docs.py --source ifcopenshell
    python scripts/fetch_reference_docs.py --status        # show current index
    python scripts/fetch_reference_docs.py --clear         # wipe the index

Wired into the Chat Manager "Knowledge" tab (plan E4) as a one-click action.
See dev/docs/AI_BIM_EDITOR_MASTER_PLAN.md Workstream E.
"""

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
BACKEND_PATH = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_PATH))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the AI reference-docs index.")
    parser.add_argument(
        "--source",
        choices=["ifcopenshell", "all"],
        default="all",
        help="Which reference source to (re)index. Default: all.",
    )
    parser.add_argument("--status", action="store_true", help="Print index status and exit.")
    parser.add_argument("--clear", action="store_true", help="Remove all reference docs and exit.")
    args = parser.parse_args(argv)

    from app.services.reference_docs_service import reference_docs_service

    if args.status:
        status = reference_docs_service.status()
        print(f"Reference index: {status['doc_count']} document(s) indexed.")
        for name in status.get("documents", []):
            print(f"  - {name}")
        sem = status.get("semantic", {})
        print(f"Semantic search: {'built' if sem.get('built') else 'BM25-only'} "
              f"(fastembed available: {sem.get('available')}).")
        return 0

    if args.clear:
        removed = reference_docs_service.clear()
        print(f"Cleared {removed} reference document(s).")
        return 0

    if args.source in ("ifcopenshell", "all"):
        print("Indexing IfcOpenShell API docstrings ...")
        result = reference_docs_service.index_ifcopenshell_api()
        if not result.get("ok"):
            print(f"  FAILED: {result.get('error')}", file=sys.stderr)
            return 1
        print(f"  Indexed {result['indexed']} API domain(s) "
              f"(ifcopenshell {result.get('ifcopenshell_version')}), "
              f"{result.get('errors', 0)} error(s).")
        print(f"  Domains: {', '.join(result.get('domains', []))}")

    print("Done. The `get_docs` tool (source='ifcopenshell') can now answer.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
