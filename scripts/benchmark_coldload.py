#!/usr/bin/env python3
"""Server-side cold-load benchmark for the IFC convert pipeline.

Hits ``POST /api/ifc/convert`` with raw IFC bytes for one or more
fixtures, runs each ``--runs`` times, and prints a result row per
fixture. When a ``PERFORMANCE_LOG.md`` with benchmark markers exists
(or ``--log-path`` points at one), the rows are also appended to its
"Benchmark runs (automated)" section.

Start the backend, then::

    python scripts/benchmark_coldload.py --label "baseline"
    python scripts/benchmark_coldload.py --scope medium --label "baseline"    # +1 medium IFC
    python scripts/benchmark_coldload.py --scope full --label "baseline"      # +medium +largest IFC
    python scripts/benchmark_coldload.py --fixtures data/fixtures/BasicHouse.ifc --runs 3
    python scripts/benchmark_coldload.py --dry-run    # discover only, no HTTP

Stdlib only (``urllib.request`` for HTTP) so the script runs from a bare
repo checkout without backend venv activation.

The script splits into pure helpers (unit-tested in
``backend/tests/test_benchmark_coldload.py``) and one IO function
(``measure_convert``) that is only exercised against a live backend.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_LOG = REPO_ROOT / "PERFORMANCE_LOG.md"
DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_PROFILE = "balanced"
DEFAULT_RUNS = 3
DEFAULT_TIMEOUT_S = 120.0
DEFAULT_SCOPE = "quick"
SCOPE_CHOICES = ("quick", "medium", "full")
DEFAULT_BASIC_HOUSE = Path("data") / "fixtures" / "BasicHouse.ifc"

BENCHMARK_START_MARKER = "<!-- benchmark-rows:start -->"
BENCHMARK_END_MARKER = "<!-- benchmark-rows:end -->"


# ---------------------------------------------------------------------------
# Pure helpers (no IO; unit-tested)
# ---------------------------------------------------------------------------


def human_size(n_bytes: int) -> str:
    """Render a byte count as a short human string (e.g. 52428800 -> "50.0 MB")."""
    if n_bytes < 0:
        raise ValueError("size must be non-negative")
    units = ("B", "KB", "MB", "GB", "TB")
    size = float(n_bytes)
    idx = 0
    while size >= 1024.0 and idx < len(units) - 1:
        size /= 1024.0
        idx += 1
    if idx == 0:
        return f"{int(size)} {units[idx]}"
    return f"{size:.1f} {units[idx]}"


def summarize_durations(durations_ms: list[float]) -> dict[str, float | int]:
    """Reduce a list of millisecond samples to min/median/p95/max/n.

    ``p95`` is computed via ``statistics.quantiles(n=20)[-1]`` for n>=2;
    for n==1, p95 == the single sample.
    """
    if not durations_ms:
        raise ValueError("durations_ms must not be empty")
    n = len(durations_ms)
    sorted_d = sorted(durations_ms)
    if n == 1:
        p95 = sorted_d[0]
    else:
        # statistics.quantiles(n=20) -> 19 cut points at 5 %, 10 %, … 95 %.
        # The last cut is p95.
        p95 = statistics.quantiles(sorted_d, n=20, method="inclusive")[-1]
    return {
        "n": n,
        "min_ms": sorted_d[0],
        "median_ms": statistics.median(sorted_d),
        "p95_ms": p95,
        "max_ms": sorted_d[-1],
    }


def format_benchmark_row(
    timestamp_iso: str,
    label: str,
    fixture_name: str,
    size_bytes: int,
    summary: dict[str, float | int],
    source_breakdown: dict[str, int],
) -> str:
    """Render one markdown table row for the benchmark log section.

    ``source_breakdown`` counts ``X-Fragment-Source`` header values across
    the runs (e.g. ``{"cache": 2, "sidecar": 1}``). Rendered as ``cache:2
    / sidecar:1`` so a reader can tell warm vs cold at a glance.
    """
    if "n" not in summary:
        raise ValueError("summary missing 'n'")
    breakdown = (
        " / ".join(f"{k}:{v}" for k, v in sorted(source_breakdown.items()))
        if source_breakdown
        else "-"
    )
    return (
        f"| {timestamp_iso} | {label} | {fixture_name} | {human_size(size_bytes)} "
        f"| {summary['n']} | {summary['min_ms']:.1f} | {summary['median_ms']:.1f} "
        f"| {summary['p95_ms']:.1f} | {summary['max_ms']:.1f} | {breakdown} |"
    )


def insert_benchmark_row(
    content: str,
    row: str,
    start_marker: str = BENCHMARK_START_MARKER,
    end_marker: str = BENCHMARK_END_MARKER,
) -> str:
    """Insert ``row`` immediately before ``end_marker`` in ``content``.

    Validates that both markers exist and that start precedes end. Returns
    the new content. Raises ``ValueError`` if either marker is missing or
    the order is wrong.
    """
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)
    if start_idx == -1:
        raise ValueError(f"start marker {start_marker!r} not found in log file")
    if end_idx == -1:
        raise ValueError(f"end marker {end_marker!r} not found in log file")
    if end_idx < start_idx:
        raise ValueError("end marker precedes start marker")
    return content[:end_idx] + row + "\n" + content[end_idx:]


def basic_house_fixture(repo_root: Path) -> Path:
    """Return the canonical BasicHouse fixture path."""
    return repo_root / DEFAULT_BASIC_HOUSE


def discover_default_fixtures(repo_root: Path) -> list[Path]:
    """Return the default fixture list (BasicHouse only).

    ``data/`` models are 20-70 MB each, too slow for an unattended default.
    Pass them explicitly via ``--fixtures`` or use
    ``--scope=medium``/``--scope=full``.
    """
    return pick_scope_fixtures(DEFAULT_SCOPE, repo_root)


def discover_data_models(repo_root: Path) -> list[Path]:
    """Return every ``data/model_*.ifc`` fixture sorted by file size (asc).

    Used by ``pick_scope_fixtures`` to select a medium + large fixture for
    the ``medium``/``full`` scopes. Returns ``[]`` if ``data/`` is missing
    or contains no matching files - callers must tolerate an empty list.
    """
    data_dir = repo_root / "data"
    if not data_dir.is_dir():
        return []
    return sorted(data_dir.glob("model_*.ifc"), key=lambda p: p.stat().st_size)


def pick_scope_fixtures(scope: str, repo_root: Path) -> list[Path]:
    """Return the fixture set for a named scope.

    Scopes ("BasicHouse + medium + large"):

    - ``quick``  → ``[data/fixtures/BasicHouse.ifc]`` (fast smoke; safe as an unattended default)
    - ``medium`` → ``[data/fixtures/BasicHouse.ifc, smallest data/model_*.ifc]``
    - ``full``   → ``[data/fixtures/BasicHouse.ifc, smallest data/model_*.ifc, largest data/model_*.ifc]``

    Missing fixtures are dropped silently - a fresh checkout without
    ``data/`` still produces a usable ``quick`` run. ``full`` collapses to
    the ``medium`` set if only one ``data/model_*.ifc`` exists.
    """
    if scope not in SCOPE_CHOICES:
        raise ValueError(f"unknown scope: {scope!r} (expected one of {SCOPE_CHOICES})")
    out: list[Path] = []
    basic_house = basic_house_fixture(repo_root)
    if basic_house.exists():
        out.append(basic_house)
    if scope in ("medium", "full"):
        models = discover_data_models(repo_root)
        if models:
            out.append(models[0])
            if scope == "full" and len(models) > 1:
                out.append(models[-1])
    return out


def parse_fixtures_arg(values: Iterable[str], repo_root: Path) -> list[Path]:
    """Resolve user-supplied fixture paths against the repo root."""
    out: list[Path] = []
    for raw in values:
        p = Path(raw)
        if not p.is_absolute():
            p = (repo_root / p).resolve()
        if not p.exists():
            raise FileNotFoundError(f"fixture not found: {p}")
        out.append(p)
    return out


# ---------------------------------------------------------------------------
# IO (live backend; not unit-tested)
# ---------------------------------------------------------------------------


def measure_convert(
    base_url: str,
    fixture: Path,
    profile: str = DEFAULT_PROFILE,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> dict[str, float | str | int]:
    """POST ``fixture`` bytes to ``/api/ifc/convert`` and time the request.

    Returns ``{duration_ms, status, source, sidecar_elapsed_ms, bytes_in,
    bytes_out}``. ``source`` is the backend's ``X-Fragment-Source`` header
    ("cache" or "sidecar"). ``sidecar_elapsed_ms`` is the backend's
    self-reported sidecar wall-clock (only present on a cold convert).
    """
    body = fixture.read_bytes()
    url = f"{base_url.rstrip('/')}/api/ifc/convert?profile={profile}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/octet-stream"},
    )
    started = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        status = resp.status
        out_bytes = resp.read()
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        source = resp.headers.get("X-Fragment-Source", "?")
        sidecar_ms_raw = resp.headers.get("X-Fragment-Elapsed-Ms")
    try:
        sidecar_ms = float(sidecar_ms_raw) if sidecar_ms_raw else 0.0
    except ValueError:
        sidecar_ms = 0.0
    return {
        "duration_ms": elapsed_ms,
        "status": status,
        "source": source,
        "sidecar_elapsed_ms": sidecar_ms,
        "bytes_in": len(body),
        "bytes_out": len(out_bytes),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="benchmark_coldload",
        description="Server-side cold-load benchmark for the IFC convert pipeline.",
    )
    p.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"backend base URL (default: {DEFAULT_BASE_URL})",
    )
    p.add_argument(
        "--fixtures",
        nargs="+",
        default=None,
        help="explicit IFC fixture paths (overrides --scope)",
    )
    p.add_argument(
        "--scope",
        default=DEFAULT_SCOPE,
        choices=SCOPE_CHOICES,
        help=(
            f"fixture preset when --fixtures is omitted: "
            f"quick=BasicHouse only, medium=+smallest data/model_*.ifc, "
            f"full=+largest data/model_*.ifc (default: {DEFAULT_SCOPE})"
        ),
    )
    p.add_argument(
        "--runs",
        type=int,
        default=DEFAULT_RUNS,
        help=f"runs per fixture (default: {DEFAULT_RUNS})",
    )
    p.add_argument(
        "--profile",
        default=DEFAULT_PROFILE,
        choices=("quality", "balanced", "performance", "ultra_fast"),
        help=f"sidecar profile (default: {DEFAULT_PROFILE})",
    )
    p.add_argument(
        "--label",
        default="ad-hoc",
        help='context label written into the log row (default: "ad-hoc")',
    )
    p.add_argument(
        "--log-path",
        type=Path,
        default=None,
        help=f"PERFORMANCE_LOG.md path (default: {DEFAULT_LOG} when it exists)",
    )
    p.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help=f"per-request timeout in seconds (default: {DEFAULT_TIMEOUT_S})",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="discover + summarize fixtures only; do not call the backend or write the log",
    )
    p.add_argument(
        "--no-log",
        action="store_true",
        help="run the benchmark but do not append to the log file",
    )
    return p


def run(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    if args.fixtures:
        fixtures = parse_fixtures_arg(args.fixtures, REPO_ROOT)
    else:
        fixtures = pick_scope_fixtures(args.scope, REPO_ROOT)
    if not fixtures:
        print(
            f"no fixtures found for scope={args.scope!r} "
            f"(data/fixtures/BasicHouse.ifc missing?)",
            file=sys.stderr,
        )
        return 2

    scope_label = "explicit" if args.fixtures else args.scope
    print(
        f"benchmark_coldload: base={args.base_url} profile={args.profile} "
        f"runs={args.runs} scope={scope_label}"
    )
    for f in fixtures:
        print(f"  fixture: {f.name}  ({human_size(f.stat().st_size)})")

    if args.dry_run:
        print("dry-run: no HTTP calls made")
        return 0

    rows: list[str] = []
    for fixture in fixtures:
        size_bytes = fixture.stat().st_size
        durations: list[float] = []
        source_breakdown: dict[str, int] = {}
        for i in range(args.runs):
            try:
                result = measure_convert(
                    args.base_url, fixture, args.profile, args.timeout
                )
            except (urllib.error.URLError, TimeoutError) as exc:
                print(f"  run {i + 1}/{args.runs} FAILED: {exc}", file=sys.stderr)
                continue
            durations.append(float(result["duration_ms"]))
            src = str(result["source"])
            source_breakdown[src] = source_breakdown.get(src, 0) + 1
            print(
                f"  run {i + 1}/{args.runs}: {result['duration_ms']:.1f} ms "
                f"(source={src} sidecar_ms={result['sidecar_elapsed_ms']:.1f})"
            )
        if not durations:
            print(f"  {fixture.name}: ALL RUNS FAILED - skipping log row", file=sys.stderr)
            continue
        summary = summarize_durations(durations)
        timestamp_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        row = format_benchmark_row(
            timestamp_iso,
            args.label,
            fixture.name,
            size_bytes,
            summary,
            source_breakdown,
        )
        rows.append(row)
        print(f"  -> {row}")

    if not rows:
        print("no successful runs; nothing to log", file=sys.stderr)
        return 1

    if args.no_log:
        print("--no-log set; skipping PERFORMANCE_LOG.md append")
        return 0

    # Without an explicit --log-path, append to the default log only when it
    # exists; a checkout without one still gets the rows on stdout above.
    if args.log_path is None:
        if not DEFAULT_LOG.exists():
            print(f"no {DEFAULT_LOG.name} found; rows were printed above but not persisted")
            return 0
        log_path: Path = DEFAULT_LOG
    else:
        log_path = args.log_path
    if not log_path.exists():
        print(f"log file not found: {log_path}", file=sys.stderr)
        return 3
    content = log_path.read_text(encoding="utf-8")
    try:
        for row in rows:
            content = insert_benchmark_row(content, row)
    except ValueError as exc:
        print(f"could not append to log: {exc}", file=sys.stderr)
        return 4
    log_path.write_text(content, encoding="utf-8")
    print(f"appended {len(rows)} row(s) to {log_path}")
    return 0


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()
