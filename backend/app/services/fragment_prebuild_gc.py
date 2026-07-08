"""Periodic GC task for the fragment pre-build registry.

Wraps :meth:`FragmentPrebuildService.prune_stale_inflight` in a loop that
runs on the app's asyncio event loop while FastAPI is alive. The loop is
``await``-friendly and cancellable, so the lifespan handler in
``app.main`` can ``cancel()`` it on shutdown without blocking.

Why this lives outside ``fragment_prebuild_service``:

* The service is a synchronous-state object - adding a long-running task
  to it would make it harder to unit-test in isolation.
* The loop only wakes the GC; the policy (interval, age threshold) is a
  deployment concern that belongs near the lifespan wiring, not in the
  data model.
* Tests can spin this loop with tiny intervals using the injected ``svc``
  argument and a ``stop_event`` for deterministic cancellation, without
  reaching for ``asyncio.sleep`` patches.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from app.services.fragment_prebuild_service import (
    FragmentPrebuildService,
    fragment_prebuild_service as _default_svc,
)

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_S = 30.0
"""How often the loop wakes to scan for stale in-flight entries.

30 s is a deliberate balance: a real pre-build of a 50 MB BasicHouse
finishes in 1-2 s, so a stuck entry is detectable within one loop tick
without flooding logs in the steady-state happy path."""

DEFAULT_MAX_AGE_S = 120.0
"""How old (since ``register_inflight``) an entry must be before the GC
flips it to ``failed``. Default 2 min - comfortably above the slowest
honest pre-build we've observed."""


def _sanitise(value: float, *, floor: float, default: float) -> float:
    """Defensive sanitiser for caller-provided intervals.

    Negative, NaN, infinity, or below-floor values fall back to
    ``default``. Centralised so the lifespan wiring and tests share the
    same policy without re-implementing the check.
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return default
    if v != v:  # NaN check
        return default
    if v == float("inf") or v == float("-inf"):
        return default
    if v < floor:
        return default
    return v


async def gc_loop(
    *,
    interval_s: float = DEFAULT_INTERVAL_S,
    max_age_s: float = DEFAULT_MAX_AGE_S,
    svc: Optional[FragmentPrebuildService] = None,
    stop_event: Optional[asyncio.Event] = None,
) -> None:
    """Run :meth:`prune_stale_inflight` on a fixed cadence until cancelled.

    Args:
        interval_s: seconds between successive prune passes. Sanitised
            against negatives / NaN / sub-second values (floor 0.05 s).
        max_age_s: passed straight through to ``prune_stale_inflight``.
            Sanitised against negatives / NaN.
        svc: registry instance to GC. Defaults to the module-singleton.
        stop_event: optional sentinel. When set, the loop exits cleanly on
            the next tick - useful for tests that don't want to wrangle
            ``Task.cancel()``. Cancellation is still honoured.

    The loop swallows every exception inside the prune call so a single
    glitch never kills the task - a dead GC is worse than a noisy one.
    """
    interval = _sanitise(interval_s, floor=0.05, default=DEFAULT_INTERVAL_S)
    age = _sanitise(max_age_s, floor=0.0, default=DEFAULT_MAX_AGE_S)
    registry = svc if svc is not None else _default_svc

    while True:
        try:
            pruned = await registry.prune_stale_inflight(age)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - never let the GC die
            logger.exception("fragment_prebuild GC: prune raised; continuing")
            pruned = []

        if pruned:
            logger.info(
                "fragment_prebuild GC: pruned %d stale in-flight entr%s (max_age=%.1fs)",
                len(pruned),
                "y" if len(pruned) == 1 else "ies",
                age,
            )

        if stop_event is not None and stop_event.is_set():
            return

        try:
            if stop_event is not None:
                # Wake early when the sentinel fires, otherwise wait the full interval.
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    pass
                if stop_event.is_set():
                    return
            else:
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise


__all__ = [
    "DEFAULT_INTERVAL_S",
    "DEFAULT_MAX_AGE_S",
    "gc_loop",
]
