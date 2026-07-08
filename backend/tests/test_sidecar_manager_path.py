from pathlib import Path

from app.services import sidecar_manager


def test_default_sidecar_dir_points_to_backend_sidecar():
    backend_dir = Path(__file__).resolve().parents[1]
    expected = (backend_dir / "sidecar").resolve()

    assert sidecar_manager._SIDECAR_DIR == expected
    assert (expected / "package.json").exists()
