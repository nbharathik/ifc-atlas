"""AI backend readiness state machine.

Surfaces the warm-up state of the two AI backends so the user knows when
deep / edit tools are usable and when the assistant is degrading
gracefully to native-only queries:

* ``native_index`` - metadata index built by the TypeScript
  sidecar on upload. ``ready`` once :pydata:`metadata_index_service.is_loaded`.
* ``ifcopenshell`` - semantic IFC backend used by tier-2/3 tools. ``ready``
  once :pydata:`ifc_service.is_loaded` AND the warm-up routine has finished.

This module owns:
    * State enums + ``ReadinessState`` snapshot.
    * Mark / get methods (thread-safe).
    * ``get_state()`` reads live from the two underlying services so a
      caller can trust the values even if the marks were missed by a
      crash mid-flight.
    * WS push of ``readiness_changed`` via ``model_sync_broker``.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Literal, Optional


NativeIndexState = Literal["absent", "building", "ready", "error"]
IfcOpenShellState = Literal["cold", "warming", "ready", "error"]


@dataclass
class ReadinessTimings:
    """Wall-clock timings (ms) for each warm-up step. ``None`` until ready."""

    native_index_built_ms: Optional[int] = None
    ifcopenshell_loaded_ms: Optional[int] = None


@dataclass
class ReadinessSnapshot:
    """Public read-only view of the AI backend readiness."""

    model_id: Optional[str]
    native_index: NativeIndexState
    ifcopenshell: IfcOpenShellState
    timings_ms: ReadinessTimings = field(default_factory=ReadinessTimings)
    native_index_error: Optional[str] = None
    ifcopenshell_error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "model_id": self.model_id,
            "native_index": self.native_index,
            "ifcopenshell": self.ifcopenshell,
            "timings_ms": {
                "native_index_built_ms": self.timings_ms.native_index_built_ms,
                "ifcopenshell_loaded_ms": self.timings_ms.ifcopenshell_loaded_ms,
            },
            "native_index_error": self.native_index_error,
            "ifcopenshell_error": self.ifcopenshell_error,
        }


class ReadinessService:
    """Tracks AI backend warm-up state across the upload + background-task lifecycle.

    Single-model assumption matches the rest of the backend; ``reset()`` is
    called whenever a new file is uploaded.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model_id: Optional[str] = None
        self._native: NativeIndexState = "absent"
        self._ifcos: IfcOpenShellState = "cold"
        self._timings = ReadinessTimings()
        self._native_error: Optional[str] = None
        self._ifcos_error: Optional[str] = None

        # Wall-clock markers for elapsed-time math. ``time.monotonic()``
        # for measurement; not exposed as state.
        self._native_started_at: Optional[float] = None
        self._ifcos_started_at: Optional[float] = None

    # ────────────────────────────────────────────────────────────────────
    # Lifecycle
    # ────────────────────────────────────────────────────────────────────

    def reset(self, model_id: Optional[str] = None) -> None:
        """Drop all state (called from the upload handler before the new model loads)."""
        with self._lock:
            self._model_id = model_id
            self._native = "absent"
            self._ifcos = "cold"
            self._timings = ReadinessTimings()
            self._native_error = None
            self._ifcos_error = None
            self._native_started_at = None
            self._ifcos_started_at = None

    def set_model_id(self, model_id: Optional[str]) -> None:
        with self._lock:
            self._model_id = model_id

    # ────────────────────────────────────────────────────────────────────
    # IfcOpenShell transitions
    # ────────────────────────────────────────────────────────────────────

    def mark_ifcopenshell_warming(self) -> None:
        with self._lock:
            self._ifcos = "warming"
            self._ifcos_error = None
            self._ifcos_started_at = time.monotonic()

    def mark_ifcopenshell_ready(self) -> None:
        with self._lock:
            self._ifcos = "ready"
            self._ifcos_error = None
            if self._ifcos_started_at is not None:
                self._timings.ifcopenshell_loaded_ms = int(
                    (time.monotonic() - self._ifcos_started_at) * 1000
                )

    def mark_ifcopenshell_error(self, message: str) -> None:
        with self._lock:
            self._ifcos = "error"
            self._ifcos_error = message

    # ────────────────────────────────────────────────────────────────────
    # Native-index transitions
    # ────────────────────────────────────────────────────────────────────

    def mark_native_index_building(self) -> None:
        with self._lock:
            self._native = "building"
            self._native_error = None
            self._native_started_at = time.monotonic()

    def mark_native_index_ready(self, total_ms: Optional[int] = None) -> None:
        with self._lock:
            self._native = "ready"
            self._native_error = None
            if total_ms is not None:
                self._timings.native_index_built_ms = total_ms
            elif self._native_started_at is not None:
                self._timings.native_index_built_ms = int(
                    (time.monotonic() - self._native_started_at) * 1000
                )

    def mark_native_index_error(self, message: str) -> None:
        with self._lock:
            self._native = "error"
            self._native_error = message

    # ────────────────────────────────────────────────────────────────────
    # Snapshot - reads live from underlying services so we self-heal if
    # an external caller forgot to mark a transition.
    # ────────────────────────────────────────────────────────────────────

    def get_state(self) -> ReadinessSnapshot:
        """Return a self-consistent snapshot, reconciled with live service state."""
        # Read service state outside the lock to avoid cross-module deadlocks.
        ifcos_live = _safe_ifc_service_is_loaded()
        native_live = _safe_native_index_is_loaded()

        with self._lock:
            native = self._native
            ifcos = self._ifcos

            # Reconcile: if a service reports ready but we never saw the
            # transition, promote our marker so the chip shows truth.
            if ifcos_live and ifcos != "ready" and ifcos != "error":
                self._ifcos = "ready"
                ifcos = "ready"
            if native_live and native != "ready" and native != "error":
                self._native = "ready"
                native = "ready"
            # Inverse reconcile: if a service is no longer loaded but we
            # still claim "ready", drop back to absent/cold so a stale
            # chip never lies after an unload.
            if not ifcos_live and ifcos == "ready":
                self._ifcos = "cold"
                ifcos = "cold"
            if not native_live and native == "ready":
                self._native = "absent"
                native = "absent"

            return ReadinessSnapshot(
                model_id=self._model_id,
                native_index=native,
                ifcopenshell=ifcos,
                timings_ms=ReadinessTimings(
                    native_index_built_ms=self._timings.native_index_built_ms,
                    ifcopenshell_loaded_ms=self._timings.ifcopenshell_loaded_ms,
                ),
                native_index_error=self._native_error,
                ifcopenshell_error=self._ifcos_error,
            )


