# Assign Classification - built-in plugin.
#
# Runs inside the IFC code sandbox: `model`, `re` and `ifcopenshell` come
# from the host namespace, `params` is prepended by the plugin runner.
#
# params:
#   pattern: regex an element's is_a() type must fully match (default IfcWall.*)
#   system:  classification system name; an existing IfcClassification with
#            the same Name is reused (default Uniclass)
#   code:    reference code, e.g. a Uniclass or OmniClass code (required)
#   title:   optional human-readable reference name

pattern = params.get("pattern", "IfcWall.*")
system = params.get("system", "Uniclass")
code = params["code"]
title = params.get("title", "")

matcher = re.compile(pattern)
elements = [e for e in model.by_type("IfcProduct") if matcher.fullmatch(e.is_a())]

if not elements:
    # Nothing matched: do not create any entities, keep the run a no-op.
    print(f"0 elements matched pattern '{pattern}'")
    result = 0
else:
    classification = None
    for existing in model.by_type("IfcClassification"):
        if (existing.Name or "") == system:
            classification = existing
            break
    if classification is None:
        classification = model.create_entity("IfcClassification", Name=system)

    reference = model.create_entity("IfcClassificationReference")
    reference.Name = title or code
    reference.ReferencedSource = classification
    # IFC4 names the code attribute Identification; IFC2X3 calls it ItemReference.
    if hasattr(reference, "Identification"):
        reference.Identification = code
    else:
        reference.ItemReference = code

    model.create_entity(
        "IfcRelAssociatesClassification",
        GlobalId=ifcopenshell.guid.new(),
        Name=f"{system} {code}",
        RelatedObjects=elements,
        RelatingClassification=reference,
    )
    print(f"{len(elements)} element(s) classified as {system} {code}")
    result = len(elements)
