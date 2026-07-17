# Tools Reference
!!! info "Auto-generated"
    This page is regenerated automatically by `scripts/generate_tools_doc.py`
    Do not edit manually - changes will be overwritten.
    To add a new tool, update `TOOL_DEFINITIONS` in `backend/app/services/tools.py`.

---

## Read - Model

Tools in this tier query the loaded IFC model. They are safe for read-only access and are always exposed via the MCP server.

### `get_project_info`

Get metadata about the loaded IFC project including name, schema version, author, and organization.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

_No parameters._

---

### `get_model_stats`

Get statistics about the loaded IFC model: total element count, elements grouped by IFC type, list of storeys, and list of materials.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

_No parameters._

---

### `search_elements`

Search for IFC elements by name, type, or GlobalId. Returns matching elements with their Express ID, name, type, and storey.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Search text to match against element name, IFC type, or GlobalId. |
| `ifc_type` | string |  | Optional IFC type filter (e.g. 'IfcWall', 'IfcDoor', 'IfcWindow'). |
| `storey` | string |  | Optional storey name filter. |
| `limit` | integer |  | Max results to return (default 50). |

---

### `get_element_details`

Get full details for a specific IFC element by its Express ID, including properties, materials, quantities, and type information.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | The IFC Express ID of the element. |

---

### `get_elements_by_type`

Get all elements of a specific IFC type (e.g. IfcWall, IfcDoor, IfcSlab, IfcBeam, IfcColumn, IfcWindow, IfcStair, etc.).

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ifc_type` | string | ✓ | The IFC type to filter by (e.g. 'IfcWall', 'IfcDoor'). |

---

### `get_elements_by_storey`

Get all elements contained in a specific building storey by storey Express ID.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `storey_id` | integer | ✓ | The Express ID of the building storey. |

---

### `get_storeys`

List all building storeys in the model with their Express IDs and names.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

_No parameters._

---

### `search_by_property`

Search for IFC elements that have a specific property name and optionally a specific value. Useful for finding elements by their custom properties like FireRating, IsExternal, LoadBearing, etc.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `property_name` | string | ✓ | Name of the property to search for (e.g. 'FireRating', 'IsExternal', 'LoadBearing'). |
| `property_value` | string |  | Optional value to match (e.g. 'True', '60', 'REI90'). If omitted, returns all elements with that property. |
| `pset_name` | string |  | Optional property set name to narrow the search (e.g. 'Pset_WallCommon'). |
| `limit` | integer |  | Max results to return (default 50). |

---

### `search_elements_semantic`

Semantic search for IFC elements using natural-language descriptions. More powerful than search_elements for intent-based queries like 'load-bearing walls', 'fire-rated partitions', or 'elements on the ground floor'. Falls back to BM25 keyword search if the model index is not yet built. Returns the same shape as search_elements.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Natural-language query describing the elements to find. |
| `top_k` | integer |  | Maximum number of results to return (default 10, max 50). |

---

### `get_all_property_names`

Get a list of all property set names and their property names available in the model. Useful for discovering what properties exist before searching.

**Parameters:**

_No parameters._

---

### `get_quantities_summary`

Aggregate IfcElementQuantity values (lengths, areas, volumes, weights, counts) across the model. Use this for totals like 'total wall area', 'concrete volume per storey', 'gross floor area', or 'total length of pipes'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string |  | How to group the totals. Defaults to 'ifc_type'. |
| `ifc_type` | string |  | Optional IFC type filter (e.g. 'IfcWall'). When set, only that type contributes. |
| `storey` | string |  | Optional storey name filter. When set, only elements on that storey contribute. |

---

### `get_edit_history`

List recent edits that can be undone, newest first. Shows up to 20 entries with edit_id, description, and timestamp.

**Parameters:**

_No parameters._

---

### `execute_ifc_query_code`

Run read-only Python against a sandboxed COPY of the IFC model for analysis and question answering. Use this in Ask mode when the structured read tools are not expressive enough. Available names in the sandbox: `model` / `ifc` (the open ifcopenshell.file handle), `ifcopenshell`, `ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, `statistics`, `re`, `json`, `collections`, `uuid`. Assign to a `result` variable if you want a value back in the chat summary; print output is also captured. If the code produces structural model changes, the sandbox is discarded and the call returns an error. Use `execute_ifc_code` in Edit mode when you intend to stage edits.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✓ | Python source to execute read-only. See the tool description for the names available in scope. Max 100000 chars. |
| `timeout_s` | number |  | Wall-clock budget in seconds. Default 240, min 1, max 240. |

