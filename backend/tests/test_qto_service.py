"""Tests for app.services.qto_service.

All models are authored in memory with ifcopenshell.api - no disk IFC file is
loaded, so the suite stays fast and avoids the Windows / Python 3.13 loader
crash risk.
"""

from __future__ import annotations

import csv
import io

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import pytest

from app.services import qto_service
from app.services.qto_service import compute_qto, qto_to_csv


@pytest.fixture(autouse=True)
def _clear_qto_cache():
    """The result cache is module-level state; isolate it per test."""
    qto_service._RESULT_CACHE.clear()
    yield
    qto_service._RESULT_CACHE.clear()


# ---------------------------------------------------------------------------
# Model-authoring helpers
# ---------------------------------------------------------------------------


def _api(verb: str, model, **kwargs):
    return ifcopenshell.api.run(verb, model, **kwargs)


def _new_project(length_prefix: str | None = None):
    """IFC4 model with a project and explicit SI units.

    length_prefix=None gives metres; "MILLI" gives millimetres (the unit
    scale ifcopenshell reports is then 0.001).
    """
    model = ifcopenshell.file(schema="IFC4")
    project = _api("root.create_entity", model, ifc_class="IfcProject", name="QTO Test")
    length = model.create_entity(
        "IfcSIUnit", UnitType="LENGTHUNIT", Prefix=length_prefix, Name="METRE"
    )
    area = model.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE")
    volume = model.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE")
    project.UnitsInContext = model.create_entity(
        "IfcUnitAssignment", Units=[length, area, volume]
    )
    site = _api("root.create_entity", model, ifc_class="IfcSite", name="Site")
    building = _api("root.create_entity", model, ifc_class="IfcBuilding", name="Building")
    _api("aggregate.assign_object", model, products=[site], relating_object=project)
    _api("aggregate.assign_object", model, products=[building], relating_object=site)
    return model, building


def _add_storey(model, building, name: str):
    storey = _api("root.create_entity", model, ifc_class="IfcBuildingStorey", name=name)
    _api("aggregate.assign_object", model, products=[storey], relating_object=building)
    return storey


def _add_element(
    model,
    storey,
    ifc_class: str,
    name: str,
    quantities: dict | None = None,
    qto_name: str = "Qto_WallBaseQuantities",
):
    element = _api("root.create_entity", model, ifc_class=ifc_class, name=name)
    if storey is not None:
        _api("spatial.assign_container", model, products=[element], relating_structure=storey)
    if quantities:
        qto = _api("pset.add_qto", model, product=element, name=qto_name)
        _api("pset.edit_qto", model, qto=qto, properties=quantities)
    return element


def _classify(model, element, system_name: str = "Uniclass", identification: str = "EF_25_10"):
    classification = model.create_entity("IfcClassification", Name=system_name)
    reference = model.create_entity(
        "IfcClassificationReference",
        Identification=identification,
        Name="Walls",
        ReferencedSource=classification,
    )
    model.create_entity(
        "IfcRelAssociatesClassification",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[element],
        RelatingClassification=reference,
    )


def _build_house():
    """Two storeys, three walls, one slab.

    Ground Floor: W1 + W2 (quantities, Concrete, type WT-200; W1 classified),
    slab S1 (quantities, layer-set material "Brick Wall 100").
    First Floor: W3 (no quantities, no material, no type).
    """
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    first = _add_storey(model, building, "First Floor")

    concrete = _api("material.add_material", model, name="Concrete")
    wall_type = _api("root.create_entity", model, ifc_class="IfcWallType", name="WT-200")

    wall1 = _add_element(
        model, ground, "IfcWall", "W1",
        {"NetVolume": 2.0, "GrossSideArea": 8.0, "Length": 4.0},
    )
    wall2 = _add_element(
        model, ground, "IfcWall", "W2",
        {"NetVolume": 3.0, "GrossSideArea": 10.0, "Length": 5.0},
    )
    _add_element(model, first, "IfcWall", "W3")

    _api("material.assign_material", model, products=[wall1, wall2], material=concrete)
    _api("type.assign_type", model, related_objects=[wall1, wall2], relating_type=wall_type)
    _classify(model, wall1)

    slab = _add_element(
        model, ground, "IfcSlab", "S1",
        {"GrossVolume": 6.0, "NetArea": 20.0, "Perimeter": 18.0},
        qto_name="Qto_SlabBaseQuantities",
    )
    brick = model.create_entity("IfcMaterial", Name="Brick")
    layer = model.create_entity("IfcMaterialLayer", Material=brick, LayerThickness=0.1)
    layer_set = model.create_entity(
        "IfcMaterialLayerSet", MaterialLayers=[layer], LayerSetName="Brick Wall 100"
    )
    usage = model.create_entity(
        "IfcMaterialLayerSetUsage",
        ForLayerSet=layer_set,
        LayerSetDirection="AXIS2",
        DirectionSense="POSITIVE",
        OffsetFromReferenceLine=0.0,
    )
    model.create_entity(
        "IfcRelAssociatesMaterial",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[slab],
        RelatingMaterial=usage,
    )
    return model


