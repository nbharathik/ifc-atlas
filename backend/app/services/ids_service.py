"""
IDS validation v2 - wraps ifctester for full IDS 1.0 support.

The public API is unchanged from v0 so all existing callers (tools.py,
ifc_routes.py, tests) continue to work without modification.

New additions:
  - validate_ids_to_csv(ifc_model, ids_xml)  - CSV of all failures
  - validate_ids_base64_to_csv(...)           - same, b64 input
  - parse_ids_info(ids_xml)                  - metadata-only parse
  - IDS_ENGINE constant - "ifctester" | "v0"

Engine selection: ifctester is used when available (it ships with
IfcOpenShell in our requirements.txt). v0 parser is kept as a fallback.
"""

from __future__ import annotations

import base64
import io
import csv
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────
# Engine selection
# ─────────────────────────────────────────────────────────────────────

try:
    import ifctester.ids as _ids_mod
    IDS_ENGINE: str = "ifctester"
except ImportError:
    _ids_mod = None  # type: ignore[assignment]
    IDS_ENGINE = "v0"
    logger.warning("ifctester not installed; IDS validation falls back to v0 parser")


# ─────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────

def validate_ids(ifc_model, ids_xml: str, limit_per_spec: int = 25) -> dict:
    """Validate *ifc_model* against a raw IDS XML string.

    Returns a plain-dict report safe to JSON-serialize.  Structure is
    backwards-compatible with v0 with the following additions per spec:

      - ``applicability``   - list of applicability facet summaries
      - ``requirements``    - list of requirement facet summaries (with facet_type)
      - ``description``     - spec description from the IDS header
      - ``ids_title``       - top-level <info><title> (root key)
      - ``no_applicable``   - count of specs with 0 applicable elements
      - ``engine``          - "ifctester" or "v0"

    Each failing element now also carries:

      - ``facet_type``  - "Property" | "Attribute" | "Classification" | "Material" | "PartOf"
    """
    if _ids_mod is not None:
        return _validate_with_ifctester(ifc_model, ids_xml, limit_per_spec)
    return _validate_v0(ifc_model, ids_xml, limit_per_spec)


def validate_ids_base64(ifc_model, ids_b64: str, limit_per_spec: int = 25) -> dict:
    """Validate from a base64-encoded IDS XML string."""
    raw = _decode_b64(ids_b64)
    return validate_ids(ifc_model, raw, limit_per_spec=limit_per_spec)


def validate_ids_to_csv(ifc_model, ids_xml: str) -> str:
    """Validate and return a CSV string of all failing elements.

    Columns: spec_name, express_id, global_id, ifc_type, facet_type, reason
    """
    report = validate_ids(ifc_model, ids_xml)
    return _report_to_csv(report)


def validate_ids_base64_to_csv(ifc_model, ids_b64: str) -> str:
    raw = _decode_b64(ids_b64)
    return validate_ids_to_csv(ifc_model, raw)


def extract_failing_ids(report: dict, spec_name: Optional[str] = None) -> list[int]:
    """Return deduplicated Express IDs of all failing elements in a report.

    If *spec_name* is given, returns IDs only from that specification.
    """
    seen: set[int] = set()
    for spec in report.get("specifications", []):
        if spec_name and spec.get("name") != spec_name:
            continue
        for elem in spec.get("failing_elements", []):
            eid = elem.get("id")
            if eid is not None:
                seen.add(int(eid))
    return list(seen)


def parse_ids_info(ids_xml: str) -> dict:
    """Parse the IDS header (title, author, description) without validation.

    Useful for showing IDS file metadata before running a full validation.
    Returns an empty dict on parse error.
    """
    if _ids_mod is not None:
        try:
            ids = _ids_mod.from_string(ids_xml)
            info = ids.info
            return {
                "title": info.get("title", ""),
                "description": info.get("description", ""),
                "author": info.get("author", ""),
                "version": info.get("version", ""),
                "date": info.get("date", ""),
                "specifications_count": len(ids.specifications),
            }
        except Exception:
            pass
    return {}


