"""Fragment delta producer storage.

After a sandbox edit is applied, the ``sandbox_service`` consumes the
pending record and the express-id list would otherwise be lost. The
frag-delta producer needs that list to serve the geometry patches
requested by the frontend's ``fragmentDeltaLoader``.

This module is a small LRU-bounded cache of recently-applied edits:

    edit_id  →  {express_ids, model_fingerprint, applied_at}

The cache is intentionally tiny (default ``MAX_ENTRIES = 32``) - older
entries are evicted in FIFO order. Stale fetches against an evicted
edit_id return ``None`` and the frontend falls back to the existing
``rebuild_started`` full-reload path (Invariant 5 fallback).

**v0.1.1 scope** - this module stores the metadata + the endpoint serves
``{representations: {}}``. The representation bytes themselves are a
future hot-replacement work that needs a @thatopen/fragments-compatible
``RawRepresentation`` serializer built against IfcOpenShell geometry.
With empty representations, ``fragmentDeltaLoader`` returns
``updatedCount=0`` and the legacy full-reload path continues to work,
so v0.1.1 is wire-compatible without risking partial geometry updates.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field


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
