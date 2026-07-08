"""
IFC Model Health Check - rule-based quality scanner.

Runs a set of lightweight, deterministic rules against the loaded IFC model
and returns a structured report.  Each rule:
  - has a unique ``rule_id`` string
  - is tagged with a ``severity`` ('error' | 'warning' | 'info')
  - emits a list of ``HealthIssue`` records (at most ``limit_per_rule`` each)

Design goals:
  - Rules never import or call IfcOpenShell directly; they work on whatever
    object the caller passes in for `ifc_model`.  This lets the test suite
    pass lightweight mock objects with zero SIGSEGV risk.
  - ``run_health_check()`` is the single public entry point.
  - The returned dict is JSON-safe (no IFC objects inside).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

# ─── Types ────────────────────────────────────────────────────────────────────

Severity = Literal["error", "warning", "info"]


@dataclass
class HealthIssue:
    rule_id: str
    severity: Severity
    element_id: int | None
    element_name: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "severity": self.severity,
            "element_id": self.element_id,
            "element_name": self.element_name,
            "message": self.message,
        }


@dataclass
class RuleResult:
    rule_id: str
    severity: Severity
    description: str
    count: int
    issues: list[dict[str, Any]] = field(default_factory=list)


# ─── Rule helpers ─────────────────────────────────────────────────────────────

def _name(obj: Any) -> str:
    """Safe Name extractor - never raises."""
    try:
        v = getattr(obj, "Name", None)
        return str(v) if v else ""
    except Exception:
        return ""


def _global_id(obj: Any) -> str:
    """Safe GlobalId extractor."""
    try:
        v = getattr(obj, "GlobalId", None)
        return str(v) if v else ""
    except Exception:
        return ""


def _id(obj: Any) -> int | None:
    """Safe numeric express ID."""
    try:
        return int(obj.id())
    except Exception:
        return None


# ─── Individual rules ─────────────────────────────────────────────────────────

def _rule_missing_global_id(ifc_model: Any, limit: int) -> RuleResult:
    """Elements with a blank or null GlobalId."""
    issues: list[dict] = []
    try:
        elements = ifc_model.by_type("IfcElement")
    except Exception:
        return RuleResult("missing_global_id", "error", "Elements without a GlobalId", 0)

    for el in elements:
        if _global_id(el):
            continue
        if len(issues) < limit:
            issues.append(HealthIssue(
                rule_id="missing_global_id",
                severity="error",
                element_id=_id(el),
                element_name=_name(el) or f"id={_id(el)}",
                message="GlobalId is blank or null",
            ).to_dict())

    return RuleResult(
        rule_id="missing_global_id",
        severity="error",
        description="Elements without a valid GlobalId (IFC requires unique GlobalIds)",
        count=len(issues),
        issues=issues,
    )


def _rule_duplicate_global_id(ifc_model: Any, limit: int) -> RuleResult:
    """Two or more elements sharing the same GlobalId (data corruption signal)."""
    issues: list[dict] = []
    try:
        elements = ifc_model.by_type("IfcElement")
    except Exception:
        return RuleResult("duplicate_global_id", "error", "Duplicate GlobalIds", 0)

    seen: dict[str, Any] = {}
    duplicates: dict[str, list[Any]] = {}
    for el in elements:
        gid = _global_id(el)
        if not gid:
            continue
        if gid in seen:
            if gid not in duplicates:
                duplicates[gid] = [seen[gid]]
            duplicates[gid].append(el)
        else:
            seen[gid] = el

    total = sum(len(v) for v in duplicates.values())
    for gid, els in list(duplicates.items())[:limit]:
        for el in els:
            if len(issues) < limit:
                issues.append(HealthIssue(
                    rule_id="duplicate_global_id",
                    severity="error",
                    element_id=_id(el),
                    element_name=_name(el) or f"id={_id(el)}",
                    message=f"GlobalId {gid!r} is shared by {len(els)} elements",
                ).to_dict())

    return RuleResult(
        rule_id="duplicate_global_id",
        severity="error",
        description="Elements sharing a non-unique GlobalId",
        count=total,
        issues=issues,
    )


def _rule_missing_name(ifc_model: Any, limit: int) -> RuleResult:
    """Elements with no Name attribute."""
    _IMPORTANT_TYPES = (
        "IfcWall", "IfcSlab", "IfcColumn", "IfcBeam", "IfcDoor", "IfcWindow",
        "IfcStair", "IfcRoof", "IfcSpace", "IfcZone",
    )
    issues: list[dict] = []
    total = 0
    for ifc_type in _IMPORTANT_TYPES:
        try:
            elements = ifc_model.by_type(ifc_type)
        except Exception:
            continue
        for el in elements:
            if _name(el):
                continue
            total += 1
            if len(issues) < limit:
                issues.append(HealthIssue(
                    rule_id="missing_name",
                    severity="warning",
                    element_id=_id(el),
                    element_name=f"{ifc_type} id={_id(el)}",
                    message=f"{ifc_type} has no Name - may cause confusion in schedules",
                ).to_dict())

    return RuleResult(
        rule_id="missing_name",
        severity="warning",
        description="Important elements with no Name attribute",
        count=total,
        issues=issues,
    )


def _rule_empty_property_sets(ifc_model: Any, limit: int) -> RuleResult:
    """IfcPropertySet instances with zero properties."""
    issues: list[dict] = []
    try:
        psets = ifc_model.by_type("IfcPropertySet")
    except Exception:
        return RuleResult("empty_property_sets", "warning", "Empty property sets", 0)

    total = 0
    for pset in psets:
        try:
            props = getattr(pset, "HasProperties", None) or []
            if len(props) > 0:
                continue
        except Exception:
            continue
        total += 1
        if len(issues) < limit:
            issues.append(HealthIssue(
                rule_id="empty_property_sets",
                severity="warning",
                element_id=_id(pset),
                element_name=_name(pset) or f"id={_id(pset)}",
                message="Property set has zero properties",
            ).to_dict())

    return RuleResult(
        rule_id="empty_property_sets",
        severity="warning",
        description="IfcPropertySet instances with no properties",
        count=total,
        issues=issues,
    )


def _rule_no_storey_assignment(ifc_model: Any, limit: int) -> RuleResult:
    """Structural elements not assigned to any IfcBuildingStorey."""
    _STRUCTURAL = ("IfcWall", "IfcSlab", "IfcColumn", "IfcBeam")
    issues: list[dict] = []
    total = 0

    for ifc_type in _STRUCTURAL:
        try:
            elements = ifc_model.by_type(ifc_type)
        except Exception:
            continue
        for el in elements:
            # Check ContainedInStructure inverse
            try:
                contained = getattr(el, "ContainedInStructure", None) or []
                has_storey = any(
                    getattr(rel, "RelatingStructure", None) is not None
                    and getattr(getattr(rel, "RelatingStructure", None), "is_a", lambda x: False)("IfcBuildingStorey")
                    for rel in contained
                )
            except Exception:
                has_storey = True  # assume assigned if we can't check

            if has_storey:
                continue
            total += 1
            if len(issues) < limit:
                issues.append(HealthIssue(
                    rule_id="no_storey_assignment",
                    severity="warning",
                    element_id=_id(el),
                    element_name=_name(el) or f"{ifc_type} id={_id(el)}",
                    message=f"{ifc_type} is not assigned to any IfcBuildingStorey",
                ).to_dict())

    return RuleResult(
        rule_id="no_storey_assignment",
        severity="warning",
        description="Structural elements with no storey (IfcBuildingStorey) assignment",
        count=total,
        issues=issues,
    )


def _rule_duplicate_name_in_type(ifc_model: Any, limit: int) -> RuleResult:
    """Elements of the same IFC type that share identical non-empty names."""
    _CHECK_TYPES = ("IfcDoor", "IfcWindow", "IfcSpace")
    issues: list[dict] = []
    total = 0

    for ifc_type in _CHECK_TYPES:
        try:
            elements = ifc_model.by_type(ifc_type)
        except Exception:
            continue
        name_map: dict[str, list[Any]] = {}
        for el in elements:
            n = _name(el)
            if not n:
                continue
            name_map.setdefault(n, []).append(el)

        for name, els in name_map.items():
            if len(els) < 2:
                continue
            total += len(els)
            for el in els[:limit]:
                if len(issues) < limit:
                    issues.append(HealthIssue(
                        rule_id="duplicate_name_in_type",
                        severity="info",
                        element_id=_id(el),
                        element_name=name,
                        message=f'{ifc_type} name "{name}" is shared by {len(els)} elements',
                    ).to_dict())

    return RuleResult(
        rule_id="duplicate_name_in_type",
        severity="info",
        description="Elements of the same type with non-unique names",
        count=total,
        issues=issues,
    )


def _rule_large_element_count(ifc_model: Any, _limit: int) -> RuleResult:
    """Info-level notice when the model has >10 000 elements (viewer performance tip)."""
    try:
        total = len(ifc_model.by_type("IfcElement"))
    except Exception:
        return RuleResult("large_element_count", "info", "Large element count", 0)

    if total <= 10_000:
        return RuleResult(
            rule_id="large_element_count",
            severity="info",
            description="Element count within recommended range",
            count=0,
        )
    return RuleResult(
        rule_id="large_element_count",
        severity="info",
        description="Model has >10 000 elements - consider LOD reduction for better viewer FPS",
        count=1,
        issues=[HealthIssue(
            rule_id="large_element_count",
            severity="info",
            element_id=None,
            element_name="(model)",
            message=f"Model contains {total:,} elements. Viewer FPS may be affected on integrated GPU.",
        ).to_dict()],
    )


# ─── Public API ───────────────────────────────────────────────────────────────

_RULES = [
    _rule_missing_global_id,
    _rule_duplicate_global_id,
    _rule_missing_name,
    _rule_empty_property_sets,
    _rule_no_storey_assignment,
    _rule_duplicate_name_in_type,
    _rule_large_element_count,
]


def run_health_check(ifc_model: Any, limit_per_rule: int = 50) -> dict[str, Any]:
    """Run all health rules against *ifc_model*.

    Returns a JSON-safe dict::

        {
          "total_issues": 12,
          "by_severity": {"error": 2, "warning": 8, "info": 2},
          "rules": [
            {
              "rule_id": "missing_global_id",
              "severity": "error",
              "description": "...",
              "count": 2,
              "issues": [{"rule_id": ..., "severity": ..., ...}],
            },
            ...
          ]
        }
    """
    rule_results: list[RuleResult] = []
    by_sev: dict[str, int] = {"error": 0, "warning": 0, "info": 0}

    for rule_fn in _RULES:
        try:
            result = rule_fn(ifc_model, limit_per_rule)
            rule_results.append(result)
            by_sev[result.severity] = by_sev.get(result.severity, 0) + result.count
        except Exception:
            pass  # individual rule failures don't abort the scan

    total = sum(by_sev.values())
    return {
        "total_issues": total,
        "by_severity": by_sev,
        "rules": [
            {
                "rule_id": r.rule_id,
                "severity": r.severity,
                "description": r.description,
                "count": r.count,
                "issues": r.issues,
            }
            for r in rule_results
        ],
    }
