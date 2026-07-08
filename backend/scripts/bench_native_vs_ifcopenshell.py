"""Benchmark: native TS parser vs IfcOpenShell on BasicHouse.ifc.

Measures wall-clock time for:
  1. Native parser (subprocess `npx tsx src/smoke-parse.ts`).
     This is the fastest local way to invoke the parser without standing
     up the HTTP sidecar - same code path, no HTTP overhead.
  2. IfcOpenShell ``ifcopenshell.open(path)`` (Python binding).
  3. IfcOpenShell + populate basic queries (storeys, elements, etc.).

Run from the repo root:

    python backend/scripts/bench_native_vs_ifcopenshell.py

Output is markdown-formatted so it can be appended to the performance log.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"
SIDECAR_DIR = REPO_ROOT / "backend" / "sidecar"


def bench_native(rounds: int = 3) -> dict:
    """Invoke the smoke-parse script and capture its summary lines."""
    times: list[int] = []
    summary: dict[str, str] = {}
    for i in range(rounds):
        start = time.monotonic()
        proc = subprocess.run(  # noqa: S603 - controlled args
            ["npx", "tsx", "src/smoke-parse.ts"],
            cwd=str(SIDECAR_DIR),
            capture_output=True,
            text=True,
            shell=(sys.platform.startswith("win")),
        )
        elapsed = int((time.monotonic() - start) * 1000)
        times.append(elapsed)
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr)
            raise RuntimeError(f"smoke-parse exited {proc.returncode}")
        if i == rounds - 1:
            # Parse the structured "Done in X ms" line + key counts.
            for line in proc.stdout.splitlines():
                line = line.strip()
                if line.startswith("Done in "):
                    summary["done_line"] = line
                if line.startswith("schema:"):
                    summary["schema"] = line.split(":", 1)[1].strip()
                if line.startswith("total entities:"):
                    summary["entity_count"] = line.split(":", 1)[1].strip()
                if line.startswith("elements:"):
                    summary["element_count"] = line.split(":", 1)[1].strip()
                if line.startswith("storeys:"):
                    summary["storey_count"] = line.split(":", 1)[1].strip()
                if line.startswith("materials:"):
                    summary["material_count"] = line.split(":", 1)[1].strip()
    return {
        "wall_clock_ms": times,
        "wall_clock_median_ms": sorted(times)[len(times) // 2],
        "summary": summary,
    }


def bench_ifcopenshell(rounds: int = 3) -> dict:
    """Time `ifcopenshell.open(path)` + basic queries."""
    try:
        import ifcopenshell  # noqa: F401
    except ImportError:
        return {"skipped": True, "reason": "ifcopenshell not installed"}

    times_open: list[int] = []
    times_full: list[int] = []
    summary: dict[str, object] = {}

    for i in range(rounds):
        # Open phase: just parse the file.
        import ifcopenshell

        start = time.monotonic()
        model = ifcopenshell.open(str(FIXTURE))
        open_ms = int((time.monotonic() - start) * 1000)
        times_open.append(open_ms)

        # Query phase: walk storeys + count elements (mimics Ask-mode hot path).
        q_start = time.monotonic()
        storeys = model.by_type("IfcBuildingStorey")
        by_type: dict[str, int] = {}
        for product in model.by_type("IfcProduct"):
            if product.is_a("IfcOpeningElement"):
                continue
            t = product.is_a()
            by_type[t] = by_type.get(t, 0) + 1
        full_ms = open_ms + int((time.monotonic() - q_start) * 1000)
        times_full.append(full_ms)

        if i == rounds - 1:
            summary["schema"] = model.schema
            summary["storey_count"] = len(storeys)
            summary["element_count"] = sum(by_type.values())
            summary["by_type_top"] = dict(
                sorted(by_type.items(), key=lambda kv: -kv[1])[:5]
            )

    return {
        "open_ms": times_open,
        "open_median_ms": sorted(times_open)[len(times_open) // 2],
        "full_ms": times_full,
        "full_median_ms": sorted(times_full)[len(times_full) // 2],
        "summary": summary,
    }


def main() -> int:
    if not FIXTURE.exists():
        print(f"Missing fixture: {FIXTURE}", file=sys.stderr)
        return 2

    size_mb = FIXTURE.stat().st_size / 1024 / 1024
    print(f"# Native vs IfcOpenShell - {FIXTURE.name} ({size_mb:.1f} MB)\n")

    print("## Native parser (TS sidecar)\n")
    native = bench_native(rounds=3)
    print(f"- Wall clock (3 rounds, ms): {native['wall_clock_ms']}")
    print(f"- **Median: {native['wall_clock_median_ms']} ms**")
    if native["summary"]:
        for k, v in native["summary"].items():
            print(f"- {k}: {v}")
    print()

    print("## IfcOpenShell\n")
    ios = bench_ifcopenshell(rounds=3)
    if ios.get("skipped"):
        print(f"- skipped: {ios['reason']}")
    else:
        print(f"- Open-only ms (3 rounds): {ios['open_ms']}")
        print(f"- **Open-only median: {ios['open_median_ms']} ms**")
        print(f"- Open + by_type walk (3 rounds): {ios['full_ms']}")
        print(f"- **Open + walk median: {ios['full_median_ms']} ms**")
        for k, v in ios["summary"].items():
            print(f"- {k}: {v}")

    print()
    print("## Verdict\n")
    if not ios.get("skipped"):
        native_med = native["wall_clock_median_ms"]
        ios_med = ios["full_median_ms"]
        ratio = ios_med / native_med if native_med > 0 else 0
        print(f"Native parser is **{ratio:.2f}×** faster than IfcOpenShell open + walk on this fixture.")
        print()
        print("Caveats: native wall-clock includes `npx tsx` cold-start (~250 ms). The HTTP-served path (sidecar already running) drops that overhead - see V1 smoke logs.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
