# REST API
!!! info "Auto-generated"
    This page is regenerated automatically by `scripts/generate_api_doc.py`
    from the FastAPI OpenAPI spec. Do not edit manually.
    To add a new endpoint, add a route in `backend/app/api/`.

---

## Other

### `GET` `/api/health`

Health

**Response:** Successful Response

---

## bcf

### `GET` `/api/bcf/export`

Export Bcf

Download every topic for the loaded model as a BCF 2.1 .bcfzip.

**Response:** Successful Response

---

### `POST` `/api/bcf/import`

Import Bcf

Import a .bcfzip, merging topics by guid (incoming wins).

**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `GET` `/api/bcf/topics`

List Topics

List every BCF topic stored for the loaded model.

**Response:** Successful Response

---

### `POST` `/api/bcf/topics`

Create Topic

Create a topic; an optional snapshot arrives as a data:image/jpeg URL.

**Request body:** `TopicCreateRequest` (JSON)

**Response:** Successful Response

---

### `PATCH` `/api/bcf/topics/{guid}`

Update Topic

Partially update a topic's editable fields.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `guid` | string | ✓ |  |
**Request body:** `TopicPatchRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/bcf/topics/{guid}`

Delete Topic

Delete a topic and its stored snapshot.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `guid` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/bcf/topics/{guid}/comments`

Add Comment

Append a comment; returns the full topic with the new comment.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `guid` | string | ✓ |  |
**Request body:** `CommentCreateRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/bcf/topics/{guid}/snapshot`

Get Topic Snapshot

Serve the topic's snapshot JPEG; 404 when the topic has none.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `guid` | string | ✓ |  |
**Response:** Successful Response

---

## carbon

### `GET` `/api/carbon/estimate`

Carbon Estimate

Embodied-carbon estimate for the loaded model (grouped by material + extras).

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string |  | Extra dimensions after material: ifc_class, storey, type_object, classification |
| `include_ids` | boolean |  | Attach element_ids per row. |
**Response:** Successful Response

---

### `GET` `/api/carbon/estimate.csv`

Carbon Estimate Csv

Download the carbon estimate as a CSV attachment.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string |  | Extra dimensions after material. |
**Response:** Successful Response

---

### `GET` `/api/carbon/factors`

Get Factors

Return the persisted user factor library (empty means keyword defaults apply).

**Response:** Successful Response

---

### `PUT` `/api/carbon/factors`

Put Factors

Replace the factor library (sanitized). Body: ``{"factors": {...}}``.

An empty body legitimately clears the library (keyword defaults apply
again); a non-empty body where no entry survives sanitization is a 422 so
a malformed payload can never silently wipe the user's factors.

**Request body:** `Body_put_factors_api_carbon_factors_put` (JSON)

**Response:** Successful Response

---

## chat

### `GET` `/api/chat/agents`

Get Agents

Return the catalogue of agent presets for the UI picker.

**Response:** Successful Response

---

### `POST` `/api/chat/agents`

Create Agent

Create a new custom agent preset.

**Request body:** `AgentCreateRequest` (JSON)

**Response:** Successful Response

---

### `PUT` `/api/chat/agents/{agent_id}`

Update Agent

Update an existing custom agent preset.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | ✓ |  |
**Request body:** `AgentCreateRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/chat/agents/{agent_id}`

Delete Agent

Delete a custom agent preset.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/budget/summary`

Get Budget Summary

Return the current-month USD spend per agent.

Response shape:
  {
    "month": "2026-05",
    "agents": [
      {"agent_id": "...", "label": "...", "spent_usd": 0.123, "budget_usd": 5.0, "status": "ok"}
    ]
  }

**Response:** Successful Response

---

### `DELETE` `/api/chat/budget/{agent_id}`

Reset Agent Budget

Reset the current-month spend counter for a single agent.

Useful for correcting erroneous charges or for testing.  Does not modify
the agent's monthly_budget_usd cap - only the accumulated spend.
Returns ``{"reset": agent_id, "previous_spent_usd": float}``.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/context`

Get Model Context

Return the context block currently injected into agent system prompts.

The frontend Agent Harness panel displays this so users know exactly
what model metadata the agents receive automatically.

**Response:** Successful Response

---

### `GET` `/api/chat/docs`

List Docs

Return all indexed document metadata, newest first.

**Response:** Successful Response

---

### `GET` `/api/chat/docs/semantic-status`

Doc Semantic Status

Return the current semantic-search status for the document index.

Reports whether fastembed + hnswlib are available, whether the HNSW
index has been built, the model in use, and the current chunk count.
Useful for the frontend to surface 'Semantic search active' / 'BM25 only'
badges without additional client-side detection logic.

**Response:** Successful Response

---

### `POST` `/api/chat/docs/upload`

Upload Doc

Upload a PDF or Markdown file and index it for agent search.

**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `DELETE` `/api/chat/docs/{doc_id}`

Delete Doc

Remove a document from the index.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `doc_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/manager/bootstrap`

Get Manager Bootstrap

Return all Chat Manager data in one payload.

The frontend uses this to avoid multiple parallel REST calls when opening
the manager modal, which significantly reduces perceived load latency.

**Response:** Successful Response

---

### `GET` `/api/chat/models`

Get Models

Return the full model catalogue (enabled + disabled) for the Models tab.

**Response:** Successful Response

---

### `POST` `/api/chat/models`

Create Model

**Request body:** `ModelRequest` (JSON)

**Response:** Successful Response

---

### `PUT` `/api/chat/models/reorder`

Reorder Models

Persist a new display order. Body: ``{order: [entry_id, ...]}``.

**Request body:** `ModelReorderRequest` (JSON)

**Response:** Successful Response

---

### `PUT` `/api/chat/models/{model_id}`

Update Model

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `model_id` | string | ✓ |  |
**Request body:** `ModelRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/chat/models/{model_id}`

Delete Model

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `model_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/prompts`

Get Prompts

**Response:** Successful Response

---

### `POST` `/api/chat/prompts`

Create Prompt

**Request body:** `PromptRequest` (JSON)

**Response:** Successful Response

---

### `PUT` `/api/chat/prompts/{prompt_id}`

Update Prompt

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `prompt_id` | string | ✓ |  |
**Request body:** `PromptRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/chat/prompts/{prompt_id}`

Delete Prompt

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `prompt_id` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/chat/reference-docs/fetch`

