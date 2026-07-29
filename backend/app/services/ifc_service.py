"""Global singleton :class:`IfcService`.

Holds one loaded ``ifcopenshell.file`` in ``self._model`` and exposes model-query plus
inline-edit operations. NOT thread-safe: only :meth:`load` runs off the event loop (it
wholesale-replaces ``_model``); all reads/edits assume serialized access from the single
event loop.
"""

import copy
import hashlib
import logging
import shutil
import time
import uuid
from collections import OrderedDict, deque
from pathlib import Path
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.util.element as element_util

from app.models.contracts import ModelIdentityV1, build_model_identity
from app.models.ifc_models import (
    EditApplyRequest,
    EditApplyResponse,
    EditOperation,
    ElementDetail,
    ElementSummary,
    MetadataPatch,
    ModelStats,
    ProjectInfo,
    PropertySet,
    SearchResult,
    SpatialNode,
)

logger = logging.getLogger(__name__)


def _coerce_pset_value(v: Any) -> str | int | float | bool | None:
    # get_psets returns raw Python scalars for SingleValue, tuples for
    # EnumeratedValue/ListValue, and dicts for BoundedValue / nested
    # ComplexProperty. The frontend pset row renders primitive scalars,
    # so collapse the non-scalar variants to a human-readable string.
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)):
        return ", ".join("" if x is None else str(x) for x in v)
    if isinstance(v, dict):
        return ", ".join(f"{k}={vv}" for k, vv in v.items() if vv is not None)
    return str(v)


