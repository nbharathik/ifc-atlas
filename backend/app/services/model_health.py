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
  - ``run_health_check()`` is the single public entry point for the scanner.
  - The returned dict is JSON-safe (no IFC objects inside).

This module also hosts the one-call model audit for the ``run_model_audit``
chat tool. It chains the existing per-domain services into a single structured
report:

1. ``health``      - the rule-based checks above.
2. ``quantities``  - QTO coverage (how many elements carry base quantities).
3. ``cost``        - 5D pricing coverage from :mod:`app.services.qto_service`.
4. ``carbon``      - embodied-carbon factor coverage from ``qto_service``.
5. ``ids``         - summary of the last cached IDS validation run, if any.

Shape::

    {
      "sections": [{"name", "status": "ok"|"warnings"|"issues",
                    "findings": [str, ...], "stats": {...}}, ...],
      "summary": {"status", "section_statuses", "counts", "note", ...}
    }

Runtime discipline: the QTO underneath quantities/cost/carbon is memoized per
model-contract fingerprint (``qto_service._RESULT_CACHE``), so passing the
route-style fingerprint keeps the audit warm-cache cheap. Every section is
individually fault-isolated - one failing computation degrades that section
to ``issues`` instead of aborting the audit.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Optional

from app.services.qto_service import (
    DEFAULT_CURRENCY,
    compute_boq,
    compute_carbon,
    compute_qto,
)

logger = logging.getLogger(__name__)

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


# ─── Model audit ──────────────────────────────────────────────────────────────

STATUS_OK = "ok"
STATUS_WARNINGS = "warnings"
STATUS_ISSUES = "issues"

_STATUS_RANK = {STATUS_OK: 0, STATUS_WARNINGS: 1, STATUS_ISSUES: 2}

# Sentinel: "caller didn't supply the IDS last-run - fetch it ourselves".
_UNSET: Any = object()

# How many example labels/spec names a section inlines before summarising.
_MAX_EXAMPLE_LABELS = 8


def fetch_ids_last_run() -> Optional[dict[str, Any]]:
    """Read the cached last IDS run for the current model, if one exists.

    The cache lives module-level in ``app.api.ids_routes`` (kept there so the
    REST layer owns its lifecycle); this is a read-only, lazily-imported peek
    that returns ``None`` when nothing has run or the cached run belongs to a
    different model fingerprint.
    """
    try:
        from app.api import ids_routes  # local - avoid api<->service cycle at import

        if ids_routes._cache_is_current() and ids_routes._last_run is not None:  # noqa: SLF001
            run = ids_routes._last_run  # noqa: SLF001
            return {
                "ids_id": run.get("ids_id"),
                "ran_at": run.get("ran_at"),
                "report": run.get("report") or {},
            }
    except Exception:  # noqa: BLE001
        logger.debug("IDS last-run lookup failed", exc_info=True)
    return None


def _pct(part: int | float, whole: int | float) -> float:
    return round(100.0 * part / whole, 1) if whole else 0.0


def _health_section(model: Any, limit_per_rule: int) -> dict[str, Any]:
    report = run_health_check(model, limit_per_rule=limit_per_rule)
    by_sev = report.get("by_severity", {})
    errors = int(by_sev.get("error", 0))
    warnings_count = int(by_sev.get("warning", 0))
    info = int(by_sev.get("info", 0))

    if errors:
        status = STATUS_ISSUES
    elif warnings_count:
        status = STATUS_WARNINGS
    else:
        status = STATUS_OK

    findings = [
        f"{rule['rule_id']} ({rule['severity']}): {rule['count']} - {rule['description']}"
        for rule in report.get("rules", [])
        if rule.get("count", 0) > 0
    ]
    if not findings:
        findings = ["All model health rules passed."]

    return {
        "name": "health",
        "status": status,
        "findings": findings,
        "stats": {
            "total_issues": report.get("total_issues", 0),
            "errors": errors,
            "warnings": warnings_count,
            "info": info,
        },
    }


