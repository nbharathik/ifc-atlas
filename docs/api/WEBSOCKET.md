# WebSocket Protocol

The main chat streaming interface uses a WebSocket connection at `/api/chat/ws`.

!!! info "Auto-generated"
    This page is regenerated automatically by `scripts/generate_api_doc.py`
    from structured comments in `chat_routes.py`.

---

## Events

### `chat_request`

Client -> server. Starts an agent turn. Any JSON object whose "type" is not "tool_result" is parsed as a ChatRequest; a "type" field is optional and ignored. Malformed payloads get an "error" event back.

Only "message" is required. "tool_mode" is one of "server" | "client" | "hybrid". "model_registry_id" (when set) resolves provider/model/sampling from the Model Registry and overrides "provider"/"model"/"temperature". "use_graph" + "thread_id" opt in to server-side conversation checkpointing.

```json
{"message": "How many walls are on the ground floor?", "history": [{"role": "user", "content": "..."}], "provider": "openai", "model": "gpt-4o", "temperature": 0.3, "tool_mode": "hybrid", "agent_id": "default", "attachments": [], "tool_set_id": null, "prompt_id": null, "model_registry_id": null, "use_graph": false, "thread_id": null}
```

---

### `chunk`

Server -> client. A streamed text fragment from the LLM.

```json
{"type": "chunk", "content": "There are 42 walls "}
```

---

### `tool_call`

Server -> client. The agent is invoking a tool.

```json
{"type": "tool_call", "name": "search_elements", "arguments": {"query": "wall"}}
```

---

### `tool_result`

Server -> client. The result of a tool call. "executed_on" is "server" or "client".

When a write tool stages a sandboxed edit, "result" carries {"action": "pending_edit", "edit_id": "...", ...}; the pending_edit / pending_applied / pending_discarded broadcasts themselves go out on the separate model-sync WebSocket at /api/ifc/sync/ws, not on this socket.

```json
{"type": "tool_result", "name": "search_elements", "result": {"elements": [], "total": 42}, "executed_on": "server"}
```

---

### `tool_call_request`

Server -> client. Asks the browser to execute a client-side tool (viewer-state tools in "client"/"hybrid" tool mode). The client must reply within 30 seconds with a tool_result ack: {"type": "tool_result", "tool_call_id": "<same id>", "result": {...}}.

```json
{"type": "tool_call_request", "tool_call_id": "a1b2c3", "name": "get_camera_state", "arguments": {}}
```

---

### `memory_update`

Server -> client. The per-connection session memory accumulated new facts from tool results.

```json
{"type": "memory_update", "facts": ["Model has 42 walls"]}
```

---

### `highlight`

Server -> client. Viewer command: highlight the given elements.

```json
{"type": "highlight", "element_ids": [123, 456]}
```

---

### `select`

Server -> client. Viewer command: select one element.

```json
{"type": "select", "element_id": 123}
```

---

### `isolate`

Server -> client. Viewer command: isolate the given elements (hide everything else).

```json
{"type": "isolate", "element_ids": [123, 456]}
```

---

### `show_all`

Server -> client. Viewer command: clear isolation and show the full model.

```json
{"type": "show_all"}
```

---

### `clip_section_box`

Server -> client. Viewer command: fit a clipping section box around one element.

```json
{"type": "clip_section_box", "element_id": 123}
```

---

### `metadata_changed`

Server -> client. A committed edit changed element metadata. "renamed" is optional ({"id", "old_name", "new_name"}-style payload) and only present for rename edits.

```json
{"type": "metadata_changed", "changed_ids": [123], "description": "Renamed wall", "renamed": null}
```

---

### `entity_delta`

Server -> client. Partial model update signal: which entities changed and which dependent entities are now dirty. "delta_type" is "metadata" or "geometry".

```json
{"type": "entity_delta", "changed_ids": [123], "dirty_ids": [456], "delta_type": "metadata"}
```

---

### `usage`

Server -> client. Per-turn token + cost telemetry. "cost_usd" is present only when pricing is known for the model. The cache fields (cache_read_tokens, cache_creation_tokens, cache_hit_ratio, cached_cost_usd) are present only when prompt caching was active.

```json
{"type": "usage", "model": "gpt-4o", "provider": "openai", "input_tokens": 1200, "output_tokens": 300, "cost_usd": 0.0105}
```

---

### `model_fallback`

Server -> client. The agent's monthly budget cap was reached, so this turn runs on the agent's configured fallback model instead of the requested one.

```json
{"type": "model_fallback", "original_model": "gpt-4o", "fallback_model": "gpt-4o-mini", "reason": "budget_cap", "used_usd": 5.01, "budget_usd": 5.0}
```

---

### `budget_warning`

Server -> client. The agent's monthly spend is near or over its budget cap. "at_cap" is true once the cap is exceeded.

```json
{"type": "budget_warning", "used_usd": 4.61, "budget_usd": 5.0, "ratio": 0.92, "agent_id": "default", "at_cap": false}
```

---

### `done`

Server -> client. The agent finished its response; "content" is the full assembled assistant text.

```json
{"type": "done", "content": "There are 42 walls on the ground floor."}
```

---

### `error`

Server -> client. An error occurred (invalid chat payload, in-band stream error, or an unhandled exception during the turn).

```json
{"type": "error", "content": "Invalid chat payload: ..."}
```

---

_Last regenerated: 2026-07-07. Run `python scripts/generate_api_doc.py` to refresh._
