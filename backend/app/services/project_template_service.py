"""New IFC project templates (plan A3) - the "create a new IFC file" capability.

Builds a fresh, valid IFC file from a template using ``ifcopenshell.api``: the
spatial scaffold (Project -> Site -> Building -> Storey) with SI units and
geometric contexts, so the result opens cleanly and is ready to receive
elements. Returned as bytes; the frontend loads them through the normal upload
pipeline (which makes it the active model). The house generator (F1) builds on
this same scaffold.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import ifcopenshell
import ifcopenshell.api.aggregate
import ifcopenshell.api.context
import ifcopenshell.api.project
import ifcopenshell.api.root
import ifcopenshell.api.unit

logger = logging.getLogger(__name__)

# Supported templates. "empty" = spatial scaffold only; the *_storey variants
# pre-create storeys so the user can start placing elements immediately.
TEMPLATES: tuple[str, ...] = ("empty", "single_storey", "two_storey")
DEFAULT_TEMPLATE = "single_storey"

_STOREY_HEIGHT_M = 3.0


def _storey_names(template: str) -> list[str]:
    if template == "empty":
        return []
    if template == "two_storey":
        return ["Ground Floor", "First Floor"]
    return ["Ground Floor"]  # single_storey (default)


def create_blank_project(
    template: str = DEFAULT_TEMPLATE,
    *,
    project_name: str = "New Project",
    schema: str = "IFC4",
) -> bytes:
    """Build a fresh IFC file from *template* and return its bytes.

    Unknown templates fall back to the default. Raises only on a genuine
    IfcOpenShell failure (caller maps that to a 500).
    """
    resolved = template if template in TEMPLATES else DEFAULT_TEMPLATE

    f = ifcopenshell.api.project.create_file(version=schema)
    project = ifcopenshell.api.root.create_entity(f, ifc_class="IfcProject", name=project_name)
    ifcopenshell.api.unit.assign_unit(f)  # SI metre length unit by default
    model_ctx = ifcopenshell.api.context.add_context(f, context_type="Model")
    # A Body subcontext is what element geometry hangs off; create it up front so
    # later element-creation ops have a representation context to target.
    ifcopenshell.api.context.add_context(
        f,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model_ctx,
    )

    site = ifcopenshell.api.root.create_entity(f, ifc_class="IfcSite", name="Site")
    building = ifcopenshell.api.root.create_entity(f, ifc_class="IfcBuilding", name="Building")
    ifcopenshell.api.aggregate.assign_object(f, relating_object=project, products=[site])
    ifcopenshell.api.aggregate.assign_object(f, relating_object=site, products=[building])

    storeys = []
    for i, name in enumerate(_storey_names(resolved)):
        storey = ifcopenshell.api.root.create_entity(f, ifc_class="IfcBuildingStorey", name=name)
        try:
            storey.Elevation = float(i) * _STOREY_HEIGHT_M
        except Exception:  # pragma: no cover - schema variance
            pass
        storeys.append(storey)
    if storeys:
        ifcopenshell.api.aggregate.assign_object(f, relating_object=building, products=storeys)

    tmp = Path(tempfile.mkdtemp()) / "new_project.ifc"
    f.write(str(tmp))
    try:
        return tmp.read_bytes()
    finally:
        tmp.unlink(missing_ok=True)