def _quantity_section(model: Any, fingerprint: Optional[str]) -> dict[str, Any]:
    qto = compute_qto(model, ["ifc_class"], fingerprint=fingerprint)
    overall = qto.get("overall", {})
    total = int(overall.get("count", 0))
    coverage = {
        basis: sum(
            int(group.get("coverage", {}).get(basis, 0))
            for group in qto.get("groups", [])
        )
        for basis in ("volume", "area", "length")
    }

    if total == 0:
        status = STATUS_ISSUES
        findings = [
            "No takeoff population - the model has no quantifiable IfcProduct elements."
        ]
    elif all(count == 0 for count in coverage.values()):
        status = STATUS_WARNINGS
        findings = [
            f"None of the {total} elements carry IfcElementQuantity data - "
            "QTO, cost and carbon fall back to element counts only."
        ]
    else:
        status = STATUS_OK
        findings = [
            f"{basis} quantities on {count} of {total} elements ({_pct(count, total)}%)"
            for basis, count in coverage.items()
        ]

    return {
        "name": "quantities",
        "status": status,
        "findings": findings,
        "stats": {
            "element_count": total,
            "totals": overall.get("quantities", {}),
            "coverage": {
                basis: {"elements": count, "pct": _pct(count, total)}
                for basis, count in coverage.items()
            },
        },
    }


def _cost_section(model: Any, fingerprint: Optional[str]) -> dict[str, Any]:
    boq = compute_boq(model, None, DEFAULT_CURRENCY, False, fingerprint)
    total_rows = int(boq.get("total_rows", 0))
    priced = int(boq.get("priced_rows", 0))
    pct = _pct(priced, total_rows)
    unpriced = [row["label"] for row in boq.get("rows", []) if not row.get("priced")]

    if total_rows == 0:
        status = STATUS_ISSUES
        findings = ["No BoQ rows - the takeoff population is empty."]
    elif pct >= 80.0:
        status = STATUS_OK
        findings = [
            f"{priced} of {total_rows} BoQ rows priced ({pct}%) - estimated total "
            f"{boq.get('total', 0)} {boq.get('currency', DEFAULT_CURRENCY)}."
        ]
    else:
        status = STATUS_WARNINGS
        findings = [
            f"Only {priced} of {total_rows} BoQ rows priced ({pct}%) - estimated "
            f"total {boq.get('total', 0)} {boq.get('currency', DEFAULT_CURRENCY)} "
            "understates the real cost."
        ]
    if unpriced:
        shown = ", ".join(unpriced[:_MAX_EXAMPLE_LABELS])
        suffix = ", ..." if len(unpriced) > _MAX_EXAMPLE_LABELS else ""
        findings.append(f"Unpriced rows: {shown}{suffix}")

    return {
        "name": "cost",
        "status": status,
        "findings": findings,
        "stats": {
            "currency": boq.get("currency", DEFAULT_CURRENCY),
            "total": boq.get("total", 0),
            "priced_rows": priced,
            "total_rows": total_rows,
            "priced_pct": pct,
        },
    }


def _carbon_section(model: Any, fingerprint: Optional[str]) -> dict[str, Any]:
    carbon = compute_carbon(model, None, False, fingerprint)
    total_rows = int(carbon.get("total_rows", 0))
    factored = int(carbon.get("factored_rows", 0))
    pct = _pct(factored, total_rows)
    unfactored = [
        row["label"] for row in carbon.get("rows", []) if not row.get("factored")
    ]

    if total_rows == 0:
        status = STATUS_ISSUES
        findings = ["No carbon rows - the takeoff population is empty."]
    elif pct >= 80.0:
        status = STATUS_OK
        findings = [
            f"{factored} of {total_rows} material rows factored ({pct}%) - estimated "
            f"{carbon.get('total_tonnes', 0)} tCO2e ({carbon.get('total_kg', 0)} kg)."
        ]
    else:
        status = STATUS_WARNINGS
        findings = [
            f"Only {factored} of {total_rows} material rows have an emission factor "
            f"({pct}%) - estimated {carbon.get('total_tonnes', 0)} tCO2e "
            f"({carbon.get('total_kg', 0)} kg) understates the real footprint."
        ]
    if unfactored:
        shown = ", ".join(unfactored[:_MAX_EXAMPLE_LABELS])
        suffix = ", ..." if len(unfactored) > _MAX_EXAMPLE_LABELS else ""
        findings.append(f"Materials without a factor: {shown}{suffix}")

    return {
        "name": "carbon",
        "status": status,
        "findings": findings,
        "stats": {
            "total_kg": carbon.get("total_kg", 0),
            "total_tonnes": carbon.get("total_tonnes", 0),
            "factored_rows": factored,
            "total_rows": total_rows,
            "factored_pct": pct,
        },
    }