# ─────────────────────────────────────────────────────────────────────
# ifctester-based engine
# ─────────────────────────────────────────────────────────────────────

def _validate_with_ifctester(ifc_model, ids_xml: str, limit_per_spec: int) -> dict:
    try:
        ids = _ids_mod.from_string(ids_xml)
    except Exception as exc:
        raise ValueError(f"Invalid IDS XML: {exc}") from exc

    ids.validate(ifc_model)

    overall_passed = 0
    overall_failed = 0
    overall_na = 0
    report_specs: list[dict] = []

    for spec in ids.specifications:
        total_applied = len(spec.applicable_entities)
        failed_count = len(spec.failed_entities)
        passed_count = len(spec.passed_entities)

        if total_applied == 0:
            spec_status = "no_applicable"
            overall_na += 1
        elif failed_count == 0:
            spec_status = "passed"
            overall_passed += 1
        else:
            spec_status = "failed"
            overall_failed += 1

        # Collect failures per requirement facet
        failing: list[dict] = []
        for req in spec.requirements:
            facet_type = type(req).__name__  # "Property", "Attribute", etc.
            for failure in req.failures:
                elem = failure["element"]
                reason = failure["reason"]
                failing.append({
                    "id": elem.id(),
                    "global_id": getattr(elem, "GlobalId", None),
                    "ifc_type": elem.is_a(),
                    "name": getattr(elem, "Name", None),
                    "facet_type": facet_type,
                    "reason": reason,
                })

        failing_truncated = len(failing) > limit_per_spec
        failing = failing[:limit_per_spec]

        # Applicability facet summaries
        applicability = [_summarise_facet(f) for f in spec.applicability]

        # Requirements facet summaries
        requirements = [_summarise_facet(f) for f in spec.requirements]

        # Legacy compat: ifc_type / predefined_type from first entity applicability
        legacy_ifc_type = None
        legacy_pred_type = None
        for a in applicability:
            if a.get("facet_type") == "Entity":
                legacy_ifc_type = a.get("name")
                legacy_pred_type = a.get("predefined_type") or None
                break

        report_specs.append({
            # Legacy fields (unchanged)
            "name": spec.name,
            "ifc_type": legacy_ifc_type,
            "predefined_type": legacy_pred_type,
            "status": spec_status,
            "applied_to": total_applied,
            "passed": passed_count,
            "failed": failed_count,
            "requirements": requirements,
            "failing_elements": failing,
            "failing_truncated": failing_truncated,
            # v2 additions
            "description": spec.description or "",
            "applicability": applicability,
            "ifc_versions": (
                spec.ifcVersion if isinstance(spec.ifcVersion, list) else [spec.ifcVersion]
            ),
            "min_occurs": spec.minOccurs,
            "max_occurs": spec.maxOccurs,
        })

    return {
        "total_specifications": len(ids.specifications),
        "passed": overall_passed,
        "failed": overall_failed,
        "no_applicable": overall_na,
        "specifications": report_specs,
        "ids_title": ids.info.get("title", ""),
        "ids_version": ids.info.get("version", ""),
        "ids_description": ids.info.get("description", ""),
        "engine": "ifctester",
    }


def _summarise_facet(facet) -> dict:
    """Distil a facet object into a JSON-serialisable summary dict."""
    ft = type(facet).__name__
    base = {"facet_type": ft}
    if ft == "Entity":
        base["name"] = str(getattr(facet, "name", "") or "")
        base["predefined_type"] = str(getattr(facet, "predefinedType", "") or "")
    elif ft == "Property":
        base["property_set"] = str(getattr(facet, "propertySet", "") or "")
        base["name"] = str(getattr(facet, "baseName", "") or "")
        base["value"] = str(getattr(facet, "value", "") or "")
        base["data_type"] = str(getattr(facet, "dataType", "") or "")
    elif ft == "Attribute":
        base["name"] = str(getattr(facet, "name", "") or "")
        base["value"] = str(getattr(facet, "value", "") or "")
    elif ft == "Classification":
        base["system"] = str(getattr(facet, "system", "") or "")
        base["value"] = str(getattr(facet, "value", "") or "")
    elif ft == "Material":
        base["value"] = str(getattr(facet, "value", "") or "")
    elif ft == "PartOf":
        entity_attr = getattr(facet, "entity", None)
        base["entity"] = str(entity_attr or "")
        base["relation"] = str(getattr(facet, "relation", "") or "")
    return base


