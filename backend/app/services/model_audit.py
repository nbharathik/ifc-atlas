"""One-call model audit for the ``run_model_audit`` chat tool.

Chains the existing per-domain services into a single structured report:

1. ``health``      - rule-based checks from :mod:`app.services.model_health`.
2. ``quantities``  - QTO coverage (how many elements carry base quantities).
3. ``cost``        - 5D pricing coverage from :mod:`app.services.cost_service`.
4. ``carbon``      - embodied-carbon factor coverage from ``carbon_service``.
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
from typing import Any, Callable, Optional

from app.services.carbon_service import compute_carbon
from app.services.cost_service import DEFAULT_CURRENCY, compute_boq
from app.services.model_health import run_health_check
from app.services.qto_service import compute_qto

logger = logging.getLogger(__name__)

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
