"""Shared element creation/deletion recipes over ``ifcopenshell.api`` (plan A2).

ONE implementation of "how a wall/slab/storey is authored", used by BOTH write
paths so human, AI, and MCP edits produce byte-identical results:

* the sandbox pipeline (AI staged edits: propose → diff preview → apply), and
* ``IfcService``'s direct write methods (human editor / MCP direct ops via the
  operation layer).

Every function takes the ``ifcopenshell.file`` to mutate (never a service) and
raises ``ValueError`` with a caller-friendly message for bad input. Geometry
uses the purpose-built ``ifcopenshell.api.geometry`` recipes - NOT hand-rolled
ShapeBuilder calls, whose keyword API drifted across ifcopenshell releases and
silently broke the previous wall recipe (caught by the R5 audit; guarded by
``backend/tests/test_element_factory.py``'s no-mock integration tests).
"""

from __future__ import annotations

import math
from typing import Any, Optional

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.context
import ifcopenshell.api.geometry
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.util.element
import ifcopenshell.util.representation

# Sensible architectural defaults (metres).
DEFAULT_WALL_HEIGHT_M = 3.0
DEFAULT_WALL_THICKNESS_M = 0.2
DEFAULT_SLAB_DEPTH_M = 0.2
MIN_SEGMENT_LENGTH_M = 1e-3


def find_storey(model: "ifcopenshell.file", storey_name: Optional[str] = None) -> Any:
    """Return the IfcBuildingStorey whose Name fuzzy-matches *storey_name*.

    ``None`` or no match → the lowest-elevation storey (deterministic default).
    Raises ``ValueError`` when the model has no storeys at all.
    """
    storeys = list(model.by_type("IfcBuildingStorey"))
    if not storeys:
        raise ValueError(
            "The model has no IfcBuildingStorey - create one first "
            "(create_storey) so elements have a spatial container."
        )
    if storey_name:
        wanted = storey_name.strip().lower()
        for s in storeys:
            if (getattr(s, "Name", None) or "").strip().lower() == wanted:
                return s
        for s in storeys:
            if wanted in (getattr(s, "Name", None) or "").strip().lower():
                return s
    return min(storeys, key=_storey_elevation)


def _storey_elevation(storey: Any) -> float:
    try:
        return float(getattr(storey, "Elevation", None) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def get_body_context(model: "ifcopenshell.file") -> Any:
    """Return the Model/Body context, creating it if the file lacks one
    (files from other authoring tools do not always carry a Body subcontext)."""
    ctx = ifcopenshell.util.representation.get_context(model, "Model", "Body", "MODEL_VIEW")
    if ctx is not None:
        return ctx
    model_ctx = ifcopenshell.util.representation.get_context(model, "Model")
    if model_ctx is None:
        model_ctx = ifcopenshell.api.context.add_context(model, context_type="Model")
    return ifcopenshell.api.context.add_context(
        model,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model_ctx,
    )


def create_wall(
    model: "ifcopenshell.file",
    *,
    start: tuple[float, float] | list[float],
    end: tuple[float, float] | list[float],
    height: float = DEFAULT_WALL_HEIGHT_M,
    thickness: float = DEFAULT_WALL_THICKNESS_M,
    storey_name: Optional[str] = None,
    name: str = "Wall",
) -> Any:
    """Create an IfcWall between two XY points (metres) on a storey work plane.

    Uses ``ifcopenshell.api.geometry.create_2pt_wall`` - the exact recipe
    Bonsai's wall tool drives - so placement (axis along the segment),
    SweptSolid body, and units all come from the maintained upstream code.
    Returns the new wall entity.
    """
    try:
        sx, sy = float(start[0]), float(start[1])
        ex, ey = float(end[0]), float(end[1])
    except (TypeError, ValueError, IndexError):
        raise ValueError("'start' and 'end' must be [x, y] coordinate pairs (metres)")
    height = float(height)
    thickness = float(thickness)
    if height <= 0:
        raise ValueError(f"Wall height must be positive (got {height})")
    if thickness <= 0:
        raise ValueError(f"Wall thickness must be positive (got {thickness})")
    length = math.hypot(ex - sx, ey - sy)
    if length < MIN_SEGMENT_LENGTH_M:
        raise ValueError(
            f"Wall start and end are too close (length {length:.4f} m) - "
            "a wall needs a non-degenerate axis"
        )

    storey = find_storey(model, storey_name)
    context = get_body_context(model)

    wall = ifcopenshell.api.root.create_entity(model, ifc_class="IfcWall", name=name or "Wall")
    # create_2pt_wall computes the placement (axis along the segment, at the
    # storey elevation) and RETURNS the SweptSolid body representation - it
    # does not attach it; assign_representation completes the wall.
    rep = ifcopenshell.api.geometry.create_2pt_wall(
        model,
        element=wall,
        context=context,
        p1=(sx, sy),
        p2=(ex, ey),
        elevation=_storey_elevation(storey),
        height=height,
        thickness=thickness,
        is_si=True,
    )
    ifcopenshell.api.geometry.assign_representation(model, product=wall, representation=rep)
    ifcopenshell.api.spatial.assign_container(
        model, products=[wall], relating_structure=storey
    )
    return wall


def create_slab(
    model: "ifcopenshell.file",
    *,
    outline: list[tuple[float, float]] | list[list[float]],
    depth: float = DEFAULT_SLAB_DEPTH_M,
    storey_name: Optional[str] = None,
    name: str = "Slab",
) -> Any:
    """Create an IfcSlab from a closed XY polygon (metres) on a storey.

    *outline* is the slab boundary as ≥3 [x, y] points (unclosed - the recipe
    closes it). The slab extrudes *depth* downward from the storey elevation
    (floor-slab convention: its top face is the walking surface).
    """
    if not isinstance(outline, (list, tuple)) or len(outline) < 3:
        raise ValueError("'outline' must be a polygon of at least 3 [x, y] points")
    try:
        points = [(float(p[0]), float(p[1])) for p in outline]
    except (TypeError, ValueError, IndexError):
        raise ValueError("'outline' points must be [x, y] coordinate pairs (metres)")
    depth = float(depth)
    if depth <= 0:
        raise ValueError(f"Slab depth must be positive (got {depth})")
    if _polygon_area(points) < 1e-6:
        raise ValueError("'outline' is degenerate (zero area) - check the points")

    storey = find_storey(model, storey_name)
    context = get_body_context(model)

    slab = ifcopenshell.api.root.create_entity(model, ifc_class="IfcSlab", name=name or "Slab")
    # Place the slab's origin at the storey elevation; the representation's
    # NEGATIVE direction sense extrudes downward so the top face sits at the
    # storey level.
    matrix = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, _storey_elevation(storey)],
        [0.0, 0.0, 0.0, 1.0],
    ]
    ifcopenshell.api.geometry.edit_object_placement(model, product=slab, matrix=matrix, is_si=True)
    rep = ifcopenshell.api.geometry.add_slab_representation(
        model,
        context=context,
        depth=depth,
        direction_sense="NEGATIVE",
        polyline=points,
    )
    ifcopenshell.api.geometry.assign_representation(model, product=slab, representation=rep)
    ifcopenshell.api.spatial.assign_container(
        model, products=[slab], relating_structure=storey
    )
    return slab


