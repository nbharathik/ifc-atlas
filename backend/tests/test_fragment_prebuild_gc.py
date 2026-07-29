"""Unit tests for ``fragment_prebuild_service.gc_loop``.

The loop is intentionally testable in isolation - it takes an injected
``svc`` plus a ``stop_event`` so we never need to fight ``asyncio.sleep``
patches or worry about leaking real background tasks across tests.
"""

from __future__ import annotations

import asyncio
import math

import pytest

from app.services.fragment_prebuild_service import (
    DEFAULT_INTERVAL_S,
    DEFAULT_MAX_AGE_S,
    FragmentPrebuildService,
    _sanitise,
    gc_loop,
)


@pytest.fixture()
def svc() -> FragmentPrebuildService:
    return FragmentPrebuildService()


# ---------------------------------------------------------------------------
# _sanitise - defensive coercion
# ---------------------------------------------------------------------------


def test_sanitise_passes_through_valid_values() -> None:
    assert _sanitise(1.5, floor=0.05, default=10.0) == 1.5
    assert _sanitise(0.05, floor=0.05, default=10.0) == 0.05


def test_sanitise_rejects_below_floor() -> None:
    assert _sanitise(0.01, floor=0.05, default=10.0) == 10.0


def test_sanitise_rejects_negative() -> None:
    assert _sanitise(-1.0, floor=0.0, default=42.0) == 42.0


def test_sanitise_rejects_nan() -> None:
    assert _sanitise(math.nan, floor=0.0, default=7.0) == 7.0


def test_sanitise_rejects_infinity() -> None:
    assert _sanitise(math.inf, floor=0.0, default=3.0) == 3.0
    assert _sanitise(-math.inf, floor=0.0, default=3.0) == 3.0


def test_sanitise_rejects_non_numeric() -> None:
    assert _sanitise("oops", floor=0.0, default=9.0) == 9.0  # type: ignore[arg-type]
    assert _sanitise(None, floor=0.0, default=9.0) == 9.0  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# gc_loop - happy path + cancellation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_gc_loop_prunes_stale_inflight(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "performance")
    await asyncio.sleep(0.05)  # let the entry age past the threshold below
    stop = asyncio.Event()

    task = asyncio.create_task(
        gc_loop(interval_s=0.05, max_age_s=0.0, svc=svc, stop_event=stop)
    )
    await asyncio.sleep(0.12)
    stop.set()
    await task

    report = svc.get_status("abc", "performance")
    assert report.status == "failed"
    assert report.error is not None and report.error.startswith("abandoned")


@pytest.mark.asyncio
async def test_gc_loop_does_not_touch_fresh_entries(
    svc: FragmentPrebuildService,
) -> None:
    await svc.register_inflight("fresh", "performance")
    stop = asyncio.Event()

    # max_age_s=1.0 means the freshly-registered entry is well within the
    # threshold for the duration of this test.
    task = asyncio.create_task(
        gc_loop(interval_s=0.05, max_age_s=1.0, svc=svc, stop_event=stop)
    )
    await asyncio.sleep(0.15)
    stop.set()
    await task

    report = svc.get_status("fresh", "performance")
    assert report.status == "inflight"


@pytest.mark.asyncio
async def test_gc_loop_stops_promptly_on_event(
    svc: FragmentPrebuildService,
) -> None:
    stop = asyncio.Event()
    task = asyncio.create_task(
        gc_loop(
            interval_s=DEFAULT_INTERVAL_S,  # would otherwise sleep ~30 s
            max_age_s=DEFAULT_MAX_AGE_S,
            svc=svc,
            stop_event=stop,
        )
    )
    # Give the loop one tick to register the wait.
    await asyncio.sleep(0.02)
    stop.set()
    # Without the stop_event short-circuit, this would block for ~30 s.
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_gc_loop_cancellable_without_stop_event(
    svc: FragmentPrebuildService,
) -> None:
    task = asyncio.create_task(
        gc_loop(interval_s=0.05, max_age_s=10.0, svc=svc)
    )
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_gc_loop_survives_prune_exception(
    svc: FragmentPrebuildService, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A flaky prune call must not kill the loop - best-effort GC."""
    calls = {"n": 0}
    second_call = asyncio.Event()

    async def _flaky(_max_age_s: float):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        second_call.set()
        return []

    monkeypatch.setattr(svc, "prune_stale_inflight", _flaky)
    stop = asyncio.Event()
    task = asyncio.create_task(
        gc_loop(interval_s=0.05, max_age_s=0.0, svc=svc, stop_event=stop)
    )
    # Wait deterministically for the second invocation rather than racing
    # the OS scheduler on Windows where tick granularity is ~15 ms.
    await asyncio.wait_for(second_call.wait(), timeout=2.0)
    stop.set()
    await task

    assert calls["n"] >= 2, "loop must survive a single prune exception"


@pytest.mark.asyncio
async def test_gc_loop_clamps_bad_intervals(
    svc: FragmentPrebuildService,
) -> None:
    """A negative interval / age must not break the loop - defaults take over."""
    stop = asyncio.Event()
    task = asyncio.create_task(
        gc_loop(
            interval_s=-5.0,
            max_age_s=float("nan"),
            svc=svc,
            stop_event=stop,
        )
    )
    # The defaults are 30 s / 120 s respectively - the loop should still be alive.
    await asyncio.sleep(0.05)
    stop.set()
    await asyncio.wait_for(task, timeout=1.0)
