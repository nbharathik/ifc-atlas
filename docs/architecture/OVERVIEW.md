# Architecture Overview

High-level picture of the system. The **non-negotiable invariants** are
summarized at the end of this page; read them before changing loader,
renderer, chat, edit, or sync code.

## The split

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (frontend/)                                            │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Three.js + @thatopen/components + web-ifc                 │ │
│  │  ↳ load server-built fragments → render                   │ │
│  │    (in-browser web-ifc parse as fallback)                 │ │
│  │  ↳ raycast → express ID → select / highlight / isolate    │ │
│  │  ↳ measurement math (client-side, pure)                   │ │
│  │  ↳ clip planes, viewpoints, share-link URL                │ │
│  └───────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ React + Zustand + Atlas design tokens                     │ │
│  │  ↳ ChatPanel (WebSocket)                                  │ │
│  │  ↳ PropertiesPanel, SearchPanel, PerfHUD, ActivityLog     │ │
│  │  ↳ DiffPreviewPanel (client-side of the edit flow)        │ │
│  └───────────────────────────────────────────────────────────┘ │
└──────────────────┬──────────────────────────────────────────────┘
                   │  HTTPS: REST + WebSocket
                   │  - POST /api/ifc/upload         (.ifc file)
                   │  - GET  /api/ifc/file           (file bytes)
                   │  - GET  /api/ifc/{tree,stats,…} (metadata helpers)
                   │  - POST /api/ifc/convert        (server-side fragment build)
                   │  - WS   /api/chat/ws            (streaming chat + tool calls)
                   │  - WS   /api/ifc/sync/ws        (live model-sync broadcasts)
                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend (backend/)                                             │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ FastAPI + uvicorn                                         │ │
│  │  ↳ ifc_routes.py        (REST)                            │ │
│  │  ↳ chat_routes.py       (WebSocket)                       │ │
│  └───────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Services (single source of truth per concern)             │ │
│  │  ↳ ifc_service.py       (IfcOpenShell reads + writes)     │ │
│  │  ↳ llm_service.py       (OpenAI/Anthropic/OpenRouter)     │ │
│  │  ↳ tools.py             (tool registry + router)          │ │
│  │  ↳ agent_registry.py    (agent presets)                   │ │
│  │  ↳ ids_service.py       (IDS 1.0 validator)               │ │
│  │  ↳ mcp_registry.py      (MCP scaffold)                    │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Data flow: loading a model

1. User drops `.ifc` onto the viewer.
2. Frontend POSTs the file to `/api/ifc/upload`; backend stores it under the per-user `~/.ifc-atlas/uploads/` folder, builds the native metadata index, and kicks off a background fragment pre-build.
3. Frontend calls `/api/ifc/convert` to ask the server for optimised fragment binaries and streams them straight into the renderer (this is the default cold-load path). If the server is unavailable, the viewer falls back to in-browser `web-ifc` parsing.
4. The render loop starts; initial raycast hookup populates the Zustand store; the spatial tree comes from `/api/ifc/tree`.

Both paths refer to the same uploaded file, so the backend can serve semantic helpers (`/api/ifc/storeys`, `/api/ifc/stats`, …) from the authoritative IfcOpenShell handle while the browser owns geometry rendering.

## Data flow: an AI chat question

1. User types, submits.
2. Frontend sends a WebSocket message carrying the prompt, the active agent id, and the chat history.
3. Backend's `chat_routes.py` resolves the agent preset → system prompt + tool allowlist + model.
4. `llm_service.py` streams a function-calling request to OpenAI / Anthropic / OpenRouter.
5. For each tool call the LLM emits, `tools.py` routes it:
   - **Read-only** (e.g. `get_model_stats`, `search_elements`) → `ifc_service.py` → IfcOpenShell → JSON reply. (In the default hybrid tool mode the basic read tools run in the browser against the in-memory model index instead, via a `tool_call_request` round trip.)
   - **Viewer op** (e.g. `highlight_elements`, `isolate_elements`) → dedicated WebSocket event (`highlight`, `isolate`, ...) → frontend mutates the Zustand store.
   - **Write** (e.g. `delete_element`, `execute_ifc_code`) → sandboxed IfcOpenShell copy → structural diff → `pending_edit` envelope (tool result + model-sync WS broadcast) → user Applies or Discards over REST.
