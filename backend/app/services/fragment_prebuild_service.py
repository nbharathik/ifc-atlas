"""In-flight fragment pre-conversion registry.

The upload route (``POST /api/ifc/upload``) kicks off a fire-and-forget
background task that pre-converts the uploaded IFC into ``.frag`` bytes
for the ``balanced`` graphics profile. The frontend
later asks for the manifest by SHA-256 fingerprint and either fetches the
cached bytes or - if the cache has not been written yet - re-uploads the
full 50 MB file to ``/api/ifc/convert``.

This module closes that race window: while a pre-conversion task is in
flight, the frontend can poll ``/api/ifc/convert-status`` and ``await`` the
task instead of paying the re-upload cost. On Windows + BasicHouse this
saves ~1-2 s and ~50 MB of upload bandwidth for the common cold-load case.

Design notes:

* Module-singleton state, ``asyncio.Event`` per (fingerprint, profile) so
  multiple frontend callers can wait on the same task without busy-polling.
* Disk-cache hit always wins: ``get_status`` is paired with a caller-supplied
  ``cache_exists`` callback so the registry never falsely returns
  ``"inflight"`` after the cache write has landed.
* No persistence - registry is cleared on process restart. Callers that miss
  the in-memory window simply fall back to the existing ``/convert`` upload.
* Failure is sticky: ``mark_failed`` leaves the entry visible so the next
  poll can surface the error string instead of looping forever.

Imported by ``backend/app/api/ifc_routes.py`` (upload background task +
status endpoint).
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Callable, Dict, Literal, Optional, Tuple

logger = logging.getLogger(__name__)

PrebuildStatus = Literal["idle", "inflight", "complete", "failed"]
"""Status returned by :meth:`FragmentPrebuildService.get_status`.

* ``idle``     - no record in the registry; the frontend should issue a
                 normal ``/convert`` upload.
* ``inflight`` - a pre-conversion is currently running.
* ``complete`` - the disk cache holds the fragment; fetch via
                 ``/api/ifc/fragments/serve``.
* ``failed``   - the most recent pre-conversion raised; the error string is
                 surfaced in ``StatusReport.error``.