class IfcService:
    """Manages a loaded IFC model and provides query + edit operations."""

    def __init__(self):
        self._model: Optional[ifcopenshell.file] = None
        # _file_path is the WORKING file - edits get persisted here. Sandbox
        # swap, rollback, and the /file download all hit this path. The
        # pristine upload is kept untouched at _original_path so a future
        # "Save As" can ship the edits to a user-chosen location without
        # ever overwriting the source file the user gave us.
        self._file_path: Optional[Path] = None
        self._original_path: Optional[Path] = None
        # Snapshot of the upload's fingerprint at load time - used to decide
        # whether sandbox apply / rollback left the working file in a state
        # that still matches the original upload (e.g. a rollback to the
        # baseline checkpoint should reset dirty, not flag it).
        self._original_fingerprint: str = ""
        self._dirty: bool = False
        # Cache expensive traversals. Invalidated when model version changes.
        self._spatial_cache: Optional[SpatialNode] = None
        self._project_cache: Optional[ProjectInfo] = None
        self._stats_cache: Optional[ModelStats] = None
        self._owner_product_cache: dict[int, int | None] = {}

        self._model_version = 0
        self._model_fingerprint = ""
        self._last_edit_id: Optional[str] = None

        # Small in-memory LRU for warm reopen metadata.
        self._meta_cache_by_fingerprint: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._meta_cache_limit = 4

        # Inverse-delta undo stack - each entry records the ops needed to
        # reverse one committed edit.  Max 20 entries per Invariant 4.
        self._undo_stack: list[dict[str, Any]] = []
        self._undo_max = 20

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def model(self) -> ifcopenshell.file:
        if self._model is None:
            raise RuntimeError("No IFC model loaded")
        return self._model

    @property
    def model_version(self) -> int:
        return self._model_version

    @property
    def model_fingerprint(self) -> str:
        return self._model_fingerprint

    @property
    def last_edit_id(self) -> Optional[str]:
        return self._last_edit_id

    @property
    def original_path(self) -> Optional[Path]:
        return self._original_path

    @property
    def original_filename(self) -> Optional[str]:
        return self._original_path.name if self._original_path else None

    @property
    def original_fingerprint(self) -> str:
        """SHA of the upload at load time. Stable across edits (which
        re-fingerprint the working file), so it keys the per-model operation
        log (see :mod:`app.services.operation_service`)."""
        return self._original_fingerprint

    @property
    def dirty(self) -> bool:
        """True if any edit has been persisted to the working file since load."""
        return self._dirty

    def _recompute_dirty(self) -> None:
        """Dirty = working content diverges from the SAVE baseline (the
        original upload until the first Save, then whatever was last saved)."""
        baseline = getattr(self, "_saved_fingerprint", "") or self._original_fingerprint
        self._dirty = bool(baseline and self._model_fingerprint != baseline)

    def mark_clean(self) -> None:
        """Reset the dirty flag - called after Save As exports the edits.

        Also moves the dirty baseline to the current content so subsequent
        no-op persists don't immediately re-flag the model as dirty."""
        self._dirty = False
        if self._model_fingerprint:
            self._saved_fingerprint = self._model_fingerprint

    def save_to_original(self) -> Path:
        """Write the working copy back to the original upload path (A7 Save).

        Same serializer as Save As (ID contract preserved). Resets the dirty
        baseline WITHOUT touching original_fingerprint - the load-time
        identity that keys this model's operation log and checkpoint repo.
        """
        if self._original_path is None:
            raise RuntimeError("No original path to save to (model not loaded from a file)")
        self.save_as(self._original_path)
        self.mark_clean()
        return self._original_path

    def get_model_contract(self) -> dict[str, Any]:
        return {
            "model_version": self._model_version,
            "model_fingerprint": self._model_fingerprint,
            "edit_id": self._last_edit_id,
        }

    def get_model_identity(self) -> ModelIdentityV1:
        """Return the stable Atlas identity for the current model revision.

        During the migration the import digest defines the model lineage and
        the current working-file digest defines its immutable revision.
        """

        if not self._original_fingerprint or not self._model_fingerprint:
            raise RuntimeError("No IFC model loaded")
        project_global_id: str | None = None
        projects = self.model.by_type("IfcProject")
        if projects:
            value = getattr(projects[0], "GlobalId", None)
            if isinstance(value, str) and value.strip():
                project_global_id = value
        return build_model_identity(
            project_global_id=project_global_id,
            source_sha256=self._original_fingerprint,
            revision_sha256=self._model_fingerprint,
            model_version=self._model_version,
        )

    def read_bytes(self) -> Optional[bytes]:
        """Return the raw IFC bytes from the backing file, or None if unavailable."""
        if self._file_path is None or not self._file_path.exists():
            return None
        try:
            return self._file_path.read_bytes()
        except OSError:
            return None

    def load(self, path: Path) -> ProjectInfo:
        fingerprint = self._fingerprint_file(path)

        # Mirror the upload into a hidden working file so edits never touch
        # the original on disk. Sandbox swap, rollback, and /file all read
        # _file_path - pointing it at the working copy keeps every existing
        # subsystem honest while still preserving the pristine upload at
        # _original_path for the "Save As" / safety story.
        working_path = self._derive_working_path(path)
        try:
            working_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, working_path)
        except OSError as exc:
            logger.warning(
                "Failed to materialise working copy at %s (%s) - falling back "
                "to in-place edits against the upload.",
                working_path,
                exc,
            )
            working_path = path

        self._model = ifcopenshell.open(str(working_path))
        self._original_path = path
        self._original_fingerprint = fingerprint
        # Dirty baseline: separate from original_fingerprint because Save
        # updates it while the original fingerprint must stay the LOAD-TIME
        # identity (it keys the op log + checkpoint repo; re-keying on save
        # would divorce the model from its own history).
        self._saved_fingerprint = fingerprint
        self._file_path = working_path
        self._dirty = False
        self._model_fingerprint = fingerprint
        self._model_version += 1
        self._last_edit_id = None

        # Drop stale per-model caches and undo history on new load.
        self._spatial_cache = None
        self._project_cache = None
        self._stats_cache = None
        self._owner_product_cache = {}
        for stale in self._undo_stack:
            self._drop_undo_snapshots(stale)
        self._undo_stack = []

        # Any in-flight sandboxed edit proposals become invalid the
        # moment we load a different file - nuke them eagerly. Deferred
        # import avoids a circular-import ping-pong at module load.
        try:
            from app.services.sandbox_service import sandbox_service
            sandbox_service.clear_all()
        except ImportError:
            pass

        # Invalidate the semantic element index so it rebuilds on next query.
        try:
            from app.services.element_index_service import element_index
            element_index.invalidate()
        except ImportError:
            pass

        # The reusable property-filter index can be substantially larger than
        # the lightweight semantic index. Its revision guard prevents stale
        # query results, but eagerly dropping the previous snapshot here also
        # releases its interned property/value tables as soon as another IFC is
        # opened instead of retaining both models until the next filter query.
        try:
            from app.services.property_filter_index import property_filter_index
            property_filter_index.invalidate()
        except ImportError:
            pass

        # Rebuild the entity dependency graph for dirty-set computation.
        try:
            from app.services.entity_dependency_graph import rebuild_graph
            rebuild_graph(self._model)
        except Exception:
            pass

        # Warm path: hydrate metadata cache for repeated open of same model.
        cached_meta = self._meta_cache_by_fingerprint.get(fingerprint)
        if cached_meta:
            self._meta_cache_by_fingerprint.move_to_end(fingerprint)
            self._project_cache = copy.deepcopy(cached_meta.get("project"))
            self._spatial_cache = copy.deepcopy(cached_meta.get("tree"))
            self._stats_cache = copy.deepcopy(cached_meta.get("stats"))

        return self.get_project_info()

    def get_project_info(self) -> ProjectInfo:
        if self._project_cache:
            return self._project_cache

        m = self.model
        project = m.by_type("IfcProject")[0] if m.by_type("IfcProject") else None
        owner = m.by_type("IfcOwnerHistory")
        org = None
        author = None
        if owner:
            oh = owner[0]
            if oh.OwningUser:
                person = oh.OwningUser.ThePerson
                if person and person.FamilyName:
                    author = person.FamilyName
                org_obj = oh.OwningUser.TheOrganization
                if org_obj and org_obj.Name:
                    org = org_obj.Name

        info = ProjectInfo(
            name=project.Name if project and project.Name else "Unnamed Project",
            description=project.Description if project else None,
            schema_version=m.schema,
            author=author,
            organization=org,
        )
        self._project_cache = info
        self._cache_meta_snapshot()
        return info

    def get_spatial_tree(self) -> SpatialNode:
        if self._spatial_cache:
            return self._spatial_cache

        m = self.model
        projects = m.by_type("IfcProject")
        if not projects:
            raise ValueError("IFC file contains no IfcProject entity")
        project = projects[0]

        _STOREY_TYPES = ("IfcBuildingStorey", "IfcFacilityPart", "IfcSpatialZone")

        def build_node(entity, _parent_storey: Optional[str] = None) -> SpatialNode:
            children: list[SpatialNode] = []
            # Propagate the nearest ancestor storey name to contained elements.
            my_storey = (
                entity.Name if entity.is_a() in _STOREY_TYPES else _parent_storey
            )
            # Spatial children via IfcRelAggregates.
            for rel in getattr(entity, "IsDecomposedBy", []) or []:
                for child in rel.RelatedObjects:
                    children.append(build_node(child, my_storey))
            # Contained elements via IfcRelContainedInSpatialStructure.
            for rel in getattr(entity, "ContainsElements", []) or []:
                for elem in rel.RelatedElements:
                    children.append(
                        SpatialNode(
                            id=elem.id(),
                            global_id=elem.GlobalId,
                            name=elem.Name or f"Unnamed {elem.is_a()}",
                            ifc_type=elem.is_a(),
                            storey=my_storey,
                            children=[],
                        )
                    )
            return SpatialNode(
                id=entity.id(),
                global_id=entity.GlobalId,
                name=entity.Name or f"Unnamed {entity.is_a()}",
                ifc_type=entity.is_a(),
                storey=_parent_storey,
                children=children,
            )

        self._spatial_cache = build_node(project)
        self._cache_meta_snapshot()
        return self._spatial_cache

    def get_element(self, element_id: int) -> ElementDetail:
        entity = self._require_entity(element_id)

        if (
            not entity.is_a("IfcRoot")
            or entity.is_a("IfcPropertyDefinition")
            or entity.is_a("IfcRelationship")
            or entity.is_a("IfcTypeProduct")
            or entity.is_a("IfcOpeningElement")
        ):
            owner = self._resolve_owner_product(entity)
            if owner is not None:
                entity = owner

        # ElementDetail assumes GlobalId / Name / etc. which only IfcRoot
        # subclasses carry. Express IDs in an IFC file also point at type rows,
        # geometry
        # placements (IfcAxis2Placement3D), quantities (IfcQuantityArea), and
        # other schema-internal entities. Resolve those when possible; reject
        # unresolved internals with 404 instead of raising AttributeError.
        if not entity.is_a("IfcRoot"):
            raise ValueError(
                f"Element {element_id} is a {entity.is_a()} (not an IfcRoot subclass) "
                "and has no Name / GlobalId / properties to expose"
            )

        storey = self._get_storey(entity)
        material = self._get_material(entity)
        psets = self._get_property_sets(entity)
        quantities = self._get_quantities(entity)

        relating_type = None
        etype = element_util.get_type(entity)
        if etype:
            relating_type = f"{etype.is_a()}: {etype.Name or 'Unnamed'}"

        # Direct entity attributes - getattr because each one lives on a
        # different IFC class in the hierarchy and not every entity has all
        # four (e.g. IfcSite has no PredefinedType, IfcOpeningElement has
        # no Tag). NOTDEFINED / NOTKNOWN / USERDEFINED are dropped because
        # they're either noise (the default) or duplicated in ObjectType.
        predef_raw = getattr(entity, "PredefinedType", None)
        predef = str(predef_raw) if predef_raw is not None else None
        if predef in ("NOTDEFINED", "NOTKNOWN", "USERDEFINED"):
            predef = None

        return ElementDetail(
            id=entity.id(),
            global_id=entity.GlobalId,
            name=entity.Name,
            ifc_type=entity.is_a(),
            storey=storey,
            material=material,
            property_sets=psets,
            quantities=quantities,
            relating_type=relating_type,
            description=getattr(entity, "Description", None),
            object_type=getattr(entity, "ObjectType", None),
            tag=getattr(entity, "Tag", None),
            predefined_type=predef,
        )

    def get_all_elements(self) -> list[ElementSummary]:
        elements: list[ElementSummary] = []
        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            storey = self._get_storey(entity)
            elements.append(
                ElementSummary(
                    id=entity.id(),
                    global_id=entity.GlobalId,
                    name=entity.Name,
                    ifc_type=entity.is_a(),
                    storey=storey,
                )
            )
        return elements

    def get_model_stats(self) -> ModelStats:
        if self._stats_cache:
            return self._stats_cache

        m = self.model
        by_type: dict[str, int] = {}
        for entity in m.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            t = entity.is_a()
            by_type[t] = by_type.get(t, 0) + 1

        storeys = [s.Name or f"Storey #{s.id()}" for s in self._get_all_storeys()]
        materials = set()
        for entity in m.by_type("IfcMaterial"):
            if entity.Name:
                materials.add(entity.Name)

        stats = ModelStats(
            total_elements=sum(by_type.values()),
            by_type=by_type,
            storeys=storeys,
            materials=sorted(materials),
        )
        self._stats_cache = stats
        self._cache_meta_snapshot()
        return stats

    def search(
        self,
        query: str,
        ifc_type: Optional[str] = None,
        storey: Optional[str] = None,
        limit: int = 100,
    ) -> SearchResult:
        results: list[ElementSummary] = []
        q = query.lower()

        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            if ifc_type and not entity.is_a(ifc_type):
                continue

            entity_storey = self._get_storey(entity)
            if storey and entity_storey != storey:
                continue

            # Match by name, type, or GlobalId.
            name = entity.Name or ""
            if q in name.lower() or q in entity.is_a().lower() or q in entity.GlobalId.lower():
                results.append(
                    ElementSummary(
                        id=entity.id(),
                        global_id=entity.GlobalId,
                        name=entity.Name,
                        ifc_type=entity.is_a(),
                        storey=entity_storey,
                    )
                )
                if len(results) >= limit:
                    break

        return SearchResult(elements=results, total=len(results), query=query)

    def get_elements_by_type(self, ifc_type: str) -> list[ElementSummary]:
        elements: list[ElementSummary] = []
        for entity in self.model.by_type(ifc_type):
            storey = self._get_storey(entity)
            elements.append(
                ElementSummary(
                    id=entity.id(),
                    global_id=entity.GlobalId,
                    name=entity.Name,
                    ifc_type=entity.is_a(),
                    storey=storey,
                )
            )
        return elements

    def get_storeys(self) -> list[ElementSummary]:
        return [
            ElementSummary(
                id=s.id(),
                global_id=s.GlobalId,
                name=s.Name,
                ifc_type=s.is_a(),
            )
            for s in self._get_all_storeys()
        ]

    def get_elements_by_storey(self, storey_id: int) -> list[ElementSummary]:
        storey = self._require_entity(storey_id)

        elements: list[ElementSummary] = []
        for rel in getattr(storey, "ContainsElements", []) or []:
            for elem in rel.RelatedElements:
                if elem.is_a("IfcOpeningElement"):
                    continue
                elements.append(
                    ElementSummary(
                        id=elem.id(),
                        global_id=elem.GlobalId,
                        name=elem.Name,
                        ifc_type=elem.is_a(),
                        storey=storey.Name,
                    )
                )
        return elements

    def search_by_property(
        self,
        property_name: str,
        property_value: Optional[str] = None,
        pset_name: Optional[str] = None,
        limit: int = 50,
    ) -> list[dict]:
        """Search elements that have a specific property, optionally matching a value."""
        results: list[dict[str, Any]] = []
        pname_lower = property_name.lower()
        pval_lower = property_value.lower() if property_value else None

        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            definitions = getattr(entity, "IsDefinedBy", []) or []
            for rel in definitions:
                if not rel.is_a("IfcRelDefinesByProperties"):
                    continue
                pset = rel.RelatingPropertyDefinition
                if not pset.is_a("IfcPropertySet"):
                    continue
                if pset_name and (pset.Name or "").lower() != pset_name.lower():
                    continue
                for prop in pset.HasProperties:
                    if prop.is_a("IfcPropertySingleValue") and prop.Name.lower() == pname_lower:
                        val = prop.NominalValue
                        actual_value = val.wrappedValue if val else None
                        if pval_lower and str(actual_value).lower() != pval_lower:
                            continue
                        storey = self._get_storey(entity)
                        results.append(
                            {
                                "id": entity.id(),
                                "global_id": entity.GlobalId,
                                "name": entity.Name,
                                "ifc_type": entity.is_a(),
                                "storey": storey,
                                "property_set": pset.Name,
                                "property_name": prop.Name,
                                "property_value": str(actual_value) if actual_value is not None else None,
                            }
                        )
                        if len(results) >= limit:
                            return results
        return results

    def get_quantities_summary(
        self,
        group_by: str = "ifc_type",
        ifc_type: Optional[str] = None,
        storey: Optional[str] = None,
    ) -> dict:
        """Aggregate IfcElementQuantity values across the model."""
        if group_by not in ("ifc_type", "storey"):
            raise ValueError("group_by must be 'ifc_type' or 'storey'")

        quantity_kinds = {
            "IfcQuantityLength": ("LengthValue", "length"),
            "IfcQuantityArea": ("AreaValue", "area"),
            "IfcQuantityVolume": ("VolumeValue", "volume"),
            "IfcQuantityWeight": ("WeightValue", "weight"),
            "IfcQuantityCount": ("CountValue", "count"),
        }

        groups: dict[str, dict] = {}
        overall_totals: dict[str, float] = {}
        overall_units: dict[str, str] = {}
        ifc_type_lower = ifc_type.lower() if ifc_type else None
        storey_lower = storey.lower() if storey else None

        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            etype = entity.is_a()
            if ifc_type_lower and not entity.is_a(ifc_type) and etype.lower() != ifc_type_lower:
                continue
            entity_storey = self._get_storey(entity)
            if storey_lower and (entity_storey or "").lower() != storey_lower:
                continue

            key = etype if group_by == "ifc_type" else (entity_storey or "(no storey)")
            bucket = groups.setdefault(
                key,
                {
                    "key": key,
                    "count": 0,
                    "totals": {},
                    "units": {},
                },
            )
            bucket["count"] += 1

            for rel in getattr(entity, "IsDefinedBy", []) or []:
                if not rel.is_a("IfcRelDefinesByProperties"):
                    continue
                qset = rel.RelatingPropertyDefinition
                if not qset.is_a("IfcElementQuantity"):
                    continue
                for q in qset.Quantities:
                    qtype = q.is_a()
                    if qtype not in quantity_kinds:
                        continue
                    attr, unit_kind = quantity_kinds[qtype]
                    try:
                        val = float(getattr(q, attr))
                    except (TypeError, ValueError):
                        continue
                    qname = q.Name
                    bucket["totals"][qname] = round(bucket["totals"].get(qname, 0.0) + val, 4)
                    bucket["units"].setdefault(qname, unit_kind)
                    overall_totals[qname] = round(overall_totals.get(qname, 0.0) + val, 4)
                    overall_units.setdefault(qname, unit_kind)

        sorted_groups = sorted(groups.values(), key=lambda g: g["count"], reverse=True)
        return {
            "group_by": group_by,
            "filter": {"ifc_type": ifc_type, "storey": storey},
            "groups": sorted_groups,
            "overall": {
                "totals": overall_totals,
                "units": overall_units,
                "element_count": sum(g["count"] for g in sorted_groups),
            },
        }

    def get_all_property_names(self) -> dict[str, list[str]]:
        """Get all property set names and their property names from the model."""
        pset_props: dict[str, set[str]] = {}
        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            definitions = getattr(entity, "IsDefinedBy", []) or []
            for rel in definitions:
                if not rel.is_a("IfcRelDefinesByProperties"):
                    continue
                pset = rel.RelatingPropertyDefinition
                if not pset.is_a("IfcPropertySet"):
                    continue
                pset_name = pset.Name or "Unnamed"
                if pset_name not in pset_props:
                    pset_props[pset_name] = set()
                for prop in pset.HasProperties:
                    if prop.is_a("IfcPropertySingleValue"):
                        pset_props[pset_name].add(prop.Name)
        return {k: sorted(v) for k, v in sorted(pset_props.items())}

    # ------------------------------------------------------------------
    # Spatial relationship query tools (read-only, Tier 1)
    # ------------------------------------------------------------------

    def get_connected_elements(self, element_id: int) -> dict[str, Any]:
        """Return wall/slab neighbours via IfcRelConnectsPathElements."""
        self._require_entity(element_id)  # raises if the element id is unknown
        connected: list[dict] = []
        # ConnectsPathElements - the entity is RelatingElement or RelatedElement
        for rel in self.model.by_type("IfcRelConnectsPathElements"):
            other = None
            point = None
            if rel.RelatingElement and rel.RelatingElement.id() == element_id:
                other = rel.RelatedElement
                point = getattr(rel, "RelatingConnectionType", None)
            elif rel.RelatedElement and rel.RelatedElement.id() == element_id:
                other = rel.RelatingElement
                point = getattr(rel, "RelatedConnectionType", None)
            if other is None:
                continue
            connected.append({
                "id": other.id(),
                "name": getattr(other, "Name", None) or f"#{other.id()}",
                "ifc_type": other.is_a(),
                "connection_type": str(point) if point else None,
            })
        return {
            "element_id": element_id,
            "count": len(connected),
            "connected_elements": connected,
        }

    def get_element_material(self, element_id: int) -> dict[str, Any]:
        """Return material layer set information for an element."""
        entity = self._require_entity(element_id)
        mat = element_util.get_material(entity)
        if mat is None:
            return {"element_id": element_id, "material_type": "none", "layers": []}

        if mat.is_a("IfcMaterialLayerSetUsage"):
            layer_set = mat.ForLayerSet
            layers = []
            for layer in layer_set.MaterialLayers:
                mat_name = None
                if layer.Material:
                    mat_name = getattr(layer.Material, "Name", None)
                layers.append({
                    "name": mat_name or "Unnamed",
                    "thickness_mm": float(getattr(layer, "LayerThickness", 0)),
                })
            return {
                "element_id": element_id,
                "material_type": "layer_set",
                "layer_set_name": getattr(layer_set, "LayerSetName", None),
                "layers": layers,
                "total_thickness_mm": sum(l["thickness_mm"] for l in layers),
            }
        if mat.is_a("IfcMaterial"):
            return {
                "element_id": element_id,
                "material_type": "single",
                "name": getattr(mat, "Name", None) or "Unnamed",
                "layers": [],
            }
        if mat.is_a("IfcMaterialList"):
            names = [getattr(m, "Name", None) or "Unnamed" for m in (mat.Materials or [])]
            return {
                "element_id": element_id,
                "material_type": "list",
                "materials": names,
                "layers": [],
            }
        return {"element_id": element_id, "material_type": mat.is_a(), "layers": []}

    def get_openings_for_element(self, element_id: int) -> dict[str, Any]:
        """Return doors/windows that are hosted by an element via IfcRelVoidsElement."""
        self._require_entity(element_id)
        openings: list[dict] = []
        for void_rel in self.model.by_type("IfcRelVoidsElement"):
            if not void_rel.RelatingBuildingElement:
                continue
            if void_rel.RelatingBuildingElement.id() != element_id:
                continue
            opening_elem = void_rel.RelatedOpeningElement
            if opening_elem is None:
                continue
            # Doors/windows fill the opening
            fillers: list[dict] = []
            for fill_rel in getattr(opening_elem, "HasFillings", []) or []:
                filler = fill_rel.RelatedBuildingElement
                if filler:
                    fillers.append({
                        "id": filler.id(),
                        "name": getattr(filler, "Name", None) or f"#{filler.id()}",
                        "ifc_type": filler.is_a(),
                    })
            if fillers:
                openings.extend(fillers)
            else:
                openings.append({
                    "id": opening_elem.id(),
                    "name": getattr(opening_elem, "Name", None) or f"#{opening_elem.id()}",
                    "ifc_type": opening_elem.is_a(),
                })
        return {
            "element_id": element_id,
            "count": len(openings),
            "openings": openings,
        }

    def find_elements_by_type_name(
        self, substring: str, limit: int = 50
    ) -> dict[str, Any]:
        """Search elements by their IfcTypeObject name (partial, case-insensitive)."""
        lower = substring.lower()
        matches: list[dict] = []
        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            type_obj = element_util.get_type(entity)
            if type_obj is None:
                continue
            type_name = getattr(type_obj, "Name", None) or ""
            if lower not in type_name.lower():
                continue
            matches.append({
                "id": entity.id(),
                "name": getattr(entity, "Name", None) or f"#{entity.id()}",
                "ifc_type": entity.is_a(),
                "type_name": type_name,
                "storey": self._get_storey(entity),
            })
            if len(matches) >= limit:
                break
        return {
            "query": substring,
            "count": len(matches),
            "elements": matches,
        }

    # ------------------------------------------------------------------
    # Spatial query tools
    # ------------------------------------------------------------------

    def _get_element_origin(self, entity: Any) -> Optional[tuple[float, float, float]]:
        """Extract (x, y, z) origin from IfcLocalPlacement without full geometry processing.

        Returns None when no placement is available. This is a fast, geometry-free
        approach: it reads the placement matrix origin (world or relative), which gives
        an approximate element location suitable for proximity queries.
        """
        placement = getattr(entity, "ObjectPlacement", None)
        if placement is None or not placement.is_a("IfcLocalPlacement"):
            return None
        rel = getattr(placement, "RelativePlacement", None)
        if rel is None:
            return None
        loc = getattr(rel, "Location", None)
        if loc is None:
            return None
        coords = getattr(loc, "Coordinates", None)
        if not coords:
            return None
        x = float(coords[0]) if len(coords) > 0 else 0.0
        y = float(coords[1]) if len(coords) > 1 else 0.0
        z = float(coords[2]) if len(coords) > 2 else 0.0
        return (x, y, z)

    def find_nearby_elements(
        self,
        element_id: int,
        radius_m: float = 5.0,
        ifc_types: Optional[list[str]] = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Find IFC elements whose placement origin is within *radius_m* metres of the given element.

        Uses IfcLocalPlacement coordinates (no full geometry processing). Distances are
        Euclidean 3-D between placement origins. Elements without a placement are skipped.
        """
        if radius_m <= 0:
            raise ValueError("radius_m must be positive")
        ref = self._require_entity(element_id)
        ref_origin = self._get_element_origin(ref)
        if ref_origin is None:
            return {
                "element_id": element_id,
                "radius_m": radius_m,
                "count": 0,
                "elements": [],
                "note": "Reference element has no local placement - distance query unavailable.",
            }

        rx, ry, rz = ref_origin
        ifc_types_lower = [t.lower() for t in ifc_types] if ifc_types else None

        results: list[dict] = []
        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            if entity.id() == element_id:
                continue
            if ifc_types_lower and entity.is_a().lower() not in ifc_types_lower:
                continue
            origin = self._get_element_origin(entity)
            if origin is None:
                continue
            dx, dy, dz = origin[0] - rx, origin[1] - ry, origin[2] - rz
            dist = (dx * dx + dy * dy + dz * dz) ** 0.5
            if dist > radius_m:
                continue
            results.append({
                "id": entity.id(),
                "name": getattr(entity, "Name", None) or f"#{entity.id()}",
                "ifc_type": entity.is_a(),
                "storey": self._get_storey(entity),
                "distance_m": round(dist, 3),
            })
            if len(results) >= limit:
                break

        results.sort(key=lambda r: r["distance_m"])
        return {
            "element_id": element_id,
            "radius_m": radius_m,
            "count": len(results),
            "elements": results,
        }

    def filter_by_property_value(
        self,
        property_name: str,
        operator: str,
        value: str,
        ifc_type: Optional[str] = None,
        storey: Optional[str] = None,
        pset_name: Optional[str] = None,
        limit: int = 100,
    ) -> dict[str, Any]:
        """Filter elements where a property matches a condition.

        Supported operators: eq, neq, contains, startswith, gt, lt, gte, lte.
        Numeric operators (gt/lt/gte/lte) coerce both the actual value and *value* to float.
        """
        VALID_OPS = {"eq", "neq", "contains", "startswith", "gt", "lt", "gte", "lte"}
        if operator not in VALID_OPS:
            raise ValueError(f"operator must be one of {sorted(VALID_OPS)}, got {operator!r}")

        pname_lower = property_name.lower()
        pset_lower = pset_name.lower() if pset_name else None
        ifc_type_lower = ifc_type.lower() if ifc_type else None
        storey_lower = storey.lower() if storey else None
        is_numeric_op = operator in {"gt", "lt", "gte", "lte"}

        try:
            numeric_target = float(value) if is_numeric_op else None
        except (ValueError, TypeError):
            raise ValueError(f"operator {operator!r} requires a numeric value, got {value!r}")

        matches: list[dict] = []

        for entity in self.model.by_type("IfcProduct"):
            if entity.is_a("IfcOpeningElement"):
                continue
            if ifc_type_lower and entity.is_a().lower() != ifc_type_lower:
                continue
            entity_storey = self._get_storey(entity)
            if storey_lower and (entity_storey or "").lower() != storey_lower:
                continue
            definitions = getattr(entity, "IsDefinedBy", []) or []
            for rel in definitions:
                if not rel.is_a("IfcRelDefinesByProperties"):
                    continue
                pset = rel.RelatingPropertyDefinition
                if not pset.is_a("IfcPropertySet"):
                    continue
                if pset_lower and (pset.Name or "").lower() != pset_lower:
                    continue
                for prop in pset.HasProperties:
                    if not prop.is_a("IfcPropertySingleValue"):
                        continue
                    if prop.Name.lower() != pname_lower:
                        continue
                    raw = prop.NominalValue
                    actual = raw.wrappedValue if raw else None
                    actual_str = str(actual) if actual is not None else ""

                    matched = False
                    if operator == "eq":
                        matched = actual_str.lower() == value.lower()
                    elif operator == "neq":
                        matched = actual_str.lower() != value.lower()
                    elif operator == "contains":
                        matched = value.lower() in actual_str.lower()
                    elif operator == "startswith":
                        matched = actual_str.lower().startswith(value.lower())
                    elif is_numeric_op:
                        try:
                            actual_num = float(actual_str)
                        except (ValueError, TypeError):
                            continue
                        if operator == "gt":
                            matched = actual_num > numeric_target  # type: ignore[operator]
                        elif operator == "lt":
                            matched = actual_num < numeric_target  # type: ignore[operator]
                        elif operator == "gte":
                            matched = actual_num >= numeric_target  # type: ignore[operator]
                        elif operator == "lte":
                            matched = actual_num <= numeric_target  # type: ignore[operator]

                    if matched:
                        matches.append({
                            "id": entity.id(),
                            "name": getattr(entity, "Name", None) or f"#{entity.id()}",
                            "ifc_type": entity.is_a(),
                            "storey": entity_storey,
                            "pset": pset.Name,
                            "property": prop.Name,
                            "value": actual_str,
                        })
                        if len(matches) >= limit:
                            return {
                                "property_name": property_name,
                                "operator": operator,
                                "value": value,
                                "count": len(matches),
                                "truncated": True,
                                "elements": matches,
                                "element_ids": [m["id"] for m in matches],
                            }
                        break  # found matching prop in this pset, move to next pset

        return {
            "property_name": property_name,
            "operator": operator,
            "value": value,
            "count": len(matches),
            "truncated": False,
            "elements": matches,
            "element_ids": [m["id"] for m in matches],
        }

    def resolve_storey_name(self, entity: Any) -> Optional[str]:
        """Public read-only storey lookup for revision-scoped query indexes."""

        return self._get_storey(entity)

    # ------------------------------------------------------------------
    # Structured write tools (rename, property edit, undo)
    # ------------------------------------------------------------------

    def _require_entity(self, element_id: int) -> Any:
        """Return the IfcOpenShell entity or raise ValueError.

        ifcopenshell.by_id() raises RuntimeError (not None) for missing IDs,
        so we normalise both failure modes into a clean ValueError.
        """
        try:
            entity = self.model.by_id(element_id)
        except RuntimeError:
            entity = None
        if entity is None:
            raise ValueError(f"Element {element_id} not found")
        return entity

    def _resolve_owner_product(self, entity) -> Any | None:
        """Resolve an IFC internal row to the nearest owning IfcProduct."""
        try:
            start_id = entity.id()
        except Exception:
            return None

        if start_id in self._owner_product_cache:
            owner_id = self._owner_product_cache[start_id]
            if owner_id is None:
                return None
            try:
                return self.model.by_id(owner_id)
            except RuntimeError:
                return None

        queue = deque([(entity, 0)])
        visited: set[int] = set()
        max_depth = 8
        max_seen = 512

        while queue and len(visited) < max_seen:
            current, depth = queue.popleft()
            try:
                current_id = current.id()
            except Exception:
                continue
            if current_id in visited:
                continue
            visited.add(current_id)

            if current.is_a("IfcProduct") and not current.is_a("IfcOpeningElement"):
                self._owner_product_cache[start_id] = current_id
                return current

            if depth >= max_depth:
                continue

            neighbours: list[Any] = []
            try:
                neighbours.extend(self.model.get_inverse(current))
            except Exception:
                pass
            neighbours.extend(self._iter_entity_references(current))

            for neighbour in neighbours:
                try:
                    neighbour_id = neighbour.id()
                except Exception:
                    continue
                if neighbour_id not in visited:
                    queue.append((neighbour, depth + 1))

        self._owner_product_cache[start_id] = None
        return None

    def _iter_entity_references(self, value: Any) -> list[Any]:
        refs: list[Any] = []

        def walk(v: Any) -> None:
            if hasattr(v, "is_a") and callable(v.is_a):
                refs.append(v)
                return
            if isinstance(v, (list, tuple, set)):
                for item in v:
                    walk(item)

        try:
            for i in range(len(value)):
                walk(value[i])
        except Exception:
            return refs
        return refs

    def rename_element(self, element_id: int, new_name: str) -> dict[str, Any]:
        """Rename an IFC element.  Pushes an inverse op onto the undo stack."""
        entity = self._require_entity(element_id)
        if not hasattr(entity, "Name"):
            raise ValueError(f"Element {element_id} ({entity.is_a()}) has no Name attribute")

        old_name = getattr(entity, "Name", None) or ""
        new_name = new_name.strip()
        if not new_name:
            raise ValueError("new_name must be a non-empty string")
        if old_name == new_name:
            return {"changed": False, "reason": "Name is already that value", "element_id": element_id}

        entity.Name = new_name
        self._patch_cached_tree_name(element_id, new_name, entity.is_a())
        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None

        description = f"Renamed '{old_name}' → '{new_name}' (#{element_id} {entity.is_a()})"
        self._push_undo(edit_id, description, [
            {"op": "set_name", "express_id": element_id, "value": old_name},
        ])
        self._cache_meta_snapshot()
        return {
            "changed": True,
            "element_id": element_id,
            "ifc_type": entity.is_a(),
            "old_name": old_name,
            "new_name": new_name,
            "edit_id": edit_id,
            "description": description,
            "action": "metadata_changed",
            "changed_ids": [element_id],
        }

    def update_text_attribute(
        self,
        element_id: int,
        attribute: str,
        new_value: Optional[str],
    ) -> dict[str, Any]:
        """Update a safe, non-relational IFC text attribute.

        Relationship and enum fields are intentionally excluded: assigning
        those as strings can invalidate an IFC graph. Spatial/type changes go
        through their dedicated operations instead.
        """
        allowed = {"Description", "ObjectType", "Tag", "LongName"}
        if attribute not in allowed:
            raise ValueError(
                f"attribute must be one of {', '.join(sorted(allowed))}"
            )
        entity = self._require_entity(element_id)
        if not hasattr(entity, attribute):
            raise ValueError(
                f"Element {element_id} ({entity.is_a()}) has no {attribute} attribute"
            )

        old_value = getattr(entity, attribute, None)
        value = None if new_value is None or not str(new_value).strip() else str(new_value).strip()
        if old_value == value:
            return {
                "changed": False,
                "reason": f"{attribute} is already that value",
                "element_id": element_id,
            }

        setattr(entity, attribute, value)
        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None

        description = (
            f"Set {attribute} on #{element_id} ({entity.is_a()}) "
            f"from {old_value!r} to {value!r}"
        )
        self._push_undo(edit_id, description, [{
            "op": "set_attribute",
            "express_id": element_id,
            "attribute": attribute,
            "value": old_value,
        }])
        self._cache_meta_snapshot()
        return {
            "changed": True,
            "element_id": element_id,
            "ifc_type": entity.is_a(),
            "attribute": attribute,
            "old_value": old_value,
            "new_value": value,
            "edit_id": edit_id,
            "description": description,
            "action": "metadata_changed",
            "changed_ids": [element_id],
        }

    def update_property_value(
        self,
        element_id: int,
        property_name: str,
        new_value: Any,
        pset_name: Optional[str] = None,
    ) -> dict[str, Any]:
        """Update a single IfcPropertySingleValue on an element.
        Pushes an inverse op onto the undo stack on success.
        """
        entity = self._require_entity(element_id)

        op = EditOperation(
            op="set_property",
            express_id=element_id,
            property_set=pset_name,
            property_name=property_name,
            value=new_value,
        )

        # Read old value before mutating.
        old_value, found_pset = self._read_property_value(entity, property_name, pset_name)
        if old_value is None and found_pset is None:
            raise ValueError(
                f"Property '{property_name}'"
                + (f" in '{pset_name}'" if pset_name else "")
                + f" not found on element {element_id}"
            )

        ok, msg = self._apply_property_edit(entity, op)
        if not ok:
            raise ValueError(msg or "Property update failed")

        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None

        description = (
            f"Set {found_pset}.{property_name} = {new_value!r} "
            f"(was {old_value!r}) on #{element_id}"
        )
        self._push_undo(edit_id, description, [
            {
                "op": "set_property",
                "express_id": element_id,
                "property_set": found_pset,
                "property_name": property_name,
                "value": old_value,
            },
        ])
        self._cache_meta_snapshot()
        return {
            "changed": True,
            "element_id": element_id,
            "property_set": found_pset,
            "property_name": property_name,
            "old_value": old_value,
            "new_value": new_value,
            "edit_id": edit_id,
            "description": description,
            "action": "metadata_changed",
            "changed_ids": [element_id],
        }

    def rename_elements_batch(
        self,
        renames: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Rename multiple IFC elements atomically with a single undo entry.

        Each item in *renames* must have ``element_id`` (int) and
        ``new_name`` (str).  Items that are no-ops (name unchanged) are counted
        as skipped but never raise.  Items where the entity doesn't exist or
        lacks a Name attribute are recorded as failures and skipped.

        A single undo entry groups all successful renames so one
        ``undo_last_edit`` call reverses the whole batch.
        """
        if not renames:
            return {"changed_count": 0, "skipped_count": 0, "failed_count": 0, "results": []}

        results: list[dict[str, Any]] = []
        inverse_ops: list[dict] = []
        changed_ids: list[int] = []
        changed_count = 0
        skipped_count = 0
        failed_count = 0

        for item in renames:
            eid = int(item["element_id"])
            new_name = str(item["new_name"]).strip()
            try:
                entity = self._require_entity(eid)
                if not hasattr(entity, "Name"):
                    raise ValueError(f"Element {eid} ({entity.is_a()}) has no Name attribute")
                if not new_name:
                    raise ValueError("new_name must be non-empty")

                old_name = getattr(entity, "Name", None) or ""
                if old_name == new_name:
                    skipped_count += 1
                    results.append({"element_id": eid, "status": "skipped", "reason": "already that name"})
                    continue

                entity.Name = new_name
                self._patch_cached_tree_name(eid, new_name, entity.is_a())
                inverse_ops.append({"op": "set_name", "express_id": eid, "value": old_name})
                changed_ids.append(eid)
                changed_count += 1
                results.append({"element_id": eid, "status": "changed", "old_name": old_name, "new_name": new_name})
            except Exception as exc:
                failed_count += 1
                results.append({"element_id": eid, "status": "failed", "error": str(exc)})

        if not inverse_ops:
            return {
                "changed_count": 0,
                "skipped_count": skipped_count,
                "failed_count": failed_count,
                "results": results,
                "action": "metadata_changed",
                "changed_ids": [],
            }

        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None

        description = f"Batch rename: {changed_count} element(s)"
        self._push_undo(edit_id, description, inverse_ops)
        self._cache_meta_snapshot()
        return {
            "changed_count": changed_count,
            "skipped_count": skipped_count,
            "failed_count": failed_count,
            "results": results,
            "edit_id": edit_id,
            "description": description,
            "action": "metadata_changed",
            "changed_ids": changed_ids,
        }

    def update_properties_batch(
        self,
        updates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Update property values on multiple elements atomically with a
        single undo entry.

        Each item must have ``element_id`` (int), ``property_name`` (str),
        ``new_value``, and optionally ``pset_name`` (str).  Items where the
        property is not found or the update fails are recorded as failures and
        skipped - the remaining items still apply.

        A single undo entry groups all successful updates so one
        ``undo_last_edit`` call reverses the whole batch.
        """
        if not updates:
            return {"changed_count": 0, "skipped_count": 0, "failed_count": 0, "results": []}

        results: list[dict[str, Any]] = []
        inverse_ops: list[dict] = []
        changed_ids: list[int] = []
        changed_count = 0
        skipped_count = 0
        failed_count = 0

        for item in updates:
            eid = int(item["element_id"])
            prop_name = str(item["property_name"])
            new_value = item["new_value"]
            pset_name = item.get("pset_name")
            try:
                entity = self._require_entity(eid)

                old_value, found_pset = self._read_property_value(entity, prop_name, pset_name)
                if old_value is None and found_pset is None:
                    raise ValueError(
                        f"Property '{prop_name}'"
                        + (f" in '{pset_name}'" if pset_name else "")
                        + f" not found on element {eid}"
                    )

                if old_value == new_value:
                    skipped_count += 1
                    results.append({"element_id": eid, "property_name": prop_name, "status": "skipped", "reason": "already that value"})
                    continue

                op = EditOperation(
                    op="set_property",
                    express_id=eid,
                    property_set=found_pset,
                    property_name=prop_name,
                    value=new_value,
                )
                ok, msg = self._apply_property_edit(entity, op)
                if not ok:
                    raise ValueError(msg or "Property update failed")

                inverse_ops.append({
                    "op": "set_property",
                    "express_id": eid,
                    "property_set": found_pset,
                    "property_name": prop_name,
                    "value": old_value,
                })
                changed_ids.append(eid)
                changed_count += 1
                results.append({
                    "element_id": eid,
                    "property_set": found_pset,
                    "property_name": prop_name,
                    "status": "changed",
                    "old_value": old_value,
                    "new_value": new_value,
                })
            except Exception as exc:
                failed_count += 1
                results.append({"element_id": eid, "property_name": prop_name, "status": "failed", "error": str(exc)})

        if not inverse_ops:
            return {
                "changed_count": 0,
                "skipped_count": skipped_count,
                "failed_count": failed_count,
                "results": results,
                "action": "metadata_changed",
                "changed_ids": [],
            }

        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None

        description = f"Batch property update: {changed_count} element(s)"
        self._push_undo(edit_id, description, inverse_ops)
        self._cache_meta_snapshot()
        return {
            "changed_count": changed_count,
            "skipped_count": skipped_count,
            "failed_count": failed_count,
            "results": results,
            "edit_id": edit_id,
            "description": description,
            "action": "metadata_changed",
            "changed_ids": changed_ids,
        }

    # ------------------------------------------------------------------
    # Structural write methods (plan A2): creation / deletion / spatial ops.
    # Same bookkeeping contract as the metadata writers above. Geometry- or
    # tree-affecting results return action="model_refresh" (PatchTier.BULK →
    # rebuild_started → viewers reload; correct-first per the master plan,
    # incremental frag deltas come with A5). All authoring goes through the
    # shared element_factory recipes - the exact code path AI sandbox edits
    # use - so every surface produces identical IFC.
    # ------------------------------------------------------------------

    def create_wall(
        self,
        *,
        start: list[float],
        end: list[float],
        height: Optional[float] = None,
        thickness: Optional[float] = None,
        storey_name: Optional[str] = None,
        name: str = "Wall",
    ) -> dict[str, Any]:
        """Create a wall between two XY points (metres). Undoable (removes
        the created product)."""
        from app.services import element_factory

        wall = element_factory.create_wall(
            self.model,
            start=start,
            end=end,
            height=height if height is not None else element_factory.DEFAULT_WALL_HEIGHT_M,
            thickness=thickness if thickness is not None else element_factory.DEFAULT_WALL_THICKNESS_M,
            storey_name=storey_name,
            name=name or "Wall",
        )
        wall_id = wall.id()
        return self._commit_structural_edit(
            description=f"Created wall '{wall.Name}' (#{wall_id})",
            changed_ids=[wall_id],
            inverse_ops=[{"op": "remove_products", "express_ids": [wall_id]}],
            extra={"element_id": wall_id, "ifc_type": wall.is_a(), "name": wall.Name},
        )

    def create_slab(
        self,
        *,
        outline: list[list[float]],
        depth: Optional[float] = None,
        storey_name: Optional[str] = None,
        name: str = "Slab",
    ) -> dict[str, Any]:
        """Create a slab from a closed XY polygon (metres). Undoable."""
        from app.services import element_factory

        slab = element_factory.create_slab(
            self.model,
            outline=outline,
            depth=depth if depth is not None else element_factory.DEFAULT_SLAB_DEPTH_M,
            storey_name=storey_name,
            name=name or "Slab",
        )
        slab_id = slab.id()
        return self._commit_structural_edit(
            description=f"Created slab '{slab.Name}' (#{slab_id})",
            changed_ids=[slab_id],
            inverse_ops=[{"op": "remove_products", "express_ids": [slab_id]}],
            extra={"element_id": slab_id, "ifc_type": slab.is_a(), "name": slab.Name},
        )

    def create_storey(self, *, name: str, elevation: float = 0.0) -> dict[str, Any]:
        """Create a building storey at *elevation* (metres). Undoable."""
        from app.services import element_factory

        storey = element_factory.create_storey(self.model, name=name, elevation=elevation)
        storey_id = storey.id()
        return self._commit_structural_edit(
            description=f"Created storey '{storey.Name}' at {float(elevation):.2f} m (#{storey_id})",
            changed_ids=[storey_id],
            inverse_ops=[{"op": "remove_products", "express_ids": [storey_id]}],
            extra={"element_id": storey_id, "ifc_type": storey.is_a(), "name": storey.Name},
        )

    def assign_to_storey(self, element_id: int, storey_id: int) -> dict[str, Any]:
        """Move an element to another storey. Undoable (restores the previous
        container when there was one)."""
        from app.services import element_factory

        entity = self._require_entity(int(element_id))
        storey = self._require_entity(int(storey_id))
        old_container = element_factory.get_container_id(entity)
        if old_container == int(storey_id):
            return {
                "changed": False,
                "reason": "Element is already contained in that storey",
                "element_id": int(element_id),
            }
        element_factory.assign_to_storey(self.model, entity, storey)
        inverse: list[dict[str, Any]] = []
        if old_container is not None:
            inverse.append({
                "op": "assign_container",
                "express_id": int(element_id),
                "container_id": old_container,
            })
        storey_label = getattr(storey, "Name", None) or f"#{storey_id}"
        return self._commit_structural_edit(
            description=(
                f"Moved #{element_id} ({entity.is_a()}) to storey '{storey_label}'"
            ),
            changed_ids=[int(element_id)],
            inverse_ops=inverse,
            extra={"element_id": int(element_id), "storey_id": int(storey_id)},
        )

    def set_storey_elevation(self, storey_id: int, elevation: float) -> dict[str, Any]:
        """Set a storey's Elevation attribute (metres). Undoable."""
        entity = self._require_entity(int(storey_id))
        if not entity.is_a("IfcBuildingStorey"):
            raise ValueError(
                f"Element {storey_id} is {entity.is_a()}, not an IfcBuildingStorey"
            )
        try:
            old = float(entity.Elevation) if entity.Elevation is not None else None
        except (TypeError, ValueError):
            old = None
        new = float(elevation)
        if old is not None and abs(old - new) < 1e-9:
            return {
                "changed": False,
                "reason": "Elevation is already that value",
                "element_id": int(storey_id),
            }
        entity.Elevation = new
        return self._commit_structural_edit(
            description=f"Set storey '{entity.Name or storey_id}' elevation to {new:.2f} m",
            changed_ids=[int(storey_id)],
            inverse_ops=[{"op": "set_elevation", "express_id": int(storey_id), "value": old}],
            extra={"element_id": int(storey_id), "old_elevation": old, "new_elevation": new},
            action="metadata_changed",
        )

    def delete_element(self, element_id: int) -> dict[str, Any]:
        """Delete an IfcProduct. Undoable via a pre-delete working-file
        snapshot (a deletion's op-by-op inverse is not expressible; restoring
        the exact prior bytes also preserves every express id)."""
        from app.services import element_factory

        entity = self._require_entity(int(element_id))
        entity_name = getattr(entity, "Name", None) or f"#{element_id}"
        ifc_type = entity.is_a()

        snapshot = self._snapshot_for_undo()
        element_factory.delete_product(self.model, entity)
        inverse: list[dict[str, Any]] = []
        if snapshot is not None:
            inverse.append({"op": "restore_file", "snapshot_path": str(snapshot)})
        return self._commit_structural_edit(
            description=f"Deleted {ifc_type} '{entity_name}' (#{element_id})",
            changed_ids=[int(element_id)],
            inverse_ops=inverse,
            extra={"deleted_id": int(element_id), "ifc_type": ifc_type},
        )

    def _snapshot_for_undo(self) -> Optional[Path]:
        """Copy the (persisted, pre-mutation) working file for snapshot undo.

        Every write method persists before returning, so the on-disk working
        file always equals the in-memory model at the START of the next edit.
        Returns None when there is no backing file (undo simply unavailable).
        """
        if self._file_path is None or not self._file_path.exists():
            return None
        try:
            snap_dir = self._file_path.parent / ".undo_snapshots"
            snap_dir.mkdir(parents=True, exist_ok=True)
            snap = snap_dir / f"{uuid.uuid4().hex}.ifc"
            shutil.copy2(self._file_path, snap)
            return snap
        except OSError:
            logger.warning("undo snapshot failed; delete will not be undoable", exc_info=True)
            return None

    def _commit_structural_edit(
        self,
        *,
        description: str,
        changed_ids: list[int],
        inverse_ops: list[dict[str, Any]],
        extra: Optional[dict[str, Any]] = None,
        action: str = "model_refresh",
    ) -> dict[str, Any]:
        """Persist + version-bump + undo-push shared by the structural writers."""
        self._persist_model()
        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id
        self._project_cache = None
        self._stats_cache = None
        if action == "model_refresh":
            # Structure changed: the cached spatial tree is stale.
            self._spatial_cache = None
        self._push_undo(
            edit_id, description, inverse_ops, action=action, changed_ids=changed_ids
        )
        self._cache_meta_snapshot()
        out: dict[str, Any] = {
            "changed": True,
            "edit_id": edit_id,
            "description": description,
            "action": action,
            "changed_ids": changed_ids,
        }
        if extra:
            out.update(extra)
        return out

    def undo_last_edit(self) -> dict[str, Any]:
        """Pop the top entry off the undo stack and apply its inverse ops.

        Three inverse families:
        * attribute/property restores (``set_name``/``set_property``/
          ``set_elevation``) - cheap in-place edits;
        * structural reversals (``remove_products`` for creations,
          ``assign_container`` for spatial moves);
        * ``restore_file`` - a full working-file snapshot taken before an
          operation whose inverse is not expressible op-by-op (deletions).
          Snapshot restore preserves express ids exactly (the bytes ARE the
          prior state), honouring the native-IFC ID contract.
        """
        if not self._undo_stack:
            return {"undone": False, "reason": "Undo stack is empty"}

        entry = self._undo_stack.pop()
        issues: list[str] = []

        # Whole-file snapshot restore (single-op entries by construction).
        first = entry["inverse_ops"][0] if entry["inverse_ops"] else None
        if first is not None and first.get("op") == "restore_file":
            return self._undo_restore_file(entry, first)

        changed_ids: list[int] = list(entry.get("changed_ids") or [])
        for inv_op in entry["inverse_ops"]:
            kind = inv_op.get("op")

            if kind == "remove_products":
                # Inverse of a creation: remove the minted product(s).
                from app.services import element_factory

                for eid in inv_op.get("express_ids", []):
                    try:
                        created = self.model.by_id(int(eid))
                    except RuntimeError:
                        created = None
                    if created is None:
                        issues.append(f"Created element {eid} no longer exists; skipped")
                        continue
                    try:
                        element_factory.delete_product(self.model, created)
                        changed_ids.append(int(eid))
                    except Exception as exc:
                        issues.append(f"Could not remove created element {eid}: {exc}")
                continue

            expr_id = inv_op["express_id"]
            entity = self.model.by_id(expr_id)
            if entity is None:
                issues.append(f"Element {expr_id} no longer exists; skipped")
                continue
            changed_ids.append(expr_id)

            if kind == "set_name":
                entity.Name = inv_op["value"]
                self._patch_cached_tree_name(expr_id, inv_op["value"] or "", entity.is_a())

            elif kind == "set_attribute":
                try:
                    setattr(entity, inv_op["attribute"], inv_op.get("value"))
                except Exception as exc:
                    issues.append(
                        f"Could not restore {inv_op.get('attribute')} on {expr_id}: {exc}"
                    )

            elif kind == "set_property":
                op = EditOperation(
                    op="set_property",
                    express_id=expr_id,
                    property_set=inv_op.get("property_set"),
                    property_name=inv_op["property_name"],
                    value=inv_op["value"],
                )
                ok, msg = self._apply_property_edit(entity, op)
                if not ok:
                    issues.append(msg or f"Could not restore property on {expr_id}")

            elif kind == "set_elevation":
                try:
                    entity.Elevation = inv_op["value"]
                except Exception as exc:
                    issues.append(f"Could not restore elevation on {expr_id}: {exc}")

            elif kind == "assign_container":
                from app.services import element_factory

                container_id = inv_op.get("container_id")
                container = self.model.by_id(int(container_id)) if container_id else None
                if container is None:
                    issues.append(
                        f"Previous container for {expr_id} no longer exists; skipped"
                    )
                    continue
                try:
                    element_factory.assign_to_storey(self.model, entity, container)
                except Exception as exc:
                    issues.append(f"Could not restore container of {expr_id}: {exc}")

        self._persist_model()
        self._model_version += 1
        undo_edit_id = uuid.uuid4().hex
        self._last_edit_id = undo_edit_id
        self._project_cache = None
        self._stats_cache = None
        if entry.get("action") == "model_refresh":
            self._spatial_cache = None
        self._cache_meta_snapshot()

        # De-dupe while preserving order.
        changed_ids = list(dict.fromkeys(changed_ids))
        return {
            "undone": True,
            "reverted_edit_id": entry["edit_id"],
            "description": entry["description"],
            "issues": issues,
            "action": entry.get("action", "metadata_changed"),
            "changed_ids": changed_ids,
        }

    def _undo_restore_file(self, entry: dict[str, Any], inv_op: dict[str, Any]) -> dict[str, Any]:
        """Restore the working file from a pre-edit snapshot (delete undo)."""
        snap = Path(str(inv_op.get("snapshot_path") or ""))
        if not snap.exists():
            return {
                "undone": False,
                "reason": "The undo snapshot for this edit no longer exists",
            }
        if self._file_path is None:
            return {"undone": False, "reason": "No working file to restore into"}

        shutil.copy2(snap, self._file_path)
        self._model = ifcopenshell.open(str(self._file_path))
        self._model_fingerprint = self._fingerprint_file(self._file_path)
        self._model_version += 1
        undo_edit_id = uuid.uuid4().hex
        self._last_edit_id = undo_edit_id
        self._spatial_cache = None
        self._project_cache = None
        self._stats_cache = None
        self._recompute_dirty()
        self._cache_meta_snapshot()
        snap.unlink(missing_ok=True)
        return {
            "undone": True,
            "reverted_edit_id": entry["edit_id"],
            "description": entry["description"],
            "issues": [],
            "action": "model_refresh",
            "changed_ids": list(entry.get("changed_ids") or []),
        }

    def get_edit_history(self) -> list[dict[str, Any]]:
        """Return the undo stack newest-first (without inverse ops for brevity)."""
        return [
            {
                "edit_id": e["edit_id"],
                "description": e["description"],
                "timestamp": e["timestamp"],
            }
            for e in reversed(self._undo_stack)
        ]

    def reload_after_sandbox(self, *, edit_id: str) -> None:
        """Re-open the file from disk after SandboxService swapped a
        sandbox into the live path. Bumps the contract counters but
        preserves the existing ``_meta_cache_by_fingerprint`` - different
        fingerprint means a fresh cache slot anyway.
        """
        if self._file_path is None:
            raise RuntimeError("reload_after_sandbox called before a model was loaded")

        self._model = ifcopenshell.open(str(self._file_path))
        self._model_fingerprint = self._fingerprint_file(self._file_path)
        self._model_version += 1
        self._last_edit_id = edit_id
        self._spatial_cache = None
        self._project_cache = None
        self._stats_cache = None
        # Sandbox edits are atomic commits - the inverse-delta undo stack
        # doesn't cover them. Clear it so a mixed rename+sandbox flow
        # can't walk into a half-reverted state.
        for stale in self._undo_stack:
            self._drop_undo_snapshots(stale)
        self._undo_stack = []
        # Sandbox swap and rollback both reach this reload entry. The
        # bounded-ops path runs through _persist_model() and sets _dirty
        # there, but this path doesn't - without an explicit refresh
        # here, every chat-driven edit and post-rollback state silently
        # reports dirty=False even when the working file diverges from
        # the upload. Compare fingerprints so a rollback to the baseline
        # correctly resets dirty.
        self._recompute_dirty()

    # ------------------------------------------------------------------
    # Undo stack helpers
    # ------------------------------------------------------------------

    def _push_undo(
        self,
        edit_id: str,
        description: str,
        inverse_ops: list[dict],
        *,
        action: str = "metadata_changed",
        changed_ids: Optional[list[int]] = None,
    ) -> None:
        self._undo_stack.append({
            "edit_id": edit_id,
            "description": description,
            "timestamp": time.time(),
            "inverse_ops": inverse_ops,
            # The sync action undoing this entry requires ("model_refresh"
            # for structural edits → viewers reload; default cheap metadata).
            "action": action,
            "changed_ids": list(changed_ids or []),
        })
        if len(self._undo_stack) > self._undo_max:
            evicted = self._undo_stack.pop(0)
            self._drop_undo_snapshots(evicted)

    @staticmethod
    def _drop_undo_snapshots(entry: dict[str, Any]) -> None:
        """Delete snapshot files owned by an evicted/cleared undo entry."""
        for op in entry.get("inverse_ops", []):
            if op.get("op") == "restore_file":
                Path(str(op.get("snapshot_path") or "")).unlink(missing_ok=True)

    def _read_property_value(
        self, entity, property_name: str, pset_name: Optional[str]
    ) -> tuple[Optional[Any], Optional[str]]:
        """Return (current_value, pset_name) for the first matching property, or (None, None)."""
        wanted_prop = property_name.strip().lower()
        wanted_pset = (pset_name or "").strip().lower()
        for rel in getattr(entity, "IsDefinedBy", []) or []:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset.is_a("IfcPropertySet"):
                continue
            if wanted_pset and (pset.Name or "").strip().lower() != wanted_pset:
                continue
            for prop in pset.HasProperties:
                if not prop.is_a("IfcPropertySingleValue"):
                    continue
                if (prop.Name or "").strip().lower() != wanted_prop:
                    continue
                nominal = prop.NominalValue
                return (nominal.wrappedValue if nominal else None), (pset.Name or "Unnamed")
        return None, None

    def apply_edits(self, request: EditApplyRequest) -> EditApplyResponse:
        if request.base_model_version is not None and request.base_model_version != self._model_version:
            return EditApplyResponse(
                edit_id=uuid.uuid4().hex,
                model_version=self._model_version,
                model_fingerprint=self._model_fingerprint,
                status="rejected",
                requires_rebuild=False,
                message=(
                    f"Version mismatch: client={request.base_model_version}, "
                    f"server={self._model_version}"
                ),
            )

        if not request.operations:
            return EditApplyResponse(
                edit_id=uuid.uuid4().hex,
                model_version=self._model_version,
                model_fingerprint=self._model_fingerprint,
                status="rejected",
                requires_rebuild=False,
                message="No edit operations provided",
            )

        changed_ids: set[int] = set()
        removed_ids: set[int] = set()
        touched_storeys: set[str] = set()
        issues: list[str] = []
        persisted_change = False
        requires_rebuild = False

        for op in request.operations:
            if op.op in {"set_transform", "create", "delete"}:
                requires_rebuild = True
                if op.express_id is not None:
                    changed_ids.add(op.express_id)
                    if op.op == "delete":
                        removed_ids.add(op.express_id)
                continue

            if op.op == "set_visibility":
                if op.express_id is not None:
                    changed_ids.add(op.express_id)
                continue

            if op.express_id is None:
                issues.append(f"{op.op}: missing express_id")
                continue

            # by_id raises RuntimeError (not None) for unknown ids, so an
            # invalid express_id must be caught here or it aborts the batch.
            try:
                entity = self.model.by_id(op.express_id)
            except RuntimeError:
                entity = None
            if entity is None:
                issues.append(f"{op.op}: element {op.express_id} not found")
                continue

            if op.op == "set_name":
                new_name = "" if op.value is None else str(op.value)
                if new_name and entity.Name != new_name:
                    entity.Name = new_name
                    persisted_change = True
                    changed_ids.add(op.express_id)
                    self._patch_cached_tree_name(op.express_id, new_name, entity.is_a())
            elif op.op == "set_description":
                if not hasattr(entity, "Description"):
                    issues.append(f"set_description: element {op.express_id} has no Description")
                    continue
                new_desc = None if op.value is None else str(op.value)
                if getattr(entity, "Description", None) != new_desc:
                    entity.Description = new_desc
                    persisted_change = True
                    changed_ids.add(op.express_id)
            elif op.op == "set_property":
                ok, msg = self._apply_property_edit(entity, op)
                if ok:
                    persisted_change = True
                    changed_ids.add(op.express_id)
                elif msg:
                    issues.append(msg)
            else:
                issues.append(f"Unsupported edit op: {op.op}")

            if op.express_id in changed_ids:
                storey = self._get_storey(entity)
                if storey:
                    touched_storeys.add(storey)

        if not changed_ids and not requires_rebuild:
            return EditApplyResponse(
                edit_id=uuid.uuid4().hex,
                model_version=self._model_version,
                model_fingerprint=self._model_fingerprint,
                status="rejected",
                requires_rebuild=False,
                message=issues[0] if issues else "No applicable edit operations",
            )

        if persisted_change:
            self._persist_model()
            # Refresh lightweight caches and keep heavy caches when safe.
            self._project_cache = None
            self._stats_cache = None

        self._model_version += 1
        edit_id = uuid.uuid4().hex
        self._last_edit_id = edit_id

        patch = self._build_metadata_patch(changed_ids, removed_ids, touched_storeys)
        self._cache_meta_snapshot()

        notes: list[str] = []
        if issues:
            notes.append(f"Ignored {len(issues)} operation(s): " + "; ".join(issues[:3]))
        if requires_rebuild:
            notes.append("At least one operation requires background rebuild")

        return EditApplyResponse(
            edit_id=edit_id,
            model_version=self._model_version,
            model_fingerprint=self._model_fingerprint,
            changed_express_ids=sorted(changed_ids),
            metadata_patch=patch,
            status="accepted",
            requires_rebuild=requires_rebuild,
            message=" ".join(notes) if notes else None,
        )

    # --- Private helpers ---

    def _build_metadata_patch(
        self,
        changed_ids: set[int],
        removed_ids: set[int],
        touched_storeys: set[str],
    ) -> MetadataPatch:
        updated_elements: list[ElementSummary] = []
        for express_id in sorted(changed_ids):
            if express_id in removed_ids:
                continue
            entity = self.model.by_id(express_id)
            if entity is None:
                continue
            # Keep response small and frontend-friendly.
            if entity.is_a("IfcOpeningElement"):
                continue
            if not hasattr(entity, "GlobalId"):
                continue
            updated_elements.append(self._entity_to_summary(entity))

        return MetadataPatch(
            updated_elements=updated_elements,
            removed_element_ids=sorted(removed_ids),
            touched_storeys=sorted(touched_storeys),
            stats_delta={},
        )

    def _entity_to_summary(self, entity) -> ElementSummary:
        return ElementSummary(
            id=entity.id(),
            global_id=entity.GlobalId,
            name=getattr(entity, "Name", None),
            ifc_type=entity.is_a(),
            storey=self._get_storey(entity),
        )

    def _patch_cached_tree_name(self, express_id: int, new_name: str, ifc_type: str) -> None:
        if not self._spatial_cache:
            return

        def walk(node: SpatialNode) -> bool:
            if node.id == express_id:
                node.name = new_name or f"Unnamed {ifc_type}"
                return True
            for child in node.children:
                if walk(child):
                    return True
            return False

        walk(self._spatial_cache)

    def _apply_property_edit(self, entity, op: EditOperation) -> tuple[bool, Optional[str]]:
        if not op.property_name:
            return False, "set_property: property_name is required"

        wanted_pset = (op.property_set or "").strip().lower()
        wanted_prop = op.property_name.strip().lower()

        for rel in getattr(entity, "IsDefinedBy", []) or []:
            if not rel.is_a("IfcRelDefinesByProperties"):
                continue
            pset = rel.RelatingPropertyDefinition
            if not pset.is_a("IfcPropertySet"):
                continue
            if wanted_pset and (pset.Name or "").strip().lower() != wanted_pset:
                continue
            for prop in pset.HasProperties:
                if not prop.is_a("IfcPropertySingleValue"):
                    continue
                if (prop.Name or "").strip().lower() != wanted_prop:
                    continue

                nominal = prop.NominalValue
                if nominal is None:
                    return False, (
                        f"set_property: {op.property_name} on element {entity.id()} "
                        "has no nominal value"
                    )

                try:
                    current = nominal.wrappedValue
                    nominal.wrappedValue = self._coerce_value(op.value, current)
                    return True, None
                except Exception as exc:
                    return False, (
                        f"set_property: failed to update {op.property_name} on "
                        f"element {entity.id()}: {exc}"
                    )

        return False, (
            f"set_property: {op.property_name} not found on element {entity.id()}"
        )

    def _coerce_value(self, value: Any, current: Any) -> Any:
        if isinstance(current, bool):
            if isinstance(value, str):
                return value.strip().lower() in {"1", "true", "yes", "on"}
            return bool(value)
        if isinstance(current, int) and not isinstance(current, bool):
            return int(value) if value is not None else 0
        if isinstance(current, float):
            return float(value) if value is not None else 0.0
        if value is None:
            return None
        return str(value) if isinstance(current, str) else value

    def _persist_model(self) -> None:
        if not self._file_path:
            return
        self.model.write(str(self._file_path))
        self._model_fingerprint = self._fingerprint_file(self._file_path)
        # Flag dirty whenever the working file's content actually diverges
        # from the upload. Fingerprint compare (not path compare) so a
        # round-trip that canonicalises back to the original bytes - or
        # the fallback load path where working == upload - doesn't falsely
        # claim unsaved changes.
        self._recompute_dirty()

    @staticmethod
    def _derive_working_path(upload_path: Path) -> Path:
        # Hidden ".working" sibling dir keeps UPLOAD_DIR's *.ifc glob (used
        # by warm-from-cache) from picking up edited copies, and mirrors how
        # .git / .venv stay out of the user's way.
        return upload_path.parent / ".working" / upload_path.name

    def save_as(self, target_path: Path) -> Path:
        """Write the current in-memory model to ``target_path``.

        Neither the original upload nor the working file is modified. Caller
        is responsible for choosing a safe destination - the path is created
        if its parent doesn't exist. Returns the resolved target path.
        """
        if self._model is None:
            raise RuntimeError("No IFC model loaded")
        target = Path(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._model.write(str(target))
        return target

    def _fingerprint_file(self, path: Path) -> str:
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def _cache_meta_snapshot(self) -> None:
        if not self._model_fingerprint:
            return
        if not (self._project_cache and self._spatial_cache and self._stats_cache):
            return

        self._meta_cache_by_fingerprint[self._model_fingerprint] = {
            "project": copy.deepcopy(self._project_cache),
            "tree": copy.deepcopy(self._spatial_cache),
            "stats": copy.deepcopy(self._stats_cache),
        }
        self._meta_cache_by_fingerprint.move_to_end(self._model_fingerprint)
        while len(self._meta_cache_by_fingerprint) > self._meta_cache_limit:
            self._meta_cache_by_fingerprint.popitem(last=False)

    def _is_storey_entity(self, entity) -> bool:
        """True if entity represents a building storey (IFC4 or IFC5)."""
        if entity.is_a("IfcBuildingStorey"):
            return True
        # IFC5 renames IfcBuildingStorey → IfcFacilityPart with PredefinedType=STOREY
        if entity.is_a("IfcFacilityPart"):
            try:
                return str(getattr(entity, "PredefinedType", "")).upper() == "STOREY"
            except Exception:
                pass
        return False

    def _get_all_storeys(self):
        """Return all storey entities from the loaded model (IFC4 + IFC5 compatible)."""
        m = self.model
        storeys = list(m.by_type("IfcBuildingStorey"))
        if not storeys:
            # IFC5 fallback: IfcFacilityPart with PredefinedType=STOREY
            try:
                storeys = [
                    e for e in m.by_type("IfcFacilityPart")
                    if str(getattr(e, "PredefinedType", "")).upper() == "STOREY"
                ]
            except Exception:
                logger.debug("IFC5 IfcFacilityPart storey fallback failed", exc_info=True)
        return storeys

    def _get_storey(self, entity) -> Optional[str]:
        try:
            container = ifcopenshell.util.element.get_container(entity)
            if container and self._is_storey_entity(container):
                return container.Name
        except Exception:
            logger.debug("Failed to get storey for entity %s", entity.id(), exc_info=True)
        return None

    def export_properties_csv(
        self,
        ifc_type: Optional[str] = None,
        include_quantities: bool = False,
        max_elements: int = 10_000,
    ) -> str:
        """Export all (or type-filtered) elements with their pset properties as CSV.

        Columns: express_id, global_id, name, ifc_type, storey, <pset.prop> ...
        Each unique (pset_name, prop_name) pair becomes its own column, formatted
        as ``PsetName.PropName``.  Returns the raw CSV string (caller decides
        how to stream or save it).  Quantity columns are prefixed ``Qty.``.

        Args:
            ifc_type: If given, only export elements of this IFC class (e.g.
                ``"IfcWall"``).  ``None`` exports all IfcProduct entities.
            include_quantities: When True, append IfcElementQuantity length/area
                /volume columns with ``Qty.`` prefix.
            max_elements: Safety cap so the response never overwhelms memory.
        """
        import csv
        import io

        m = self.model
        entities = (
            list(m.by_type(ifc_type))[:max_elements]
            if ifc_type
            else [e for e in m.by_type("IfcProduct") if not e.is_a("IfcOpeningElement")][:max_elements]
        )

        # ── First pass: collect all unique column keys ───────────────────────
        FIXED = ["express_id", "global_id", "name", "ifc_type", "storey"]
        pset_keys: list[str] = []
        pset_key_set: set[str] = set()
        qty_keys: list[str] = []
        qty_key_set: set[str] = set()

        rows: list[dict] = []
        for entity in entities:
            row: dict[str, str] = {
                "express_id": str(entity.id()),
                "global_id": getattr(entity, "GlobalId", "") or "",
                "name": getattr(entity, "Name", "") or "",
                "ifc_type": entity.is_a(),
                "storey": self._get_storey(entity) or "",
            }
            try:
                for rel in getattr(entity, "IsDefinedBy", []) or []:
                    if rel.is_a("IfcRelDefinesByProperties"):
                        defn = rel.RelatingPropertyDefinition
                        if defn.is_a("IfcPropertySet"):
                            pset_name = defn.Name or "Unnamed"
                            for prop in defn.HasProperties:
                                if prop.is_a("IfcPropertySingleValue"):
                                    col = f"{pset_name}.{prop.Name}"
                                    val = prop.NominalValue
                                    row[col] = str(val.wrappedValue) if val is not None else ""
                                    if col not in pset_key_set:
                                        pset_key_set.add(col)
                                        pset_keys.append(col)
                        elif defn.is_a("IfcElementQuantity") and include_quantities:
                            qset_name = defn.Name or "Qty"
                            for q in defn.Quantities:
                                raw: Optional[float] = None
                                if q.is_a("IfcQuantityLength"):
                                    raw = float(q.LengthValue)
                                elif q.is_a("IfcQuantityArea"):
                                    raw = float(q.AreaValue)
                                elif q.is_a("IfcQuantityVolume"):
                                    raw = float(q.VolumeValue)
                                elif q.is_a("IfcQuantityCount"):
                                    raw = float(q.CountValue)
                                if raw is not None:
                                    col = f"Qty.{qset_name}.{q.Name}"
                                    row[col] = str(round(raw, 6))
                                    if col not in qty_key_set:
                                        qty_key_set.add(col)
                                        qty_keys.append(col)
            except Exception:
                logger.debug("CSV export: failed reading entity %s", entity.id(), exc_info=True)
            rows.append(row)

        # ── Second pass: write CSV with unified header ───────────────────────
        fieldnames = FIXED + sorted(pset_keys) + sorted(qty_keys)
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row.get(k, "") for k in fieldnames})

        return buf.getvalue()

    def get_aggregate(self, express_ids: list[int]) -> dict:
        """Aggregate quantities + histograms for a set of express IDs.

        Returns a dict matching AggregateResult schema. Area/volume are
        summed from IfcElementQuantity. Material and type histograms are
        always populated. Element IDs that have no quantity data are listed
        in missing_quantity_ids so the UI can surface a caveat.
        """
        if not self.model:
            raise ValueError("No model loaded")

        # Priority-ordered area / volume quantity names (first found wins per element)
        _AREA_NAMES = ("GrossArea", "NetArea", "GrossFloorArea", "NetFloorArea", "Area")
        _VOL_NAMES  = ("GrossVolume", "NetVolume", "GrossBodyVolume", "Volume")

        total_area: float = 0.0
        total_volume: float = 0.0
        area_qty_name: Optional[str] = None
        vol_qty_name: Optional[str] = None
        material_histogram: dict[str, int] = {}
        type_histogram: dict[str, int] = {}
        missing_qty: list[int] = []
        found_area = False
        found_vol = False

        for eid in express_ids:
            try:
                entity = self.model.by_id(eid)
            except Exception:
                continue

            # Type histogram
            raw_type = entity.is_a().replace("Ifc", "", 1)
            type_histogram[raw_type] = type_histogram.get(raw_type, 0) + 1

            # Material histogram
            mat = self._get_material(entity)
            if mat:
                material_histogram[mat] = material_histogram.get(mat, 0) + 1

            # Quantities
            qtys = self._get_quantities(entity)
            if not qtys:
                missing_qty.append(eid)
                continue

            # Area: pick the first matching name
            for aname in _AREA_NAMES:
                if aname in qtys:
                    total_area += qtys[aname]
                    if area_qty_name is None:
                        area_qty_name = aname
                    found_area = True
                    break
            else:
                # Fallback: sum any quantity that looks like area
                for k, v in qtys.items():
                    if "area" in k.lower():
                        total_area += v
                        if area_qty_name is None:
                            area_qty_name = k
                        found_area = True
                        break

            # Volume: pick the first matching name
            for vname in _VOL_NAMES:
                if vname in qtys:
                    total_volume += qtys[vname]
                    if vol_qty_name is None:
                        vol_qty_name = vname
                    found_vol = True
                    break
            else:
                for k, v in qtys.items():
                    if "volume" in k.lower():
                        total_volume += v
                        if vol_qty_name is None:
                            vol_qty_name = k
                        found_vol = True
                        break

        return {
            "count": len(express_ids),
            "total_area": round(total_area, 4) if found_area else None,
            "total_volume": round(total_volume, 4) if found_vol else None,
            "area_quantity_name": area_qty_name,
            "volume_quantity_name": vol_qty_name,
            "material_histogram": dict(
                sorted(material_histogram.items(), key=lambda x: -x[1])
            ),
            "type_histogram": dict(
                sorted(type_histogram.items(), key=lambda x: -x[1])
            ),
            "missing_quantity_ids": missing_qty,
        }

    def _get_material(self, entity) -> Optional[str]:
        try:
            mat = ifcopenshell.util.element.get_material(entity)
            if mat is None:
                return None
            if mat.is_a("IfcMaterial"):
                return mat.Name
            if mat.is_a("IfcMaterialLayerSetUsage"):
                layers = mat.ForLayerSet.MaterialLayers
                return ", ".join(
                    l.Material.Name for l in layers if l.Material and l.Material.Name
                )
            if mat.is_a("IfcMaterialLayerSet"):
                return ", ".join(
                    l.Material.Name for l in mat.MaterialLayers if l.Material and l.Material.Name
                )
            if mat.is_a("IfcMaterialList"):
                return ", ".join(m.Name for m in mat.Materials if m.Name)
            return str(mat.is_a())
        except Exception:
            logger.debug("Failed to get material for entity %s", entity.id(), exc_info=True)
            return None

    def _get_property_sets(self, entity) -> list[PropertySet]:
        # ifcopenshell.util.element.get_psets handles every IfcProperty
        # variant - SingleValue, EnumeratedValue, ListValue, BoundedValue,
        # ReferenceValue, ComplexProperty - and inherited type psets.
        # Hand-walking IsDefinedBy only caught SingleValue and silently
        # dropped the rest, which is why the Properties tab looked sparse.
        psets: list[PropertySet] = []
        try:
            raw = element_util.get_psets(entity, qtos_only=False, psets_only=True) or {}
            for pset_name, props_dict in raw.items():
                if not isinstance(props_dict, dict):
                    continue
                cleaned: dict[str, str | int | float | bool | None] = {}
                for k, v in props_dict.items():
                    if k == "id":
                        continue
                    cleaned[k] = _coerce_pset_value(v)
                psets.append(PropertySet(name=pset_name or "Unnamed", properties=cleaned))
        except Exception:
            logger.debug("Failed to get property sets for entity %s", entity.id(), exc_info=True)
        return psets

    def _get_quantities(self, entity) -> dict[str, float]:
        quantities: dict[str, float] = {}
        try:
            raw = element_util.get_psets(entity, qtos_only=True, psets_only=False) or {}
            for _, qset_dict in raw.items():
                if not isinstance(qset_dict, dict):
                    continue
                for k, v in qset_dict.items():
                    if k == "id":
                        continue
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        quantities[k] = float(v)
        except Exception:
            logger.debug("Failed to get quantities for entity %s", entity.id(), exc_info=True)
        return quantities


# Singleton instance
ifc_service = IfcService()