Reference Docs Fetch

(Re)build the reference-docs index from installed sources.

Currently indexes the installed IfcOpenShell Python API docstrings (grouped
per API domain). Runs off the event loop - importing and walking the package
takes a few seconds - so the chat WebSocket stays responsive. Returns the
index result (indexed domain count, ifcopenshell version). Idempotent: a
re-fetch clears and rebuilds.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `source` | string |  |  |
**Response:** Successful Response

---

### `GET` `/api/chat/reference-docs/status`

Reference Docs Status

Status of the AI reference-docs index (IfcOpenShell API, IFC schema).

Drives the Chat Manager "Knowledge" tab: how many reference documents are
indexed and whether semantic search is active. Distinct from ``/docs`` which
manages the *user's* uploaded documents; reference docs are the API/schema
knowledge the ``get_docs`` tool consults.

**Response:** Successful Response

---

### `GET` `/api/chat/snippets`

Get Snippets

Return all prompt snippets (built-ins + custom).

**Response:** Successful Response

---

### `POST` `/api/chat/snippets`

Create Snippet

Create a new custom prompt snippet.

**Request body:** `SnippetRequest` (JSON)

---

### `PUT` `/api/chat/snippets/{snippet_id}`

Update Snippet

Update a custom prompt snippet.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `snippet_id` | string | ✓ |  |
**Request body:** `SnippetRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/chat/snippets/{snippet_id}`

Delete Snippet

Delete a custom prompt snippet.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `snippet_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/thread/{thread_id}/state`

Get Thread State

Return the latest checkpoint for a LangGraph thread.

The frontend can call this on reconnect to restore conversation history
without the user needing to repeat themselves.

