# Roadmap after v0.1.1

The roadmap favors complete workflows over feature count.

## Viewer reference principles

Established BIM viewers reinforce a small set of dependable interactions:
measure and cut the model, filter by model data, save a view, and keep hidden
context available when needed. Dalux combines 2D/3D inspection, filtering,
properties, measurements, cuts, comments, and saved views; Trimble Connect
adds an especially useful ghosted-visibility mode. IFC Atlas will adopt those
interaction principles incrementally without copying product branding or
proprietary implementations.

- [Dalux BIM Viewer](https://www.dalux.com/en-gb/products/bim-viewer/)
- [Dalux 2D and 3D viewer functionality](https://www.dalux.com/en-ca/solutions/2d-and-3d-viewer-functionality/)
- [Trimble Connect visibility tools](https://help.trimble.com/doc/trimble-connect/trimble-connect/connect-for-browsers-3d-viewer/work-in-3d/visibility-tools)

## Near term

- Fragment-level geometry replacement so structural edits do not require a full
  viewer refresh.
- First-class add/remove property and property-set operations with schema-aware
  value types and previewable bulk edits.
- Classification and material assignment editors backed by bSDD discovery.
- Saved selection sets and property-based coloring presets.
- Automated browser-level viewer regression tests with reference screenshots
  and WebGL context/memory counters.

## Later

- Model comparison with spatial/geometry change visualization.
- BCF issue assignment and shareable viewpoints across hosted projects.
- Federated multi-model loading and discipline controls.
- Clash-result visualization and exportable validation reports.
- Signed/notarized macOS packages and ARM64 release targets.

## Deliberately out of scope

IFC Atlas is not intended to replace a full parametric BIM authoring tool.
Constraint solvers, family editors, fabrication modeling, and general-purpose
solid modeling will not be pursued until the viewer, semantic workspace, and
exchange reliability are mature.
