"""Unit tests for the embodied-carbon service (pure estimate over a QTO summary)."""

from app.services.qto_service import (
    apply_factors,
    carbon_to_csv,
    resolve_factor,
    sanitize_factors,
)


def _summary():
    """A QTO summary shaped like compute_qto output, grouped by material."""
    return {
        "group_by": ["material"],
        "groups": [
            {
                "key": {"material": "Concrete"},
                "label": "Concrete",
                "count": 5,
                "quantities": {"volume_m3": 10.0, "area_m2": 0.0, "length_m": 0.0},
                "coverage": {"volume": 5, "area": 0, "length": 0},
            },
            {
                "key": {"material": "Glass"},
                "label": "Glass",
                "count": 8,
                "quantities": {"volume_m3": 0.0, "area_m2": 20.0, "length_m": 0.0},
                "coverage": {"volume": 0, "area": 8, "length": 0},
            },
            {
                "key": {"material": "Unobtanium"},
                "label": "Unobtanium",
                "count": 2,
                "quantities": {"volume_m3": 1.0, "area_m2": 0.0, "length_m": 0.0},
                "coverage": {"volume": 2, "area": 0, "length": 0},
            },
        ],
        "overall": {"count": 15, "quantities": {"volume_m3": 11.0, "area_m2": 20.0, "length_m": 0.0}},
        "truncated": False,
    }


def test_keyword_fallback_resolves_common_materials():
    # Concrete -> volume @ 120; matched case-insensitively as a substring.
    entry = resolve_factor("Cast-in-place Concrete", {})
    assert entry == {"basis": "volume", "factor": 120.0}
    assert resolve_factor("Unobtanium", {}) is None


def test_library_overrides_keyword():
    entry = resolve_factor("Concrete", {"Concrete": {"basis": "volume", "factor": 999.0}})
    assert entry["factor"] == 999.0


def test_apply_factors_estimates_carbon():
    result = apply_factors(_summary(), {})
    by_material = {r["material"]: r for r in result["rows"]}
    # Concrete: 10 m3 * 120 = 1200
    assert by_material["Concrete"]["carbon_kg"] == 1200.0
    # Glass: 20 m2 * 45 = 900
    assert by_material["Glass"]["carbon_kg"] == 900.0
    # Unobtanium: no factor resolves -> not factored
    assert by_material["Unobtanium"]["factored"] is False
    assert by_material["Unobtanium"]["carbon_kg"] == 0.0
    assert result["total_kg"] == 2100.0
    assert result["total_tonnes"] == 2.1


def test_rows_sorted_by_carbon_descending():
    result = apply_factors(_summary(), {})
    carbons = [r["carbon_kg"] for r in result["rows"]]
    assert carbons == sorted(carbons, reverse=True)


def test_sanitize_factors_drops_bad_entries():
    clean = sanitize_factors(
        {
            "Concrete": {"basis": "volume", "factor": 120.0},
            "Bad": {"basis": "nope", "factor": 1.0},
            "AlsoBad": {"basis": "volume", "factor": "lots"},
        }
    )
    assert set(clean) == {"Concrete"}


def test_carbon_csv_has_total():
    csv_text = carbon_to_csv(apply_factors(_summary(), {}))
    lines = csv_text.strip().splitlines()
    assert lines[0].startswith("material,count,basis,quantity,unit,factor_kgCO2e,carbon_kgCO2e")
    assert lines[-1].endswith("TOTAL,2100.0")