def _safe_ifc_service_is_loaded() -> bool:
    """Return ``ifc_service.is_loaded`` or ``False`` on any import / attr error."""
    try:
        from app.services.ifc_service import ifc_service  # local import - avoid cycles
        return bool(ifc_service.is_loaded)
    except Exception:
        return False


def _safe_native_index_is_loaded() -> bool:
    try:
        from app.services.metadata_index_service import metadata_index_service
        return bool(metadata_index_service.is_loaded)
    except Exception:
        return False


# Module-level singleton - same pattern as ifc_service, metadata_index_service.
readiness_service = ReadinessService()


async def broadcast_readiness_changed() -> None:
    """Publish the current readiness snapshot to all model-sync WS subscribers.

    Replaces the chat-panel's 1.5 s `/readiness` polling. Call
    this after every ``mark_*`` transition; the frontend's model_sync
    consumer updates the chip store slice without polling.

    The carried ``model_version`` / ``model_fingerprint`` mirror the current
    ifc_service contract when a model is loaded, otherwise ``0`` and ``""``;
    those default values pass the App.tsx fingerprint filter (which
    short-circuits when either side is falsy) so readiness events delivered
    before the contract is set still reach the store.
    """
    # Local imports to avoid cycles + tolerate missing services in tests.
    try:
        from app.models.ifc_models import ModelSyncEvent
        from app.services.model_sync import model_sync_broker
    except Exception:  # pragma: no cover - defensive
        return

    snap = readiness_service.get_state()

    try:
        from app.services.ifc_service import ifc_service
        if ifc_service.is_loaded:
            contract = ifc_service.get_model_contract()
            model_version = int(contract.get("model_version") or 0)
            model_fingerprint = str(contract.get("model_fingerprint") or "")
            edit_id = contract.get("edit_id")
        else:
            model_version = 0
            model_fingerprint = ""
            edit_id = None
    except Exception:
        model_version = 0
        model_fingerprint = ""
        edit_id = None

    event = ModelSyncEvent(
        type="readiness_changed",
        model_version=model_version,
        model_fingerprint=model_fingerprint,
        edit_id=edit_id,
        payload={
            "readiness": {
                "model_id": snap.model_id,
                "native_index": snap.native_index,
                "ifcopenshell": snap.ifcopenshell,
                "timings_ms": {
                    "native_index_built_ms": snap.timings_ms.native_index_built_ms,
                    "ifcopenshell_loaded_ms": snap.timings_ms.ifcopenshell_loaded_ms,
                },
                "native_index_error": snap.native_index_error,
                "ifcopenshell_error": snap.ifcopenshell_error,
            }
        },
    )
    await model_sync_broker.publish(event)


__all__ = [
    "readiness_service",
    "ReadinessService",
    "ReadinessSnapshot",
    "ReadinessTimings",
    "NativeIndexState",
    "IfcOpenShellState",
    "broadcast_readiness_changed",
]