---

### `search_document_index`

Search the user's uploaded document index (PDFs, Markdown specs, standards, notes) using BM25 keyword matching. Returns the top matching passages with source document names and relevance scores. Use this when the user asks a question that might be answered by an uploaded specification or standard, e.g. 'does this model comply with the uploaded BIM standard?' or 'what does the spec say about fire ratings?'. Returns empty results when no documents have been indexed yet.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Natural-language or keyword query to search the document index. |
| `top_k` | integer |  | Maximum number of passages to return (default 5, max 20). |

---

### `get_connected_elements`

Return the wall or slab neighbours that are path-connected to a given element via IfcRelConnectsPathElements. Useful for questions like 'which walls meet at this corner?' or 'what does this wall connect to?'. Returns a list of connected elements with their IFC type and connection type.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the element to find connections for. |

---

### `get_element_material`

Return the material assignment of an IFC element - material name, layer set, layer thicknesses (in mm), and total wall thickness. Useful for questions like 'what material is this wall made of?' or 'how thick is the insulation layer?'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the element. |

---

### `get_openings_for_element`

Return the doors and windows that are hosted by (cut into) a given element. Uses IfcRelVoidsElement to find openings and IfcRelFillsElement to find the door/window that fills each opening. Useful for questions like 'which windows are in the north wall?' or 'does this slab have any openings?'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the host element (typically a wall or slab). |

---

### `find_elements_by_type_name`

Search for elements whose IfcTypeObject name contains a given substring (case-insensitive). Complements get_elements_by_type (which matches exact IFC class names) with human-friendly type names like 'Exterior Wall', 'Double Door', or 'Paroc'. Returns matching elements with their storey. Useful for questions like 'find all Paroc walls' or 'show Basic Wall type'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `substring` | string | ✓ | Substring to match against IfcTypeObject.Name (case-insensitive). |
| `limit` | integer |  | Maximum results to return (default 50). |

---

### `find_nearby_elements`

Find IFC elements within a given radius (in metres) of a reference element, sorted by distance ascending. When the model's real-geometry AABB cache is warm, distances are box-to-box surface distances (result carries geometry: 'aabb'; 0.0 means the elements touch or overlap). Before that cache finishes computing, the tool falls back to Euclidean distance between IfcLocalPlacement origins (result carries geometry: 'placement_origin' plus a note) - origin distances are approximate for large or off-origin elements, so mention that caveat when it applies. Useful for questions like 'what elements are near door #123?', 'find all elements within 3 m of this column', or 'which walls are adjacent to this room?'. Filter by ifc_types to limit to specific element categories.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the reference element. |
| `radius_m` | number |  | Search radius in metres (default 5.0). |
| `ifc_types` | array[string] |  | Optional IFC class filter, e.g. ['IfcWall', 'IfcColumn']. Omit to include all element types. |
| `limit` | integer |  | Maximum results to return (default 20). |

---

### `filter_by_property_value`

