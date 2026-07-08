"""Read-only metadata index served by the native parser sidecar.

This service holds the index produced by the native parser sidecar and
exposes Ask-mode queries that mirror the IfcOpenShell-based methods in
``ifc_service.py``.

Persistence model:
  * ``~/.ifc-atlas/data/ifc-index/{sha256}.json`` (under ``DATA_DIR``) -
    the raw sidecar output.
  * On native-parse request: hit cache → if miss, call the sidecar.
  * Build is deterministic given (sha, sidecar version) so re-uploads of
    the same file are instant.

The service stores a single "current" index - same single-model assumption
the rest of the app uses.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from pathlib import Path
from typing import Iterable, Optional

from app.core.config import DATA_DIR
from app.models.ifc_models import ElementSummary as LegacyElementSummary
from app.models.metadata_index_models import (
    IndexElementSummary,
    MetadataIndex,
)
from app.services.sidecar_manager import sidecar_manager

logger = logging.getLogger(__name__)

_INDEX_CACHE_DIR: Path = DATA_DIR / "ifc-index"
_INDEX_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _to_legacy(elem: IndexElementSummary) -> LegacyElementSummary:
    """Map an index element to the existing tools' ElementSummary shape."""
    return LegacyElementSummary(
        id=elem.id,
        global_id=elem.global_id or "",
        name=elem.name,
        ifc_type=elem.type,
        storey=elem.storey_name,
    )


def _normalize_ifc_type(ifc_type: str) -> str:
    """Upper-case and ensure the ``IFC`` prefix (e.g. ``wall`` -> ``IFCWALL``)."""
    upper = ifc_type.upper().strip()
    return upper if upper.startswith("IFC") else "IFC" + upper


