"""Tests for ``scripts/benchmark_coldload.py`` pure helpers.

The HTTP function (``measure_convert``) is not covered here - it
requires a live backend and is exercised by invoking the
CLI directly. Everything else (size formatting, distribution summary,
row formatting, marker-based log insertion, fixture discovery / parse)
is pure-Python and tested in isolation.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import benchmark_coldload as bench  # noqa: E402


# ---------------------------------------------------------------------------
# human_size
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "n,expected",
    [
        (0, "0 B"),
        (512, "512 B"),
        (1024, "1.0 KB"),
        (1536, "1.5 KB"),
        (1_048_576, "1.0 MB"),
        (52_702_577, "50.3 MB"),  # BasicHouse.ifc, real fixture size
        (1_073_741_824, "1.0 GB"),
    ],
)
def test_human_size_renders_expected_units(n: int, expected: str) -> None:
    assert bench.human_size(n) == expected


def test_human_size_rejects_negative() -> None:
    with pytest.raises(ValueError):
        bench.human_size(-1)


# ---------------------------------------------------------------------------
# summarize_durations
# ---------------------------------------------------------------------------


def test_summarize_durations_single_sample_collapses_to_one_value() -> None:
    out = bench.summarize_durations([123.4])
    assert out["n"] == 1
    assert out["min_ms"] == 123.4
    assert out["max_ms"] == 123.4
    assert out["median_ms"] == 123.4
    assert out["p95_ms"] == 123.4


def test_summarize_durations_multiple_samples_returns_distribution() -> None:
    samples = [100.0, 200.0, 150.0, 175.0, 125.0]
    out = bench.summarize_durations(samples)
    assert out["n"] == 5
    assert out["min_ms"] == 100.0
    assert out["max_ms"] == 200.0
    assert out["median_ms"] == 150.0
    # p95 on this 5-sample distribution should sit above the median and
    # at-or-below the max.
    assert out["median_ms"] <= out["p95_ms"] <= out["max_ms"]


def test_summarize_durations_p95_at_or_below_max_for_uniform_distribution() -> None:
    samples = [float(x) for x in range(1, 21)]  # 1..20
    out = bench.summarize_durations(samples)
    assert out["min_ms"] == 1.0
    assert out["max_ms"] == 20.0
    assert out["p95_ms"] >= out["median_ms"]
    assert out["p95_ms"] <= out["max_ms"]


def test_summarize_durations_empty_raises() -> None:
    with pytest.raises(ValueError):
        bench.summarize_durations([])


# ---------------------------------------------------------------------------
# format_benchmark_row
# ---------------------------------------------------------------------------


def test_format_benchmark_row_has_expected_column_count() -> None:
    summary = bench.summarize_durations([1234.5, 1500.0, 1100.0])
    row = bench.format_benchmark_row(
        timestamp_iso="2026-05-17T23:07Z",
        label="nightly",
        fixture_name="BasicHouse.ifc",
        size_bytes=52_702_577,
        summary=summary,
        source_breakdown={"sidecar": 1, "cache": 2},
    )
    # Markdown table row: opening | + 10 columns + closing | -> 11 pipes.
    assert row.count("|") == 11
    assert row.startswith("| 2026-05-17T23:07Z |")
    assert " nightly " in row
    assert " BasicHouse.ifc " in row
    assert " 50.3 MB " in row
    assert " 3 " in row  # n=3
    assert "cache:2 / sidecar:1" in row


def test_format_benchmark_row_empty_source_breakdown_renders_dash() -> None:
    summary = bench.summarize_durations([100.0])
    row = bench.format_benchmark_row(
        timestamp_iso="2026-05-17T00:00Z",
        label="ad-hoc",
        fixture_name="x.ifc",
        size_bytes=0,
        summary=summary,
        source_breakdown={},
    )
    assert row.endswith("| - |")


def test_format_benchmark_row_rejects_summary_missing_n() -> None:
    with pytest.raises(ValueError):
        bench.format_benchmark_row(
            timestamp_iso="t",
            label="l",
            fixture_name="f.ifc",
            size_bytes=1,
            summary={"min_ms": 1.0, "max_ms": 1.0, "median_ms": 1.0, "p95_ms": 1.0},
            source_breakdown={},
        )


# ---------------------------------------------------------------------------
# insert_benchmark_row
# ---------------------------------------------------------------------------


_BASE_LOG = (
    "header text\n"
    "<!-- benchmark-rows:start -->\n"
    "<!-- benchmark-rows:end -->\n"
    "trailing text\n"
)


def test_insert_benchmark_row_inserts_just_before_end_marker() -> None:
    row = "| a | b | c |"
    out = bench.insert_benchmark_row(_BASE_LOG, row)
    assert "| a | b | c |\n<!-- benchmark-rows:end -->" in out
    # Trailing text preserved.
    assert out.endswith("trailing text\n")
    # Start marker untouched.
    assert "<!-- benchmark-rows:start -->\n<!-- benchmark-rows:end -->" not in out


def test_insert_benchmark_row_appends_in_order_across_calls() -> None:
    out = bench.insert_benchmark_row(_BASE_LOG, "| row1 |")
    out = bench.insert_benchmark_row(out, "| row2 |")
    # Newer row appears just before the end marker; older row precedes it.
    row1_idx = out.find("| row1 |")
    row2_idx = out.find("| row2 |")
    end_idx = out.find("<!-- benchmark-rows:end -->")
    assert row1_idx < row2_idx < end_idx


def test_insert_benchmark_row_missing_start_marker_raises() -> None:
    with pytest.raises(ValueError, match="start marker"):
        bench.insert_benchmark_row(
            "no markers here\n<!-- benchmark-rows:end -->\n",
            "| row |",
        )


def test_insert_benchmark_row_missing_end_marker_raises() -> None:
    with pytest.raises(ValueError, match="end marker"):
        bench.insert_benchmark_row(
            "<!-- benchmark-rows:start -->\n",
            "| row |",
        )


def test_insert_benchmark_row_inverted_markers_raises() -> None:
    bad = "<!-- benchmark-rows:end -->\n<!-- benchmark-rows:start -->\n"
    with pytest.raises(ValueError, match="end marker precedes"):
        bench.insert_benchmark_row(bad, "| row |")


# ---------------------------------------------------------------------------
# discover_default_fixtures / parse_fixtures_arg
# ---------------------------------------------------------------------------


def test_discover_default_fixtures_returns_basichouse_when_present(tmp_path: Path) -> None:
    fixture = tmp_path / "data" / "fixtures" / "BasicHouse.ifc"
    fixture.parent.mkdir(parents=True)
    fixture.write_bytes(b"ISO-10303-21;\n")
    out = bench.discover_default_fixtures(tmp_path)
    assert out == [fixture]


def test_discover_default_fixtures_returns_empty_when_missing(tmp_path: Path) -> None:
    out = bench.discover_default_fixtures(tmp_path)
    assert out == []


def test_parse_fixtures_arg_resolves_relative_paths_against_repo_root(
    tmp_path: Path,
) -> None:
    (tmp_path / "sub").mkdir()
    fixture = tmp_path / "sub" / "model.ifc"
    fixture.write_bytes(b"x")
    out = bench.parse_fixtures_arg(["sub/model.ifc"], tmp_path)
    assert out == [fixture.resolve()]


def test_parse_fixtures_arg_accepts_absolute_paths(tmp_path: Path) -> None:
    fixture = tmp_path / "model.ifc"
    fixture.write_bytes(b"x")
    out = bench.parse_fixtures_arg([str(fixture)], tmp_path)
    assert out == [fixture]


def test_parse_fixtures_arg_raises_for_missing_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        bench.parse_fixtures_arg(["does-not-exist.ifc"], tmp_path)


# ---------------------------------------------------------------------------
# discover_data_models / pick_scope_fixtures
# ---------------------------------------------------------------------------


def _write_sized(path: Path, n_bytes: int) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * n_bytes)
    return path


def _write_basic_house(repo_root: Path, n_bytes: int = 100) -> Path:
    return _write_sized(
        repo_root / "data" / "fixtures" / "BasicHouse.ifc",
        n_bytes,
    )


def test_discover_data_models_returns_empty_when_no_data_dir(tmp_path: Path) -> None:
    assert bench.discover_data_models(tmp_path) == []


def test_discover_data_models_returns_empty_when_data_dir_has_no_matches(
    tmp_path: Path,
) -> None:
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "not_a_model.txt").write_bytes(b"x")
    assert bench.discover_data_models(tmp_path) == []


def test_discover_data_models_sorts_ascending_by_file_size(tmp_path: Path) -> None:
    big = _write_sized(tmp_path / "data" / "model_big.ifc", 3_000)
    small = _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    mid = _write_sized(tmp_path / "data" / "model_mid.ifc", 2_000)
    out = bench.discover_data_models(tmp_path)
    assert out == [small, mid, big]


def test_pick_scope_fixtures_quick_returns_basichouse_only(tmp_path: Path) -> None:
    basic_house = _write_basic_house(tmp_path)
    _write_sized(tmp_path / "data" / "model_1.ifc", 200)
    out = bench.pick_scope_fixtures("quick", tmp_path)
    assert out == [basic_house]


def test_pick_scope_fixtures_medium_adds_smallest_data_model(tmp_path: Path) -> None:
    basic_house = _write_basic_house(tmp_path)
    small = _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    _write_sized(tmp_path / "data" / "model_big.ifc", 3_000)
    out = bench.pick_scope_fixtures("medium", tmp_path)
    assert out == [basic_house, small]


def test_pick_scope_fixtures_full_adds_smallest_and_largest(tmp_path: Path) -> None:
    basic_house = _write_basic_house(tmp_path)
    small = _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    _write_sized(tmp_path / "data" / "model_mid.ifc", 2_000)
    big = _write_sized(tmp_path / "data" / "model_big.ifc", 3_000)
    out = bench.pick_scope_fixtures("full", tmp_path)
    assert out == [basic_house, small, big]


def test_pick_scope_fixtures_full_with_single_model_collapses_to_medium_shape(
    tmp_path: Path,
) -> None:
    basic_house = _write_basic_house(tmp_path)
    only = _write_sized(tmp_path / "data" / "model_only.ifc", 1_000)
    out = bench.pick_scope_fixtures("full", tmp_path)
    assert out == [basic_house, only]


def test_pick_scope_fixtures_skips_missing_basichouse(tmp_path: Path) -> None:
    small = _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    out = bench.pick_scope_fixtures("medium", tmp_path)
    assert out == [small]


def test_pick_scope_fixtures_quick_returns_empty_when_basichouse_missing(
    tmp_path: Path,
) -> None:
    _write_sized(tmp_path / "data" / "model_x.ifc", 1_000)
    out = bench.pick_scope_fixtures("quick", tmp_path)
    assert out == []


def test_pick_scope_fixtures_rejects_unknown_scope(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown scope"):
        bench.pick_scope_fixtures("turbo", tmp_path)


def test_discover_default_fixtures_delegates_to_quick_scope(tmp_path: Path) -> None:
    _write_basic_house(tmp_path)
    _write_sized(tmp_path / "data" / "model_1.ifc", 200)
    assert bench.discover_default_fixtures(tmp_path) == bench.pick_scope_fixtures(
        "quick", tmp_path
    )


# ---------------------------------------------------------------------------
# CLI parser shape
# ---------------------------------------------------------------------------


def test_build_arg_parser_defaults() -> None:
    parser = bench.build_arg_parser()
    args = parser.parse_args([])
    assert args.base_url == bench.DEFAULT_BASE_URL
    assert args.profile == bench.DEFAULT_PROFILE
    assert args.runs == bench.DEFAULT_RUNS
    assert args.label == "ad-hoc"
    assert args.dry_run is False
    assert args.no_log is False
    assert args.scope == bench.DEFAULT_SCOPE


def test_build_arg_parser_rejects_unknown_profile() -> None:
    parser = bench.build_arg_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--profile", "not-a-real-profile"])


def test_build_arg_parser_rejects_unknown_scope() -> None:
    parser = bench.build_arg_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--scope", "turbo"])


def test_build_arg_parser_accepts_each_scope_choice() -> None:
    parser = bench.build_arg_parser()
    for choice in bench.SCOPE_CHOICES:
        assert parser.parse_args(["--scope", choice]).scope == choice


# ---------------------------------------------------------------------------
# run() - end-to-end with mocked HTTP
# ---------------------------------------------------------------------------


def test_run_dry_run_skips_http_and_log(tmp_path: Path, capsys, monkeypatch) -> None:
    _write_basic_house(tmp_path, 1024)
    # Force discover_default_fixtures to point at tmp_path.
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run(["--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "dry-run: no HTTP calls made" in out


def test_run_writes_row_to_log_with_mocked_measure(
    tmp_path: Path, monkeypatch
) -> None:
    _write_basic_house(tmp_path, 1024)
    log_path = tmp_path / "PERFORMANCE_LOG.md"
    log_path.write_text(
        "head\n"
        + bench.BENCHMARK_START_MARKER
        + "\n"
        + bench.BENCHMARK_END_MARKER
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)

    call_count = {"n": 0}

    def fake_measure(base_url, fixture_path, profile, timeout_s):
        call_count["n"] += 1
        return {
            "duration_ms": 100.0 + call_count["n"] * 10.0,
            "status": 200,
            "source": "cache",
            "sidecar_elapsed_ms": 0.0,
            "bytes_in": 1024,
            "bytes_out": 2048,
        }

    monkeypatch.setattr(bench, "measure_convert", fake_measure)

    rc = bench.run(
        [
            "--runs",
            "2",
            "--label",
            "test-label",
            "--log-path",
            str(log_path),
        ]
    )
    assert rc == 0
    assert call_count["n"] == 2
    contents = log_path.read_text(encoding="utf-8")
    assert " test-label " in contents
    assert " BasicHouse.ifc " in contents
    assert "cache:2" in contents


def test_run_no_log_flag_does_not_touch_log(tmp_path: Path, monkeypatch) -> None:
    _write_basic_house(tmp_path, 1)
    log_path = tmp_path / "PERFORMANCE_LOG.md"
    original = "DO NOT MODIFY"
    log_path.write_text(original, encoding="utf-8")

    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(
        bench,
        "measure_convert",
        lambda base_url, fp, profile, t: {
            "duration_ms": 1.0,
            "status": 200,
            "source": "cache",
            "sidecar_elapsed_ms": 0.0,
            "bytes_in": 1,
            "bytes_out": 1,
        },
    )

    rc = bench.run(["--runs", "1", "--no-log", "--log-path", str(log_path)])
    assert rc == 0
    assert log_path.read_text(encoding="utf-8") == original


def test_run_returns_nonzero_when_no_fixtures_found(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run([])
    err = capsys.readouterr().err
    assert rc == 2
    assert "no fixtures found" in err


def test_run_scope_medium_dry_run_lists_basichouse_plus_one_data_model(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    _write_basic_house(tmp_path)
    _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    _write_sized(tmp_path / "data" / "model_big.ifc", 5_000)
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run(["--scope", "medium", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "scope=medium" in out
    assert "BasicHouse.ifc" in out
    assert "model_small.ifc" in out
    assert "model_big.ifc" not in out  # medium excludes the largest


def test_run_scope_full_dry_run_lists_basichouse_plus_smallest_plus_largest(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    _write_basic_house(tmp_path)
    _write_sized(tmp_path / "data" / "model_small.ifc", 1_000)
    _write_sized(tmp_path / "data" / "model_mid.ifc", 2_000)
    _write_sized(tmp_path / "data" / "model_big.ifc", 5_000)
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run(["--scope", "full", "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "scope=full" in out
    assert "BasicHouse.ifc" in out
    assert "model_small.ifc" in out
    assert "model_big.ifc" in out
    assert "model_mid.ifc" not in out  # full only picks endpoints, not the middle


def test_run_explicit_fixtures_overrides_scope_in_preamble(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    fixture = _write_basic_house(tmp_path)
    _write_sized(tmp_path / "data" / "model_x.ifc", 1_000)
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run(["--scope", "full", "--fixtures", str(fixture), "--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    # --fixtures bypasses the scope picker; preamble labels it "explicit".
    assert "scope=explicit" in out
    assert "BasicHouse.ifc" in out
    assert "model_x.ifc" not in out


def test_run_no_basichouse_quick_scope_errors_with_scope_in_message(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(bench, "REPO_ROOT", tmp_path)
    rc = bench.run(["--scope", "quick"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "scope='quick'" in err