Filter elements by a property value condition. Supports string and numeric comparisons. Operators: eq (equals), neq (not equals), contains (substring), startswith, gt (greater than), lt (less than), gte (>=), lte (<=). Returns matching element IDs for highlight + detailed element list. Useful for questions like 'find all walls with FireRating = 2h', 'show rooms with area > 20 m²', or 'which doors have IsExternal = true'. After calling this, call highlight_elements with the returned element_ids.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `property_name` | string | ✓ | Name of the IFC property (e.g. 'FireRating', 'IsExternal', 'Area'). |
| `operator` | string | ✓ | Comparison operator. |
| `value` | string | ✓ | Value to compare against (always a string; numeric operators coerce both sides). |
| `ifc_type` | string |  | Optional IFC class filter (e.g. 'IfcWall'). Omit for all types. |
| `storey` | string |  | Optional storey name filter. Omit for all storeys. |
| `pset_name` | string |  | Optional property set name filter (e.g. 'Pset_WallCommon'). Omit to search all psets. |
| `limit` | integer |  | Maximum results to return (default 100). |

---

### `get_cost_summary`

Priced bill of quantities (5D cost estimate) for the loaded model. Runs the quantity takeoff grouped by IFC class (plus optional extra dimensions), prices each row from the editable rate library, and returns rows sorted by amount descending with the grand total and priced/unpriced coverage. IMPORTANT: rates come from the user-editable cost rate library and the shipped defaults are illustrative placeholders, NOT market prices - always present amounts as estimates and mention that rates are editable in the Cost panel. Use for questions like 'what does this building cost?', 'cost breakdown per storey', or 'which element types drive the cost?'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | array[string] |  | Optional extra grouping dimensions applied after the implicit ifc_class (e.g. ['storey'] for a per-storey cost breakdown). |
| `top_rows` | integer |  | Maximum rows to return, sorted by amount descending (default 25, max 100). Totals always cover ALL rows. |

---

### `get_carbon_summary`

Embodied-carbon estimate for the loaded model, grouped by material (plus optional extra dimensions). Multiplies quantity takeoff values by emission factors (kgCO2e per unit) from the editable factor library, with keyword fallbacks for common materials (concrete, steel, timber, glass, ...). Returns rows sorted by carbon descending with totals in kg and tonnes plus factored/unfactored coverage. IMPORTANT: the default factors are illustrative cradle-to-gate placeholders, NOT a certified LCA - always present figures as rough estimates and mention that factors are editable in the Carbon panel. Use for questions like 'what is the embodied carbon of this building?' or 'which material drives the CO2 footprint?'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | array[string] |  | Optional extra grouping dimensions applied after the implicit material (e.g. ['storey'] for a per-storey carbon breakdown). |
| `top_rows` | integer |  | Maximum rows to return, sorted by carbon descending (default 25, max 100). Totals always cover ALL rows. |

---

### `get_element_relationships`

Full relationship map for one element: spatial containment chain (storey / building / site / project), aggregation parent and children, openings the element hosts and what fills them (doors / windows), the opening + host the element itself fills, path-connected neighbours, its type object with the instance count, and property-set sharing stats. Every reference includes the Express ID, GlobalId, name and IFC type so you can narrate the context. Use for questions like 'where is this element?', 'which wall hosts this door?', 'what belongs to this wall?', or 'how is this element related to the rest of the model?'.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the element to map relationships for. |

---

## Read - Viewer

Tools in this tier control what is visible in the 3D viewport. They execute client-side in the browser and are **not** exposed via the MCP server.

### `highlight_elements`

Highlight specific elements in the 3D viewer by their Express IDs. Use this when the user asks to show, highlight, or point out elements.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_ids` | array[integer] | ✓ | List of Express IDs to highlight in the viewer. |

---

### `select_element`

Select a single element in the 3D viewer and open its properties panel. Use when the user asks to focus on, inspect, or open one specific element.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | The IFC Express ID of the element to select. |

---

### `isolate_elements`

Isolate specific elements in the 3D viewer (hide everything else). Useful when the user asks to focus on a subset, e.g. 'isolate level 2' or 'show me only doors'.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_ids` | array[integer] | ✓ | List of Express IDs to keep visible. Pass an empty array to clear isolation. |

---

### `show_all_elements`

