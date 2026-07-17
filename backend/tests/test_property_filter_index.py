from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.property_filter_index import (
    PropertyFilterCondition,
    PropertyFilterIndex,
    condition_matches,
)


class Wrapped:
    def __init__(self, value):
        self.wrappedValue = value


class FakeProperty:
    def __init__(self, name: str, value):
        self.Name = name
        self.NominalValue = Wrapped(value) if value is not None else None

    def is_a(self, name: str | None = None):
        return "IfcPropertySingleValue" if name is None else name == "IfcPropertySingleValue"


class FakeEnumeratedProperty:
    def __init__(self, name: str, values: list[str]):
        self.Name = name
        self.EnumerationValues = [Wrapped(value) for value in values]

    def is_a(self, name: str | None = None):
        return "IfcPropertyEnumeratedValue" if name is None else name == "IfcPropertyEnumeratedValue"


class FakePset:
    def __init__(self, name: str, values: dict[str, object]):
        self.Name = name
        self.HasProperties = [FakeProperty(key, value) for key, value in values.items()]

    def is_a(self, name: str | None = None):
        return "IfcPropertySet" if name is None else name == "IfcPropertySet"


class FakeQuantity:
    def __init__(self, name: str, value: float):
        self.Name = name
        self._value = value

    def is_a(self, name: str | None = None):
        return "IfcQuantityArea" if name is None else name == "IfcPhysicalSimpleQuantity"

    def get_info(self):
        return {"id": 99, "type": "IfcQuantityArea", "AreaValue": self._value}


class FakeElementQuantity:
    def __init__(self, name: str, quantities: list[FakeQuantity]):
        self.Name = name
        self.Quantities = quantities

    def is_a(self, name: str | None = None):
        return "IfcElementQuantity" if name is None else name == "IfcElementQuantity"


class FakeRelation:
    def __init__(self, pset: FakePset):
        self.RelatingPropertyDefinition = pset

    def is_a(self, name: str | None = None):
        return "IfcRelDefinesByProperties" if name is None else name == "IfcRelDefinesByProperties"


class FakeTypeObject:
    def __init__(self, property_sets: list[FakePset]):
        self.HasPropertySets = property_sets


class FakeTypeRelation:
    def __init__(self, type_object: FakeTypeObject):
        self.RelatingType = type_object

    def is_a(self, name: str | None = None):
        return "IfcRelDefinesByType" if name is None else name == "IfcRelDefinesByType"


class FakeEntity:
    def __init__(self, express_id: int, ifc_type: str, name: str, storey: str, psets):
        self._id = express_id
        self._type = ifc_type
        self.Name = name
        self.storey = storey
        self.IsDefinedBy = [FakeRelation(FakePset(pset, values)) for pset, values in psets]
        self.IsTypedBy = []

    def id(self):
        return self._id

    def is_a(self, name: str | None = None):
        if name is None:
            return self._type
        return self._type == name


def make_model():
    entities = [
        FakeEntity(10, "IfcWall", "External wall", "Level 1", [
            ("Pset_WallCommon", {"FireRating": "2h", "IsExternal": True}),
            ("BaseQuantities", {"GrossArea": 45.2}),
        ]),
        FakeEntity(11, "IfcWall", "Internal wall", "Level 1", [
            ("Pset_WallCommon", {"FireRating": "30min", "IsExternal": False}),
            ("BaseQuantities", {"GrossArea": 18.0}),
        ]),
        FakeEntity(12, "IfcDoor", "Fire door", "Level 2", [
            ("Pset_DoorCommon", {"FireRating": "2h"}),
        ]),
        FakeEntity(13, "IfcSlab", "Unrated slab", "Level 2", []),
    ]
    return SimpleNamespace(by_type=lambda _name: entities)


def query(index: PropertyFilterIndex, conditions, **kwargs):
    model = kwargs.pop("model", make_model())
    return index.query(
        model=model,
        model_version=kwargs.pop("model_version", 1),
        storey_resolver=lambda entity: entity.storey,
        conditions=conditions,
        **kwargs,
    )


def test_and_filter_combines_numeric_and_boolean_properties():
    result = query(PropertyFilterIndex(), [
        PropertyFilterCondition("IsExternal", "eq", "true"),
        PropertyFilterCondition("GrossArea", "gt", "40"),
    ])
    assert result["count"] == 1
    assert result["element_ids"] == [10]
    assert result["truncated"] is False


def test_or_filter_and_type_scope():
    result = query(
        PropertyFilterIndex(),
        [
            PropertyFilterCondition("FireRating", "eq", "30MIN"),
            PropertyFilterCondition("FireRating", "eq", "2h"),
        ],
        logic="or",
        ifc_types=["IfcWall"],
    )
    assert result["count"] == 2
    assert result["element_ids"] == [10, 11]


def test_exists_not_exists_and_storey_scope_have_explicit_missing_semantics():
    index = PropertyFilterIndex()
    exists = query(
        index,
        [PropertyFilterCondition("FireRating", "exists")],
        storeys=["level 2"],
    )
    missing = query(
        index,
        [PropertyFilterCondition("FireRating", "not_exists")],
        storeys=["LEVEL 2"],
    )
    assert exists["element_ids"] == [12]
    assert missing["element_ids"] == [13]