When no checkpoint exists yet (fresh thread, graph_mode was False, or
LangGraph isn't installed), an empty-state payload is returned with HTTP
200 instead of 404. The frontend always asks once on mount; returning an
empty payload keeps the browser console quiet for the common "new thread"
case without changing observable behaviour (frontend treats missing
history as no-op either way).

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `thread_id` | string | ✓ |  |
**Response:** Successful Response

---

### `DELETE` `/api/chat/thread/{thread_id}/state`

Delete Thread State

Clear the checkpoint for a thread (user explicitly starts fresh).

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `thread_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/tool-sets`

Get Tool Sets

**Response:** Successful Response

---

### `POST` `/api/chat/tool-sets`

Create Tool Set

**Request body:** `ToolSetRequest` (JSON)

**Response:** Successful Response

---

### `PUT` `/api/chat/tool-sets/{set_id}`

Update Tool Set

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `set_id` | string | ✓ |  |
**Request body:** `ToolSetRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/chat/tool-sets/{set_id}`

Delete Tool Set

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `set_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/chat/tools`

Get Tools

Return the full tool catalog enriched with tier metadata for the Agent Manager UI.

**Response:** Successful Response

---

### `GET` `/api/chat/tools/settings`

Get Tool Settings

Read the global tool enable/disable settings.

Returns ``{disabled_tools: [name, ...]}`` (sorted, deduplicated).
Frontend Tools registry tab reads this to render toggles.

**Response:** Successful Response

---

### `PUT` `/api/chat/tools/settings`

Set Tool Settings

Overwrite the global tool enable/disable settings.

The frontend sends the full disabled set on every toggle (idempotent).
The service persists immediately + returns the canonical sorted set.

**Request body:** `ToolSettingsPayload` (JSON)

**Response:** Successful Response

---

## cobie

### `GET` `/api/cobie/export.csv`

Cobie Export Csv

Download the COBie-lite sheets as a single multi-section CSV.

**Response:** Successful Response

---

### `GET` `/api/cobie/summary`

Cobie Summary

Sheet counts + handover completeness for the loaded model.

**Response:** Successful Response

---

## cost

### `GET` `/api/cost/boq`

Cost Boq

Priced bill of quantities for the loaded model (grouped by ifc_class + extras).

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string |  | Extra dimensions after ifc_class: storey, material, type_object, classification |
| `include_ids` | boolean |  | Attach element_ids per row. |
**Response:** Successful Response

---

### `GET` `/api/cost/boq.csv`

Cost Boq Csv

Download the priced BoQ as a CSV attachment.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string |  | Extra dimensions after ifc_class. |
**Response:** Successful Response

---

### `GET` `/api/cost/rates`

Get Rates

Return the editable rate library and the default currency.

**Response:** Successful Response

---

### `PUT` `/api/cost/rates`

Put Rates

Replace the rate library (sanitized). Body: ``{"rates": {...}}``.

**Request body:** `Body_put_rates_api_cost_rates_put` (JSON)

**Response:** Successful Response

---

## diff

### `GET` `/api/diff/working-vs-original`

Diff Working Vs Original

Structural diff (added / removed / changed) of the working model vs the upload.

**Response:** Successful Response

---

### `GET` `/api/diff/working-vs-original.csv`

Diff Working Vs Original Csv

Download the change report as CSV.

**Response:** Successful Response

---

## ids

### `GET` `/api/ids/last`

Get Last Ids Run

Return the cached last validation run for the currently loaded model.

``available`` is false when nothing has run yet or the cached run belongs
to a different model fingerprint.

**Response:** Successful Response

---

### `GET` `/api/ids/last.csv`

Get Last Ids Run Csv

Download the cached last run's failures as CSV. 404 when no valid cache.

**Response:** Successful Response

---

### `GET` `/api/ids/library`

List Ids Library

List all stored IDS documents with their header metadata.

**Response:** Successful Response

---

### `POST` `/api/ids/library`

Add Ids To Library

Store an uploaded .ids/.xml document in the library.

Identical content dedupes to the existing entry (same id). Returns 422
when the file does not parse as IDS XML.

**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `DELETE` `/api/ids/library/{entry_id}`

Delete Ids From Library

Delete a stored IDS document. 404 when the id is unknown.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `entry_id` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ids/library/{entry_id}/validate`

Validate With Library Entry

Validate the loaded model against a stored IDS document.

Returns the full ``ids_service.validate_ids`` report enriched with
``ids_id``, ``ran_at`` and the deduplicated ``all_failing_ids`` (Express
IDs usable with viewer selection). The run is cached for GET /last and
GET /last.csv.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `entry_id` | string | ✓ |  |

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit_per_spec` | integer |  | Max failing elements returned per spec. |
**Response:** Successful Response

---

## ifc

### `POST` `/api/ifc/aabb/bulk`

Get Aabbs Bulk

Return AABBs for a list of express IDs.

Missing IDs (not yet computed, or skipped for geometry reasons) come
back in the `missing` field rather than failing the whole request.

**Request body:** `AABBBulkRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/ifc/aabb/cache`

Clear Aabb Cache

Evict the in-memory AABB cache (and optionally the on-disk JSON).

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sha` | string |  |  |
| `disk` | boolean |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/aabb/status`

Get Aabb Status

Return the live state of the AABB warm-up for the loaded model.

**Response:** Successful Response

---

### `GET` `/api/ifc/aabb/{express_id}`

Get Aabb One

Return the world-space AABB for one element. 404 when not cached.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `express_id` | integer | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/aggregate`

Aggregate Elements

Aggregate quantities + histograms for a set of express IDs.

Accepts up to 2000 IDs. Returns ΣArea, ΣVolume (from IfcElementQuantity),
material histogram, and type histogram.

**Request body:** `AggregateRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/checkpoints`

Get Checkpoints

List git-backed IFC edit checkpoints newest-first.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit` | integer |  |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/checkpoints/rollback/{sha}`

Rollback To Checkpoint

Restore the IFC model to a previous git checkpoint.

Emits a ``metadata_changed`` WS event so connected clients reload.
Returns ``{sha, model_version, model_fingerprint}`` on success.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sha` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/checkpoints/{sha}/diff`

Get Checkpoint Diff

Diff checkpoint *sha* against the current loaded model.

Returns a ``CheckpointDiffResult`` describing which IfcProduct entities
were added, removed, or changed (by Name / Description / ObjectType)
between the snapshot and the live model.  At most 100 entries are
returned; when there are more, ``truncated=true`` is set.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sha` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/convert`

Convert Ifc To Fragments

Accepts IFC bytes, proxies to the Node sidecar, returns fragment
binary. Content-hashes the input so repeat uploads of the same file
are served from the on-disk fragment cache instantly.

Content-Type: `application/octet-stream`.
Query params: `profile`, `modelId`.
Response: binary `.frag` bytes.
Response headers:
  - `X-Fragment-Source`: "cache" | "sidecar"
  - `X-Fragment-Profile`: resolved profile
  - `X-Fragment-Elapsed-Ms`: sidecar conversion time (only when fresh)
  - `X-Fragment-Source-Sha256`: sha256 of the input IFC
  - `X-Fragments-Format-Version`: producing @thatopen/fragments version

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `profile` | string |  |  |
| `modelId` | string |  |  |
| `no_cache` | boolean |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/convert-status`

Get Convert Status

Report the state of the fingerprint's fragment pre-build task.

Background: ``POST /api/ifc/upload`` schedules a fire-and-forget pre-build
of the uploaded IFC into ``.frag`` bytes for the ``balanced`` profile.
There is a short window where the manifest cache
file has not yet been written but the conversion is already running. Without
this endpoint, the viewer's cold-load path falls back to a wasteful 50 MB
re-upload via ``/convert``.

Response (``status`` is one of ``idle | inflight | complete | failed``):

* ``idle``     - registry has no record; frontend should issue ``/convert``.
* ``inflight`` - pre-build running; ``elapsed_ms`` populated.
* ``complete`` - fragment cached on disk; ``serve_url`` ready to fetch.
* ``failed``   - pre-build raised; ``error`` populated. Caller may still
                 try ``/convert`` (transient sidecar failures are common).

If ``wait_ms > 0`` the call blocks until the task reaches a terminal state
or the timeout fires; the same payload shape is returned either way.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string | ✓ | SHA-256 of the IFC file (from model contract) |
| `profile` | string |  |  |
| `wait_ms` | integer |  | If > 0, block until the in-flight pre-build resolves or this many milliseconds pass - bounded so the request can never wedge the client. 0 (default) returns the current snapshot immediately. |
**Response:** Successful Response

---

### `GET` `/api/ifc/convert/progress/{model_id}`

Get Convert Progress

Latest sidecar progress snapshot for an in-flight conversion.

The frontend's serverConvert helper polls this in parallel with the
main ``POST /convert`` so the loader UI can show real percent +
stage ("lex"/"parse"/"index"/"geometry"/"serialise") instead of
stalling at "70 %".

Returns:
  - ``200 OK`` with ``{model_id, stage, progress, updated_at,
    in_flight: true}`` while the sidecar reports progress.
  - ``200 OK`` with ``{model_id, in_flight: false}`` when no
    snapshot is known (conversion not started, finished, or
    evicted from the 64-entry LRU).

No 404: a missing snapshot is a normal state in the polling
lifecycle, not an error.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `model_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/edit-history`

Get Edit History

Return the committed edit history (newest first, without inverse ops).

**Response:** Successful Response

---

### `GET` `/api/ifc/edit-state`

Get Edit State

Return safe-edit state: dirty flag + original/working filenames.

Used by the Save As menu item to decide whether to show the unsaved
badge and the post-save "Close model?" prompt. Also the runtime carrier
of the backend's EDIT_MODE_ENABLED flag: the frontend gates its whole
edit surface on this response instead of a compile-time constant, so the
two sides can never disagree (ADR 003 phased flip).

**Response:** Successful Response

---

### `POST` `/api/ifc/edits/apply`

Apply Edits

**Request body:** `EditApplyRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/edits/pending`

List Pending Edits

List all sandboxed pending edits awaiting Apply/Discard.

**Response:** Successful Response

---

### `GET` `/api/ifc/edits/pending/{edit_id}`

Get Pending Edit

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `edit_id` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/edits/pending/{edit_id}/apply`

Apply Pending Edit

Promote a sandbox to the live model. Fires tiered sync events.

Serialised: if another /apply is already in flight, this
call returns HTTP 409 with ``{detail: {status: "edit_in_progress",
retry_after_ms: 1500}}`` so the client can show a transient toast
+ auto-retry on the next ``pending_applied`` WS event (or after the
retry timeout, whichever fires first).

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `edit_id` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/edits/pending/{edit_id}/discard`

Discard Pending Edit

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `edit_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/elements`

Get Elements

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `ifc_type` | string |  |  |
| `storey_id` | string |  |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/elements/filter`

Evaluate an indexed, reusable BIM property filter

Evaluate a typed AND/OR filter against the current model revision.

The first request builds a compact property index. Later requests reuse it
until ``model_version`` changes. ``count`` is exact; ``elements`` is only a
bounded preview while ``element_ids`` carries the viewer action set.

**Request body:** `IndexedPropertyFilterRequest` (JSON)

**Response:** Successful Response

---

### `POST` `/api/ifc/elements/filter-by-property`

Filter elements by property value condition

Filter IFC elements by a property value condition.

Operators: ``eq``, ``neq``, ``contains``, ``startswith``, ``gt``, ``lt``, ``gte``, ``lte``.
Returns matching element IDs and details.

**Request body:** `PropertyFilterRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/elements/{element_id}`

Get Element

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/elements/{element_id}/nearby`

Find nearby elements by placement distance

Return elements within *radius_m* metres of a reference element.

Uses IfcLocalPlacement origin coordinates - no full geometry processing.
Results are sorted by distance ascending.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ |  |

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `radius_m` | number |  | Search radius in metres |
| `ifc_types` | string |  | Comma-separated IFC types, e.g. IfcWall,IfcColumn |
| `limit` | integer |  | Max results |
**Response:** Successful Response

---

### `GET` `/api/ifc/elements/{element_id}/relations`

Get Element Relations

Return connectivity, material, and openings for an element.

Combines the three new spatial-query tools into one round-trip so the
PropertiesPanel can lazy-load a "Relations" section without three separate
API calls.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `element_id` | integer | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/export/properties`

Export model properties as CSV or JSON

Export all (or type-filtered) IFC elements with their property sets as CSV or JSON.

CSV columns: ``express_id, global_id, name, ifc_type, storey, <PsetName.PropName> ...``
Each unique (property set, property) pair becomes its own column.  Quantity columns
use a ``Qty.`` prefix when ``include_quantities=true``.

JSON returns a list of flat dicts with the same column structure as CSV.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `format` | string |  | Output format |
| `ifc_type` | string |  | Filter by IFC class, e.g. 'IfcWall' |
| `include_quantities` | boolean |  | Include IfcElementQuantity columns |
| `max_elements` | integer |  | Max elements to export |
**Response:** Successful Response

---

### `GET` `/api/ifc/features`

Get Ifc Features

Capability probe called by the frontend at startup to decide
whether to use the server-side convert path or fall back to live
browser parse.

Part of the server-side convert path. See docs/architecture/AI_NATIVE_ENGINE.md.

**Response:** Successful Response

---

### `GET` `/api/ifc/file`

Get Ifc File

Return the raw IFC file for frontend 3D rendering.

**Response:** Successful Response

---

### `GET` `/api/ifc/frag-delta/{edit_id}`

Get Frag Delta

Geometry patch endpoint.

Returns ``{representations: {<expressId>: <RawRepresentation>}}`` for
the elements touched by the named applied edit. The frontend's
``fragmentDeltaLoader`` consumes this to apply per-element geometry
updates via ``Editor.edit()`` instead of triggering a full reload.

**v1.1.0 scope** - the route returns the correct shape but with an
empty ``representations`` map. The frontend loader iterates, finds
no matching repData per express id, and returns ``updatedCount=0``;
the existing ``rebuild_started`` full-reload path then takes over.

A future release will populate the ``representations`` map with
@thatopen/fragments-compatible ``RawRepresentation`` blobs built from the
live IfcOpenShell geometry. Until then, structural edits use the
camera-preserving full refresh for correctness.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `edit_id` | string | ✓ |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/fragment-manifest`

Get Fragment Manifest

Check whether pre-built fragments are cached on disk for a given IFC fingerprint.

The frontend stores the model fingerprint from the upload contract. On remount
it can call this endpoint with just the fingerprint (no 50 MB IFC re-upload)
to discover whether `/api/ifc/fragments/serve` can serve the fragments
directly - skipping both the IFC download and re-upload.

Response:
  - ``cached`` - whether the disk cache entry exists
  - ``size_bytes`` - file size of the cached fragment (only when cached)
  - ``serve_url`` - URL the frontend can GET to fetch the fragment bytes

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string | ✓ | SHA-256 of the IFC file (from model contract) |
| `profile` | string |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/fragments/serve`

Serve Fragment By Fingerprint

Serve cached fragment bytes by fingerprint - no IFC re-upload required.

Only succeeds when the disk cache already holds the fragment (i.e.
``/api/ifc/fragment-manifest`` returned ``cached: true``). Returns 404
otherwise; the caller should fall back to the full ``/api/ifc/convert``
upload path.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string | ✓ | SHA-256 of the IFC file |
| `profile` | string |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/fragments/storey`

Get Storey Fragment

Return binary fragment bytes for one IfcBuildingStorey.

Workflow (fastest first):
1. **ID-preserving subset** - copies the storey's elements out of the
   validated full fragment through the sidecar subset path (identity and
   content parity proofs, original local-ID/GUID bridge preserved).
2. **Disk cache hit** - returns cached reconstruction ``.frag`` bytes.
3. **Sidecar convert** - serializes the storey to a sub-IFC via
   ``copy_deep``, sends to the Node sidecar, caches result, returns binary.
4. **Sub-IFC fallback** - when the sidecar is unavailable, returns raw
   sub-IFC bytes so the frontend can convert via ``IfcConvertWorker``.

Response codes:

- ``200`` - binary bytes (check ``X-Fragment-Source`` for the source)
- ``204`` - storey has no elements (no bytes to send)
- ``400`` - no model loaded
- ``404`` - SHA mismatch or storey index out of range
- ``503`` - serialization failed (IfcOpenShell error)

Response headers:

- ``X-Fragment-Source`` - ``storey-subset-cache`` |
  ``storey-subset-sidecar`` | ``cache`` | ``sidecar`` | ``sub-ifc``
- ``X-Fragment-Storey-Idx`` - storey index (mirrors ``idx``)
- ``X-Fragment-Storey-Name`` - IfcBuildingStorey.Name
- ``X-Fragment-Elapsed-Ms`` - sidecar convert time (sub-IFC sidecar path only)

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sha` | string | ✓ | SHA-256 fingerprint of the loaded IFC model |
| `idx` | integer | ✓ | Zero-based storey index (elevation-sorted) |
**Response:** Successful Response

---

### `GET` `/api/ifc/fragments/tile`

Get Spatial Tile Fragment

Return an independently loadable, ID-preserving spatial tile fragment.

Tiles are copied from the validated full fragment with the fragments
library's dependency-aware subset authoring path.  The sidecar reloads the
result and proves local-ID/GUID plus geometry/material parity before the
backend publishes it to the versioned cache.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `sha` | string | ✓ | SHA-256 fingerprint of the loaded IFC model |
| `tile_id` | string | ✓ |  |
| `grid` | integer |  | NxN grid resolution per storey |
| `profile` | string |  |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/geometry`

Extract Geometry

Extract preview mesh geometry via the native parser sidecar.

Returns per-element meshes (Float32 positions + Uint32 indices, base64-
encoded) for elements whose geometry is an IfcExtrudedAreaSolid. The
frontend uses these to render preview meshes immediately - before the
slow @thatopen/fragments conversion is done - eliminating the blank-screen
wait on large IFC files.

Coverage: ~40-80 % of elements depending on model complexity
(rectangle/polyline profiles). Furniture/windows/doors may be absent;
they continue loading via the normal path in parallel.

Response shape:
  { meshCount, attempted, skipped, geoElapsedMs, totalElapsedMs,
    meshes: [{expressId, ifcType, name, positions(b64), indices(b64), bbox}] }

**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `POST` `/api/ifc/geometry/stream`

Stream preview mesh batches as NDJSON

Chunked NDJSON streaming of preview meshes.

Same input as ``POST /geometry``, but the response is
``application/x-ndjson`` over HTTP chunked transfer. The frontend
receives mesh batches as they are produced rather than waiting for
the full conversion to finish - first triangle on screen scales with
``batchSize × per-element-cost`` instead of total model size.

**Event shapes** (one JSON object per line, terminated with ``\n``):

* ``{"type": "start", "modelId": ..., "batchSize": N}``
* ``{"type": "batch", "batchIndex": N, "meshes": [...]}``
* ``{"type": "summary", "meshCount": X, "attempted": Y, "skipped": Z,
  "batchCount": B, "geoElapsedMs": G, "totalElapsedMs": T}``
* ``{"type": "error", "message": "..."}`` (terminal - no further events)

Each ``meshes[]`` entry has the same shape as the non-streaming
``/geometry`` response (base64-encoded ``positions`` and ``indices``,
plus ``expressId``, ``ifcType``, ``name``, ``bbox``).

The event contract is fixed so consumers can be written against it.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `batchSize` | integer |  | Meshes per NDJSON batch. Smaller = faster first-paint, more overhead. |
| `modelId` | string |  | Opaque caller tag, mirrored back in stream events for client correlation. |
**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `POST` `/api/ifc/health`

Run model quality health check

Run the built-in IFC model quality rules against the loaded model.

Returns a structured report listing issues grouped by rule, each tagged
with a severity (``error``, ``warning``, ``info``).  At most
``limit_per_rule`` issue records are returned per rule; the ``count``
field gives the true total.  A ``duration_ms`` field reports wall-clock
time spent running all rules.

Rules checked:

- ``missing_global_id`` - elements with a blank or null GlobalId
- ``duplicate_global_id`` - elements sharing a GlobalId (data corruption)
- ``missing_name`` - structural elements with no Name attribute
- ``empty_property_sets`` - IfcPropertySet with zero properties
- ``no_storey_assignment`` - walls/slabs/columns/beams outside any storey
- ``duplicate_name_in_type`` - same name used for multiple doors/windows/spaces
- ``large_element_count`` - informational notice when >10 000 elements

**Request body:** `HealthCheckRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/history/diff`

History Diff

Semantic diff between two history points using ifcdiff (plan C3).

Element-level added/deleted/changed INCLUDING property/pset changes (the
legacy per-checkpoint diff only compared Name/Description/ObjectType).
Feeds the Timeline panel's two-point compare. CPU-bound work runs off the
event loop; results are LRU-cached by content identity.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `from_sha` | string | ✓ | Older checkpoint SHA (the diff base). |
| `to_sha` | string |  | Newer checkpoint SHA; omit to compare against the CURRENT working model. |
| `limit` | integer |  |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/ids-info`

Ids Info Endpoint

Parse IDS header metadata without running full validation.

Useful for showing the IDS title / author / spec count in the UI
immediately after the user attaches an IDS file.

**Request body:** `IdsValidateRequest` (JSON)

**Response:** Successful Response

---

### `POST` `/api/ifc/ids-validate`

Ids Validate Endpoint

Validate the currently-loaded IFC model against an IDS document.

Accepts the IDS XML base64-encoded in the request body.  Returns a
structured JSON report or a CSV file of all failures depending on
``format``.

The engine used is reported in the response header
``X-IDS-Engine`` (``ifctester`` or ``v0``).

**Request body:** `IdsValidateRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/lod`

Get Lod Fragment

Serve a decimated (LOD) fragment for a previously-converted model.

Reuses the full, validated ``.frag`` artifact the convert path already
cached, decimates it via the Node sidecar's ``/decimate`` endpoint, and
atomically publishes a versioned LOD artifact. The first call builds and
caches; subsequent calls serve from disk.

The decimated frag preserves element identity (localIds + GUIDs + spatial
structure), so the frontend can swap it in during camera motion and swap the
full model back at rest without re-bridging picking.

Response codes:

- ``200`` - binary LOD ``.frag`` bytes (``Content-Type: application/octet-stream``)
- ``503`` - no LOD available yet: the full frag is not cached, the sidecar is
  unavailable, or decimation failed. The frontend treats any non-200 as
  "just use the full model".

Response headers:

- ``X-Fragment-Source`` - ``lod-cache`` (served from disk) | ``lod-sidecar`` (freshly built)
- ``X-Fragment-Profile`` - the resolved profile
- ``X-Fragment-Source-Sha256`` - the requested fingerprint (sanitised)

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string | ✓ | SHA-256 of the IFC file (from the model contract) |
| `profile` | string |  |  |
| `ratio` | string |  | Target fraction of each shell's original triangle count. Lower = fewer triangles + faster navigation. Omit for the sidecar default (0.35). |
| `error` | string |  | Relative error ceiling for the sloppy simplifier. Omit for the default (0.05). |
**Response:** Successful Response

---

### `GET` `/api/ifc/meta`

Get Meta

Return model metadata for the currently-loaded model.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `response` | string |  | minimal returns project + version contract; full also includes tree + stats. |
**Response:** Successful Response

---

### `GET` `/api/ifc/native-index`

Get Native Index

Serve the full, already-cached metadata index for the current model.

This is the read-path that lets the **frontend** consume the metadata the
sidecar already produced on upload (spatial tree, elements, property sets,
materials, GlobalId↔ExpressId map) INSTEAD of running its own redundant
web-ifc parse in a browser worker. It is a cheap in-memory serve - no
IfcOpenShell call, no re-parse, no sidecar round-trip.

Returns a status envelope:

* ``{"status": "ready", "sha256": ..., "index": ...}`` - the index is
  available; ``index`` is the full ``MetadataIndex`` (``by_alias=True``
  so ``schema`` keeps its JSON spelling). The caller composes
  ``index.id_by_global_id`` with the FragmentsModel's localId↔GlobalId
  table to bridge ids, and reads ``element_psets`` for
  properties-on-click.
* ``{"status": "pending", "sha256": null, "index": null}`` - no index is
  loaded yet (the background parse is still running). Poll again.
* ``{"status": "mismatch", "sha256": <loaded sha>, "index": null}`` - an
  index is loaded but belongs to a different model than the requested
  ``fingerprint``. Poll again; the background parse for the requested
  model replaces it when finished.

The transient states are deliberately 200s rather than errors: they are
normal polling outcomes during the upload→parse window, and non-2xx
responses are auto-logged by browsers on every poll.

NOTE: the index reflects the *pristine uploaded* model. After an edit, the
caller invalidates the changed express-ids and falls back to the
authoritative ``GET /elements/{id}`` (IfcOpenShell) for those - so this
route never needs to be rebuilt mid-session.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string |  | Optional SHA-256 the caller expects. When it does not match the currently-loaded index, the response reports ``status='mismatch'`` (with ``index=null``) instead of handing back the wrong model's index. |
**Response:** Successful Response

---

### `POST` `/api/ifc/native-parse`

Native Parse

Parse an IFC file with the native (TypeScript sidecar) parser.

Returns a read-only `MetadataIndex` covering schema, header, project,
spatial tree, element catalog, type histogram, and materials. The
response is suitable for Ask-mode chat queries - no IfcOpenShell
required.

This path is roughly 30x faster than the IfcOpenShell load path on the
50 MB BasicHouse sample (~1.6 s vs ~50 s+) and the result is cached
by SHA-256 so re-uploads are instant.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `force` | boolean |  | Skip the on-disk cache and re-parse via the sidecar. |
**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `POST` `/api/ifc/new`

New Project

Create a fresh IFC project from a template and return its bytes (plan A3).

The "create a new IFC file in the viewer" path. A pure generator: it does
NOT touch the currently-loaded model. The frontend loads the returned bytes
through the normal upload pipeline, which then makes the new project the
active model. Runs off the event loop (IfcOpenShell build is CPU-bound).

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `template` | string |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/operations/catalogue`

Operations Catalogue

List the registered model operations (name, params, tier). Read-only, so
ungated - lets the editor UI discover what it can do.

**Response:** Successful Response

---

### `POST` `/api/ifc/operations/execute`

Operations Execute

Execute one model operation from the editor UI (a human direct edit).

Routes through the operation layer with actor=USER, then emits the
classified sync event so open viewers update live. Serialized against
/edits/apply via the shared edit lock; the mutation runs on the event loop
(not a thread) to preserve IfcOpenShell's single-writer invariant.

**Request body:** `OperationRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/ifc/operations/history`

Operations History

Newest-first, actor-attributed operation log for the current model. Feeds
the history timeline ('what did the AI change vs what did I change').

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit` | integer |  |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/operations/redo`

Operations Redo

Redo the most recently undone operation (editor UI). Emits a sync event.

**Response:** Successful Response

---

### `POST` `/api/ifc/operations/undo`

Operations Undo

Undo the most recent operation (editor UI). Emits a sync event.

**Response:** Successful Response

---

### `GET` `/api/ifc/project`

Get Project

**Response:** Successful Response

---

### `GET` `/api/ifc/readiness`

AI backend readiness

Return warm-up state of the two AI backends.

* ``native_index`` - metadata index built by the sidecar
  on upload (Ask-mode tools depend on it).
* ``ifcopenshell`` - semantic backend used by tier-2/3 (deep / edit)
  tools. The chat-panel chip uses this field to show a "warming"
  pulse on first upload and unmount once it reads ``ready``.

Available for polling until ``ifcopenshell === "ready"``; transitions
are also pushed as ``readiness_changed`` WS events.

**Response:** Successful Response

---

### `POST` `/api/ifc/save`

Save Model

Persist working-copy edits back to the ORIGINAL upload path (plan A7).

The counterpart to Save As: instead of downloading a copy, the loaded
file itself is updated - a warm reload of the same file then opens the
edited state. Serialized on the edit lock (a save mid-mutation would
persist a torn state); the ID contract holds (same serializer as Save As,
covered by test_id_stability_contract). Also snapshots a checkpoint so
the save is a visible point on the timeline.

**Response:** Successful Response

---

### `GET` `/api/ifc/save-as`

Save Ifc As

Stream the current edited IFC bytes as a downloadable file.

The user picks where the bytes land via their browser's save dialog
(showSaveFilePicker on Chromium, "Save target as…" on Firefox). The
original uploaded IFC on the server is never modified - only a hidden
working copy carries edits. After the download succeeds the frontend
calls /api/ifc/edit-state to reset the dirty flag.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `filename` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/ifc/save-as/ack`

Acknowledge Save As

Frontend calls this once the browser confirms the download landed.

Resets the dirty flag so the UI can drop the "unsaved changes" badge
and Word/Excel-style close prompts. We can't observe the download from
the server side, so the frontend is responsible for calling this on
success.

**Response:** Successful Response

---

### `GET` `/api/ifc/search`

Search

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `q` | string | ✓ |  |
| `ifc_type` | string |  |  |
| `storey` | string |  |  |
| `limit` | integer |  |  |
**Response:** Successful Response

---

### `GET` `/api/ifc/stats`

Get Stats

**Response:** Successful Response

---

### `POST` `/api/ifc/storey-manifest`

Get Storey Manifest

Return per-storey element-ID manifest for the loaded model.

Clients use the manifest to implement progressive storey reveal:
show the ground floor immediately after model load completes, then
add subsequent storeys at a controlled pace so the user perceives
faster time-to-first-render without requiring separate IFC uploads.

Response shape::

    {
      "source_sha256": "abc...",
      "total_elements": 149,
      "storeys": [
        { "idx": 0, "name": "Ground Floor", "elevation": 0.0,
          "element_ids": [123, 456, ...], "element_count": 87 },
        ...
      ]
    }

**Response:** Successful Response

---

### `GET` `/api/ifc/storeys`

Get Storeys

**Response:** Successful Response

---

### `GET` `/api/ifc/tile-manifest`

Get Tile Manifest

Return the spatial tile manifest for the loaded model.

The frontend uses this to drive frustum-based tile streaming: each
tile's AABB is intersected against the camera frustum, and only the
tiles inside (or near) the view load their geometry.

Current limitations:

- When the geometry AABB cache is cold, element-to-tile assignment
  falls back to placement-origin point AABBs, not real geometry.
  Models with all elements sharing the same placement (e.g.
  BasicHouse.ifc) will then collapse to one tile per storey.
- Per-tile fragment bytes are NOT yet produced; the manifest reports
  element assignment only.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `grid` | integer |  | NxN grid resolution per storey |
**Response:** Successful Response

---

### `GET` `/api/ifc/tree`

Get Spatial Tree

**Response:** Successful Response

---

### `POST` `/api/ifc/undo`

Undo Last Edit

Revert the most recently applied committed edit (legacy endpoint).

Delegates to the operation layer so the undo is serialized on the edit
lock, recorded in the op log, arms redo, and emits the classified sync
events - the legacy response shape (``{"undone": ...}``) is preserved
for existing callers. Returns ``{"undone": false}`` (200) when the stack
is already empty.

**Response:** Successful Response

---

### `POST` `/api/ifc/upload`

Upload Ifc

Parse an uploaded IFC and return model metadata.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `response` | string |  | minimal returns project + version contract; full also includes tree + stats. |
| `prebuild_fragments` | boolean |  | Eagerly warm the on-disk fragment cache after the upload completes. Set to false when the client has disabled the server fragment cache (`useServerCache=false`) - the prebuild output would never be reused and only steals CPU from interactive operations on the just-loaded model. |
| `prebuild_profile` | string |  | Conversion profile for the eager prebuild. Must match the profile the viewer requests from POST /convert, otherwise the prebuild warms a cache entry nobody reads and the viewer's own conversion runs the sidecar a second time. |
**Request body:** `multipart/form-data`

**Response:** Successful Response

---

### `POST` `/api/ifc/warm-from-cache`

Reload a previously-uploaded IFC from disk

Re-warm the backend's IfcOpenShell handle from a previously-uploaded
IFC file. Used by the viewer's cached-load path when the user reloads
the page (or the backend restarted) and the model is served from the
fragment cache, but the semantic backend has nothing loaded.

Searches the uploads directory (``~/.ifc-atlas/uploads/``) for a file
whose SHA-256 matches the requested fingerprint. Loads it on a worker
thread so the event loop stays responsive. Returns the model meta on
success.

404 when no matching IFC exists on disk - the frontend should fall
back to re-uploading the bytes via ``POST /api/ifc/upload``.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `fingerprint` | string | ✓ | SHA-256 of the IFC to find in uploads/ |
**Response:** Successful Response

---

## mcp

### `POST` `/api/mcp/reload`

Reload

Re-read the config file without restarting the backend.

Useful after the operator hand-edits mcp_servers.json - saves the
Uvicorn reload cycle. Idempotent and safe to spam.

**Response:** Successful Response

---

### `GET` `/api/mcp/servers`

List Servers

**Response:** Successful Response

---

## plugins

### `GET` `/api/plugins`

List Plugins

All installed plugins (built-ins first), manifest plus ``builtin`` flag.

**Response:** Successful Response

---

### `POST` `/api/plugins`

Create Plugin

Install a new user plugin from an inline manifest + script.

**Request body:** `PluginCreateRequest` (JSON)

---

### `POST` `/api/plugins/install-zip`

Install Plugin Zip

Install a plugin from a zip holding manifest.json + script.py.

**Request body:** `multipart/form-data`

---

### `GET` `/api/plugins/{plugin_id}`

Get Plugin

Full plugin record: manifest, script source, and built-in flag.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `plugin_id` | string | ✓ |  |
**Response:** Successful Response

---

### `PUT` `/api/plugins/{plugin_id}`

Update Plugin

Rewrite a user plugin's manifest and/or script.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `plugin_id` | string | ✓ |  |
**Request body:** `PluginUpdateRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/plugins/{plugin_id}`

Delete Plugin

Remove a user plugin from disk.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `plugin_id` | string | ✓ |  |
**Response:** Successful Response

---

### `POST` `/api/plugins/{plugin_id}/run`

Run Plugin

Run a plugin in the IFC code sandbox with validated params.

Read-only plugins return the sandbox execute_result/execute_error dict;
write plugins stage a pending edit that flows through the existing
preview/apply UI. Every result carries plugin_id + plugin_name.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `plugin_id` | string | ✓ |  |
**Request body:** `PluginRunRequest` (JSON)

**Response:** Successful Response

---

## qto

### `GET` `/api/qto/export.csv`

Qto Export Csv

Download the QTO summary as a CSV attachment.

Header: one column per group field, then count,volume_m3,area_m2,length_m.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string | ✓ | Comma-separated grouping fields, order preserved. Allowed values: ifc_class, storey, material, type_object, classification |
**Response:** Successful Response

---

### `GET` `/api/qto/summary`

Qto Summary

Grouped element counts and base quantities for the loaded model.

Groups are sorted by count descending and capped at 500 (``truncated``
flags the cap). ``coverage`` reports how many elements in each group
contributed a value to each quantity; 0 means the quantity is unknown for
the whole group.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `group_by` | string | ✓ | Comma-separated grouping fields, order preserved. Allowed values: ifc_class, storey, material, type_object, classification |
| `include_ids` | boolean |  | Attach element_ids (express ids, capped at 5000) to every group. |
**Response:** Successful Response

---

## settings

### `GET` `/api/settings/secrets`

Get Secrets Status

Status-only view of the per-user secrets file. No raw keys.

**Response:** Successful Response

---

### `PUT` `/api/settings/secrets`

Update Secrets

Merge non-empty values from ``payload`` into ``secrets.json``.

Empty / missing fields are ignored - to remove a key use DELETE.
Returns the refreshed status so the UI can re-render in one round trip.

**Request body:** `SecretsUpdateRequest` (JSON)

**Response:** Successful Response

---

### `DELETE` `/api/settings/secrets/{provider}`

Delete Secret

Remove a stored key for ``provider``, or ``provider="all"``.

Env-var keys are never touched - they live outside this store. If the
user wants to remove an env-var key they must edit ``.env`` / their
shell themselves.

**Path parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `provider` | string | ✓ |  |
**Response:** Successful Response

---

## system

### `DELETE` `/api/system/cache`

Flush Cache

Delete files in one or more cache scopes.

Scopes:
  - ``uploads`` - uploaded IFC files (re-uploadable, safe to flush).
  - ``snapshots`` - viewpoint snapshot images (regenerated on demand).
  - ``data`` - aabb / native-index / doc-index caches. Custom agents,
    prompts, and budget state are *also* in here; flushing this drops
    them. (UI should warn.)
  - ``checkpoints`` - IFC edit history. Destructive - UI must confirm.
  - ``fragments`` - converted-fragment cache (next load re-converts).
  - ``all`` - every cache scope above.

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `scope` | string |  |  |
**Response:** Successful Response

---

### `POST` `/api/system/cache/config`

Update Cache Config

Set the cache cap in process memory (and the IFC_VIEWER_CACHE_MAX_BYTES env).

Note: this is a runtime override - it does NOT persist across process
restarts. To persist, the user must set IFC_VIEWER_CACHE_MAX_BYTES in
``~/.ifc-atlas/.env`` (or the shell environment).

**Request body:** `CacheConfigUpdate` (JSON)

**Response:** Successful Response

---

### `POST` `/api/system/cache/enforce-cap`

Enforce Cache Cap

Manually run the LRU sweep on the uploads dir against ``CACHE_MAX_BYTES``.

The Settings UI calls this after the user changes the slider and
confirms. Returns the bytes freed and files removed.

**Response:** Successful Response

---

### `GET` `/api/system/data-paths`

Get Data Paths

Return resolved data-dir paths, their sizes, and the cache cap.

Used by the Settings → Storage panel to show the user exactly where
their data lives and how much disk it's using.

**Response:** Successful Response

---

## viewer

### `POST` `/api/viewer/command`

Send Viewer Command

**Request body:** `ViewerCommandRequest` (JSON)

**Response:** Successful Response

---

### `GET` `/api/viewer/snapshot`

Capture Snapshot

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `timeout_s` | number |  |  |
**Response:** Successful Response

---

### `GET` `/api/viewer/state`

Get Viewer State

**Response:** Successful Response

---

### `POST` `/api/viewer/state`

Report Viewer State

**Request body:** `ViewerStateReport` (JSON)

**Response:** Successful Response

---

### `POST` `/api/viewer/state/snapshot`

Upload Snapshot

**Request body:** `SnapshotUpload` (JSON)

**Response:** Successful Response

---

_Last regenerated: 2026-07-17. Run `python scripts/generate_api_doc.py` to refresh._
