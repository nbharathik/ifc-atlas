# Editing IFC models

IFC Atlas edits **native IFC**: every change is written by IfcOpenShell into
the IFC file itself (never into a proprietary scene format), through one
audited operation layer shared by you, the AI assistant, and external MCP
clients. The 3D scene is just a projection of the file - what you save is
valid, portable IFC with stable element IDs.

Editing is on by default. To run a read-only deployment set
`EDIT_MODE_ENABLED=0` on the backend - the entire edit surface (UI, AI write
tools, MCP direct ops) disappears together.

## Create or open a project

- **Open**: drag an `.ifc` file onto the window, or File → Open IFC….
- **New**: File → New project… (single-storey, two-storey, or empty), or the
  "New Project" buttons on the start screen. Templates are valid IFC4 files
  with SI units, geometric contexts, and a Project → Site → Building → Storey
  scaffold, ready to receive elements.

## Switch between viewing and editing

Click the **Edit** button in the top toolbar (or Edit menu → Enter Edit mode).
In Edit mode:

- property values in the Properties panel become editable,
- the drawing toolbar appears in the viewport,
- undo/redo buttons show in the status bar.

View mode is untouched by all of this - the viewer performs identically with
editing available but idle.

## Select and inspect elements

Click an element in the viewport or the outliner. The Properties panel shows
identity, quantities, and property sets. Ctrl+click for multi-selection.

## Edit properties

In Edit mode, click any value in the Properties panel (Name or a property-set
value), type the new value, and press Enter. Values are validated against
their original type (a number stays a number, a boolean needs true/false),
the panel refreshes from the authoritative model, and the outliner updates
for renames. Every inline edit is one operation: logged, checkpointed, and
undoable.

## Draw building elements

**Not available in this release.** Geometry authoring (drawing walls, placing
slabs, deleting elements) reloads the 3D viewer on every applied edit, which is
too disruptive to ship outside beta, so the whole surface is turned off in the
app: there is no drawing toolbar, no edit-scope toggle, and the AI cannot create
or delete geometry. Editing is limited to metadata, which updates in place with
no reload.

Walls, slabs, storeys, spatial moves, and deletions remain available to
API/MCP clients as operations (`create_wall`, `create_slab`, `create_storey`,
`assign_to_storey`, `set_storey_elevation`, `delete_element`) - the server side
is unchanged. Expect the in-app surface back once geometry edits stop requiring
a full reload.

## Use AI assistance

Switch the chat to **Edit** mode (pill above the message box) and ask for the
change: "rename all doors on the ground floor to D-101…", "add a 4 m wall
along the north side", "delete the selected column". Your current viewport
selection is sent with each message, so "the selected wall" resolves without
further explanation.

AI edits are **never applied directly**: each one is staged in a sandbox and
presented as a diff preview.

## Review proposed AI changes

The Diff Preview panel lists exactly what would change (renames, property
changes, created/deleted elements) plus a **verifier verdict**: the staged
model is health-checked against the live baseline and any created geometry is
tessellation-tested before you see the proposal. PASS/WARN/FAIL shows at the
top of the panel; the AI sees the same verdict and will usually withdraw and
correct a failing edit on its own. Click **Apply** to commit or **Discard**
to reject.

## Undo, redo, and compare changes

- **Ctrl+Z / Ctrl+Y** (also Ctrl+Shift+Z) undo and redo, from the keyboard,
  the status bar, or the Edit menu. Undo works across surfaces - it reverts
  the last committed change whether you made it inline, drew it, or the AI
  applied it.
- The **Timeline panel** (Shift+H) shows the full history: every operation
  with who made it (you / AI / MCP), merged with the automatic git
  checkpoints taken after each change. Filter by actor, select two points to
  see a semantic diff (powered by ifcdiff - including property changes), click
  a changed element to flash it in the viewport, and restore any checkpoint.

## Save and export

- **File → Save** writes your edits back to the loaded file. The status bar
  shows "● Unsaved changes" until you do; closing the model or the tab with
  unsaved edits asks first.
- **File → Save as IFC…** downloads a copy instead (the loaded file is not
  touched).
- Saves preserve the native-IFC ID contract - element express IDs and
  GlobalIds survive save/reload round-trips, so external diff/merge tools
  keep working against your history.

## For developers and external agents

The same operations are exposed programmatically:

- REST: `GET /api/ifc/operations/catalogue`, `POST /api/ifc/operations/execute`
  (plus `/undo`, `/redo`, `/history` and `GET /api/ifc/history/diff`). See
  [REST API](../api/REST.md).
- MCP: read tools always; staged writes under `MCP_ALLOW_WRITES=1`; direct
  operations additionally require `EDIT_MODE_ENABLED=1`. Edits from MCP
  clients broadcast live to open viewers and are attributed as `mcp` in the
  timeline.
