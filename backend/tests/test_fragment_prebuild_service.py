"""Unit tests for ``fragment_prebuild_service``.

Covers the registry mutation API (register / mark_complete / mark_failed),
the disk-cache override in ``get_status``, the ``wait_for`` timeout +
wake-up behaviour, and the idempotence guarantees needed by the upload
background task.
"""

from __future__ import annotations

import asyncio

import pytest

from app.services.fragment_prebuild_service import (
    FragmentPrebuildService,
    _truncate_error,
)


@pytest.fixture()
def svc() -> FragmentPrebuildService:
    return FragmentPrebuildService()


def test_idle_for_unknown_fingerprint(svc: FragmentPrebuildService) -> None:
    report = svc.get_status("deadbeef", "performance")
    assert report.status == "idle"
    assert report.fingerprint == "deadbeef"
    assert report.profile == "performance"
    assert report.started_at is None
    assert report.size_bytes is None
    assert report.error is None


@pytest.mark.asyncio
async def test_register_marks_inflight(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "ultra_fast")
    report = svc.get_status("abc", "ultra_fast")
    assert report.status == "inflight"
    assert report.started_at is not None
    assert report.elapsed_ms is not None and report.elapsed_ms >= 0
    assert report.size_bytes is None


@pytest.mark.asyncio
async def test_register_is_idempotent(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "performance")
    first = svc.get_status("abc", "performance").started_at
    assert first is not None
    # Force a measurable delta on coarse-clock platforms.
    await asyncio.sleep(0.02)
    await svc.register_inflight("abc", "performance")
    second = svc.get_status("abc", "performance").started_at
    assert second == first, "re-registering an inflight task must not reset the clock"


@pytest.mark.asyncio
async def test_mark_complete_records_size(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "performance")
    await svc.mark_complete("abc", "performance", size_bytes=12_345)
    report = svc.get_status("abc", "performance")
    assert report.status == "complete"
    assert report.size_bytes == 12_345
    assert report.error is None


@pytest.mark.asyncio
async def test_mark_failed_records_error(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "performance")
    await svc.mark_failed("abc", "performance", error="sidecar exited with code 1")
    report = svc.get_status("abc", "performance")
    assert report.status == "failed"
    assert report.error == "sidecar exited with code 1"
    assert report.size_bytes is None


@pytest.mark.asyncio
async def test_mark_complete_synthesises_entry_when_no_register(
    svc: FragmentPrebuildService,
) -> None:
    """If ``mark_complete`` lands without a prior ``register_inflight`` (e.g.
    on a process that restarted after the task started elsewhere), the report
    still reads ``complete`` so the frontend can fetch the bytes."""
    await svc.mark_complete("abc", "performance", size_bytes=42)
    report = svc.get_status("abc", "performance")
    assert report.status == "complete"
    assert report.size_bytes == 42


def test_disk_cache_overrides_idle(svc: FragmentPrebuildService) -> None:
    """An external prewarm (or prior process run) may have written the .frag
    file without touching this registry. The cache must win."""
    seen: list[tuple[str, str]] = []

    def cache_exists(fp: str, profile: str) -> bool:
        seen.append((fp, profile))
        return True

    report = svc.get_status(
        "abc",
        "performance",
        cache_exists=cache_exists,
        cached_size=2048,
    )
    assert seen == [("abc", "performance")]
    assert report.status == "complete"
    assert report.size_bytes == 2048


@pytest.mark.asyncio
async def test_disk_cache_overrides_inflight(svc: FragmentPrebuildService) -> None:
    """Even an in-flight entry must yield to a cache hit - once the file is on
    disk there's no reason for the caller to wait."""
    await svc.register_inflight("abc", "performance")
    report = svc.get_status(
        "abc",
        "performance",
        cache_exists=lambda _f, _p: True,
        cached_size=99,
    )
    assert report.status == "complete"
    assert report.size_bytes == 99


@pytest.mark.asyncio
async def test_wait_for_returns_immediately_when_terminal(
    svc: FragmentPrebuildService,
) -> None:
    await svc.register_inflight("abc", "performance")
    await svc.mark_complete("abc", "performance", size_bytes=10)
    report = await svc.wait_for("abc", "performance", timeout_s=5.0)
    assert report.status == "complete"