"""

CacheExistsFn = Callable[[str, str], bool]
"""``(fingerprint, profile) -> cached``. Pure / fast - called on every status
read so it must not hit the network."""


@dataclass
class StatusReport:
    """Plain-data envelope returned to API callers."""

    status: PrebuildStatus
    fingerprint: str
    profile: str
    started_at: Optional[float] = None
    """Monotonic clock reading (``time.monotonic``) when the in-flight task began -
    NOT a wall-clock epoch. Only meaningful relative to ``elapsed_ms`` within the same
    process; do not interpret as an absolute timestamp. ``None`` for ``idle``."""
    elapsed_ms: Optional[int] = None
    """Wall-clock duration. Live while ``inflight``, frozen on terminal state."""
    size_bytes: Optional[int] = None
    """Cached fragment size; only populated when ``status == "complete"``."""
    error: Optional[str] = None
    """Truncated error message; only populated when ``status == "failed"``."""

    def as_dict(self) -> Dict[str, object]:
        return {
            "status": self.status,
            "fingerprint": self.fingerprint,
            "profile": self.profile,
            "started_at": self.started_at,
            "elapsed_ms": self.elapsed_ms,
            "size_bytes": self.size_bytes,
            "error": self.error,
        }


@dataclass
class _Entry:
    """Internal registry row. ``event`` is set once the task reaches a terminal
    state (``complete`` or ``failed``)."""

    state: PrebuildStatus
    started_at: float
    event: asyncio.Event = field(default_factory=asyncio.Event)
    finished_at: Optional[float] = None
    size_bytes: Optional[int] = None
    error: Optional[str] = None


_ERROR_TRUNCATE_LEN = 240


def _truncate_error(message: str) -> str:
    """Keep error messages compact for API responses."""
    if len(message) <= _ERROR_TRUNCATE_LEN:
        return message
    return message[: _ERROR_TRUNCATE_LEN - 1] + "…"


class FragmentPrebuildService:
    """Async-safe in-process registry of pre-conversion tasks.

    Not designed for cross-process state: each backend worker keeps its own
    map. That's fine - the disk cache is the authoritative durable store; the
    registry only narrows the race window between upload and first viewer
    fetch within a single process.
    """

    def __init__(self) -> None:
        self._entries: Dict[Tuple[str, str], _Entry] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Mutation API - called by the upload background task.
    # ------------------------------------------------------------------

    async def register_inflight(self, fingerprint: str, profile: str) -> None:
        """Mark a (fingerprint, profile) task as in flight.

        Idempotent: re-registering an already-inflight entry leaves the
        original ``started_at`` untouched so concurrent uploads of the same
        file don't reset the clock seen by waiters.
        """
        key = (fingerprint, profile)
        async with self._lock:
            existing = self._entries.get(key)
            if existing is not None and existing.state == "inflight":
                return
            self._entries[key] = _Entry(state="inflight", started_at=time.monotonic())

    async def mark_complete(
        self, fingerprint: str, profile: str, *, size_bytes: int
    ) -> None:
        """Mark the task complete and wake any waiters."""
        key = (fingerprint, profile)
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                # Late completion without a register call - synthesise an entry
                # so callers polling for the result still see ``complete``.
                entry = _Entry(state="complete", started_at=time.monotonic())
                self._entries[key] = entry
            entry.state = "complete"
            entry.finished_at = time.monotonic()
            entry.size_bytes = size_bytes
            entry.event.set()

    async def mark_failed(
        self, fingerprint: str, profile: str, *, error: str
    ) -> None:
        """Mark the task failed and wake any waiters with the error string."""
        key = (fingerprint, profile)
        async with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                entry = _Entry(state="failed", started_at=time.monotonic())
                self._entries[key] = entry
            entry.state = "failed"
            entry.finished_at = time.monotonic()
            entry.error = _truncate_error(error)
            entry.event.set()

    # ------------------------------------------------------------------
    # Read API - called by the status endpoint + waiters.
    # ------------------------------------------------------------------

    def get_status(
        self,
        fingerprint: str,
        profile: str,
        *,
        cache_exists: Optional[CacheExistsFn] = None,
        cached_size: Optional[int] = None,
    ) -> StatusReport:
        """Return the current status for a (fingerprint, profile) pair.

        If ``cache_exists`` returns True, the disk cache is authoritative and
        the report always reads ``"complete"`` - even if the in-memory entry
        has been evicted, or has not yet been written by ``mark_complete``.
        This handles the corner case where the cache file is present from a
        prior run / external prewarm and the registry knows nothing about it.
        """
        cached_hit = bool(cache_exists and cache_exists(fingerprint, profile))
        entry = self._entries.get((fingerprint, profile))

        if cached_hit:
            return StatusReport(
                status="complete",
                fingerprint=fingerprint,
                profile=profile,
                started_at=entry.started_at if entry is not None else None,
                elapsed_ms=(
                    int((entry.finished_at or time.monotonic()) * 1000 - entry.started_at * 1000)
                    if entry is not None
                    else None
                ),
                size_bytes=cached_size,
            )

        if entry is None:
            return StatusReport(status="idle", fingerprint=fingerprint, profile=profile)

        if entry.state == "inflight":
            return StatusReport(
                status="inflight",
                fingerprint=fingerprint,
                profile=profile,
                started_at=entry.started_at,
                elapsed_ms=int((time.monotonic() - entry.started_at) * 1000),
            )

        # complete / failed
        elapsed_ms = (
            int((entry.finished_at - entry.started_at) * 1000)
            if entry.finished_at is not None
            else None
        )
        return StatusReport(
            status=entry.state,
            fingerprint=fingerprint,
            profile=profile,
            started_at=entry.started_at,
            elapsed_ms=elapsed_ms,
            size_bytes=entry.size_bytes,
            error=entry.error,
        )

    async def wait_for(
        self,
        fingerprint: str,
        profile: str,
        *,
        timeout_s: float,
    ) -> StatusReport:
        """Block until the (fingerprint, profile) task reaches a terminal state.

        Returns immediately if the entry is already terminal or absent. Times
        out gracefully - caller decides whether to fall back to ``/convert``.
        Does not consult the disk cache; the API endpoint is responsible for
        combining ``wait_for`` with a cache probe.
        """
        entry = self._entries.get((fingerprint, profile))
        if entry is None or entry.state != "inflight":
            return self.get_status(fingerprint, profile)
        try:
            await asyncio.wait_for(entry.event.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            return self.get_status(fingerprint, profile)
        return self.get_status(fingerprint, profile)

    # ------------------------------------------------------------------
    # Housekeeping API - periodic GC of abandoned in-flight tasks.
    # ------------------------------------------------------------------

    async def prune_stale_inflight(
        self, max_age_s: float
    ) -> list[Tuple[str, str]]:
        """Mark in-flight entries older than ``max_age_s`` as ``failed``.

        A pre-conversion task can leak the ``inflight`` state when the
        sidecar process is killed mid-run, the worker is restarted with the
        registry intact (impossible today - registry is in-memory only - but
        will matter when the registry is persisted in a future slot), or the
        background task raises without our hook running. The result is a
        ghost entry: ``wait_for`` callers block until their own timeout
        elapses, paying the worst-case latency on every poll for a task that
        will never complete.

        This method walks the registry and flips any in-flight row whose
        wall-clock age exceeds ``max_age_s`` to ``failed`` with a
        ``"abandoned"`` error string, waking any pending waiters so they can
        fall back to ``/convert``. Entries already in a terminal state
        (``complete`` / ``failed``) are never touched.

        Returns the ``(fingerprint, profile)`` pairs that were pruned. The
        list is empty when there's nothing to do, so callers can safely run
        this on a tight schedule.

        ``max_age_s`` is clamped to ``>= 0`` - a non-positive argument prunes
        every in-flight entry regardless of age, which is useful for tests
        but not generally for production.
        """
        threshold = max(0.0, max_age_s)
        now = time.monotonic()
        pruned: list[Tuple[str, str]] = []
        async with self._lock:
            for key, entry in self._entries.items():
                if entry.state != "inflight":
                    continue
                if now - entry.started_at < threshold:
                    continue
                entry.state = "failed"
                entry.finished_at = now
                entry.error = _truncate_error(
                    f"abandoned: in-flight task exceeded {threshold:.1f}s without completing"
                )
                entry.event.set()
                pruned.append(key)
        return pruned

    # ------------------------------------------------------------------
    # Test / housekeeping utilities.
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """Drop all registry rows. Test-only - production code never calls
        this, but it's exposed so pytest fixtures can sandbox cleanly."""
        self._entries.clear()

    def __len__(self) -> int:  # pragma: no cover - convenience for repr
        return len(self._entries)


