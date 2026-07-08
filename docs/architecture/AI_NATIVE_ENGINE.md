# Native Engine

How IFC Atlas avoids the classic "live-parse on every load" pipeline. This document describes the engine as it ships today; for the underlying invariants, see the summary in [`OVERVIEW.md`](OVERVIEW.md).

---

## Design thesis

1. **Backend owns IFC.** IfcOpenShell is the only place that understands IFC semantics. When the backend is reachable, the browser never parses raw IFC.
2. **Deltas, not dumps.** Every committed edit emits a typed `ifc_patch` event over WebSocket. The viewer patches the spatial tree and the affected geometry in place; no full reload.
3. **Streaming everywhere.** Upload, fragment conversion, queries, and edit apply all stream progress events rather than blocking on a single response.
4. **Typed contracts.** Patch envelopes and tool I/O are typed end-to-end (Pydantic on the backend, mirror types on the frontend).
5. **Agents are first-class citizens.** Per-agent tool allowlists, model selection, and budget caps live in the same registry as the engine knobs.

---

## Shape

```
┌───────────────────────────────────────────────────────────────┐
│ Viewer  (React + Three.js + @thatopen/components)             │
│   • Receives pre-built .frag tiles (not raw IFC)              │
│   • Applies ifc_patch events in place                         │
│   • Per-storey + per-element frustum culling                  │
├───────────────────────────────────────────────────────────────┤
│ AI Chat  (frontend)                                           │
│   • Tool results stream as JSON + optional viewer-action      │
│   • Pending edits surface in Diff Preview without reload      │
├───────────────────────────────────────────────────────────────┤
│     ▲                    ▲                         ▲          │
│     │ pre-built frags    │ ifc_patch WS events     │ typed    │
│     │                    │                         │ tools    │
│ ════╧════════════════════╧═════════════════════════╧════════  │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│ Backend  (FastAPI + Python)                                   │
│                                                               │
│   ┌────────────────────┐  ┌────────────────────────────────┐  │
│   │ IfcOpenShell       │  │ Node sidecar                   │  │
│   │ (authoritative;    │  │ (@thatopen/fragments +         │  │
│   │  edits, queries,   │←→│  web-ifc-node; emits .frag     │  │
│   │  IDS, sandbox)     │  │  binaries to disk cache)       │  │
│   └────────┬───────────┘  └────────────────────────────────┘  │
│            │                                                  │
│            ▼                                                  │
│   ┌────────────────────┐  ┌────────────────────────────────┐  │
│   │ patch_generator    │  │ metadata_index (TS sidecar)    │  │
│   │ (sandbox diff →    │  │ (fast type / storey / pset     │  │
│   │  typed ifc_patch)  │  │  lookup independent of OCC)    │  │
│   └────────────────────┘  └────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

---

## Cold-load pipeline

1. **Upload.** `POST /api/ifc/upload` writes the file to `~/.ifc-atlas/uploads/`, kicks off the native-metadata-index parse, and starts a background fragment pre-build.
2. **Server convert.** The viewer calls `POST /api/ifc/convert` with the raw IFC bytes. The Node sidecar (`backend/sidecar/`) boots `@thatopen/fragments` and `web-ifc-node`, builds optimised fragment binaries, and the backend returns them as raw binary bytes (`application/octet-stream`, with `X-Fragment-*` headers for source, profile, and timing). The express → local ID bridge is built client-side from the fragments model itself.
3. **Cache.** Output lands at `~/.ifc-atlas/fragments/{sha256}-{profile}.frag`. On a remount, `GET /api/ifc/fragment-manifest` answers with the cached manifest and the viewer downloads the fragments directly (`fragmentsManager.core.load()`), skipping upload entirely.
4. **Fallback.** If the sidecar is down or the endpoint returns 5xx, the viewer falls back to in-browser `web-ifc` parsing in a Web Worker. The activity log records which path won the cold load.

Settings → Performance exposes a wait-timeout slider so a cold reload of a model the server is already pre-building can skip the upload and just wait for the existing job.

---

## Edit pipeline (`ifc_patch`)

Every committed edit produces a typed envelope on the `/api/ifc/sync/ws` WebSocket. Frontend handlers in [`frontend/src/services/viewer/`](https://github.com/nbharathik/ifc-atlas/blob/main/frontend/src/services/viewer/) apply the patch in place:

| Patch kind | Frontend reaction |
|---|---|
| `attribute_changed`, `pset_changed` | Update the in-memory store; Properties panel re-renders. No geometry reload. |
| `element_removed` | `model.hide([localId])` + drop from spatial tree. |
| `element_added`, `geometry_changed` | Backend sends a mini `.frag` containing just the affected elements; frontend does `fragmentsManager.core.load(delta, { merge: true })`. |

`appliedPatchIds` in the store de-duplicates retries. After every AI edit, directly modified elements flash-highlight for 250 ms so the user can see exactly what changed.

---

## Native metadata index

`backend/app/services/metadata_index_service.py` calls a TypeScript sidecar that produces a compact `{express_id, type, storey, pset_names, …}` index for the uploaded file, keyed by SHA-256. The index is roughly 30× faster than IfcOpenShell for the queries most chat agents make (type counts, storey contents, property-name listings). Tool results served from the index are tagged `_source: "native_index"` in the tool-call log; cache misses fall through to IfcOpenShell.

---

## Query → viewer pipeline

Every read tool can return both structured JSON **and** an optional `viewer_action` envelope:

```json
{
  "type": "highlight" | "isolate" | "zoom" | "camera_to",
  "express_ids": [101, 102, 103],
  "mode": "set" | "add"
}
```

The frontend auto-applies the action when the tool result arrives, so an answer like "the three load-bearing walls are highlighted" is visually true the moment it streams in.

---

## Streaming geometry (opt-in)

A streaming tile path exists in [`frontend/src/services/viewer/streamingGeometryConsumer.ts`](https://github.com/nbharathik/ifc-atlas/blob/main/frontend/src/services/viewer/streamingGeometryConsumer.ts) and is wired to a per-storey tile manifest in the backend. It is gated by `VITE_STREAMING_GEOMETRY=true` and is **off in the v1 release**. When enabled, the visible-by-default tiles (envelope + active storey) load first and other tiles lazy-load on orbit into frustum.

---

## How this maps to the architecture invariants

- **Invariants 1 + 2 (convert-once, IfcOpenShell stays authoritative)**: enforced end-to-end. The browser sees pre-built fragments, never raw IFC, when the backend is reachable.
- **Invariant 4 (sandbox + hash diff)**: unchanged. The patch generator reads existing sandbox diffs and re-emits them as typed `ifc_patch` events.
- **Invariant 5 (tiered sync events)**: `ifc_patch` is the typed superset of the legacy `metadata_changed` event.
- **Invariant 8 (frontend-first)**: server convert is the documented exception, a frontend-performance feature that requires backend work.

---

## Related docs

- [`OVERVIEW.md`](OVERVIEW.md): system shape and data-flow diagrams.
- [`FRONTEND.md`](FRONTEND.md): viewer pipeline, store shape, visibility ownership.
- [`BACKEND.md`](BACKEND.md): FastAPI structure, service responsibilities.
- [`EDIT_PROTOCOL.md`](EDIT_PROTOCOL.md): sandbox / diff / Apply / Discard contract.
- [`DISTRIBUTION.md`](DISTRIBUTION.md): three editions (Cloud / Desktop / Demo) from one repo.
- [`TAURI.md`](TAURI.md): desktop shell contract.
