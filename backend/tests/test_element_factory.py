"""No-mock tests for the shared element authoring recipes (plan A2/R5).

These execute the REAL ifcopenshell.api recipes against a real (tiny,
template-generated) IFC model and tessellate the results - precisely the
verification whose absence let the previous hand-rolled wall recipe ship
broken against ifcopenshell 0.8.5 (ShapeBuilder keyword drift) behind
fully-mocked dispatch tests. Fast enough for the unit lane: the template
model has ~30 entities and tessellating one wall is milliseconds.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

ifcopenshell = pytest.importorskip("ifcopenshell")

from app.services import element_factory
from app.services.project_template_service import create_blank_project


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _template_model(template: str = "single_storey"):
    data = create_blank_project(template)
    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as fh:
        fh.write(data)
        path = Path(fh.name)
    try:
        return ifcopenshell.open(str(path))
    finally:
        path.unlink(missing_ok=True)


def _aabb(entity) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """World-coordinate AABB of an element's tessellated geometry."""
    import ifcopenshell.geom as geom

    settings = geom.settings()
    try:
        settings.set("use-world-coords", True)
    except Exception:  # pragma: no cover - pre-0.8 settings API
        settings.set(settings.USE_WORLD_COORDS, True)
    shape = geom.create_shape(settings, entity)
    verts = shape.geometry.verts
    xs, ys, zs = verts[0::3], verts[1::3], verts[2::3]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def _size(entity) -> tuple[float, float, float]:
    lo, hi = _aabb(entity)
    return (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])


# ---------------------------------------------------------------------------
# create_wall
# ---------------------------------------------------------------------------


def test_create_wall_produces_real_geometry():
    model = _template_model()
    wall = element_factory.create_wall(
        model, start=[0.0, 0.0], end=[5.0, 0.0], height=3.0, thickness=0.2, name="Test Wall"
    )
    assert wall.is_a("IfcWall")
    assert wall.Name == "Test Wall"
    # It is spatially contained in the template's storey.
    import ifcopenshell.util.element as ue

    container = ue.get_container(wall)
    assert container is not None and container.is_a("IfcBuildingStorey")

    # The tessellated AABB matches length × thickness × height. This single
    # assertion is what catches recipe/API drift for real.
    w, d, h = _size(wall)
    assert w == pytest.approx(5.0, abs=0.01)
    assert d == pytest.approx(0.2, abs=0.01)
    assert h == pytest.approx(3.0, abs=0.01)


def test_create_wall_diagonal_and_elevation():
    model = _template_model("two_storey")
    wall = element_factory.create_wall(
        model, start=[0.0, 0.0], end=[3.0, 4.0], height=2.5, thickness=0.3,
        storey_name="First Floor",
    )
    lo, hi = _aabb(wall)
    # First Floor sits at elevation 3.0 in the template.
    assert lo[2] == pytest.approx(3.0, abs=0.01)
    assert hi[2] == pytest.approx(5.5, abs=0.01)
    # 3-4-5 diagonal: XY extents reflect the rotated axis (roughly the
    # segment's bounding box, padded by thickness).
    assert hi[0] - lo[0] == pytest.approx(3.0, abs=0.4)
    assert hi[1] - lo[1] == pytest.approx(4.0, abs=0.4)


def test_create_wall_rejects_degenerate_segment():
    model = _template_model()
    with pytest.raises(ValueError, match="too close"):
        element_factory.create_wall(model, start=[1.0, 1.0], end=[1.0, 1.0])


def test_create_wall_rejects_bad_dimensions():
    model = _template_model()
    with pytest.raises(ValueError, match="height"):
        element_factory.create_wall(model, start=[0, 0], end=[1, 0], height=0)
    with pytest.raises(ValueError, match="thickness"):
        element_factory.create_wall(model, start=[0, 0], end=[1, 0], thickness=-0.1)


def test_create_wall_requires_a_storey():
    model = _template_model("empty")
    with pytest.raises(ValueError, match="no IfcBuildingStorey"):
        element_factory.create_wall(model, start=[0, 0], end=[1, 0])


# ---------------------------------------------------------------------------
# create_slab
# ---------------------------------------------------------------------------


