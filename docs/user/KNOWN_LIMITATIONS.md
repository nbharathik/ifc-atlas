# Known limitations

## IFC support

- IFC2X3 and IFC4 are the primary supported schemas. IFC4X3 is best-effort.
- Malformed STEP syntax, unsupported representation types, or vendor-specific
  extensions may load without every shape or may be rejected with an error.
- The repository contains one large IFC2X3 regression fixture. IFC4 behavior is
  also covered with in-memory IfcOpenShell models, but a diverse public model
  corpus is not distributed with the repository.

## Editing

- Semantic editing covers names; Description, ObjectType, Tag, and LongName
  text attributes where the IFC entity exposes them; and existing
  `IfcPropertySingleValue` values.
- Adding or removing property definitions/property sets, classification and
  material authoring, arbitrary entity retyping, and general relationship
  authoring are not yet first-class UI operations.
- Structural editing is beta. Create/delete/spatial operations preserve IFC
  validity through controlled IfcOpenShell operations, but they refresh the
  complete rendered model after apply. The camera and store state are restored;
  a brief loading transition is expected.
- Geometry editing is not a general BIM authoring system. Complex profiles,
  openings, MEP routing, constraints, and parametric family editing are out of
  scope for v0.1.1.

## AI and code execution

- Remote AI providers receive the chat text and the model context/tool results
  needed for the request. The complete IFC file is not sent unless a future
  integration explicitly implements that behavior.
- AI output can be wrong. Ask mode is read-only; Edit mode stages agent writes
  against a local sandbox and exposes approval, validation, discard, and undo.
- The Python sandbox is defense-in-depth, not a general untrusted-code hosting
  service. Keep code execution disabled for hostile multi-user deployments.

## Platforms and distribution

- Release packaging targets Windows x64 and Linux x86_64. macOS can run from
  source but is not shipped until code signing/notarization is configured.
- Auto-update artifacts require the maintainer signing key. Contributor builds
  are valid installers but intentionally omit updater signatures.