Restore full visibility in the 3D viewer (clear any isolation/hiding). Use when the user asks to see everything again.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

_No parameters._

---

### `clip_section_box_to_element`

Fit the 3D section-box crop to a single element's bounding box (AABB) with 10 % padding. Useful when the user asks to 'zoom into', 'section', 'cut to', or 'focus the section box on' a specific element. Combines a section-box enable with an element-centred crop in one step.

!!! note "Client-side"
    This tool executes in the browser (metadata worker). Results arrive via the tool_result WS event.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the element to clip the section box to. |

---

## Validate

Tools in this tier validate the model against external specifications such as IDS.

### `run_model_health_check`

Run a set of deterministic IFC model quality rules and return a structured JSON report including total issue counts, per-severity breakdown, and per-rule issue records with element names and Express IDs. Seven rules are checked: (1) missing_global_id - elements without a GUID (severity: error); (2) duplicate_global_id - elements sharing a GUID (severity: error); (3) missing_name - structural elements with blank Name (severity: warning); (4) empty_property_sets - IfcPropertySet with no properties (severity: warning); (5) no_storey_assignment - walls/slabs/columns/beams not assigned to any building storey (severity: warning); (6) duplicate_name_in_type - same Name used for multiple instances of the same door/window/space type (severity: info); (7) large_element_count - informational flag when the model has more than 10 000 elements. Use this tool when the user asks about model quality, data integrity, BIM health, QA/QC audits, or missing data issues. The response includes duration_ms so you can report how long the check took.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit_per_rule` | integer |  | Max issue records to return per rule (default 50). Use 10-20 for a quick summary, 100+ for deep audits. |

---

### `ids_validate`

Validate the loaded IFC model against a buildingSMART IDS (Information Delivery Specification) XML document. The IDS payload is supplied as base64 (typically from a chat file attachment with kind='ids'). Returns per-specification pass/fail counts and a list of offending Express IDs with reasons. Prefer this over manual property searches when the user asks to audit the model against a spec.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ids_base64` | string | ✓ | Base64-encoded IDS XML. The chat attachment pipeline exposes one as {kind:'ids', data_base64}; pass that data_base64 through unchanged. |
| `limit_per_spec` | integer |  | Max failing elements to enumerate per spec (default 25). |

---

### `highlight_ids_failures`

Highlight in the 3D viewer all IFC elements that failed an IDS specification. Re-runs the IDS validation and highlights only the failing elements for the given spec (or all specs if spec_name is omitted). Call after ids_validate when the user asks to see non-compliant elements in the model.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ids_base64` | string | ✓ | Same base64-encoded IDS XML used in ids_validate. |
| `spec_name` | string |  | Name of a single specification to highlight (from the 'name' field in ids_validate results). If omitted, all failing elements across all specs are highlighted. |

---

### `run_model_audit`

THE tool for 'audit this model', 'is this model ready?', or any overall quality-and-readiness question. One call chains five checks into a structured report: (1) rule-based model health (GUIDs, names, storey assignment, empty psets), (2) quantity-takeoff coverage (how many elements carry base quantities), (3) 5D cost pricing coverage, (4) embodied-carbon factor coverage, and (5) a summary of the last cached IDS validation run for this model when one exists. Returns {sections: [{name, status: ok|warnings|issues, findings, stats}], summary} - narrate it section by section, leading with the overall summary status and any 'issues' sections. Cost and carbon figures rely on the editable placeholder rate/factor libraries, so flag them as estimates.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit_per_rule` | integer |  | Max issue examples per health rule (default 10). Raise for deep audits. |

---

## Write - Edit

Tools in this tier modify the IFC model. They require the **Edit** pill to be active in the chat panel. Write tools are off by default in the MCP server (enable with `MCP_ALLOW_WRITES=1`).

### `rename_element`

