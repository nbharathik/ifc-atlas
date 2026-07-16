"""Revision-scoped, in-memory BIM property filtering.

The legacy property endpoint walks every ``IfcProduct`` and every property set
for each request, then stops at its presentation limit.  That is useful for a
one-off lookup, but it cannot support reusable AND/OR filters or complete
viewer visibility sets.

This service pays the IFC traversal cost once per ``IfcService.model_version``.
Each rebuild publishes one immutable snapshot, so a concurrent query either
uses the complete old snapshot or the complete new one -- never a mixture of
both. Semantic edits increment the model version and therefore invalidate the
snapshot without coupling the index to the edit implementation.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
from sys import intern
from types import MappingProxyType
import threading
import time
from typing import Any, Callable, Iterable, Literal, Mapping, Optional

FilterLogic = Literal["and", "or"]
FilterOperator = Literal[
    "eq",
    "neq",
    "contains",
    "startswith",
    "gt",
    "lt",
    "gte",
    "lte",
    "exists",
    "not_exists",
]

VALID_OPERATORS: frozenset[str] = frozenset(
    {
        "eq",
        "neq",
        "contains",
        "startswith",
        "gt",
        "lt",
        "gte",
        "lte",
        "exists",
        "not_exists",
    }
)
NUMERIC_OPERATORS: frozenset[str] = frozenset({"gt", "lt", "gte", "lte"})


@dataclass(frozen=True, slots=True)
class PropertyFilterCondition:
    property_name: str
    operator: FilterOperator
    value: Optional[str] = None
    pset_name: Optional[str] = None


@dataclass(frozen=True, slots=True)
class IndexedPropertyValue:
    pset: str
    name: str
    value: Optional[str]


@dataclass(frozen=True, slots=True)
class IndexedElement:
    express_id: int
    name: str
    ifc_type: str
    storey: Optional[str]
    properties: tuple[IndexedPropertyValue, ...]


PropertyKey = tuple[Optional[str], str]


@dataclass(frozen=True, slots=True)
class _IndexSnapshot:
    model_identity: Optional[int]
    model_version: int
    elements: tuple[IndexedElement, ...]
    ids_by_property: Mapping[PropertyKey, frozenset[int]]


_EMPTY_SNAPSHOT = _IndexSnapshot(None, -1, (), MappingProxyType({}))


def _safe_is_a(entity: Any, ifc_class: str) -> bool:
    try:
        return bool(entity.is_a(ifc_class))
    except (AttributeError, RuntimeError, TypeError, ValueError):
        return False


def _string_value(value: Any) -> Optional[str]:
    """Convert a scalar IFC wrapped value to a stable filter representation."""

    if value is None:
        return None
    wrapped = getattr(value, "wrappedValue", value)
    if wrapped is None:
        return None
    if isinstance(wrapped, bool):
        return "true" if wrapped else "false"
    return str(wrapped)


def _sequence_or_missing(value: Any) -> tuple[Any, ...]:
    """Return collection values individually so equality has item semantics."""

    if value is None:
        return (None,)
    if isinstance(value, (str, bytes)):
        return (value,)
    if isinstance(value, (list, tuple)):
        return tuple(value) or (None,)
    try:
        return tuple(value) or (None,)
    except TypeError:
        return (value,)


def _definition_identity(definition: Any) -> tuple[str, int]:
    try:
        express_id = int(definition.id())
    except (AttributeError, RuntimeError, TypeError, ValueError):
        express_id = 0
    return ("ifc", express_id) if express_id > 0 else ("python", id(definition))


def _iter_property_definitions(entity: Any) -> Iterable[Any]:
    """Yield occurrence and type property definitions once.

    IFC4 exposes type relations through ``IsTypedBy``. IFC2X3 routes the same
    relationship through ``IsDefinedBy``. Supporting both avoids silently
    omitting manufacturer/type properties from viewer filters.
    """

    seen_definitions: set[tuple[str, int]] = set()
    type_objects: list[Any] = []
    try:
        defined_by = getattr(entity, "IsDefinedBy", ()) or ()
    except (AttributeError, RuntimeError, TypeError):
        defined_by = ()
    for relation in defined_by:
        try:
            if _safe_is_a(relation, "IfcRelDefinesByProperties"):
                definition = relation.RelatingPropertyDefinition
                key = _definition_identity(definition)
                if key not in seen_definitions:
                    seen_definitions.add(key)
                    yield definition
            elif _safe_is_a(relation, "IfcRelDefinesByType"):
                type_objects.append(relation.RelatingType)
        except (AttributeError, RuntimeError, TypeError):
            continue

    try:
        typed_by = getattr(entity, "IsTypedBy", ()) or ()
    except (AttributeError, RuntimeError, TypeError):
        typed_by = ()
    for relation in typed_by:
        try:
            if _safe_is_a(relation, "IfcRelDefinesByType"):
                type_objects.append(relation.RelatingType)
        except (AttributeError, RuntimeError, TypeError):
            continue

    seen_types: set[tuple[str, int]] = set()
    for type_object in type_objects:
        type_key = _definition_identity(type_object)
        if type_key in seen_types:
            continue
        seen_types.add(type_key)
        try:
            property_sets = getattr(type_object, "HasPropertySets", ()) or ()
        except (AttributeError, RuntimeError, TypeError):
            property_sets = ()
        for definition in property_sets:
            key = _definition_identity(definition)
            if key not in seen_definitions:
                seen_definitions.add(key)
                yield definition


def _simple_quantity_value(quantity: Any) -> Any:
    try:
        info = quantity.get_info() if hasattr(quantity, "get_info") else {}
    except (RuntimeError, TypeError, ValueError):
        info = {}
    for key, candidate in info.items():
        if key.endswith("Value"):
            return candidate
    return None


def _property_raw_values(prop: Any) -> tuple[Any, ...]:
    if _safe_is_a(prop, "IfcPropertySingleValue"):
        return (getattr(prop, "NominalValue", None),)
    if _safe_is_a(prop, "IfcPropertyEnumeratedValue"):
        return _sequence_or_missing(getattr(prop, "EnumerationValues", None))
    if _safe_is_a(prop, "IfcPropertyListValue"):
        return _sequence_or_missing(getattr(prop, "ListValues", None))
    if _safe_is_a(prop, "IfcPropertyBoundedValue"):
        candidates = tuple(
            value
            for value in (
                getattr(prop, "SetPointValue", None),
                getattr(prop, "LowerBoundValue", None),
                getattr(prop, "UpperBoundValue", None),
            )
            if value is not None
        )
        return candidates or (None,)
    if _safe_is_a(prop, "IfcPropertyReferenceValue"):
        reference = getattr(prop, "PropertyReference", None)
        if reference is None:
            return (None,)
        return (
            getattr(reference, "Name", None)
            or getattr(reference, "GlobalId", None)
            or reference,
        )
    if _safe_is_a(prop, "IfcPhysicalSimpleQuantity"):
        return (_simple_quantity_value(prop),)
    return ()


def _iter_definition_values(
    definition: Any,
    pset_name: str,
) -> Iterable[IndexedPropertyValue]:
    if _safe_is_a(definition, "IfcPropertySet"):
        children = getattr(definition, "HasProperties", ()) or ()
    elif _safe_is_a(definition, "IfcElementQuantity"):
        children = getattr(definition, "Quantities", ()) or ()
    else:
        return

    pending = deque(children)
    seen_children: set[tuple[str, int]] = set()
    while pending:
        prop = pending.popleft()
        prop_key = _definition_identity(prop)
        if prop_key in seen_children:
            continue
        seen_children.add(prop_key)
        try:
            if _safe_is_a(prop, "IfcComplexProperty"):
                pending.extendleft(
                    reversed(tuple(getattr(prop, "HasProperties", ()) or ()))
                )
                continue
            if _safe_is_a(prop, "IfcPhysicalComplexQuantity"):
                pending.extendleft(
                    reversed(tuple(getattr(prop, "HasQuantities", ()) or ()))
                )
                continue
            prop_name = str(getattr(prop, "Name", None) or "").strip()
            if not prop_name:
                continue
            for raw_value in _property_raw_values(prop):
                yield IndexedPropertyValue(
                    intern(pset_name),
                    intern(prop_name),
                    _string_value(raw_value),
                )
        except (AttributeError, RuntimeError, TypeError, ValueError):
            continue


def _entity_properties(entity: Any) -> tuple[IndexedPropertyValue, ...]:
    """Extract identity, occurrence, type, and quantity values."""

    values: list[IndexedPropertyValue] = []
    for attribute in (
        "GlobalId",
        "Name",
        "Description",
        "ObjectType",
        "Tag",
        "PredefinedType",
    ):
        try:
            raw = getattr(entity, attribute, None)
        except (AttributeError, RuntimeError):
            raw = None
        if raw is not None:
            values.append(IndexedPropertyValue("IFC", attribute, _string_value(raw)))

    for definition in _iter_property_definitions(entity):
        try:
            pset_name = str(
                getattr(definition, "Name", None) or definition.is_a()
            ).strip()
        except (AttributeError, RuntimeError, TypeError, ValueError):
            continue
        values.extend(_iter_definition_values(definition, pset_name))

    # A type relation and an occurrence relation can legally expose the same
    # definition. Stable deduplication keeps multi-value semantics without
    # inflating memory or detail previews.
    return tuple(dict.fromkeys(values))


def _normalise_scope(values: Iterable[str]) -> frozenset[str]:
    return frozenset(value.strip().casefold() for value in values if value.strip())


def _normalised_property_key(
    property_name: str,
    pset_name: Optional[str],
) -> PropertyKey:
    return (
        pset_name.strip().casefold() if pset_name and pset_name.strip() else None,
        property_name.strip().casefold(),
    )


def _condition_values(
    element: IndexedElement,
    condition: PropertyFilterCondition,
) -> tuple[IndexedPropertyValue, ...]:
    pset_name, property_name = _normalised_property_key(
        condition.property_name,
        condition.pset_name,
    )
    return tuple(
        prop
        for prop in element.properties
        if prop.name.strip().casefold() == property_name
        and (pset_name is None or prop.pset.strip().casefold() == pset_name)
    )


def _parse_finite(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def condition_matches(
    element: IndexedElement,
    condition: PropertyFilterCondition,
) -> bool:
    """Evaluate one typed property predicate against one indexed element."""

    operator = condition.operator
    if operator not in VALID_OPERATORS:
        raise ValueError(f"Unsupported property filter operator: {operator!r}")
    values = _condition_values(element, condition)
    if operator == "exists":
        return bool(values)
    if operator == "not_exists":
        return not values
    if not values:
        return False

    target = (condition.value or "").casefold()
    if operator in NUMERIC_OPERATORS:
        numeric_target = _parse_finite(condition.value)
        if numeric_target is None:
            raise ValueError(f"Operator {operator!r} requires a finite numeric value")

        def compare_numeric(prop: IndexedPropertyValue) -> bool:
            actual = _parse_finite(prop.value)
            if actual is None:
                return False
            if operator == "gt":
                return actual > numeric_target
            if operator == "lt":
                return actual < numeric_target
            if operator == "gte":
                return actual >= numeric_target
            return actual <= numeric_target

        return any(compare_numeric(prop) for prop in values)

    normalised = [(prop.value or "").casefold() for prop in values]
    if operator == "eq":
        return any(actual == target for actual in normalised)
    if operator == "neq":
        # Missing values are handled by ``not_exists``. For a repeated
        # property, not-equal means no occurrence equals the target.
        return all(actual != target for actual in normalised)
    if operator == "contains":
        return any(target in actual for actual in normalised)
    if operator == "startswith":
        return any(actual.startswith(target) for actual in normalised)
    return False


class PropertyFilterIndex:
    """One authoritative property index for the currently loaded model."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._snapshot = _EMPTY_SNAPSHOT

    @property
    def element_count(self) -> int:
        with self._lock:
            return len(self._snapshot.elements)

    def invalidate(self) -> None:
        with self._lock:
            self._snapshot = _EMPTY_SNAPSHOT

    def _build_snapshot(
        self,
        model: Any,
        model_version: int,
        storey_resolver: Callable[[Any], Optional[str]],
    ) -> _IndexSnapshot:
        elements: list[IndexedElement] = []
        ids_by_property: dict[PropertyKey, set[int]] = {}
        for entity in model.by_type("IfcProduct"):
            try:
                if entity.is_a("IfcOpeningElement"):
                    continue
                express_id = int(entity.id())
                ifc_type = intern(str(entity.is_a()))
                name = str(getattr(entity, "Name", None) or f"#{express_id}")
                properties = _entity_properties(entity)
            except (AttributeError, RuntimeError, TypeError, ValueError):
                continue
            try:
                storey = storey_resolver(entity)
            except (AttributeError, RuntimeError, TypeError, ValueError):
                storey = None

            elements.append(
                IndexedElement(express_id, name, ifc_type, storey, properties)
            )
            property_keys = {
                (None, prop.name.strip().casefold()) for prop in properties
            }
            property_keys.update(
                (prop.pset.strip().casefold(), prop.name.strip().casefold())
                for prop in properties
            )
            for key in property_keys:
                ids_by_property.setdefault(key, set()).add(express_id)

        frozen_ids = MappingProxyType(
            {key: frozenset(ids) for key, ids in ids_by_property.items()}
        )
        return _IndexSnapshot(
            id(model),
            model_version,
            tuple(elements),
            frozen_ids,
        )

    def ensure(
        self,
        model: Any,
        model_version: int,
        storey_resolver: Callable[[Any], Optional[str]],
    ) -> tuple[_IndexSnapshot, bool]:
        """Return an atomic snapshot and whether it was already cached."""

        with self._lock:
            snapshot = self._snapshot
            if (
                snapshot.model_identity == id(model)
                and snapshot.model_version == model_version
            ):
                return snapshot, True
            snapshot = self._build_snapshot(model, model_version, storey_resolver)
            self._snapshot = snapshot
            return snapshot, False

    def query(
        self,
        *,
        model: Any,
        model_version: int,
        storey_resolver: Callable[[Any], Optional[str]],
        conditions: Iterable[PropertyFilterCondition],
        logic: FilterLogic = "and",
        ifc_types: Iterable[str] = (),
        storeys: Iterable[str] = (),
        max_result_ids: int = 200_000,
        detail_limit: int = 50,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        condition_list = tuple(conditions)
        if not condition_list:
            raise ValueError("At least one property filter condition is required")
        if logic not in {"and", "or"}:
            raise ValueError("Filter logic must be 'and' or 'or'")
        if max_result_ids < 1:
            raise ValueError("max_result_ids must be positive")
        if detail_limit < 0:
            raise ValueError("detail_limit must not be negative")
        for condition in condition_list:
            if not condition.property_name.strip():
                raise ValueError("Property names must not be empty")
            if condition.operator not in VALID_OPERATORS:
                raise ValueError(
                    f"Unsupported property filter operator: {condition.operator!r}"
                )
            if (
                condition.operator not in {"exists", "not_exists"}
                and condition.value is None
            ):
                raise ValueError(f"Operator {condition.operator!r} requires a value")
            if (
                condition.operator in NUMERIC_OPERATORS
                and _parse_finite(condition.value) is None
            ):
                raise ValueError(
                    f"Operator {condition.operator!r} requires a finite numeric value"
                )

        snapshot, cache_hit = self.ensure(model, model_version, storey_resolver)
        type_scope = _normalise_scope(ifc_types)
        storey_scope = _normalise_scope(storeys)

        # For AND queries, the presence index cheaply rejects elements that
        # cannot possibly match before evaluating values. A pset-qualified
        # predicate uses the narrower compound key.
        required_ids: Optional[set[int]] = None
        if logic == "and":
            for condition in condition_list:
                if condition.operator == "not_exists":
                    continue
                key = _normalised_property_key(
                    condition.property_name,
                    condition.pset_name,
                )
                ids = snapshot.ids_by_property.get(key, frozenset())
                required_ids = (
                    set(ids)
                    if required_ids is None
                    else required_ids.intersection(ids)
                )

        exact_count = 0
        returned: list[IndexedElement] = []
        for element in snapshot.elements:
            if required_ids is not None and element.express_id not in required_ids:
                continue
            if type_scope and element.ifc_type.strip().casefold() not in type_scope:
                continue
            if (
                storey_scope
                and (element.storey or "").strip().casefold() not in storey_scope
            ):
                continue
            # Preserve predicate order from the saved filter and short-circuit
            # as soon as its boolean result is known. This matters for large
            # OR filters: a common first condition should not trigger another
            # full property scan for every remaining condition.
            matches = (
                all(condition_matches(element, condition) for condition in condition_list)
                if logic == "and"
                else any(condition_matches(element, condition) for condition in condition_list)
            )
            if matches:
                exact_count += 1
                if len(returned) < max_result_ids:
                    returned.append(element)

        details = []
        for element in returned[:detail_limit]:
            matched_values: list[IndexedPropertyValue] = []
            for condition in condition_list:
                if condition_matches(element, condition):
                    matched_values.extend(_condition_values(element, condition))
            matched_values = list(dict.fromkeys(matched_values))
            first = matched_values[0] if matched_values else None
            details.append(
                {
                    "id": element.express_id,
                    "name": element.name,
                    "ifc_type": element.ifc_type,
                    "storey": element.storey,
                    "pset": first.pset if first else "",
                    "property": first.name if first else "",
                    "value": first.value if first and first.value is not None else "",
                    "matches": [
                        {
                            "pset": prop.pset,
                            "property": prop.name,
                            "value": prop.value,
                        }
                        for prop in matched_values
                    ],
                }
            )

        return {
            "logic": logic,
            "count": exact_count,
            "truncated": exact_count > len(returned),
            "element_ids": [element.express_id for element in returned],
            "elements": details,
            "index_version": snapshot.model_version,
            "index_cached": cache_hit,
            "indexed_elements": len(snapshot.elements),
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 2),
        }


property_filter_index = PropertyFilterIndex()