# ─────────────────────────────────────────────────────────────────────
# CSV export
# ─────────────────────────────────────────────────────────────────────

def _report_to_csv(report: dict) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        ["spec_name", "express_id", "global_id", "ifc_type", "name", "facet_type", "reason"]
    )
    for spec in report.get("specifications", []):
        spec_name = spec.get("name", "")
        for f in spec.get("failing_elements", []):
            writer.writerow([
                spec_name,
                f.get("id", ""),
                f.get("global_id", ""),
                f.get("ifc_type", ""),
                f.get("name", ""),
                f.get("facet_type", ""),
                f.get("reason", ""),
            ])
    return output.getvalue()


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _decode_b64(b64: str) -> str:
    try:
        return base64.b64decode(b64).decode("utf-8", errors="replace")
    except Exception as exc:
        raise ValueError(f"IDS attachment could not be base64-decoded: {exc}") from exc


# ─────────────────────────────────────────────────────────────────────
# v0 fallback parser (kept for environments without ifctester)
# ─────────────────────────────────────────────────────────────────────

_NS_RE = re.compile(r"\{[^}]+\}")


def _localname(tag: str) -> str:
    return _NS_RE.sub("", tag or "")


def _iter_children(node: ET.Element, name: str) -> Iterable[ET.Element]:
    for child in list(node):
        if _localname(child.tag) == name:
            yield child


def _first_child(node: ET.Element, name: str) -> Optional[ET.Element]:
    for child in _iter_children(node, name):
        return child
    return None


def _simple_value(node: Optional[ET.Element]) -> Optional[str]:
    if node is None:
        return None
    sv = _first_child(node, "simpleValue")
    if sv is not None and sv.text:
        return sv.text.strip()
    if node.text and node.text.strip():
        return node.text.strip()
    return None


@dataclass
class _PropertyRequirement:
    pset: str
    name: str
    expected_value: Optional[str]


@dataclass
class _Specification:
    name: str
    ifc_type: Optional[str]
    predefined_type: Optional[str]
    property_requirements: list[_PropertyRequirement] = field(default_factory=list)


def _parse_specification_v0(spec_node: ET.Element) -> Optional[_Specification]:
    name = spec_node.attrib.get("name", "(unnamed spec)")
    applicability = _first_child(spec_node, "applicability")
    requirements = _first_child(spec_node, "requirements")
    if applicability is None or requirements is None:
        return None

    entity = _first_child(applicability, "entity")
    ifc_type = None
    predefined_type = None
    if entity is not None:
        ifc_type = _simple_value(_first_child(entity, "name"))
        predefined_type = _simple_value(_first_child(entity, "predefinedType"))

    spec = _Specification(
        name=name,
        ifc_type=(ifc_type or "").upper() or None,
        predefined_type=predefined_type,
    )

    for prop_node in _iter_children(requirements, "property"):
        pset = _simple_value(_first_child(prop_node, "propertySet"))
        base_name = _simple_value(_first_child(prop_node, "baseName"))
        value = _simple_value(_first_child(prop_node, "value"))
        if pset and base_name:
            spec.property_requirements.append(
                _PropertyRequirement(pset=pset, name=base_name, expected_value=value)
            )

    return spec


def _parse_ids_v0(xml_text: str) -> list[_Specification]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise ValueError(f"Invalid IDS XML: {exc}") from exc

    if _localname(root.tag) == "ids":
        wrapper = _first_child(root, "specifications") or root
    else:
        wrapper = root

    specs: list[_Specification] = []
    for spec_node in _iter_children(wrapper, "specification"):
        parsed = _parse_specification_v0(spec_node)
        if parsed is not None:
            specs.append(parsed)
    return specs


