"""Persistence tests for the cost rate / carbon factor libraries.

Both libraries write via tempfile + ``os.replace`` (atomic) - a crash mid-write
must never corrupt or truncate the file, and no temp files may be left behind.
"""

from __future__ import annotations

from app.services import carbon_service, cost_service


def test_cost_rates_roundtrip_and_no_temp_leftovers(tmp_path, monkeypatch):
    path = tmp_path / "cost" / "rates.json"
    monkeypatch.setattr(cost_service, "_RATES_PATH", path)

    written = cost_service.save_rates({"IfcWall": {"basis": "area", "rate": 12.5}, "bad": "nope"})
    assert written == {"IfcWall": {"basis": "area", "rate": 12.5}}
    assert cost_service.load_rates() == written
    # Atomic write leaves exactly the target file, no .tmp residue.
    assert [p.name for p in path.parent.iterdir()] == ["rates.json"]

    # Overwrite replaces the previous content.
    cost_service.save_rates({"IfcSlab": {"basis": "volume", "rate": 1.0}})
    assert cost_service.load_rates() == {"IfcSlab": {"basis": "volume", "rate": 1.0}}
    assert [p.name for p in path.parent.iterdir()] == ["rates.json"]


def test_carbon_factors_roundtrip_and_no_temp_leftovers(tmp_path, monkeypatch):
    path = tmp_path / "carbon" / "factors.json"
    monkeypatch.setattr(carbon_service, "_FACTORS_PATH", path)

    written = carbon_service.save_factors(
        {"Concrete": {"basis": "volume", "factor": 120.0}, "bad": 1}
    )
    assert written == {"Concrete": {"basis": "volume", "factor": 120.0}}
    assert carbon_service.load_factors() == written
    assert [p.name for p in path.parent.iterdir()] == ["factors.json"]

    # Empty save clears the library (keyword defaults apply again).
    carbon_service.save_factors({})
    assert carbon_service.load_factors() == {}
    assert [p.name for p in path.parent.iterdir()] == ["factors.json"]