def test_pset_scope_and_ifc_identity_attributes_are_indexed():
    index = PropertyFilterIndex()
    scoped = query(index, [
        PropertyFilterCondition("FireRating", "eq", "2h", "Pset_DoorCommon")
    ])
    by_name = query(index, [PropertyFilterCondition("Name", "contains", "external", "IFC")])
    assert scoped["element_ids"] == [12]
    assert by_name["element_ids"] == [10]


def test_neq_requires_property_to_exist_and_not_exists_handles_missing():
    result = query(PropertyFilterIndex(), [
        PropertyFilterCondition("FireRating", "neq", "2h")
    ])
    assert result["element_ids"] == [11]


def test_exact_count_is_kept_when_ids_are_bounded():
    result = query(
        PropertyFilterIndex(),
        [PropertyFilterCondition("Name", "exists", pset_name="IFC")],
        max_result_ids=2,
        detail_limit=1,
    )
    assert result["count"] == 4
    assert result["truncated"] is True
    assert len(result["element_ids"]) == 2
    assert len(result["elements"]) == 1


def test_index_reuses_same_model_version_and_rebuilds_after_revision():
    index = PropertyFilterIndex()
    model = make_model()
    first = query(index, [PropertyFilterCondition("Name", "exists")], model=model, model_version=1)
    assert index.element_count == 4
    assert first["index_cached"] is False
    model.by_type = lambda _name: []
    cached = query(index, [PropertyFilterCondition("Name", "exists")], model=model, model_version=1)
    assert index.element_count == 4
    assert cached["index_cached"] is True
    rebuilt = query(index, [PropertyFilterCondition("Name", "exists")], model=model, model_version=2)
    assert index.element_count == 0
    assert rebuilt["index_cached"] is False


def test_type_property_sets_and_enumeration_items_are_indexed():
    entity = FakeEntity(20, "IfcDoor", "Typed door", "Level 1", [])
    occurrence_pset = FakePset("Pset_DoorCommon", {})
    occurrence_pset.HasProperties = [
        FakeEnumeratedProperty("Status", ["NEW", "EXISTING"]),
    ]
    entity.IsDefinedBy = [FakeRelation(occurrence_pset)]
    entity.IsTypedBy = [
        FakeTypeRelation(FakeTypeObject([FakePset("Manufacturer", {"Model": "D-42"})]))
    ]
    model = SimpleNamespace(by_type=lambda _name: [entity])
    index = PropertyFilterIndex()

    enum_result = query(
        index,
        [PropertyFilterCondition("Status", "eq", "existing", "Pset_DoorCommon")],
        model=model,
    )
    type_result = query(
        index,
        [PropertyFilterCondition("Model", "eq", "d-42", "Manufacturer")],
        model=model,
    )

    assert enum_result["element_ids"] == [20]
    assert type_result["element_ids"] == [20]


def test_physical_quantities_are_available_to_numeric_filters():
    entity = FakeEntity(21, "IfcSlab", "Measured slab", "Level 1", [])
    quantity_set = FakeElementQuantity(
        "BaseQuantities",
        [FakeQuantity("GrossArea", 64.5)],
    )
    entity.IsDefinedBy = [FakeRelation(quantity_set)]
    model = SimpleNamespace(by_type=lambda _name: [entity])

    result = query(
        PropertyFilterIndex(),
        [PropertyFilterCondition("GrossArea", "gte", "64", "BaseQuantities")],
        model=model,
    )

    assert result["element_ids"] == [21]


def test_rebuild_publishes_a_new_snapshot_without_mutating_old_references():
    index = PropertyFilterIndex()
    model = make_model()
    old_snapshot, _ = index.ensure(model, 1, lambda entity: entity.storey)
    model.by_type = lambda _name: []
    new_snapshot, _ = index.ensure(model, 2, lambda entity: entity.storey)

    assert len(old_snapshot.elements) == 4
    assert len(new_snapshot.elements) == 0
    with pytest.raises(TypeError):
        old_snapshot.ids_by_property[(None, "name")] = frozenset()  # type: ignore[index]


def test_storey_resolution_failure_does_not_drop_otherwise_valid_elements():
    index = PropertyFilterIndex()

    def fail_storey(_entity):
        raise RuntimeError("bad containment inverse")

    result = index.query(
        model=make_model(),
        model_version=1,
        storey_resolver=fail_storey,
        conditions=[PropertyFilterCondition("Name", "exists")],
    )

    assert result["count"] == 4
    assert all(element["storey"] is None for element in result["elements"])


@pytest.mark.parametrize("value", ["nan", "inf", "not-a-number"])
def test_numeric_operators_reject_non_finite_targets(value: str):
    with pytest.raises(ValueError, match="finite numeric"):
        query(PropertyFilterIndex(), [PropertyFilterCondition("GrossArea", "gt", value)])


def test_condition_rejects_unknown_operator():
    element = SimpleNamespace(properties=())
    with pytest.raises(ValueError, match="Unsupported"):
        condition_matches(
            element,
            PropertyFilterCondition("Name", "regex", "wall"),  # type: ignore[arg-type]
        )