def _group_map(result: dict) -> dict[str, dict]:
    return {group["label"]: group for group in result["groups"]}


# ---------------------------------------------------------------------------
# Grouping by each supported key
# ---------------------------------------------------------------------------


def test_group_by_ifc_class():
    result = compute_qto(_build_house(), ["ifc_class"])
    counts = {g["label"]: g["count"] for g in result["groups"]}
    assert counts == {"IfcWall": 3, "IfcSlab": 1}
    # Sorted by count descending.
    assert result["groups"][0]["label"] == "IfcWall"
    assert result["groups"][0]["key"] == {"ifc_class": "IfcWall"}
    assert result["group_by"] == ["ifc_class"]


def test_group_by_storey():
    result = compute_qto(_build_house(), ["storey"])
    counts = {g["label"]: g["count"] for g in result["groups"]}
    assert counts == {"Ground Floor": 3, "First Floor": 1}


def test_group_by_material():
    result = compute_qto(_build_house(), ["material"])
    counts = {g["label"]: g["count"] for g in result["groups"]}
    assert counts == {"Concrete": 2, "Brick Wall 100": 1, "No material": 1}


def test_group_by_type_object():
    result = compute_qto(_build_house(), ["type_object"])
    counts = {g["label"]: g["count"] for g in result["groups"]}
    assert counts == {"WT-200": 2, "No type": 2}


def test_group_by_classification():
    result = compute_qto(_build_house(), ["classification"])
    counts = {g["label"]: g["count"] for g in result["groups"]}
    assert counts == {"Uniclass.EF_25_10": 1, "Unclassified": 3}


def test_multi_key_grouping_preserves_order():
    result = compute_qto(_build_house(), ["ifc_class", "storey"])
    assert result["group_by"] == ["ifc_class", "storey"]
    top = result["groups"][0]
    assert top["key"] == {"ifc_class": "IfcWall", "storey": "Ground Floor"}
    assert top["label"] == "IfcWall / Ground Floor"
    assert top["count"] == 2
    assert len(result["groups"]) == 3


# ---------------------------------------------------------------------------
# Sums, coverage, priorities, overall
# ---------------------------------------------------------------------------


def test_quantity_sums_and_coverage():
    result = compute_qto(_build_house(), ["ifc_class"])
    wall = _group_map(result)["IfcWall"]
    assert wall["quantities"]["volume_m3"] == pytest.approx(5.0)
    assert wall["quantities"]["area_m2"] == pytest.approx(18.0)
    assert wall["quantities"]["length_m"] == pytest.approx(9.0)
    # W3 has no quantities, so only 2 of the 3 walls contribute.
    assert wall["coverage"] == {"volume": 2, "area": 2, "length": 2}

    slab = _group_map(result)["IfcSlab"]
    assert slab["quantities"]["volume_m3"] == pytest.approx(6.0)
    assert slab["quantities"]["area_m2"] == pytest.approx(20.0)
    assert slab["quantities"]["length_m"] == pytest.approx(18.0)  # Perimeter
    assert slab["coverage"] == {"volume": 1, "area": 1, "length": 1}