def test_create_slab_produces_real_geometry():
    model = _template_model()
    slab = element_factory.create_slab(
        model,
        outline=[[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]],
        depth=0.25,
        name="Floor Slab",
    )
    assert slab.is_a("IfcSlab")
    w, d, h = _size(slab)
    assert w == pytest.approx(4.0, abs=0.01)
    assert d == pytest.approx(3.0, abs=0.01)
    assert h == pytest.approx(0.25, abs=0.01)
    # Floor convention: top face at the storey elevation (0.0), extruded down.
    lo, hi = _aabb(slab)
    assert hi[2] == pytest.approx(0.0, abs=0.01)
    assert lo[2] == pytest.approx(-0.25, abs=0.01)


def test_create_slab_rejects_short_outline():
    model = _template_model()
    with pytest.raises(ValueError, match="at least 3"):
        element_factory.create_slab(model, outline=[[0, 0], [1, 0]])


def test_create_slab_rejects_zero_area_outline():
    model = _template_model()
    with pytest.raises(ValueError, match="degenerate"):
        element_factory.create_slab(model, outline=[[0, 0], [1, 0], [2, 0]])


# ---------------------------------------------------------------------------
# create_storey / assign_to_storey / delete_product
# ---------------------------------------------------------------------------


def test_create_storey_and_assign():
    model = _template_model()
    storey = element_factory.create_storey(model, name="Level 2", elevation=6.0)
    assert storey.is_a("IfcBuildingStorey")
    assert float(storey.Elevation) == pytest.approx(6.0)
    # Aggregated under the template's building.
    import ifcopenshell.util.element as ue

    assert ue.get_aggregate(storey).is_a("IfcBuilding")

    wall = element_factory.create_wall(model, start=[0, 0], end=[2, 0])
    element_factory.assign_to_storey(model, wall, storey)
    assert ue.get_container(wall).id() == storey.id()
    assert element_factory.get_container_id(wall) == storey.id()


def test_create_storey_requires_name_and_building():
    model = _template_model()
    with pytest.raises(ValueError, match="non-empty"):
        element_factory.create_storey(model, name="  ")


def test_delete_product_removes_entity():
    model = _template_model()
    wall = element_factory.create_wall(model, start=[0, 0], end=[2, 0])
    wall_id = wall.id()
    element_factory.delete_product(model, wall)
    with pytest.raises(RuntimeError):
        model.by_id(wall_id)


def test_delete_product_rejects_non_product():
    model = _template_model()
    project = model.by_type("IfcProject")[0]
    with pytest.raises(ValueError, match="not an IfcProduct"):
        element_factory.delete_product(model, project)


# ---------------------------------------------------------------------------
# The AI sandbox path drives the SAME recipe (regression for the F0 finding:
# the staged create_wall op used to crash on ifcopenshell 0.8.5)
# ---------------------------------------------------------------------------


def test_sandbox_create_wall_op_end_to_end():
    from app.services.sandbox_service import SandboxService

    model = _template_model()
    svc = SandboxService.__new__(SandboxService)  # only need the op applier
    svc._apply_ops_to_sandbox(  # noqa: SLF001
        model,
        [{"op": "create_wall", "start": [0, 0], "end": [4, 0], "height": 2.8,
          "thickness": 0.24, "name": "AI Wall"}],
    )
    walls = [w for w in model.by_type("IfcWall") if w.Name == "AI Wall"]
    assert len(walls) == 1
    w, d, h = _size(walls[0])
    assert w == pytest.approx(4.0, abs=0.01)
    assert d == pytest.approx(0.24, abs=0.01)
    assert h == pytest.approx(2.8, abs=0.01)


def test_sandbox_delete_op_end_to_end():
    from app.services.sandbox_service import SandboxService

    model = _template_model()
    wall = element_factory.create_wall(model, start=[0, 0], end=[2, 0])
    wall_id = wall.id()
    svc = SandboxService.__new__(SandboxService)
    svc._apply_ops_to_sandbox(  # noqa: SLF001
        model, [{"op": "delete_element", "element_id": wall_id}]
    )
    with pytest.raises(RuntimeError):
        model.by_id(wall_id)
