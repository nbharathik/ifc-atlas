"""Unit tests for the 5D cost service (pure pricing over a QTO summary)."""

from app.services.qto_service import (
    apply_rates,
    boq_to_csv,
    sanitize_rates,
)


def _summary():
    """A minimal QTO summary shaped like compute_qto output, grouped by ifc_class."""
    return {
        "group_by": ["ifc_class"],
        "groups": [
            {
                "key": {"ifc_class": "IfcWall"},
                "label": "IfcWall",
                "count": 10,
                "quantities": {"volume_m3": 5.0, "area_m2": 100.0, "length_m": 0.0},
                "coverage": {"volume": 10, "area": 10, "length": 0},
            },
            {
                "key": {"ifc_class": "IfcWindow"},
                "label": "IfcWindow",
                "count": 4,
                "quantities": {"volume_m3": 0.0, "area_m2": 0.0, "length_m": 0.0},
                "coverage": {"volume": 0, "area": 0, "length": 0},
            },
            {
                "key": {"ifc_class": "IfcBeam"},
                "label": "IfcBeam",
                "count": 3,
                "quantities": {"volume_m3": 0.0, "area_m2": 0.0, "length_m": 12.0},
                "coverage": {"volume": 0, "area": 0, "length": 3},
            },
        ],
        "overall": {"count": 17, "quantities": {"volume_m3": 5.0, "area_m2": 100.0, "length_m": 12.0}},
        "truncated": False,
    }


RATES = {
    "IfcWall": {"basis": "area", "rate": 45.0},
    "IfcWindow": {"basis": "count", "rate": 350.0},
    "IfcBeam": {"basis": "length", "rate": 40.0},
}


def test_apply_rates_prices_by_basis():
    boq = apply_rates(_summary(), RATES, currency="USD")
    by_class = {r["ifc_class"]: r for r in boq["rows"]}
    # area basis: 100 m2 * 45 = 4500
    assert by_class["IfcWall"]["amount"] == 4500.0
    assert by_class["IfcWall"]["basis"] == "area"
    # count basis: 4 * 350 = 1400
    assert by_class["IfcWindow"]["amount"] == 1400.0
    # length basis: 12 m * 40 = 480
    assert by_class["IfcBeam"]["amount"] == 480.0
    assert boq["total"] == 4500.0 + 1400.0 + 480.0
    assert boq["currency"] == "USD"


def test_rows_sorted_by_amount_descending():
    boq = apply_rates(_summary(), RATES)
    amounts = [r["amount"] for r in boq["rows"]]
    assert amounts == sorted(amounts, reverse=True)


def test_unknown_class_is_unpriced():
    summary = _summary()
    summary["groups"][0]["key"]["ifc_class"] = "IfcMysteryThing"
    summary["groups"][0]["label"] = "IfcMysteryThing"
    boq = apply_rates(summary, RATES)
    row = next(r for r in boq["rows"] if r["ifc_class"] == "IfcMysteryThing")
    assert row["priced"] is False
    assert row["amount"] == 0.0


def test_basis_without_coverage_is_not_priced():
    # IfcWall rate is area-based, but this group has no area coverage.
    summary = _summary()
    summary["groups"][0]["coverage"]["area"] = 0
    boq = apply_rates(summary, RATES)
    wall = next(r for r in boq["rows"] if r["ifc_class"] == "IfcWall")
    assert wall["priced"] is False
    assert wall["amount"] == 0.0


def test_sanitize_rates_drops_bad_entries():
    clean = sanitize_rates(
        {
            "IfcWall": {"basis": "area", "rate": 45.0},
            "IfcBad": {"basis": "nonsense", "rate": 1.0},
            "IfcAlsoBad": {"basis": "area", "rate": "free"},
            "": {"basis": "area", "rate": 1.0},
            123: {"basis": "area", "rate": 1.0},
        }
    )
    assert set(clean) == {"IfcWall"}
    assert clean["IfcWall"] == {"basis": "area", "rate": 45.0}


def test_boq_to_csv_has_header_and_total():
    csv_text = boq_to_csv(apply_rates(_summary(), RATES, currency="EUR"))
    lines = csv_text.strip().splitlines()
    assert lines[0].startswith("ifc_class,count,basis,quantity,unit,rate_EUR,amount_EUR")
    assert lines[-1].endswith("TOTAL,6380.0")