Rename an IFC element by changing its Name attribute. Chat-agent calls are staged in an IFC sandbox for approval before apply. Always confirm the element_id with get_element_details first.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | The IFC Express ID of the element to rename. |
| `new_name` | string | ✓ | The new name string. Must be non-empty. |

---

### `update_property_value`

Update a single property value on an IFC element's property set. Chat-agent calls are staged in an IFC sandbox for approval before apply. Use get_element_details first to confirm the property set and property name.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | The IFC Express ID of the element. |
| `property_name` | string | ✓ | Exact name of the IfcPropertySingleValue to update. |
| `new_value` | any | ✓ | New value. Provide as a string, number, or boolean to match the existing property type. |
| `pset_name` | string |  | Optional: name of the IfcPropertySet that contains the property. Required if multiple psets share the same property name. |

---

### `update_element_attribute`

Update one safe IFC text attribute without changing geometry. Supported attributes: Description, ObjectType, Tag, LongName. The edit is sandboxed for approval, validated, logged, and updates the viewer in place. Use get_element_details first to confirm the element and current value.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | IFC Express ID of the element. |
| `attribute` | string | ✓ | The controlled IFC text attribute to update. |
| `new_value` | string | ✓ | New text, or an empty string to clear the optional attribute. |

---

### `rename_elements_batch`

Rename multiple IFC elements in a single atomic operation. All renames share ONE undo entry, so undo_last_edit rolls back the whole batch at once. Partial failures (element not found, missing Name) are recorded in 'results' but don't abort the remaining renames. Prefer this over looping rename_element when renaming more than one element.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `renames` | array[object] | ✓ | List of {element_id, new_name} rename operations. |

---

### `update_properties_batch`

Update property values on multiple IFC elements in a single atomic operation. All updates share ONE undo entry, so undo_last_edit rolls back the whole batch at once. Items where the property is not found or fails are recorded in 'results' but don't abort the remaining updates. Prefer this over looping update_property_value when changing more than one element.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `updates` | array[object] | ✓ | List of property update operations. |

---

### `undo_last_edit`

Undo the most recent rename_element, update_property_value, rename_elements_batch, or update_properties_batch operation. Can be called repeatedly to walk back through the edit history (up to 20 edits).

**Parameters:**

_No parameters._

---

### `propose_edit`