def _polygon_area(points: list[tuple[float, float]]) -> float:
    """Shoelace area of an (unclosed) polygon."""
    n = len(points)
    acc = 0.0
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        acc += x1 * y2 - x2 * y1
    return abs(acc) / 2.0


def create_storey(
    model: "ifcopenshell.file",
    *,
    name: str,
    elevation: float = 0.0,
) -> Any:
    """Create an IfcBuildingStorey aggregated under the model's building.

    Raises ``ValueError`` when the model has no IfcBuilding to attach to.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("'name' must be a non-empty storey name")
    buildings = list(model.by_type("IfcBuilding"))
    if not buildings:
        raise ValueError("The model has no IfcBuilding to attach the storey to")

    storey = ifcopenshell.api.root.create_entity(
        model, ifc_class="IfcBuildingStorey", name=name
    )
    try:
        storey.Elevation = float(elevation)
    except (TypeError, ValueError):  # pragma: no cover - schema variance
        pass
    ifcopenshell.api.aggregate.assign_object(
        model, products=[storey], relating_object=buildings[0]
    )
    return storey


def assign_to_storey(model: "ifcopenshell.file", element: Any, storey: Any) -> None:
    """(Re)assign *element*'s spatial container to *storey*."""
    if not element.is_a("IfcProduct"):
        raise ValueError(f"Element #{element.id()} ({element.is_a()}) is not an IfcProduct")
    if not storey.is_a("IfcSpatialStructureElement"):
        raise ValueError(
            f"Target #{storey.id()} ({storey.is_a()}) is not a spatial structure element"
        )
    ifcopenshell.api.spatial.assign_container(
        model, products=[element], relating_structure=storey
    )


def get_container_id(element: Any) -> Optional[int]:
    """Express id of the element's current spatial container, or None."""
    try:
        container = ifcopenshell.util.element.get_container(element)
        return container.id() if container is not None else None
    except Exception:
        return None


def delete_product(model: "ifcopenshell.file", element: Any) -> None:
    """Remove an IfcProduct (and its representation/placement subgraph)."""
    if not element.is_a("IfcProduct"):
        raise ValueError(
            f"Element #{element.id()} is {element.is_a()}, not an IfcProduct - "
            "only products can be deleted"
        )
    ifcopenshell.api.root.remove_product(model, product=element)