def test_zero_coverage_group_reports_zero_quantities():
    result = compute_qto(_build_house(), ["ifc_class", "storey"])
    upper = _group_map(result)["IfcWall / First Floor"]
    assert upper["coverage"] == {"volume": 0, "area": 0, "length": 0}
    assert upper["quantities"] == {"volume_m3": 0.0, "area_m2": 0.0, "length_m": 0.0}


def test_overall_totals():
    result = compute_qto(_build_house(), ["ifc_class"])
    assert result["overall"]["count"] == 4
    assert result["overall"]["quantities"]["volume_m3"] == pytest.approx(11.0)
    assert result["overall"]["quantities"]["area_m2"] == pytest.approx(38.0)
    assert result["overall"]["quantities"]["length_m"] == pytest.approx(27.0)
    assert result["truncated"] is False
    assert isinstance(result["elapsed_ms"], float)
    assert result["elapsed_ms"] >= 0.0


def test_quantity_name_priorities():
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    _add_element(
        model, ground, "IfcWall", "W",
        {
            "GrossVolume": 7.0,
            "NetVolume": 2.0,
            "GrossSideArea": 8.0,
            "NetSideArea": 5.0,
            "Length": 4.0,
            "Height": 3.0,
        },
    )
    result = compute_qto(model, ["ifc_class"])
    quantities = result["groups"][0]["quantities"]
    assert quantities["volume_m3"] == pytest.approx(2.0)  # NetVolume beats GrossVolume
    assert quantities["area_m2"] == pytest.approx(8.0)  # GrossSideArea beats NetSideArea
    assert quantities["length_m"] == pytest.approx(4.0)  # Length beats Height


def test_unit_scaling_uses_declared_unit_per_measure_type():
    """Millimetre lengths with SI area/volume units: only lengths rescale.

    This is the common authoring style (and the BasicHouse fixture's): the
    project declares LENGTHUNIT=mm but AREAUNIT=SQUARE_METRE and
    VOLUMEUNIT=CUBIC_METRE. Deriving the area/volume scales from the length
    unit (s**2 / s**3) would wrongly collapse those values by 1e6 / 1e9.
    """
    model, building = _new_project(length_prefix="MILLI")
    ground = _add_storey(model, building, "Ground Floor")
    _add_element(
        model, ground, "IfcWall", "W",
        {"NetVolume": 2.5, "GrossSideArea": 9.0, "Length": 4000.0},
    )
    result = compute_qto(model, ["ifc_class"])
    quantities = result["groups"][0]["quantities"]
    assert quantities["volume_m3"] == pytest.approx(2.5)
    assert quantities["area_m2"] == pytest.approx(9.0)
    assert quantities["length_m"] == pytest.approx(4.0)


# ---------------------------------------------------------------------------
# Element population
# ---------------------------------------------------------------------------


def test_population_keeps_space_drops_excluded_classes():
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    _add_element(model, ground, "IfcWall", "W")
    space = _api("root.create_entity", model, ifc_class="IfcSpace", name="Room 1")
    _api("aggregate.assign_object", model, products=[space], relating_object=ground)
    for ifc_class in ("IfcOpeningElement", "IfcAnnotation", "IfcGrid", "IfcVirtualElement"):
        _api("root.create_entity", model, ifc_class=ifc_class, name=ifc_class)

    result = compute_qto(model, ["ifc_class"])
    assert result["overall"]["count"] == 2
    assert {g["label"] for g in result["groups"]} == {"IfcWall", "IfcSpace"}


def test_space_resolves_storey_via_aggregation():
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    space = _api("root.create_entity", model, ifc_class="IfcSpace", name="Room 1")
    _api("aggregate.assign_object", model, products=[space], relating_object=ground)

    result = compute_qto(model, ["storey"])
    assert result["groups"][0]["label"] == "Ground Floor"
    assert result["groups"][0]["count"] == 1


def test_uncontained_element_gets_no_storey_label():
    model, _building = _new_project()
    _add_element(model, None, "IfcWall", "Floating")
    result = compute_qto(model, ["storey"])
    assert result["groups"][0]["label"] == "No storey"


