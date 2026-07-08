"""Per-storey element manifest + byte serialization for progressive streaming.

Two capabilities:
- element express-ID manifest per IfcBuildingStorey;
- actual sub-IFC byte blobs per storey via
  ifcopenshell.util.element.copy_deep so the frontend can load each storey
  as a separate FragmentsModel and achieve true <500 ms TTFR.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class StoreyInfo:
    """Metadata + element IDs for one IfcBuildingStorey."""

    idx: int
    name: str
    element_ids: list[int]
    element_count: int
    elevation: float = 0.0


@dataclass
class StoreyManifest:
    """Full per-storey decomposition for one IFC model."""

    source_sha256: str
    storeys: list[StoreyInfo] = field(default_factory=list)

    @property
    def total_elements(self) -> int:
        return sum(s.element_count for s in self.storeys)


class StoreyFragmentSplitter:
    """Partitions a loaded IFC model into per-storey element subsets.

    Provides the element-ID manifest (cached by SHA) and sub-IFC byte
    blobs via serialize_storey (cached by (sha, idx)).
    """

    def __init__(self) -> None:
        self._cache: dict[str, StoreyManifest] = {}
        # Cache for serialized sub-IFC bytes keyed by (sha, storey_idx).
        self._byte_cache: dict[tuple[str, int], bytes] = {}

    # ------------------------------------------------------------------
    # Public API - manifest
    # ------------------------------------------------------------------

    def get_manifest(self, model: object, sha: str) -> StoreyManifest:  # noqa: ANN001
        """Return (possibly cached) storey manifest for *model*.

        Parameters
        ----------
        model:
            An ``ifcopenshell.file`` object.  Typed as ``object`` so the
            module can be imported without ifcopenshell on test environments
            that mock the model.
        sha:
            SHA-256 fingerprint of the source IFC bytes - used as cache key.
        """
        if sha and sha in self._cache:
            logger.debug("storey manifest cache hit: %s", sha[:16])
            return self._cache[sha]

        manifest = self._build_manifest(model, sha)
        if sha:
            self._cache[sha] = manifest
        return manifest

    # ------------------------------------------------------------------
    # Public API - sub-IFC bytes
    # ------------------------------------------------------------------

    def serialize_storey(self, model: object, storey_idx: int, sha: str = "") -> bytes:
        """Extract one storey into a minimal valid IFC file and return bytes.

        Uses ``ifcopenshell.util.element.copy_deep`` to copy the full
        spatial hierarchy (IfcProject → IfcSite → IfcBuilding → storey) plus
        all contained elements.  Geometry, property sets, materials, and type
        objects are included automatically (copy_deep follows inverse attrs).

        Results are cached by (sha, storey_idx) to avoid re-extraction on
        repeated calls (e.g. endpoint + background pre-computation).

        Parameters
        ----------
        model : ifcopenshell.file
            The currently-loaded IFC model.
        storey_idx : int
            Zero-based index into the elevation-sorted storey list.
        sha : str
            SHA-256 fingerprint of the source IFC - used as cache key.
            Pass an empty string to skip caching (useful in tests).

        Raises
        ------
        IndexError
            When *storey_idx* is out of range.
        RuntimeError
            When ifcopenshell is not importable.
        """
        cache_key = (sha, storey_idx)
        if sha and cache_key in self._byte_cache:
            logger.debug("serialize_storey cache hit: sha=%s idx=%d", sha[:16], storey_idx)
            return self._byte_cache[cache_key]

        # Elevation-sorted storeys (same ordering as get_manifest)
        storeys_raw = model.by_type("IfcBuildingStorey")  # type: ignore[union-attr]
        sorted_storeys = sorted(storeys_raw, key=self._elevation)

        if storey_idx >= len(sorted_storeys):
            raise IndexError(
                f"storey index {storey_idx} out of range "
                f"- model has {len(sorted_storeys)} storeys"
            )

        target_storey = sorted_storeys[storey_idx]

        try:
            import ifcopenshell as _ifc  # type: ignore[import]
            import ifcopenshell.util.element as _util  # type: ignore[import]
        except ImportError as exc:
            raise RuntimeError("ifcopenshell is required for serialize_storey") from exc

        dest = _ifc.file(schema=getattr(model, "schema", "IFC4"))
        memo: dict = {}

        # Copy spatial context chain so the sub-IFC is a valid standalone file.
        for ifc_type in ("IfcProject", "IfcSite", "IfcBuilding"):
            try:
                entities = model.by_type(ifc_type)  # type: ignore[union-attr]
                if entities:
                    _util.copy_deep(dest, entities[0], memo)
            except Exception:  # noqa: BLE001
                pass

        # Copy storey header + all contained elements.
        _util.copy_deep(dest, target_storey, memo)
        try:
            for rel in target_storey.ContainsElements:  # type: ignore[union-attr]
                for el in rel.RelatedElements:
                    _util.copy_deep(dest, el, memo)
        except AttributeError:
            pass

        result = dest.to_string().encode("utf-8")
        if sha:
            self._byte_cache[cache_key] = result
        return result

    def clear_cache(self, sha: Optional[str] = None) -> None:
        """Evict manifest and byte-cache entries for *sha*, or all if None."""
        if sha is None:
            self._cache.clear()
            self._byte_cache.clear()
        else:
            self._cache.pop(sha, None)
            # Remove all (sha, idx) entries for this sha.
            for key in list(self._byte_cache):
                if key[0] == sha:
                    del self._byte_cache[key]

    def cache_size(self) -> int:
        return len(self._cache)

    def byte_cache_size(self) -> int:
        return len(self._byte_cache)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _elevation(s: object) -> float:
        try:
            v = getattr(s, "Elevation", None)
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    def _build_manifest(self, model: object, sha: str) -> StoreyManifest:
        storeys_raw = model.by_type("IfcBuildingStorey")  # type: ignore[union-attr]

        sorted_storeys = sorted(storeys_raw, key=self._elevation)

        storey_list: list[StoreyInfo] = []
        for idx, storey in enumerate(sorted_storeys):
            element_ids = self._collect_storey_element_ids(storey)
            elevation = self._elevation(storey)
            name = getattr(storey, "Name", None) or f"Storey {idx}"
            storey_list.append(
                StoreyInfo(
                    idx=idx,
                    name=name,
                    element_ids=sorted(element_ids),
                    element_count=len(element_ids),
                    elevation=elevation,
                )
            )
            logger.debug(
                "storey[%d] '%s' → %d elements", idx, name, len(element_ids)
            )

        return StoreyManifest(source_sha256=sha, storeys=storey_list)

    def _collect_storey_element_ids(self, storey: object) -> set[int]:
        """Return the set of express IDs for all elements in *storey*.

        Traverses ``ContainsElements`` (direct spatial containment) and
        recursively descends ``IsDecomposedBy`` (e.g. walls containing
        their constituent layers / sub-components).
        """
        ids: set[int] = set()
        try:
            for rel in storey.ContainsElements:  # type: ignore[union-attr]
                for el in rel.RelatedElements:
                    eid = el.id()
                    if eid not in ids:
                        ids.add(eid)
                        ids.update(self._collect_decomposed_ids(el))
        except AttributeError:
            pass
        return ids

    def _collect_decomposed_ids(self, element: object) -> set[int]:
        """Recursively collect express IDs of decomposed sub-elements."""
        ids: set[int] = set()
        try:
            for rel in element.IsDecomposedBy:  # type: ignore[union-attr]
                for child in rel.RelatedObjects:
                    eid = child.id()
                    if eid not in ids:
                        ids.add(eid)
                        ids.update(self._collect_decomposed_ids(child))
        except AttributeError:
            pass
        return ids


# Module-level singleton - imported by ifc_routes.
storey_splitter = StoreyFragmentSplitter()
