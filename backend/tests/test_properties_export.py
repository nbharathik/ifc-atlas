"""Tests for the full-model properties CSV export (ifc_service.export_properties_csv).

All mutation tests use the `svc` fixture from conftest.py (fresh IfcService
loaded from BasicHouse.ifc per-test).  Functional checks only - we confirm
column shape and row counts, not exact cell values, so the tests stay stable
across IfcOpenShell updates.
"""
import csv
import io

import pytest

# Uses the conftest `svc` fixture which loads BasicHouse.ifc via IfcOpenShell.
# Skipped by the fast pre-flight: pytest -m "not requires_ifc_load".
pytestmark = pytest.mark.requires_ifc_load


# ──────────────────────────────────────────────────────────────────────────────
# CSV shape tests (live BasicHouse.ifc via `svc` fixture)
# ──────────────────────────────────────────────────────────────────────────────

class TestExportPropertiesCsv:
    def test_returns_string(self, svc):
        result = svc.export_properties_csv()
        assert isinstance(result, str)

    def test_has_required_fixed_columns(self, svc):
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        header = reader.fieldnames or []
        for col in ("express_id", "global_id", "name", "ifc_type", "storey"):
            assert col in header, f"Missing column: {col}"

    def test_has_pset_columns(self, svc):
        """BasicHouse.ifc has Pset_WallCommon - at least one dot-notation column expected."""
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        header = reader.fieldnames or []
        pset_cols = [c for c in header if "." in c and not c.startswith("Qty.")]
        assert len(pset_cols) > 0, "Expected at least one Pset column (e.g. Pset_WallCommon.Reference)"

    def test_row_count_matches_element_count(self, svc):
        stats = svc.get_model_stats()
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        assert len(rows) == stats.total_elements

    def test_ifc_type_filter(self, svc):
        """by_type("IfcWall") includes subtypes like IfcWallStandardCase."""
        result = svc.export_properties_csv(ifc_type="IfcWall")
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        assert len(rows) > 0
        # by_type includes subtypes - IfcWallStandardCase is-a IfcWall
        for row in rows:
            assert "wall" in row["ifc_type"].lower(), (
                f"Expected a wall subtype, got: {row['ifc_type']!r}"
            )

    def test_no_opening_elements_in_default_export(self, svc):
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        types = {row["ifc_type"] for row in reader}
        assert "IfcOpeningElement" not in types

    def test_all_rows_have_express_id(self, svc):
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        for row in reader:
            assert row["express_id"].isdigit()

    def test_max_elements_cap(self, svc):
        result = svc.export_properties_csv(max_elements=5)
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        assert len(rows) <= 5

    def test_include_quantities_adds_qty_columns(self, svc):
        result = svc.export_properties_csv(include_quantities=True)
        reader = csv.DictReader(io.StringIO(result))
        header = reader.fieldnames or []
        qty_cols = [c for c in header if c.startswith("Qty.")]
        # BasicHouse.ifc contains IfcElementQuantity - at least one Qty column expected
        assert len(qty_cols) > 0, "Expected at least one Qty.* column with include_quantities=True"

    def test_no_qty_columns_by_default(self, svc):
        result = svc.export_properties_csv(include_quantities=False)
        reader = csv.DictReader(io.StringIO(result))
        header = reader.fieldnames or []
        qty_cols = [c for c in header if c.startswith("Qty.")]
        assert len(qty_cols) == 0

    def test_empty_pset_value_is_empty_string(self, svc):
        """Rows for elements without a particular pset must have '' not 'None'."""
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        for row in rows:
            for val in row.values():
                assert val != "None", f"Unexpected literal 'None' in CSV: {val!r}"


# ──────────────────────────────────────────────────────────────────────────────
# Mocked unit tests (no IFC file required)
# ──────────────────────────────────────────────────────────────────────────────

class TestExportPropertiesCsvMocked:
    def _make_model_and_service(self):
        from unittest.mock import MagicMock, patch
        from app.services.ifc_service import IfcService

        svc = IfcService()
        svc._persist_model = lambda: None

        pset = MagicMock()
        pset.is_a = lambda t=None: "IfcPropertySet" if t is None else t == "IfcPropertySet"
        pset.Name = "TestPset"
        prop = MagicMock()
        prop.is_a = lambda t=None: "IfcPropertySingleValue" if t is None else t == "IfcPropertySingleValue"
        prop.Name = "MyProp"
        nom = MagicMock()
        nom.wrappedValue = "hello"
        prop.NominalValue = nom
        pset.HasProperties = [prop]

        rel = MagicMock()
        rel.is_a = lambda t=None: "IfcRelDefinesByProperties" if t is None else t == "IfcRelDefinesByProperties"
        rel.RelatingPropertyDefinition = pset

        entity = MagicMock()
        entity.id = lambda: 42
        entity.is_a = lambda t=None: "IfcWall" if t is None else t == "IfcWall"
        entity.GlobalId = "GUID-W-1"
        entity.Name = "TestWall"
        entity.IsDefinedBy = [rel]

        mock_model = MagicMock()
        mock_model.by_type.side_effect = lambda t: [entity] if t in ("IfcProduct", "IfcWall") else []
        svc._model = mock_model

        return svc

    def test_single_entity_pset_value(self):
        svc = self._make_model_and_service()
        result = svc.export_properties_csv()
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        assert len(rows) == 1
        assert rows[0]["name"] == "TestWall"
        assert rows[0]["TestPset.MyProp"] == "hello"

    def test_type_filter_uses_by_type(self):
        svc = self._make_model_and_service()
        result = svc.export_properties_csv(ifc_type="IfcWall")
        reader = csv.DictReader(io.StringIO(result))
        rows = list(reader)
        assert len(rows) == 1
        assert rows[0]["ifc_type"] == "IfcWall"
