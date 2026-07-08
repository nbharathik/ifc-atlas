"""
Tests for IDS service v2 - ifctester engine + CSV export.

All tests are pure Python / in-memory IfcOpenShell models.  No disk IFC
file is loaded, so no SIGSEGV risk on Windows / Python 3.13.
"""

from __future__ import annotations

import base64

import pytest


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _make_ids_xml(
    title: str = "Test IDS",
    spec_name: str = "Wall Fire Rating",
    ifc_type: str = "IfcWall",
    pset: str = "Pset_WallCommon",
    prop: str = "FireRating",
    prop_value: str | None = None,
) -> str:
    """Build a minimal IDS 1.0 XML with one Property requirement via ifctester API."""
    import ifctester.ids as ids_mod
    import ifctester.facet as f

    ids = ids_mod.Ids(title=title)
    spec = ids_mod.Specification(
        name=spec_name, ifcVersion=["IFC2X3", "IFC4", "IFC4X3_ADD2"]
    )
    spec.applicability.append(f.Entity(name=ifc_type))
    prop_facet = f.Property(propertySet=pset, baseName=prop, dataType="IFCLABEL")
    if prop_value is not None:
        prop_facet.value = prop_value
    spec.requirements.append(prop_facet)
    ids.specifications.append(spec)
    return ids.to_string()


def _empty_model():
    """Return an empty in-memory ifcopenshell model."""
    import ifcopenshell
    return ifcopenshell.file()


def _model_with_wall(name: str = "TestWall"):
    """Return an ifcopenshell model containing one IfcWall (no properties)."""
    import ifcopenshell
    import ifcopenshell.guid

    model = ifcopenshell.file()
    model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name=name)
    return model


# ─────────────────────────────────────────────────────────────────────
# IDS engine detection
# ─────────────────────────────────────────────────────────────────────

def test_ids_engine_is_ifctester():
    from app.services.ids_service import IDS_ENGINE
    assert IDS_ENGINE == "ifctester", "ifctester should be installed in this environment"


# ─────────────────────────────────────────────────────────────────────
# parse_ids_info - no model required
# ─────────────────────────────────────────────────────────────────────

def test_parse_ids_info_returns_title():
    from app.services.ids_service import parse_ids_info
    xml = _make_ids_xml(title="My BIM Standard")
    info = parse_ids_info(xml)
    assert info["title"] == "My BIM Standard"


def test_parse_ids_info_spec_count():
    from app.services.ids_service import parse_ids_info
    xml = _make_ids_xml()
    info = parse_ids_info(xml)
    assert info["specifications_count"] == 1


def test_parse_ids_info_invalid_xml():
    from app.services.ids_service import parse_ids_info
    info = parse_ids_info("not xml at all <<<")
    assert info == {}


# ─────────────────────────────────────────────────────────────────────
# validate_ids - empty model (no applicable entities)
# ─────────────────────────────────────────────────────────────────────

def test_validate_empty_model_no_applicable():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml()
    report = validate_ids(_empty_model(), xml)
    assert report["total_specifications"] == 1
    assert report["no_applicable"] == 1
    assert report["passed"] == 0
    assert report["failed"] == 0


def test_validate_empty_model_spec_status():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml()
    report = validate_ids(_empty_model(), xml)
    spec = report["specifications"][0]
    assert spec["status"] == "no_applicable"
    assert spec["applied_to"] == 0


def test_validate_report_has_engine_field():
    from app.services.ids_service import validate_ids
    report = validate_ids(_empty_model(), _make_ids_xml())
    assert report["engine"] == "ifctester"


def test_validate_report_top_level_keys():
    from app.services.ids_service import validate_ids
    report = validate_ids(_empty_model(), _make_ids_xml())
    for key in ("total_specifications", "passed", "failed", "no_applicable",
                "specifications", "ids_title", "engine"):
        assert key in report, f"Missing key: {key}"


def test_validate_spec_has_applicability_and_requirements():
    from app.services.ids_service import validate_ids
    report = validate_ids(_empty_model(), _make_ids_xml())
    spec = report["specifications"][0]
    assert "applicability" in spec
    assert "requirements" in spec
    assert spec["applicability"][0]["facet_type"] == "Entity"
    assert spec["requirements"][0]["facet_type"] == "Property"


def test_validate_ids_title_propagated():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml(title="Structural Requirements v3")
    report = validate_ids(_empty_model(), xml)
    assert report["ids_title"] == "Structural Requirements v3"


# ─────────────────────────────────────────────────────────────────────
# validate_ids - model with a wall (property missing → failure)
# ─────────────────────────────────────────────────────────────────────

def test_validate_wall_missing_property_fails():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml()
    report = validate_ids(_model_with_wall(), xml)
    assert report["failed"] == 1
    spec = report["specifications"][0]
    assert spec["status"] == "failed"
    assert spec["applied_to"] == 1
    assert spec["failed"] == 1