# Module-singleton instance - import as `fragment_prebuild_service`.
fragment_prebuild_service = FragmentPrebuildService()


# ------------------------------------------------------------------
# Periodic GC task for the pre-build registry.
# ------------------------------------------------------------------
#
# Wraps :meth:`FragmentPrebuildService.prune_stale_inflight` in a loop that
# runs on the app's asyncio event loop while FastAPI is alive. The loop is
# ``await``-friendly and cancellable, so the lifespan handler in ``app.main``
# can ``cancel()`` it on shutdown without blocking. The policy (interval, age
# threshold) is a deployment concern that belongs near the lifespan wiring.
# Tests can spin this loop with tiny intervals using the injected ``svc``
# argument and a ``stop_event`` for deterministic cancellation, without
# reaching for ``asyncio.sleep`` patches.

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
    registry = svc if svc is not None else fragment_prebuild_service

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


# ------------------------------------------------------------------
# Fragment delta producer storage.
# ------------------------------------------------------------------
#
# After a sandbox edit is applied, the ``sandbox_service`` consumes the
# pending record and the express-id list would otherwise be lost. The
# frag-delta producer needs that list to serve the geometry patches
# requested by the frontend's ``fragmentDeltaLoader``.
#
# ``FragDeltaService`` is a small LRU-bounded cache of recently-applied edits:
#
#     edit_id  →  {express_ids, model_fingerprint, applied_at}
#
# The cache is intentionally tiny (default ``max_entries = 32``) - older
# entries are evicted in FIFO order. Stale fetches against an evicted
# edit_id return ``None`` and the frontend falls back to the existing
# ``rebuild_started`` full-reload path (Invariant 5 fallback).
#
# **v1.1.0 scope** - the service stores the metadata + the endpoint serves
# ``{representations: {}}``. The representation bytes themselves are a
# future hot-replacement work that needs a @thatopen/fragments-compatible
# ``RawRepresentation`` serializer built against IfcOpenShell geometry.
# With empty representations, ``fragmentDeltaLoader`` returns
# ``updatedCount=0`` and the legacy full-reload path continues to work,
# so v1.1.0 is wire-compatible without risking partial geometry updates.


@dataclass
class FragDeltaRecord:
    """One applied-edit record kept around for frag-delta serving."""

    edit_id: str
    express_ids: list[int]
    model_fingerprint: str
    applied_at: float = field(default_factory=time.time)


class FragDeltaService:
    """Small thread-safe LRU of recently-applied edits.

    Attributes
    ----------
    max_entries:
        Soft cap on stored records. Evicted in FIFO order.
    """

    def __init__(self, max_entries: int = 32) -> None:
        self._records: OrderedDict[str, FragDeltaRecord] = OrderedDict()
        self._lock = threading.Lock()
        self.max_entries = max_entries

    def register(
        self,
        *,
        edit_id: str,
        express_ids: list[int],
        model_fingerprint: str,
    ) -> FragDeltaRecord:
        """Store the applied edit. Returns the stored record."""
        record = FragDeltaRecord(
            edit_id=edit_id,
            express_ids=list(express_ids),  # defensive copy
            model_fingerprint=model_fingerprint,
        )
        with self._lock:
            # Re-add → move to end of LRU.
            if edit_id in self._records:
                del self._records[edit_id]
            self._records[edit_id] = record
            # Evict oldest until we're back under the cap.
            while len(self._records) > self.max_entries:
                self._records.popitem(last=False)
        return record

    def get(self, edit_id: str) -> FragDeltaRecord | None:
        """Look up an applied edit. Returns ``None`` if evicted / unknown."""
        with self._lock:
            return self._records.get(edit_id)

    def clear(self) -> None:
        """Drop every record. Called on new-model upload."""
        with self._lock:
            self._records.clear()

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._records)


# Module-level singleton - mirrors the pattern used by sandbox_service,
# patch_generator, etc.
frag_delta_service = FragDeltaService()


__all__ = [
    "DEFAULT_INTERVAL_S",
    "DEFAULT_MAX_AGE_S",
    "FragDeltaRecord",
    "FragDeltaService",
    "frag_delta_service",
    "FragmentPrebuildService",
    "fragment_prebuild_service",
    "gc_loop",
    "StatusReport",
    "PrebuildStatus",
]
