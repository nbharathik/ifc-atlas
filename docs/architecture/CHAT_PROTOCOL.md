# Chat WebSocket Protocol

Bidirectional JSON messages on `/api/chat/ws`. Every message carries a `type` field. The connection is long-lived: the client sends one chat request per turn (including the full prior history), the server streams the turn's events back, and the same socket is reused for the next turn.

> The auto-generated [WebSocket Protocol](../api/WEBSOCKET.md) page lists the event envelopes extracted from `chat_routes.py`. This page is the design-level overview of the contract.

## Connect

```
ws://host/api/chat/ws
```

The server sends nothing on connect. A separate model-sync WebSocket runs in parallel at `/api/ifc/sync/ws` for model-level broadcasts (`pending_edit`, `pending_applied`, `pending_discarded`, `metadata_patch`, `ifc_patch`, `readiness_changed`, rebuild events); see [`EDIT_PROTOCOL.md`](EDIT_PROTOCOL.md).

The server keeps almost no conversation state: the chat history travels with every request. The only per-connection state is a session-memory cache of facts gleaned from tool results (surfaced to the UI via `memory_update`). When the client opts in with `use_graph: true` plus a `thread_id`, the backend checkpoints each turn; a reconnecting client restores history via `GET /api/chat/thread/{thread_id}/state` (REST, not the WS).

## Client → Server messages

### Chat request

Any JSON object that is not a `tool_result` acknowledgement is parsed as a `ChatRequest` and starts a turn. A payload that fails validation gets an in-band `error` event back.

