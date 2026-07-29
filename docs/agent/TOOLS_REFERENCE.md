# Tools Reference
!!! info "Auto-generated"
    This page is regenerated automatically by `scripts/generate_tools_doc.py`
    Do not edit manually - changes will be overwritten.
    To add a new tool, update `TOOL_DEFINITIONS` in `backend/app/services/tools.py`.

---

## Read - Model

Tools in this tier query the loaded IFC model. They are safe for read-only access and are always exposed via the MCP server.

### `describe_model`

Read one overview aspect of the loaded IFC model. part='project': metadata (name, schema, author, organization). 'stats': element counts by IFC type, storey list, materials. 'storeys': storeys with Express IDs and names. 'property_names': every property-set and property name in the model - discover these before property queries.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `part` | string | ✓ | Which overview to return. |

---

### `query_elements`

Find IFC elements matching a predicate; returns element summaries (Express ID, name, type, storey). mode='text': match query against name/type/GlobalId. 'semantic': natural-language query like 'load-bearing walls'. 'type': all elements of the exact IFC class in ifc_type. 'storey': all elements on storey_id. 'type_name': elements whose IfcTypeObject name contains query (e.g. 'Basic Wall'). 'property': elements by property - give property_name, plus operator+value to compare, value alone for equality, or neither to list elements having the property. 'near': elements within radius_m of element_id, sorted by distance.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `mode` | string | ✓ | Search strategy. |
| `query` | string |  | Search text (modes text, semantic, type_name). |
| `ifc_type` | string |  | IFC class, e.g. 'IfcWall' (required for mode=type; optional filter for text/property). |
| `storey` | string |  | Storey name filter (modes text, property). |
| `storey_id` | integer |  | Storey Express ID (required for mode=storey). |
| `property_name` | string |  | Property to match, e.g. 'FireRating' (mode=property). |
| `operator` | string |  | Comparison operator (mode=property). |
| `value` | string |  | Value to compare against (mode=property). |
| `pset_name` | string |  | Property-set filter, e.g. 'Pset_WallCommon' (mode=property). |
| `element_id` | integer |  | Reference element (mode=near). |
| `radius_m` | number |  | Search radius in metres, default 5.0 (mode=near). |
| `ifc_types` | array[string] |  | Optional IFC class filter list (mode=near). |
| `limit` | integer |  | Max results to return. |

---

### `get_element`

Read one element by Express ID. include selects aspects: 'details' (default - attributes, property sets, quantities, type), 'material' (material/layer set with thicknesses), 'openings' (hosted doors/windows), 'connections' (path-connected neighbours), 'relationships' (full map: spatial containment chain, aggregation, openings, connections, type object + pset sharing stats).

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | The IFC Express ID of the element. |
| `include` | array[string] |  | Aspects to return (default ['details']). |

---

### `quantity_summary`

Aggregate model totals. kind='qto': IfcElementQuantity totals (areas, volumes, lengths, counts) grouped by ifc_type or storey - use for 'total wall area' style questions instead of summing element-by-element. 'cost': priced bill of quantities from the editable rate library. 'carbon': embodied-carbon estimate from the editable factor library. Cost/carbon defaults are illustrative placeholders, NOT market prices or a certified LCA - present those figures as rough estimates.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `kind` | string | ✓ | Which summary to compute. |
| `group_by` | array[string] |  | Grouping dimensions. qto: 'ifc_type' or 'storey' (first entry, default ifc_type). cost extras beyond the implicit ifc_class: storey|material|type_object|classification. carbon extras beyond the implicit material: ifc_class|storey|type_object|classification. |
| `ifc_type` | string |  | Optional IFC class filter (kind=qto). |
| `storey` | string |  | Optional storey name filter (kind=qto). |
| `top_rows` | integer |  | Max rows returned, sorted descending (cost/carbon, default 25, max 100). Totals always cover all rows. |

---

### `execute_ifc_query_code`