def _collect_properties_v0(elem) -> dict[tuple[str, str], Any]:
    result: dict[tuple[str, str], Any] = {}
    if not hasattr(elem, "IsDefinedBy"):
        return result
    for rel in elem.IsDefinedBy or []:
        if not hasattr(rel, "RelatingPropertyDefinition"):
            continue
        pset = rel.RelatingPropertyDefinition
        if not pset or pset.is_a() != "IfcPropertySet":
            continue
        pset_name = getattr(pset, "Name", None) or ""
        for prop in getattr(pset, "HasProperties", None) or []:
            prop_name = getattr(prop, "Name", None) or ""
            value = None
            if hasattr(prop, "NominalValue") and prop.NominalValue is not None:
                wrapped = prop.NominalValue
                value = getattr(wrapped, "wrappedValue", None)
                if value is None:
                    value = str(wrapped)
            result[(pset_name, prop_name)] = value
    return result


def _validate_v0(ifc_model, ids_xml: str, limit_per_spec: int = 25) -> dict:
    specs = _parse_ids_v0(ids_xml)
    if not specs:
        return {
            "total_specifications": 0,
            "passed": 0,
            "failed": 0,
            "no_applicable": 0,
            "specifications": [],
            "message": "No parseable <specification> elements found.",
            "engine": "v0",
        }

    report_specs: list[dict] = []
    overall_passed = 0
    overall_failed = 0
    overall_na = 0

    for spec in specs:
        applicable = []
        if spec.ifc_type:
            try:
                applicable = list(ifc_model.by_type(spec.ifc_type.capitalize().replace("Ifc", "Ifc")))
                if not applicable:
                    applicable = list(ifc_model.by_type(spec.ifc_type))
            except Exception:
                applicable = []

        if spec.predefined_type:
            pd = spec.predefined_type.upper()
            applicable = [
                e for e in applicable
                if str(getattr(e, "PredefinedType", "") or "").upper() == pd
            ]

        failing: list[dict] = []
        for elem in applicable:
            props = _collect_properties_v0(elem)
            failures: list[str] = []
            for req in spec.property_requirements:
                key = (req.pset, req.name)
                if key not in props:
                    failures.append(f"{req.pset}.{req.name} missing")
                    continue
                if req.expected_value is not None:
                    actual = props[key]
                    if actual is None or str(actual).strip().lower() != req.expected_value.strip().lower():
                        failures.append(
                            f"{req.pset}.{req.name} = {actual!r}; expected {req.expected_value!r}"
                        )
            if failures:
                failing.append({
                    "id": getattr(elem, "id", lambda: None)(),
                    "global_id": getattr(elem, "GlobalId", None),
                    "ifc_type": elem.is_a(),
                    "name": getattr(elem, "Name", None),
                    "facet_type": "Property",
                    "reason": "; ".join(failures),
                })

        total_applied = len(applicable)
        failed_count = len(failing)
        passed_count = max(0, total_applied - failed_count)

        if total_applied == 0:
            spec_status = "no_applicable"
            overall_na += 1
        elif failed_count == 0:
            spec_status = "passed"
            overall_passed += 1
        else:
            spec_status = "failed"
            overall_failed += 1

        report_specs.append({
            "name": spec.name,
            "ifc_type": spec.ifc_type,
            "predefined_type": spec.predefined_type,
            "status": spec_status,
            "applied_to": total_applied,
            "passed": passed_count,
            "failed": failed_count,
            "description": "",
            "applicability": [],
            "requirements": [
                {
                    "facet_type": "Property",
                    "property_set": r.pset,
                    "name": r.name,
                    "value": r.expected_value or "",
                }
                for r in spec.property_requirements
            ],
            "failing_elements": failing[:limit_per_spec],
            "failing_truncated": failed_count > limit_per_spec,
        })

    return {
        "total_specifications": len(specs),
        "passed": overall_passed,
        "failed": overall_failed,
        "no_applicable": overall_na,
        "specifications": report_specs,
        "ids_title": "",
        "ids_version": "",
        "ids_description": "",
        "engine": "v0",
    }
