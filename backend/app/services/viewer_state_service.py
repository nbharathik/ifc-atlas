"""Viewer state mirror, command broadcast, and snapshot rendezvous.

The browser viewer reports its presentation state (camera, selection,
visibility counters) to the backend so headless clients (CLI, MCP server)
can observe it. Commands flow the other way over the model-sync WebSocket;
``broadcast_viewer_command`` is the single publish point shared by the HTTP
routes and the MCP server.

Snapshots need a request/response handshake across two one-way channels:
the ``viewer_command`` event goes out over the WebSocket and the browser
uploads the captured image back over HTTP. This module pairs the two with
an asyncio rendezvous keyed by request id.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from app.models.ifc_models import ModelSyncEvent
from app.services.ifc_service import ifc_service
from app.services.model_sync import model_sync_broker


def subscriber_count() -> int:
    """Number of model-sync WebSocket subscribers (connected viewers).

    ModelSyncBroker keeps its subscriber set private and exposes no count;
    read it defensively so a broker refactor degrades callers to
    "0 viewers connected" instead of an exception.
    """
    subscribers = getattr(model_sync_broker, "_subscribers", None)
    return len(subscribers) if subscribers is not None else 0


async def broadcast_viewer_command(payload: dict[str, Any]) -> int:
    """Broadcast a ``viewer_command`` event over the model-sync WebSocket.

    When a backend model is loaded the event carries its version/fingerprint
    so the frontend executor can detect staleness; otherwise it carries
    ``0`` / ``""``. Returns the current subscriber count (how many connected
    viewers the command was delivered to).
    """
    if ifc_service.is_loaded:
        contract = ifc_service.get_model_contract()
        model_version = contract["model_version"]
        model_fingerprint = contract["model_fingerprint"]
    else:
        model_version, model_fingerprint = 0, ""
    await model_sync_broker.publish(
        ModelSyncEvent(
            type="viewer_command",
            model_version=model_version,
            model_fingerprint=model_fingerprint,
            payload=payload,
        )
    )
    return subscriber_count()


@dataclass
class _PendingSnapshot:
    event: asyncio.Event = field(default_factory=asyncio.Event)
    result: Optional[dict[str, str]] = None


class ViewerStateService:
    """Holds the last viewer-reported state and pending snapshot requests."""

    # Hard cap on outstanding snapshot requests. Creating one beyond the cap
    # evicts the oldest entry (waking its waiter, if any, with no result), so
    # abandoned requests cannot accumulate when no browser ever answers.
    MAX_PENDING_SNAPSHOTS = 8

    def __init__(self) -> None:
        self._state: Optional[dict[str, Any]] = None
        self._pending: OrderedDict[str, _PendingSnapshot] = OrderedDict()

    # -- state mirror -----------------------------------------------------

    def report_state(self, state: dict[str, Any]) -> None:
        """Store the latest viewer-reported state, stamped with updated_at."""
        stamped = dict(state)
        stamped["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._state = stamped

    @property
    def state(self) -> Optional[dict[str, Any]]:
        """Last reported state (with ``updated_at``), or None before any report."""
        return self._state

    # -- snapshot rendezvous -----------------------------------------------

    def create_snapshot_request(self) -> str:
        """Register a new pending snapshot request and return its id."""
        while len(self._pending) >= self.MAX_PENDING_SNAPSHOTS:
            _, evicted = self._pending.popitem(last=False)
            evicted.event.set()  # wake any waiter; its result stays None
        request_id = uuid.uuid4().hex
        self._pending[request_id] = _PendingSnapshot()
        return request_id

    def fulfill(self, request_id: str, image_base64: str, mime: str) -> bool:
        """Attach the browser's captured image to a pending request.

        Returns False when the request id is unknown (expired, evicted, or
        never issued). The entry deliberately stays in the pending map until
        the waiter collects it: fulfilment can land between the command
        publish and ``await_snapshot`` starting to wait, and popping here
        would lose the result for that window. Cleanup happens in
        ``await_snapshot`` or via the pending cap.
        """
        entry = self._pending.get(request_id)
        if entry is None:
            return False
        entry.result = {"image_base64": image_base64, "mime": mime}
        entry.event.set()
        return True

    async def await_snapshot(
        self, request_id: str, timeout_s: float
    ) -> Optional[dict[str, str]]:
        """Wait for ``fulfill`` on the given request; None on timeout/unknown id.

        The pending entry is always removed on exit, so timed-out and
        collected requests never linger.
        """
        entry = self._pending.get(request_id)
        if entry is None:
            return None
        try:
            await asyncio.wait_for(entry.event.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            return None
        finally:
            self._pending.pop(request_id, None)
        return entry.result


viewer_state_service = ViewerStateService()