Propose a batch of edits for USER APPROVAL before they touch the live model. The backend runs the ops in an isolated sandbox, computes a structural diff (renamed / property-changed / deleted), and returns a pending-edit envelope. The user clicks Apply or Discard in the UI - nothing mutates until they do. Prefer this over rename_element / update_property_value when the change is larger than one element or when the user asked you to 'preview' / 'show me the diff'. Supports ops: {'op':'set_name','element_id':int,'new_name':str}, {'op':'set_property','element_id':int,'property_name':str,'new_value':any,'pset_name':str?}.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ops` | array[object] | ✓ | Ordered list of edit ops to stage. |
| `summary` | string |  | Optional one-line human summary shown in the preview. |

---

### `execute_ifc_code`

Run edit-capable Python against a sandboxed COPY of the IFC model - the full sandbox-then-apply edit path. Use this from Edit mode when the change doesn't fit the enumerable op vocabulary of propose_edit (e.g. batch geometry moves, custom algorithms, relationship rewiring, psets created/deleted programmatically). Available names in the sandbox: `model` / `ifc` (the open ifcopenshell.file handle), `ifcopenshell`, `ifcopenshell.api`, `ifcopenshell.util.element`, plus `math`, `statistics`, `re`, `json`, `collections`, `uuid`. Assign to a `result` variable if you want a value back in the chat summary (its repr is returned, capped at 2 KB). Any `print(...)` output is also captured. The code runs in a subprocess with a wall-clock timeout and no network / filesystem access outside the sandbox file. If the code mutates the model, a diff envelope is returned and the user must click Apply in the UI - nothing touches the live handle until they do. If the hash is unchanged, the call is treated as read-only and returns the captured stdout + `result` repr.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | string | ✓ | Python source to execute. See the tool description for the names available in scope. Max 100000 chars. |
| `summary` | string |  | Optional one-line human summary shown in the Apply preview (ignored for pure reads). |
| `timeout_s` | number |  | Wall-clock budget in seconds. Default 240, min 1, max 240. |

---

### `create_wall_from_ends`

Create a new IfcWallStandardCase between two XY endpoint coordinates on a given building storey. The wall geometry is built from a swept rectangular profile using IfcOpenShell's ShapeBuilder. The result goes through the standard sandbox → diff-preview envelope: the user sees a 'New element' row in the Diff Preview panel and must click Apply before the wall is committed to the live model.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `start` | array[number] | ✓ | Start point [x, y] or [x, y, z] in metres. |
| `end` | array[number] | ✓ | End point [x, y] or [x, y, z] in metres. |
| `height` | number |  | Wall height in metres (default 3.0). |
| `thickness` | number |  | Wall thickness in metres (default 0.2). |
| `storey_name` | string |  | Name of the target building storey (e.g. 'Ground Floor'). Omit to use the first storey in the model. |
| `name` | string |  | Name for the new wall element (default 'Wall'). |

---

### `delete_element`

Delete an IfcProduct element from the model by its Express ID. Only IfcProduct subclasses (walls, slabs, doors, windows, columns, beams, spaces, etc.) can be deleted via this tool. The deletion goes through the sandbox → diff-preview envelope: the user sees a 'Deleted element' row in the Diff Preview panel and must click Apply to commit the deletion. This is irreversible after Apply - the undo stack covers simple property edits but not structural deletions. Warn the user before proposing large-scale deletions.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ | Express ID of the IfcProduct to delete. |
| `reason` | string |  | Optional short reason for the deletion (shown in the diff summary). |

---

## Read - Knowledge



### `bsdd_search`

Search the buildingSMART Data Dictionary (bSDD) for IFC classifications and properties by free text. bSDD is the authoritative online dictionary of building classification systems (Uniclass, IFC, DIN, etc.). Use it to find the right classification for an element, discover standard property definitions, or answer 'what classification/property should this have?'. Works WITHOUT a loaded model. Returns matching classes/properties with their bSDD URIs - pass a URI to bsdd_get_class / bsdd_get_properties.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✓ | Free-text search, e.g. 'exterior wall' or 'fire rating'. |
| `dictionary_uri` | string |  | Optional bSDD dictionary URI to scope the search. |
| `limit` | integer |  | Maximum results (default 20, max 50). |

---

### `bsdd_get_class`

Fetch the full bSDD definition of one classification by its URI - definition, parent class, and associated properties. Get the URI from bsdd_search first. Works WITHOUT a loaded model.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `uri` | string | ✓ | The bSDD class URI (from bsdd_search results). |

---

### `bsdd_get_properties`

List the standard properties a bSDD classification defines, by class URI - the correct property set + property names and datatypes the classification expects. Get the URI from bsdd_search. No model needed.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `uri` | string | ✓ | The bSDD class URI whose properties to list. |

---

### `get_docs`

Look up reference documentation. Sources: 'ifcopenshell' (the IfcOpenShell Python API - consult BEFORE writing execute_ifc_code so the calls are correct), 'bsdd' (buildingSMART classifications / properties), 'user' (documents the user uploaded), 'ifc-schema' (IFC entity / attribute reference). Returns the most relevant passages with their source. Works WITHOUT a loaded model. If a source isn't indexed yet the result says so and how to index it.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✓ | Which knowledge source to query. |
| `query` | string | ✓ | Natural-language question or keywords. |
| `symbol` | string |  | Optional exact symbol to prioritise, e.g. 'ifcopenshell.api.geometry.edit_object_placement' or a bSDD class URI. |
| `limit` | integer |  | Maximum passages to return (default 5, max 15). |

---

_Last regenerated: 2026-07-17. Run `python scripts/generate_tools_doc.py` to refresh._