```json
{
  "message": "How many walls are in this model?",
  "agent_id": "default",
  "tool_mode": "hybrid",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "attachments": [
    { "kind": "image", "name": "site.png", "mime": "image/png", "data_base64": "..." }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `message` | string | The user prompt (required). |
| `history` | `ChatMessage[]` | Prior turns; the server does not store them between requests. |
| `agent_id` | string? | Agent preset id; unknown ids fall back to `default`. |
| `tool_mode` | `"server" \| "client" \| "hybrid"` | Where tools execute (see below). The shipped UI sends `hybrid`. |
| `attachments` | `ChatAttachment[]` | `kind` is `image` / `text` / `ids` / `other`; payload travels as `data_base64`. |
| `provider`, `model`, `temperature` | string? / string? / float? | Explicit model selection (legacy path). |
| `model_registry_id` | string? | Preferred path: resolve provider, model id, and sampling settings from a Model Registry entry. |
| `tool_set_id` | string? | Optional tool-set filter applied on top of the agent allowlist for this turn. |
| `prompt_id` | string? | Optional system-prompt override from the prompt library for this turn. |
| `use_graph`, `thread_id` | bool / string? | Opt-in per-turn checkpointing so a reconnecting client can restore the thread. |

### `tool_result` (acknowledgement)

The reply to a server-initiated `tool_call_request` (see below):

```json
{ "type": "tool_result", "tool_call_id": "a1b2c3...", "result": { "total": 42 } }
```

There is no in-band cancel message; closing the socket aborts the session.

## Server → Client events

All server events are JSON objects with a `type` field.

### `chunk`

Streamed text from the LLM.

```json
{ "type": "chunk", "content": "Looking at the model" }
```

### `tool_call`

The agent invoked a tool.

```json
{
  "type": "tool_call",
  "name": "query_elements",
  "arguments": { "mode": "text", "query": "wall" }
}
```

### `tool_result`

Result of the most recent tool call.

```json
{
  "type": "tool_result",
  "name": "query_elements",
  "result": { "total": 42, "elements": ["..."] },
  "executed_on": "server"
}
```

When a write tool stages a sandboxed edit, `result` carries
`{ "action": "pending_edit", "edit_id": "...", "summary": "...", "counts": {...}, "change_preview": [...] }`
and the full diff envelope is broadcast on the model-sync WebSocket. Apply and
Discard then happen over REST
(`POST /api/ifc/edits/pending/{edit_id}/apply` / `.../discard`); see
[`EDIT_PROTOCOL.md`](EDIT_PROTOCOL.md).

### `tool_call_request` (client-executed tools)

Calls the browser can serve (when `tool_mode` is `hybrid` or `client`) are forwarded to the frontend instead of executing on the backend: every `viewer_control` action, `describe_model` with `part` of `project`/`stats`/`storeys`, `query_elements` with `mode` of `text`/`type`/`storey`, and `get_element` with `include` omitted or `["details"]`.

```json
{
  "type": "tool_call_request",
  "tool_call_id": "a1b2c3...",
  "name": "describe_model",
  "arguments": { "part": "stats" }
}
```

The client executes the tool against its in-browser model index and replies with the matching `tool_result` acknowledgement. The server waits up to 30 seconds, then injects a timeout error into the LLM loop so a frozen tab cannot stall the turn. Results are stamped `_executed_on_client: true`.

`tool_mode` semantics: `server` forces every tool to run on the backend; `client` forwards everything and rejects server-only tools; `hybrid` honours each tool's declared default.

### Viewer command events

When a viewer tool runs on the backend, the element ids are validated against the model and the side effect is shipped as a dedicated event the frontend applies to the 3D scene:

| Event | Payload | Effect |
|---|---|---|
| `highlight` | `element_ids: number[]` | Highlight the elements. |
| `select` | `element_id: number` | Select one element (opens the Properties panel). |
| `isolate` | `element_ids: number[]` | Isolate; an empty list clears isolation. |
| `show_all` | none | Restore full visibility. |
| `clip_section_box` | `element_id: number` | Clip a section box around the element. |

The accompanying `tool_result` is the dispatch acknowledgement; the visual change arrives via the dedicated event.

### Model-change events

`metadata_changed` is emitted when a direct write tool (rename / property update) mutates the live model:

```json
{
  "type": "metadata_changed",
  "changed_ids": [17],
  "description": "Renamed 'Wall-1' to 'Exterior Wall N' (#17 IfcWall)",
  "renamed": [{ "id": 17, "new_name": "Exterior Wall N" }]
}
```

`entity_delta` is the partial-update signal carrying `changed_ids`, transitively `dirty_ids`, and a `delta_type`, so the frontend can invalidate only the affected caches.

### Telemetry events

| Event | Payload |
|---|---|
| `usage` | Per-turn token/cost accounting: `model`, `provider`, `input_tokens`, `output_tokens`, plus cost and cache fields when available. |
| `memory_update` | `facts: string[]`, the session-memory facts accumulated from tool results. |
| `budget_warning` | `used_usd`, `budget_usd`, `ratio`, `agent_id`, `at_cap`; fired when an agent nears or passes its monthly budget cap. |
| `model_fallback` | `original_model`, `fallback_model`, `reason: "budget_cap"`, `used_usd`, `budget_usd`; the turn continued on the agent's cheaper fallback model. |

### `done`

Turn complete; carries the full accumulated reply text. The UI unlocks the input.

```json
{ "type": "done", "content": "There are 42 walls." }
```

### `error`

In-band failure (invalid request payload, provider error, interrupted stream). A turn that errors may end without a `done`.

```json
{ "type": "error", "content": "Invalid chat payload: ..." }
```

## Tool tiers (enforced at the `tools.py` router)

Every tool carries a tier, and the WS handler's tool executor enforces three gates in order before any tool runs:

1. **Mode gate**: `write_edit` tools are refused when `EDIT_MODE_ENABLED` is off (it defaults to on) or when the active agent is an ask-category agent.
2. **Global disable**: tools switched off in Chat Manager → Tools are refused for every agent.
3. **Agent allowlist**: a tool missing from the agent's `allowed_tools` is refused. This is defence in depth; the tool schema sent to the LLM is already filtered to the allowlist.

The tiers:

- **`read_model`**, read-only queries answered from the model: `describe_model`, `query_elements`, `get_element`, `quantity_summary`, `get_edit_history`, `execute_ifc_query_code`.
- **`read_viewer`**, viewer commands: `viewer_control`.
- **`validate`**, model quality checks: `validate_model` (health, audit, IDS).
- **`read_knowledge`**, reference lookups: `get_docs`.
- **`write_edit`**, mutating tools: `edit_semantic`, `edit_structural`, `execute_ifc_code`, `undo_last_edit`.

See the [Tools Reference](../agent/TOOLS_REFERENCE.md) for each tool's parameters and return shapes.

## Agent allowlist

Every agent preset carries `allowed_tools`. The built-in `default` (Ask) agent uses `null`, meaning every registered tool (writes are still blocked by the mode gate); the built-in `edit-assistant` carries an explicit allowlist that includes the write tools. A tool call outside the allowlist is rejected at the router before touching any service. See [`EDIT_PROTOCOL.md`](EDIT_PROTOCOL.md) for the write-specific rules.
