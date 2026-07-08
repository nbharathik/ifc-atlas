"""Tests for IFC5 storey compatibility fallback in IfcService.

IFC5 renames IfcBuildingStorey → IfcFacilityPart with PredefinedType="STOREY".
The helpers _is_storey_entity / _get_all_storeys / _get_storey must handle both.
All tests use mocked entities - no real IFC5 file required.
"""
from unittest.mock import MagicMock, patch

import pytest

from app.services.ifc_service import IfcService

# Two of the tests in this module use the conftest `svc` fixture (which loads
# BasicHouse.ifc via IfcOpenShell). The mocked-entity tests above don't strictly
# need the loader, but conftest's autouse `_reset_module_singletons` plus the
# module's IfcService import still pull in the segfault-prone branch on
# Windows + Python 3.13. Skipped by the fast pre-flight:
# pytest -m "not requires_ifc_load".
pytestmark = pytest.mark.requires_ifc_load


# ──────────────────────────────────────────────────────────────────────────────
# Helpers to build fake entities
# ──────────────────────────────────────────────────────────────────────────────

def _make_storey(name="Ground Floor"):
    e = MagicMock()
    e.is_a = lambda t=None: "IfcBuildingStorey" if t is None else t == "IfcBuildingStorey"
    e.Name = name
    e.id = lambda: 100
    e.GlobalId = "FAKE-GUID-STOREY"
    return e


def _make_facility_part(predefined_type="STOREY", name="Level 0"):
    e = MagicMock()
    e.is_a = lambda t=None: "IfcFacilityPart" if t is None else t == "IfcFacilityPart"
    e.PredefinedType = predefined_type
    e.Name = name
    e.id = lambda: 200
    e.GlobalId = "FAKE-GUID-FP"
    return e


def _fresh_service():
    svc = IfcService()
    # Patch _persist_model to no-op so we can manipulate _model directly
    svc._persist_model = lambda: None
    return svc


# ──────────────────────────────────────────────────────────────────────────────
# _is_storey_entity
# ──────────────────────────────────────────────────────────────────────────────

class TestIsStoreyEntity:
    def test_ifc4_building_storey(self):
        svc = _fresh_service()
        assert svc._is_storey_entity(_make_storey()) is True

    def test_ifc5_facility_part_storey(self):
        svc = _fresh_service()
        assert svc._is_storey_entity(_make_facility_part("STOREY")) is True

    def test_ifc5_facility_part_non_storey(self):
        svc = _fresh_service()
        assert svc._is_storey_entity(_make_facility_part("USERDEFINED")) is False

    def test_other_entity(self):
        svc = _fresh_service()
        wall = MagicMock()
        wall.is_a = lambda t=None: "IfcWall" if t is None else t == "IfcWall"
        assert svc._is_storey_entity(wall) is False

    def test_ifc5_case_insensitive(self):
        svc = _fresh_service()
        assert svc._is_storey_entity(_make_facility_part("storey")) is True


# ──────────────────────────────────────────────────────────────────────────────
# _get_all_storeys
# ──────────────────────────────────────────────────────────────────────────────

class TestGetAllStoreys:
    def test_returns_ifc4_storeys(self):
        svc = _fresh_service()
        storey = _make_storey()
        mock_model = MagicMock()
        mock_model.by_type.side_effect = lambda t: [storey] if t == "IfcBuildingStorey" else []
        svc._model = mock_model
        result = svc._get_all_storeys()
        assert result == [storey]

    def test_falls_back_to_ifc5_facility_part(self):
        svc = _fresh_service()
        fp = _make_facility_part("STOREY")
        mock_model = MagicMock()

        def by_type_side(t):
            if t == "IfcBuildingStorey":
                return []
            if t == "IfcFacilityPart":
                return [fp]
            return []

        mock_model.by_type.side_effect = by_type_side
        svc._model = mock_model
        result = svc._get_all_storeys()
        assert result == [fp]

    def test_ifc5_filters_non_storey_parts(self):
        svc = _fresh_service()
        fp_storey = _make_facility_part("STOREY", "Level 0")
        fp_other = _make_facility_part("TUNNEL", "Tunnel Section")
        mock_model = MagicMock()

        def by_type_side(t):
            if t == "IfcBuildingStorey":
                return []
            if t == "IfcFacilityPart":
                return [fp_storey, fp_other]
            return []

        mock_model.by_type.side_effect = by_type_side
        svc._model = mock_model
        result = svc._get_all_storeys()
        assert result == [fp_storey]

    def test_prefers_ifc4_when_both_present(self):
        """If IfcBuildingStorey exists, never check IfcFacilityPart."""
        svc = _fresh_service()
        storey = _make_storey()
        fp = _make_facility_part("STOREY")
        mock_model = MagicMock()

        def by_type_side(t):
            if t == "IfcBuildingStorey":
                return [storey]
            if t == "IfcFacilityPart":
                return [fp]
            return []

        mock_model.by_type.side_effect = by_type_side
        svc._model = mock_model
        result = svc._get_all_storeys()
        assert result == [storey]  # not [fp]


# ──────────────────────────────────────────────────────────────────────────────
# _get_storey (container lookup)
# ──────────────────────────────────────────────────────────────────────────────

class TestGetStoreyContainer:
    def test_ifc4_container(self):
        svc = _fresh_service()
        storey = _make_storey("Floor 1")
        entity = MagicMock()
        with patch("ifcopenshell.util.element.get_container", return_value=storey):
            assert svc._get_storey(entity) == "Floor 1"

    def test_ifc5_facility_part_container(self):
        svc = _fresh_service()
        fp = _make_facility_part("STOREY", "Level 0")
        entity = MagicMock()
        with patch("ifcopenshell.util.element.get_container", return_value=fp):
            assert svc._get_storey(entity) == "Level 0"

    def test_non_storey_container_returns_none(self):
        svc = _fresh_service()
        building = MagicMock()
        building.is_a = lambda t=None: "IfcBuilding" if t is None else t == "IfcBuilding"
        entity = MagicMock()
        with patch("ifcopenshell.util.element.get_container", return_value=building):
            assert svc._get_storey(entity) is None

    def test_no_container_returns_none(self):
        svc = _fresh_service()
        entity = MagicMock()
        with patch("ifcopenshell.util.element.get_container", return_value=None):
            assert svc._get_storey(entity) is None

    def test_exception_returns_none(self):
        svc = _fresh_service()
        entity = MagicMock()
        entity.id = lambda: 42
        with patch("ifcopenshell.util.element.get_container", side_effect=RuntimeError("bad")):
            assert svc._get_storey(entity) is None


# ──────────────────────────────────────────────────────────────────────────────
# Integration: get_storeys uses _get_all_storeys (live BasicHouse.ifc fixture)
# ──────────────────────────────────────────────────────────────────────────────

def test_get_storeys_returns_nonempty(svc):
    """With BasicHouse.ifc (IFC4), get_storeys must return at least one storey."""
    storeys = svc.get_storeys()
    assert len(storeys) >= 1
    for s in storeys:
        assert s.name is not None


def test_get_model_stats_storeys_nonempty(svc):
    """get_model_stats must include storey names from _get_all_storeys."""
    stats = svc.get_model_stats()
    assert len(stats.storeys) >= 1