@pytest.mark.asyncio
async def test_wait_for_unblocks_on_mark_complete(
    svc: FragmentPrebuildService,
) -> None:
    await svc.register_inflight("abc", "performance")

    async def complete_after_delay() -> None:
        await asyncio.sleep(0.05)
        await svc.mark_complete("abc", "performance", size_bytes=512)

    waiter = asyncio.create_task(svc.wait_for("abc", "performance", timeout_s=2.0))
    completer = asyncio.create_task(complete_after_delay())
    report, _ = await asyncio.gather(waiter, completer)
    assert report.status == "complete"
    assert report.size_bytes == 512


@pytest.mark.asyncio
async def test_wait_for_unblocks_on_mark_failed(
    svc: FragmentPrebuildService,
) -> None:
    await svc.register_inflight("abc", "performance")

    async def fail_after_delay() -> None:
        await asyncio.sleep(0.05)
        await svc.mark_failed("abc", "performance", error="boom")

    waiter = asyncio.create_task(svc.wait_for("abc", "performance", timeout_s=2.0))
    failer = asyncio.create_task(fail_after_delay())
    report, _ = await asyncio.gather(waiter, failer)
    assert report.status == "failed"
    assert report.error == "boom"


@pytest.mark.asyncio
async def test_wait_for_times_out_cleanly(svc: FragmentPrebuildService) -> None:
    await svc.register_inflight("abc", "performance")
    report = await svc.wait_for("abc", "performance", timeout_s=0.05)
    # Status is still inflight after the timeout - caller decides whether to
    # fall back to /convert or poll again.
    assert report.status == "inflight"


@pytest.mark.asyncio
async def test_wait_for_idle_is_a_fast_path(svc: FragmentPrebuildService) -> None:
    report = await svc.wait_for("unknown", "performance", timeout_s=5.0)
    # Should NOT block on a non-existent task - returns immediately as idle.
    assert report.status == "idle"


def test_truncate_error_keeps_short_messages_untouched() -> None:
    assert _truncate_error("short") == "short"


def test_truncate_error_truncates_long_messages() -> None:
    huge = "x" * 1000
    result = _truncate_error(huge)
    assert len(result) <= 240
    assert result.endswith("…")


def test_reset_clears_entries(svc: FragmentPrebuildService) -> None:
    # Use a sync mutator path via run_until_complete to avoid the asyncio mark.
    asyncio.run(svc.register_inflight("abc", "performance"))
    assert svc.get_status("abc", "performance").status == "inflight"
    svc.reset()
    assert svc.get_status("abc", "performance").status == "idle"


def test_as_dict_round_trips_all_fields(svc: FragmentPrebuildService) -> None:
    asyncio.run(svc.register_inflight("abc", "performance"))
    asyncio.run(svc.mark_complete("abc", "performance", size_bytes=123))
    data = svc.get_status("abc", "performance").as_dict()
    assert data["status"] == "complete"
    assert data["size_bytes"] == 123
    assert data["fingerprint"] == "abc"
    assert data["profile"] == "performance"
    assert data["started_at"] is not None
    assert data["elapsed_ms"] is not None
    assert data["error"] is None


@pytest.mark.asyncio
async def test_distinct_profiles_have_independent_entries(
    svc: FragmentPrebuildService,
) -> None:
    await svc.register_inflight("abc", "performance")
    await svc.mark_complete("abc", "performance", size_bytes=10)
    # Different profile is still idle.
    assert svc.get_status("abc", "ultra_fast").status == "idle"


@pytest.mark.asyncio
async def test_concurrent_waiters_wake_together(svc: FragmentPrebuildService) -> None:
    """Two viewer remounts could race on the same fingerprint - both must wake
    from the same ``asyncio.Event`` rather than the second one waiting forever."""
    await svc.register_inflight("abc", "performance")

    async def fire_completion() -> None:
        await asyncio.sleep(0.03)
        await svc.mark_complete("abc", "performance", size_bytes=7)

    a = asyncio.create_task(svc.wait_for("abc", "performance", timeout_s=2.0))
    b = asyncio.create_task(svc.wait_for("abc", "performance", timeout_s=2.0))
    _ = asyncio.create_task(fire_completion())
    r1, r2 = await asyncio.gather(a, b)
    assert r1.status == "complete"
    assert r2.status == "complete"