class MetadataIndexService:
    """Single-model read-only index. Thread-safe for the common access patterns."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._current: Optional[MetadataIndex] = None
        self._current_sha: Optional[str] = None

    # ────────────────────────────────────────────────────────────────────
    # Build / load / unload
    # ────────────────────────────────────────────────────────────────────

    @property
    def is_loaded(self) -> bool:
        return self._current is not None

    @property
    def current(self) -> Optional[MetadataIndex]:
        return self._current

    @property
    def current_sha(self) -> Optional[str]:
        return self._current_sha

    def cache_path(self, sha: str) -> Path:
        return _INDEX_CACHE_DIR / f"{sha}.json"

    def load_from_disk(self, sha: str) -> Optional[MetadataIndex]:
        path = self.cache_path(sha)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return MetadataIndex.model_validate(raw)
        except Exception:
            logger.exception("Failed to read index cache at %s", path)
            return None

    def write_to_disk(self, sha: str, index: MetadataIndex) -> None:
        path = self.cache_path(sha)
        path.write_text(
            json.dumps(index.model_dump(by_alias=True), separators=(",", ":")),
            encoding="utf-8",
        )

    async def build_from_bytes(
        self, ifc_bytes: bytes, force: bool = False
    ) -> tuple[MetadataIndex, dict, bool]:
        """Build (or load from cache) the metadata index for the given bytes.

        Returns ``(index, sidecar_meta, cached)``. When cached, sidecar_meta
        contains only ``{"elapsedMs": 0, "cached": True}``.
        """
        sha = _sha256_hex(ifc_bytes)

        if not force:
            cached = self.load_from_disk(sha)
            if cached is not None:
                with self._lock:
                    self._current = cached
                    self._current_sha = sha
                logger.info("Metadata index cache hit for sha=%s", sha[:12])
                return cached, {"elapsedMs": 0, "cached": True}, True

        logger.info(
            "Native-parsing %s (%.1f MB) via sidecar...",
            sha[:12],
            len(ifc_bytes) / 1024 / 1024,
        )
        started = time.monotonic()
        raw_index, sidecar_meta = await sidecar_manager.parse(
            ifc_bytes, model_id=sha[:12]
        )
        index = MetadataIndex.model_validate(raw_index)
        self.write_to_disk(sha, index)
        with self._lock:
            self._current = index
            self._current_sha = sha
        wall_ms = int((time.monotonic() - started) * 1000)
        sidecar_meta = dict(sidecar_meta)
        sidecar_meta["wallMs"] = wall_ms
        logger.info(
            "Native parse complete sha=%s elements=%s storeys=%s wall=%sms",
            sha[:12],
            index.stats.element_count,
            index.stats.storey_count,
            wall_ms,
        )
        return index, sidecar_meta, False

    def hydrate_from_disk(self, sha: str) -> bool:
        """Load the cached index for ``sha`` and make it current.

        Returns True when the disk cache had a usable index. Used at
        model-switch points (upload of a previously-seen file, warm-from-cache)
        to restore the index instantly instead of leaving it absent until the
        background parse finishes.
        """
        cached = self.load_from_disk(sha)
        if cached is None:
            return False
        with self._lock:
            self._current = cached
            self._current_sha = sha
        logger.info("Metadata index rehydrated from disk for sha=%s", sha[:12])
        return True

    def unload(self) -> None:
        with self._lock:
            self._current = None
            self._current_sha = None

    # ────────────────────────────────────────────────────────────────────
    # Queries - match the existing ifc_service surface so tools can swap.
    # ────────────────────────────────────────────────────────────────────

    def _require(self) -> MetadataIndex:
        if self._current is None:
            raise RuntimeError("metadata index not loaded")
        return self._current

    def get_project_info(self) -> Optional[dict]:
        idx = self._require()
        if idx.project is None:
            return None
        return {
            "name": idx.project.name,
            "description": idx.project.description,
            "long_name": idx.project.long_name,
            "phase": idx.project.phase,
            "global_id": idx.project.global_id,
        }

    def get_storeys(self) -> list[LegacyElementSummary]:
        idx = self._require()
        out: list[LegacyElementSummary] = []
        for sid in idx.storey_ids:
            node = idx.spatial.get(sid)
            if node is None:
                continue
            out.append(
                LegacyElementSummary(
                    id=node.id,
                    global_id=node.global_id or "",
                    name=node.name,
                    ifc_type=node.type,
                )
            )
        return out

    def get_elements_by_storey(self, storey_id: int) -> list[LegacyElementSummary]:
        idx = self._require()
        ids: list[int] = idx.ids_by_storey.get(storey_id, [])
        # Tolerate JSON deserialisation: dict keys come back as strings.
        if not ids:
            ids = idx.ids_by_storey.get(str(storey_id), [])  # type: ignore[arg-type]
        return [_to_legacy(idx.elements[i]) for i in ids if i in idx.elements]

    def get_elements_by_type(self, ifc_type: str) -> list[LegacyElementSummary]:
        idx = self._require()
        upper = _normalize_ifc_type(ifc_type)
        ids = idx.ids_by_type.get(upper, [])
        return [_to_legacy(idx.elements[i]) for i in ids if i in idx.elements]

    def get_element_by_id(self, express_id: int) -> Optional[IndexElementSummary]:
        idx = self._require()
        elem = idx.elements.get(express_id)
        if elem is not None:
            return elem
        # Tolerate JSON-roundtripped string keys.
        return idx.elements.get(str(express_id))  # type: ignore[arg-type]

    def get_element_by_global_id(self, global_id: str) -> Optional[IndexElementSummary]:
        idx = self._require()
        eid = idx.id_by_global_id.get(global_id)
        if eid is None:
            return None
        return self.get_element_by_id(eid)

    def get_model_stats(self) -> dict:
        idx = self._require()
        storey_names = []
        for sid in idx.storey_ids:
            node = idx.spatial.get(sid)
            if node is not None:
                storey_names.append(node.name or f"Storey #{sid}")
        return {
            "total_elements": idx.stats.element_count,
            "by_type": dict(idx.by_type),
            "storeys": storey_names,
            "materials": list(idx.materials),
        }

    def search(
        self,
        query: str,
        ifc_type: Optional[str] = None,
        storey: Optional[str] = None,
        limit: int = 100,
    ) -> list[LegacyElementSummary]:
        idx = self._require()
        q = (query or "").lower()
        wanted_type: Optional[str] = None
        if ifc_type:
            wanted_type = _normalize_ifc_type(ifc_type)
        out: list[LegacyElementSummary] = []
        for elem in idx.elements.values():
            if wanted_type and elem.type != wanted_type:
                continue
            if storey and (elem.storey_name or "").lower() != storey.lower():
                continue
            haystack_name = (elem.name or "").lower()
            haystack_type = elem.type.lower()
            haystack_gid = (elem.global_id or "").lower()
            if not q or q in haystack_name or q in haystack_type or q in haystack_gid:
                out.append(_to_legacy(elem))
                if len(out) >= limit:
                    break
        return out

    # ────────────────────────────────────────────────────────────────────
    # Property-set queries (fast path for Ask-mode tools)
    # ────────────────────────────────────────────────────────────────────

    def get_all_property_names(self) -> dict[str, list[str]]:
        """Return {pset_name: [property_names]} for the whole model.

        Replaces `ifc_service.get_all_property_names()` for models whose
        metadata index includes property-set data. Returns an empty dict
        for older cached indexes built before pset support.
        """
        idx = self._require()
        return dict(idx.all_pset_names)

    def get_element_psets(self, express_id: int) -> list:
        """Return a list of property-set dicts for one element.

        Each entry: {'name', 'description', 'properties': [{'name','value','value_type'}]}.
        Returns [] when the element has no indexed property sets.
        """
        idx = self._require()
        psets = idx.element_psets.get(express_id)
        if psets is None:
            psets = idx.element_psets.get(str(express_id))  # type: ignore[arg-type]
        if not psets:
            return []
        return [ps.model_dump() for ps in psets]

    def search_by_property(
        self,
        property_name: str,
        property_value: Optional[str] = None,
        pset_name: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict]:
        """Search elements by property name (and optionally value / pset name).

        Returns a list of {'element_id', 'global_id', 'type', 'name', 'storey',
        'pset_name', 'property_name', 'value'} dicts.
        """
        idx = self._require()
        if not idx.element_psets:
            return []  # V1 cache without pset data - caller falls back to IfcOpenShell

        pn_lower = property_name.lower().strip()
        pv_lower = (property_value or "").lower().strip()
        ps_lower = (pset_name or "").lower().strip()

        results: list[dict] = []
        for eid_key, psets in idx.element_psets.items():
            eid = int(eid_key)  # handle both int and str keys from JSON
            elem = idx.elements.get(eid) or idx.elements.get(str(eid))  # type: ignore[arg-type]
            for ps in psets:
                if ps_lower and (ps.name or "").lower() != ps_lower:
                    continue
                for prop in ps.properties:
                    if pn_lower not in (prop.name or "").lower():
                        continue
                    if pv_lower and pv_lower not in (prop.value or "").lower():
                        continue
                    results.append({
                        "element_id": eid,
                        "global_id": elem.global_id if elem else None,
                        "type": elem.type if elem else "UNKNOWN",
                        "name": elem.name if elem else None,
                        "storey": elem.storey_name if elem else None,
                        "pset_name": ps.name,
                        "property_name": prop.name,
                        "value": prop.value,
                    })
                    if len(results) >= limit:
                        return results
        return results

    def iter_all_elements(self) -> Iterable[IndexElementSummary]:
        idx = self._require()
        return idx.elements.values()


# Module-level singleton.
metadata_index_service = MetadataIndexService()


__all__ = ["metadata_index_service", "MetadataIndexService"]