6. Every tool call + result is streamed back as `tool_call` / `tool_result` events for the per-message log.
7. The LLM's text streams back as `chunk` events; a final `done` event carries the full reply.

## Data flow: an edit

In this release the Edit surface is disabled by default behind the
`EDIT_MODE_ENABLED` flag (backend env var + frontend constant, both default
off). The protocol below is fully wired and describes the flow once the flag
is enabled.

Simple attribute edits (`rename_element`, `update_property_value`, and their
batch variants) take a direct fast path: they mutate the live model
immediately, record an inverse-delta undo entry, and stream a
`metadata_changed` event. Everything else goes through the sandbox:

```
User: "delete the duplicate wall"
      │
      ▼
Edit-Assistant agent ─── tool_call: delete_element(…)
      │
      ▼
Backend sandbox ────────► snapshot the live .ifc to a scratch copy
                          run the op on the COPY
                          sha256 the copy vs the live file
                          compute structural diff
      │
      ▼
tool result: {action: 'pending_edit', edit_id, counts, change_preview}
model-sync WS: {type: 'pending_edit', edit_id, payload: <envelope>}
      │
      ▼
Frontend DiffPreviewPanel renders before/after
      │
      ├─ user clicks Apply  ──► POST /api/ifc/edits/pending/{edit_id}/apply
      │                        Backend verifies the base fingerprint still
      │                        matches the live file (HTTP 409 if stale),
      │                        swaps sandbox → live atomically, then pushes
      │                        `pending_applied` + `ifc_patch` plus
      │                        `metadata_patch` or `rebuild_started`
      │                        per Invariant 5.
      │
      └─ user clicks Discard ─► POST /api/ifc/edits/pending/{edit_id}/discard
                                Backend deletes the sandbox file and pushes
                                `pending_discarded`.
```

## The invariants (quick ref)

1. **Frontend owns rendering; backend convert-once is the standard load path.** The browser owns the render scene but consumes server-built fragments; in-browser parsing is the fallback.
2. **Backend owns IfcOpenShell.** Every semantic/metadata query goes through the Python handle.
3. **Tool tiers.** Read-only / viewer-op / validate / write, enforced at the router.
4. **Writes go through the sandbox.** Snapshot-copy, run, hash-gate, diff-preview. (Bounded attribute edits use a direct inverse-delta fast path with undo.)
5. **Sync events are tiered.** Metadata-only edits ship as in-place patches (`metadata_changed` on the chat socket, `metadata_patch` on the sync socket; no geometry reload); any created / deleted / retyped element triggers a geometry rebuild (`rebuild_started`).
6. **No redundant state across the boundary.** Every piece of state has exactly one owner; the other side is at most a cache.
7. **Performance budgets, measured every change.** On the `BasicHouse.ifc` baseline: TTFR < 2.5 s cold / < 1.0 s warm, TTFG < 4.0 s cold / < 1.5 s warm, click-to-highlight < 80 ms; no silent regressions.
8. **Frontend-first for interaction, backend-first for IFC conversion.** New viewer work ships client-only unless the feature genuinely needs the backend.
9. **Two chat modes.** Ask is read-only; Edit is the only writer (disabled by default in this release behind `EDIT_MODE_ENABLED`).
10. **Tool sets, prompts, and agents are independent libraries** persisted as JSON under `~/.ifc-atlas/data/`.
11. **(retired)** Workflow pipelines were removed; the review-before-execute principle lives on in the diff preview.

## Deeper dives

- [`FRONTEND.md`](FRONTEND.md), React tree, Zustand store, three.js viewer anatomy.
- [`BACKEND.md`](BACKEND.md), FastAPI structure, service responsibilities.
- [`CHAT_PROTOCOL.md`](CHAT_PROTOCOL.md), WebSocket event shape + tool-call wire format.
- [`EDIT_PROTOCOL.md`](EDIT_PROTOCOL.md), sandbox / diff / Apply / Discard contract in detail.
- [`DEPLOY.md`](DEPLOY.md), web / Tauri / GH-Pages matrices.
- [`TAURI.md`](TAURI.md), desktop architecture specifics.
