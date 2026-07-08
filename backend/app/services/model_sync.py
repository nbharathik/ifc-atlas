import asyncio
import logging

from app.models.ifc_models import ModelSyncEvent

logger = logging.getLogger(__name__)


class ModelSyncBroker:
    """In-memory pub/sub fanout for model-sync websocket consumers."""

    def __init__(self):
        self._subscribers: set[asyncio.Queue[ModelSyncEvent]] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue[ModelSyncEvent]:
        queue: asyncio.Queue[ModelSyncEvent] = asyncio.Queue(maxsize=128)
        async with self._lock:
            self._subscribers.add(queue)
        return queue

    async def unsubscribe(self, queue: asyncio.Queue[ModelSyncEvent]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)

    async def publish(self, event: ModelSyncEvent) -> None:
        async with self._lock:
            subscribers = list(self._subscribers)

        for queue in subscribers:
            if queue.full():
                # Drop the oldest event to keep the stream live.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.debug("Dropping model-sync event for saturated subscriber queue")


model_sync_broker = ModelSyncBroker()