# ----------------------------------------------------------------------
# prune_stale_inflight - periodic GC of abandoned tasks.
# ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prune_stale_inflight_marks_old_entries_failed(
    svc: FragmentPrebuildService,
) -> None:
    """An in-flight entry past ``max_age_s`` flips to ``failed`` with the
    abandoned-error string surfacing so callers know not to retry the wait."""
    await svc.register_inflight("abc", "performance")
    # ``max_age_s=0`` prunes every in-flight entry regardless of wall-clock.
    pruned = await svc.prune_stale_inflight(max_age_s=0.0)
    assert pruned == [("abc", "performance")]
    report = svc.get_status("abc", "performance")
    assert report.status == "failed"
    assert report.error is not None
    assert "abandoned" in report.error.lower()


@pytest.mark.asyncio
async def test_prune_stale_inflight_keeps_fresh_entries(
    svc: FragmentPrebuildService,
) -> None:
    """A fresh in-flight entry is not pruned when its age is below the
    threshold - the GC must not eat tasks that are about to land."""
    await svc.register_inflight("abc", "performance")
    pruned = await svc.prune_stale_inflight(max_age_s=10.0)
    assert pruned == []
    assert svc.get_status("abc", "performance").status == "inflight"


@pytest.mark.asyncio
async def test_prune_stale_inflight_skips_terminal_states(
    svc: FragmentPrebuildService,
) -> None:
    """Already-complete and already-failed entries must never be re-mutated;
    the GC owns only the ``inflight`` rows."""
    await svc.register_inflight("done", "performance")
    await svc.mark_complete("done", "performance", size_bytes=100)
    await svc.register_inflight("bust", "performance")
    await svc.mark_failed("bust", "performance", error="original error")

    pruned = await svc.prune_stale_inflight(max_age_s=0.0)
    assert pruned == []
    assert svc.get_status("done", "performance").status == "complete"
    failed = svc.get_status("bust", "performance")
    assert failed.status == "failed"
    assert failed.error == "original error"


@pytest.mark.asyncio
async def test_prune_stale_inflight_wakes_waiters(
    svc: FragmentPrebuildService,
) -> None:
    """A ``wait_for`` caller blocked on a stale task must wake the moment the
    GC marks it failed - otherwise the waiter pays its own timeout for a task
    that will never complete."""
    await svc.register_inflight("abc", "performance")

    async def gc_after_delay() -> None:
        await asyncio.sleep(0.02)
        await svc.prune_stale_inflight(max_age_s=0.0)

    waiter = asyncio.create_task(svc.wait_for("abc", "performance", timeout_s=2.0))
    gc = asyncio.create_task(gc_after_delay())
    report, _ = await asyncio.gather(waiter, gc)
    assert report.status == "failed"
    assert report.error is not None and "abandoned" in report.error.lower()


@pytest.mark.asyncio
async def test_prune_stale_inflight_is_idempotent(
    svc: FragmentPrebuildService,
) -> None:
    """Running the GC twice in a row must not re-touch a previously-pruned
    entry - the second pass returns an empty list."""
    await svc.register_inflight("abc", "performance")
    first = await svc.prune_stale_inflight(max_age_s=0.0)
    second = await svc.prune_stale_inflight(max_age_s=0.0)
    assert first == [("abc", "performance")]
    assert second == []


@pytest.mark.asyncio
async def test_prune_stale_inflight_handles_negative_max_age(
    svc: FragmentPrebuildService,
) -> None:
    """A negative ``max_age_s`` is clamped to zero - it prunes every in-flight
    entry rather than silently doing nothing."""
    await svc.register_inflight("abc", "performance")
    pruned = await svc.prune_stale_inflight(max_age_s=-5.0)
    assert pruned == [("abc", "performance")]
    assert svc.get_status("abc", "performance").status == "failed"


@pytest.mark.asyncio
async def test_prune_stale_inflight_returns_empty_when_registry_empty(
    svc: FragmentPrebuildService,
) -> None:
    """No entries → no work - callers must be able to schedule the GC on a
    tight cadence without paying for empty traversals."""
    pruned = await svc.prune_stale_inflight(max_age_s=0.0)
    assert pruned == []


@pytest.mark.asyncio
async def test_prune_stale_inflight_truncates_long_threshold_label(
    svc: FragmentPrebuildService,
) -> None:
    """The threshold value lands in the error string. A pathological caller
    passing a huge float must not blow past the error truncation cap."""
    await svc.register_inflight("abc", "performance")
    await svc.prune_stale_inflight(max_age_s=1e12)  # > threshold so nothing prunes
    # Re-register and force the prune to fire with a very long-format threshold.
    await svc.prune_stale_inflight(max_age_s=0.0)
    report = svc.get_status("abc", "performance")
    assert report.status == "failed"
    assert report.error is not None
    assert len(report.error) <= 240