def test_constituent_set_falls_back_to_first_material_name():
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    wall = _add_element(model, ground, "IfcWall", "W")
    steel = model.create_entity("IfcMaterial", Name="Steel")
    constituent = model.create_entity("IfcMaterialConstituent", Name="Core", Material=steel)
    constituent_set = model.create_entity(
        "IfcMaterialConstituentSet", MaterialConstituents=[constituent]
    )
    model.create_entity(
        "IfcRelAssociatesMaterial",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[wall],
        RelatingMaterial=constituent_set,
    )
    result = compute_qto(model, ["material"])
    assert result["groups"][0]["label"] == "Steel"


# ---------------------------------------------------------------------------
# Caps, ids, validation
# ---------------------------------------------------------------------------


def test_include_ids_and_capping():
    model = _build_house()
    result = compute_qto(model, ["ifc_class"], include_ids=True)
    wall_ids = _group_map(result)["IfcWall"]["element_ids"]
    assert len(wall_ids) == 3
    assert all(isinstance(express_id, int) for express_id in wall_ids)

    without = compute_qto(model, ["ifc_class"])
    assert "element_ids" not in without["groups"][0]

    capped = compute_qto(model, ["ifc_class"], include_ids=True, max_ids_per_group=2)
    assert len(_group_map(capped)["IfcWall"]["element_ids"]) == 2
    assert _group_map(capped)["IfcWall"]["count"] == 3  # count unaffected by id cap


def test_group_capping_sets_truncated():
    result = compute_qto(_build_house(), ["ifc_class", "storey"], max_groups=2)
    assert len(result["groups"]) == 2
    assert result["truncated"] is True
    # The biggest groups are kept.
    assert result["groups"][0]["count"] >= result["groups"][1]["count"]


def test_invalid_group_by_raises():
    model = _build_house()
    with pytest.raises(ValueError):
        compute_qto(model, [])
    with pytest.raises(ValueError):
        compute_qto(model, ["bogus"])
    with pytest.raises(ValueError):
        compute_qto(model, ["ifc_class", "ifc_class"])


# ---------------------------------------------------------------------------
# Result cache
# ---------------------------------------------------------------------------


def test_cache_hit_returns_same_object():
    model = _build_house()
    first = compute_qto(model, ["ifc_class"], fingerprint="fp-a")
    second = compute_qto(model, ["ifc_class"], fingerprint="fp-a")
    assert second is first
    other_fingerprint = compute_qto(model, ["ifc_class"], fingerprint="fp-b")
    assert other_fingerprint is not first
    other_ids = compute_qto(model, ["ifc_class"], include_ids=True, fingerprint="fp-a")
    assert other_ids is not first


def test_no_fingerprint_bypasses_cache():
    model = _build_house()
    first = compute_qto(model, ["ifc_class"])
    second = compute_qto(model, ["ifc_class"])
    assert second is not first
    assert len(qto_service._RESULT_CACHE) == 0


def test_cache_evicts_oldest_beyond_eight():
    model, building = _new_project()
    ground = _add_storey(model, building, "Ground Floor")
    _add_element(model, ground, "IfcWall", "W")
    for index in range(9):
        compute_qto(model, ["ifc_class"], fingerprint=f"fp-{index}")
    assert len(qto_service._RESULT_CACHE) == 8
    cached_fingerprints = {key[0] for key in qto_service._RESULT_CACHE}
    assert "fp-0" not in cached_fingerprints
    assert "fp-8" in cached_fingerprints


# ---------------------------------------------------------------------------
# CSV rendering
# ---------------------------------------------------------------------------


def test_csv_header_and_rows():
    result = compute_qto(_build_house(), ["ifc_class", "storey"])
    rows = list(csv.reader(io.StringIO(qto_to_csv(result))))
    assert rows[0] == ["ifc_class", "storey", "count", "volume_m3", "area_m2", "length_m"]
    assert len(rows) == 1 + len(result["groups"])
    top = rows[1]
    assert top[0] == "IfcWall"
    assert top[1] == "Ground Floor"
    assert top[2] == "2"


def test_csv_blank_cells_for_zero_coverage():
    result = compute_qto(_build_house(), ["ifc_class", "storey"])
    rows = list(csv.reader(io.StringIO(qto_to_csv(result))))
    upper = next(r for r in rows[1:] if r[0] == "IfcWall" and r[1] == "First Floor")
    assert upper[3] == ""
    assert upper[4] == ""
    assert upper[5] == ""
