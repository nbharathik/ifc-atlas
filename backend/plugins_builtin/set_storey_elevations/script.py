# Set Storey Elevations - built-in plugin.
#
# Runs inside the IFC code sandbox: `model` and `json` come from the host
# namespace, `params` is prepended by the plugin runner.
#
# params:
#   elevations_json: JSON object mapping storey Name to new elevation in
#                    model length units, e.g. '{"Level 1": 3.2}'.

mapping = json.loads(params["elevations_json"])
if not isinstance(mapping, dict):
    raise ValueError(
        "elevations_json must be a JSON object of {storey name: elevation}"
    )

storeys = model.by_type("IfcBuildingStorey")
changed = 0

for storey_name, raw_elevation in mapping.items():
    elevation = float(raw_elevation)
    target = None
    for storey in storeys:
        if (storey.Name or "") == storey_name:
            target = storey
            break
    if target is None:
        print(f"storey '{storey_name}': not found, skipped")
        continue

    target.Elevation = elevation

    # Keep the geometric placement consistent with the semantic attribute:
    # rewrite the Z coordinate of the local placement's Location point.
    placement = target.ObjectPlacement
    if placement is not None and placement.is_a("IfcLocalPlacement"):
        relative = placement.RelativePlacement
        location = getattr(relative, "Location", None) if relative is not None else None
        if location is not None and location.is_a("IfcCartesianPoint"):
            coords = [float(c) for c in location.Coordinates]
            while len(coords) < 3:
                coords.append(0.0)
            coords[2] = elevation
            location.Coordinates = tuple(coords)

    print(f"storey '{storey_name}': elevation set to {elevation}")
    changed += 1

print(f"{changed} storey(s) updated")
result = changed