def test_validate_failing_element_has_facet_type():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml()
    report = validate_ids(_model_with_wall(), xml)
    spec = report["specifications"][0]
    failing = spec["failing_elements"]
    assert len(failing) == 1
    assert failing[0]["facet_type"] == "Property"
    assert failing[0]["ifc_type"] == "IfcWall"


def test_validate_failing_element_has_reason():
    from app.services.ids_service import validate_ids
    xml = _make_ids_xml()
    report = validate_ids(_model_with_wall(), xml)
    spec = report["specifications"][0]
    reason = spec["failing_elements"][0]["reason"]
    assert isinstance(reason, str) and len(reason) > 0


def test_validate_limit_per_spec():
    """limit_per_spec caps the failing_elements list."""
    import ifcopenshell
    import ifcopenshell.guid
    from app.services.ids_service import validate_ids

    model = ifcopenshell.file()
    for _ in range(5):
        model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="Wall")

    xml = _make_ids_xml()
    report = validate_ids(model, xml, limit_per_spec=2)
    spec = report["specifications"][0]
    assert len(spec["failing_elements"]) == 2
    assert spec["failing_truncated"] is True


# ─────────────────────────────────────────────────────────────────────
# validate_ids - invalid XML
# ─────────────────────────────────────────────────────────────────────

def test_validate_invalid_xml_raises_value_error():
    from app.services.ids_service import validate_ids
    with pytest.raises(ValueError, match="[Ii]nvalid"):
        validate_ids(_empty_model(), "<not-valid-ids>")


# ─────────────────────────────────────────────────────────────────────
# validate_ids_base64
# ─────────────────────────────────────────────────────────────────────

def test_validate_base64_roundtrip():
    from app.services.ids_service import validate_ids_base64
    xml = _make_ids_xml()
    b64 = base64.b64encode(xml.encode()).decode()
    report = validate_ids_base64(_empty_model(), b64)
    assert report["total_specifications"] == 1
    assert report["engine"] == "ifctester"


def test_validate_base64_bad_encoding():
    from app.services.ids_service import validate_ids_base64
    with pytest.raises(ValueError, match="base64"):
        validate_ids_base64(_empty_model(), "!!!not-base64!!!")


# ─────────────────────────────────────────────────────────────────────
# CSV export
# ─────────────────────────────────────────────────────────────────────

def test_csv_no_failures_has_only_header():
    from app.services.ids_service import validate_ids_to_csv
    xml = _make_ids_xml()
    csv_text = validate_ids_to_csv(_empty_model(), xml)
    lines = [l for l in csv_text.strip().splitlines() if l]
    assert len(lines) == 1  # only header row
    assert "spec_name" in lines[0]
    assert "express_id" in lines[0]
    assert "facet_type" in lines[0]


def test_csv_failures_appear_as_rows():
    from app.services.ids_service import validate_ids_to_csv
    xml = _make_ids_xml()
    csv_text = validate_ids_to_csv(_model_with_wall(), xml)
    lines = [l for l in csv_text.strip().splitlines() if l]
    assert len(lines) == 2  # header + 1 failure row
    data_row = lines[1]
    assert "Wall Fire Rating" in data_row
    assert "Property" in data_row


def test_csv_columns_count():
    from app.services.ids_service import validate_ids_to_csv
    xml = _make_ids_xml()
    csv_text = validate_ids_to_csv(_model_with_wall(), xml)
    import csv, io
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    assert len(rows[0]) == 7  # spec_name, express_id, global_id, ifc_type, name, facet_type, reason


def test_csv_base64_export():
    from app.services.ids_service import validate_ids_base64_to_csv
    xml = _make_ids_xml()
    b64 = base64.b64encode(xml.encode()).decode()
    csv_text = validate_ids_base64_to_csv(_empty_model(), b64)
    assert "spec_name" in csv_text


# ─────────────────────────────────────────────────────────────────────
# Legacy compatibility - v0 field shape still present
# ─────────────────────────────────────────────────────────────────────

def test_legacy_ifc_type_field_present():
    """ifc_type field on spec dict is preserved for backwards compatibility."""
    from app.services.ids_service import validate_ids
    report = validate_ids(_empty_model(), _make_ids_xml(ifc_type="IfcWall"))
    spec = report["specifications"][0]
    assert "ifc_type" in spec
    assert spec["ifc_type"] == "IfcWall"


def test_legacy_passing_count_is_zero_when_no_applicable():
    from app.services.ids_service import validate_ids
    report = validate_ids(_empty_model(), _make_ids_xml())
    spec = report["specifications"][0]
    assert spec["passed"] == 0
    assert spec["failed"] == 0
