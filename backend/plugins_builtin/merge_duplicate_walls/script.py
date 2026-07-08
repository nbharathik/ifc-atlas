# Merge Duplicate Walls - built-in plugin.
#
# Runs inside the IFC code sandbox: `model` and `collections` come from the
# host namespace, `params` is prepended by the plugin runner.
#
# params:
#   tolerance_mm: walls whose placement origins quantise to the same
#                 tolerance-sized cell (and share a Name) count as duplicates.

tolerance_m = float(params.get("tolerance_mm", 1.0)) / 1000.0
if tolerance_m <= 0:
    raise ValueError("tolerance_mm must be greater than 0")


def placement_origin(product):
    # Accumulated translation of the local-placement chain. Rotations are
    # ignored on purpose: true duplicates share the same parent chain, so
    # the component-wise sum is enough to bucket them.
    x = y = z = 0.0
    placement = product.ObjectPlacement
    while placement is not None and placement.is_a("IfcLocalPlacement"):
        relative = placement.RelativePlacement
        location = getattr(relative, "Location", None) if relative is not None else None
        if location is not None and location.is_a("IfcCartesianPoint"):
            coords = list(location.Coordinates) + [0.0, 0.0, 0.0]
            x += float(coords[0])
            y += float(coords[1])
            z += float(coords[2])
        placement = getattr(placement, "PlacementRelTo", None)
    return x, y, z


def remove_product(m, product):
    # Detach `product` from every relationship that references it before
    # removing it, so no relationship is left pointing at a dead entity.
    # Aggregate sides (RelatedElements / RelatedObjects) are filtered; a
    # relationship left empty, or one referencing the product through a
    # single-valued side (e.g. RelatingStructure), is removed entirely.
    for rel in list(m.get_inverse(product)):
        if not rel.is_a("IfcRelationship"):
            continue
        detached = False
        for attr in ("RelatedElements", "RelatedObjects"):
            value = getattr(rel, attr, None)
            if not value:
                continue
            if any(e == product for e in value):
                remaining = tuple(e for e in value if e != product)
                if remaining:
                    setattr(rel, attr, remaining)
                else:
                    m.remove(rel)
                detached = True
                break
        if not detached:
            m.remove(rel)
    m.remove(product)


# by_type("IfcWall") includes subtypes, so IfcWallStandardCase is covered.
walls = list(model.by_type("IfcWall"))

groups = collections.OrderedDict()
for wall in walls:
    ox, oy, oz = placement_origin(wall)
    key = (
        wall.Name or "",
        round(ox / tolerance_m),
        round(oy / tolerance_m),
        round(oz / tolerance_m),
    )
    groups.setdefault(key, []).append(wall)

removed = 0
for group in groups.values():
    for duplicate in group[1:]:
        duplicate_id = duplicate.id()
        duplicate_name = duplicate.Name or ""
        remove_product(model, duplicate)
        removed += 1
        print(f"removed duplicate wall '{duplicate_name}' (#{duplicate_id})")

print(f"{removed} duplicate wall(s) removed")
result = removed