def _ids_section(last_run: Optional[dict[str, Any]]) -> dict[str, Any]:
    if last_run is None:
        return {
            "name": "ids",
            "status": STATUS_OK,
            "findings": [
                "No IDS validation run is cached for this model - run one via the "
                "ids_validate tool or the IDS panel to add compliance coverage."
            ],
            "stats": {"available": False},
        }

    report = last_run.get("report") or {}
    failed = int(report.get("failed", 0))
    passed = int(report.get("passed", 0))
    no_applicable = int(report.get("no_applicable", 0))
    total_specs = int(report.get("total_specifications", 0))
    failing_ids = report.get("all_failing_ids") or []

    if failed:
        status = STATUS_ISSUES
        findings = [
            f"IDS run failed {failed} of {total_specs} specifications "
            f"({len(failing_ids)} failing elements)."
        ]
        failed_specs = [
            f"'{spec.get('name')}' - {spec.get('failed', 0)} failing element(s)"
            for spec in report.get("specifications", [])
            if spec.get("status") == "failed"
        ]
        if failed_specs:
            findings.extend(failed_specs[:_MAX_EXAMPLE_LABELS])
    else:
        status = STATUS_OK
        findings = [
            f"IDS run passed: {passed} of {total_specs} specifications passed, "
            f"{no_applicable} had no applicable elements."
        ]

    return {
        "name": "ids",
        "status": status,
        "findings": findings,
        "stats": {
            "available": True,
            "ids_id": last_run.get("ids_id"),
            "ran_at": last_run.get("ran_at"),
            "total_specifications": total_specs,
            "passed": passed,
            "failed": failed,
            "no_applicable": no_applicable,
            "failing_elements": len(failing_ids),
        },
    }


def _safe_section(name: str, builder: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Fault isolation: a failing section degrades, never aborts, the audit."""
    try:
        return builder()
    except Exception as exc:  # noqa: BLE001
        logger.warning("model audit section '%s' failed: %s", name, exc, exc_info=True)
        return {
            "name": name,
            "status": STATUS_ISSUES,
            "findings": [f"Audit step '{name}' failed: {exc}"],
            "stats": {"failed": True},
        }


def run_model_audit(
    model: Any,
    fingerprint: Optional[str] = None,
    limit_per_rule: int = 10,
    ids_last_run: Any = _UNSET,
) -> dict[str, Any]:
    """Run the full audit and return ``{"sections": [...], "summary": {...}}``.

    ``ids_last_run`` is dependency-injectable for tests; the default fetches
    the cached last run from the IDS routes module.
    """
    started = time.perf_counter()
    if ids_last_run is _UNSET:
        ids_last_run = fetch_ids_last_run()

    sections = [
        _safe_section("health", lambda: _health_section(model, limit_per_rule)),
        _safe_section("quantities", lambda: _quantity_section(model, fingerprint)),
        _safe_section("cost", lambda: _cost_section(model, fingerprint)),
        _safe_section("carbon", lambda: _carbon_section(model, fingerprint)),
        _safe_section("ids", lambda: _ids_section(ids_last_run)),
    ]

    worst = max((s["status"] for s in sections), key=lambda s: _STATUS_RANK[s])
    counts = {status: 0 for status in _STATUS_RANK}
    for section in sections:
        counts[section["status"]] += 1

    return {
        "sections": sections,
        "summary": {
            "status": worst,
            "section_statuses": {s["name"]: s["status"] for s in sections},
            "counts": counts,
            "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            "note": (
                "Cost and carbon figures come from the editable placeholder "
                "rate/factor libraries - present them as estimates, not real "
                "prices or a certified LCA."
            ),
        },
    }