Run read-only Python against a sandboxed COPY of the IFC model for analysis and question answering - use when the structured read tools are not expressive enough. Available names: `model` / `ifc` (the open ifcopenshell.file handle), `ifcopenshell`, `ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, `statistics`, `re`, `json`, `collections`, `uuid`. Assign to a `result` variable for a value back in the chat summary; print output is also captured. If the code produces structural model changes, the sandbox is discarded and an error returned - use execute_ifc_code when you intend to stage edits.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✓ | Python source to execute read-only. See the tool description for the names available in scope. Max 100000 chars. |
| `timeout_s` | number |  | Wall-clock budget in seconds. Default 240, min 1, max 240. |

---

### `get_edit_history`

List recent edits that can be undone, newest first. Shows up to 20 entries with edit_id, description, and timestamp.

**Parameters:**

_No parameters._

---

## Read - Viewer

Tools in this tier control what is visible in the 3D viewport. They execute client-side in the browser and are **not** exposed via the MCP server.

### `viewer_control`

Drive the 3D viewer (presentation only - never modifies the model). action='highlight': colour-mark element_ids. 'select': select one element_id and open its properties panel. 'isolate': show only element_ids, hide the rest (empty array clears isolation). 'show_all': restore full visibility. 'clip_section_box': fit the section-box crop to element_id.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✓ | Viewer action to perform. |
| `element_ids` | array[integer] |  | Target Express IDs (actions highlight, isolate). |
| `element_id` | integer |  | Target Express ID (actions select, clip_section_box). |

---

## Validate

Tools in this tier validate the model against external specifications such as IDS.

### `validate_model`

Quality-check the model. check='health': deterministic rules (missing/duplicate GlobalIds, blank names, empty psets, missing storey assignment, duplicate type names, element count). 'audit': THE tool for 'audit this model' / 'is it ready?' - chains health, quantity/cost/carbon coverage and the last cached IDS run into one report; flag cost/carbon figures as estimates. 'ids': validate against buildingSMART IDS XML supplied as ids_base64 (from a chat attachment with kind='ids'); returns per-spec pass/fail with offending Express IDs. Set highlight_failures=true to instead highlight the failing elements in the viewer (optionally only spec_name).

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `check` | string | ✓ | Which validation to run. |
| `ids_base64` | string |  | Base64-encoded IDS XML (required for check=ids). |
| `spec_name` | string |  | Restrict highlighting to one specification name (check=ids). |
| `highlight_failures` | boolean |  | Highlight failing elements in the viewer instead of returning the report (check=ids). |
| `limit` | integer |  | Max issues per rule/spec (defaults: health 50, audit 10, ids 25). |

---

## Write - Edit

Tools in this tier modify the IFC model. They require the **Edit** pill to be active in the chat panel. Write tools are off by default in the MCP server (enable with `MCP_ALLOW_WRITES=1`).

### `edit_semantic`

Stage metadata-only edits (no geometry change, no viewer reload) as one atomic batch sharing a single undo entry. Chat-agent calls are sandboxed into a pending diff the user must Apply. Ops: {op:'set_name', element_id, new_name}; {op:'set_property', element_id, property_name, new_value, pset_name?}; {op:'set_attribute', element_id, attribute: Description|ObjectType|Tag|LongName, new_value}. Confirm element IDs and current values with get_element first.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ops` | array[object] | ✓ | Ordered metadata edit operations. |
| `summary` | string |  | Optional one-line human summary shown in the preview. |

---

### `edit_structural`

Stage geometry-changing edits; applying reloads the 3D viewer. Every call returns a pending diff the user must Apply - nothing mutates until they do. Ops: {op:'create_wall', start:[x,y], end:[x,y], height?, thickness?, storey_name?, name?} - new IfcWallStandardCase between two points (metres); {op:'delete_element', element_id, reason?} - delete an IfcProduct; NOT undoable after Apply, warn the user before large deletions.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ops` | array[object] | ✓ | Ordered structural operations. |
| `summary` | string |  | Optional one-line human summary shown in the preview. |

---

### `execute_ifc_code`

Run edit-capable Python against a sandboxed COPY of the IFC model - the full sandbox-then-apply edit path. Use when the change doesn't fit edit_semantic/edit_structural ops (batch geometry moves, custom algorithms, relationship rewiring, psets created/deleted programmatically). Available names: `model` / `ifc` (the open ifcopenshell.file handle), `ifcopenshell`, `ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, `statistics`, `re`, `json`, `collections`, `uuid`. Assign to `result` for a value back in the summary; print output is captured. Runs in a subprocess with a timeout and no network / filesystem access outside the sandbox file. If the code mutates the model, a diff envelope is returned and the user must click Apply - nothing touches the live model until they do; if the hash is unchanged the call is treated as read-only.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✓ | Python source to execute. See the tool description for the names available in scope. Max 100000 chars. |
| `summary` | string |  | Optional one-line human summary shown in the Apply preview (ignored for pure reads). |
| `timeout_s` | number |  | Wall-clock budget in seconds. Default 240, min 1, max 240. |

---

### `undo_last_edit`

Undo the most recently applied edit (edit_semantic batches share one undo entry, so a batch rolls back atomically). Can be called repeatedly to walk back through the edit history (up to 20 edits). Structural deletions applied via edit_structural are NOT undoable.

**Parameters:**

_No parameters._

---

## Read - Knowledge



### `get_docs`

Unified reference lookup - works WITHOUT a loaded model. source='ifcopenshell': the installed IfcOpenShell Python API - consult BEFORE writing execute_ifc_code (pass symbol for an exact API path). 'bsdd': buildingSMART Data Dictionary - free-text search for classifications/properties via query, or pass uri (from a previous search) with detail='class' or 'properties' for one class's definition or its standard property list. 'user': search documents the user uploaded (specs, standards, notes). 'ifc-schema': IFC entity/attribute reference. If a source isn't indexed yet the result says so.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✓ | Which knowledge source to query. |
| `query` | string |  | Natural-language question or keywords. |
| `symbol` | string |  | Exact symbol to prioritise, e.g. 'ifcopenshell.api.pset.edit_pset'. |
| `uri` | string |  | bSDD class URI for a detail lookup (source=bsdd). |
| `detail` | string |  | With uri: full class definition (default) or its property list. |
| `limit` | integer |  | Maximum passages/results (default 5, max 15). |

---

_Last regenerated: 2026-07-29. Run `python scripts/generate_tools_doc.py` to refresh._
