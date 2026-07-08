from __future__ import annotations

import pytest


pytestmark = pytest.mark.requires_ifc_load


def test_get_element_resolves_geometry_internal_id_to_owner(svc):
    detail = svc.get_element(624)

    assert detail.id == 634
    assert detail.ifc_type == "IfcWallStandardCase"
    assert detail.property_sets


def test_get_element_resolves_property_internal_id_to_owner(svc):
    detail = svc.get_element(696)

    assert detail.id == 634
    assert detail.ifc_type == "IfcWallStandardCase"
    assert any(pset.properties for pset in detail.property_sets)


def test_get_element_resolves_type_product_id_to_occurrence(svc):
    detail = svc.get_element(3719)

    assert detail.id == 3761
    assert detail.ifc_type == "IfcDoor"
    assert detail.property_sets
