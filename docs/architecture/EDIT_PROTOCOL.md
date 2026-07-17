# Edit Protocol (write tools)

Spec for how write tools go from "LLM emitted a tool call" to "live model
mutated." Four invariants underpin this: 3 (tool tiers), 4 (sandbox +
hash diff), 5 (sync event tiering), 8 (frontend-first). The whole flow exists
to make edits **reviewable, reversible, and race-safe.**

> **Release note:** the Edit surface is enabled by default and gated by the
> backend `EDIT_MODE_ENABLED` runtime setting. With the flag off, the tool
> router refuses every write tool and the frontend hides editing controls.

## Two write paths

Not every write goes through the sandbox:

- **Direct fast path**, for trusted, bounded, attribute-level edits:
  `rename_element`, `update_property_value`, `rename_elements_batch`,
  `update_properties_batch`. These mutate the live IfcOpenShell handle
  immediately, push an inverse op onto the in-memory undo stack, and stream a
  `metadata_changed` event over the chat WebSocket so the UI patches the tree
  and caches in place.
- **Sandbox path**, for everything that creates, deletes, or runs arbitrary
  code: `propose_edit`, `create_wall_from_ends`, `delete_element`,
  `execute_ifc_code`. These stage a hash-gated pending edit that the user
  must Apply or Discard.

## Sandbox flow

```
           user: "delete the duplicate wall"
                     |
                     v
       [LLM] emits delete_element(...)
                     |
                     v
  [router] mode gate (EDIT_MODE_ENABLED + agent category)
           global tool-disable gate
           agent allowlist gate          --- refused --> error result to LLM
                     |
                     v
        [sandbox] snapshot the live .ifc to a scratch copy
                     |
                     v
     [sandbox] run the requested ops against the copy
                     |
                     v
       [sandbox] SHA-256 the copy; hash == live -> silent no-op
                     |
                     v
      [sandbox] compute structural diff (by express id)
                     |
                     v
   tool result: { action: "pending_edit", edit_id, summary, counts, change_preview }
   model-sync WS: { type: "pending_edit", edit_id, payload: <full envelope> }
                     |
                     v
       [frontend] DiffPreviewPanel renders the envelope
                     |
      +--------------+----------------+
      |                               |
    Apply                          Discard
      |                               |
      v                               v
  POST /api/ifc/edits/pending      POST /api/ifc/edits/pending
       /{edit_id}/apply                 /{edit_id}/discard
      |                               |
      |                               +-> sandbox file unlinked,
      |                                   WS: pending_discarded
      |
      +- verify base fingerprint == hash(live)  --- stale --> HTTP 409
      |
      +- atomic file swap: sandbox -> live path, reload the handle
      |
      +- checkpoint snapshot of the new IFC bytes (best-effort)
      |
      +- emit sync events:
           pending_applied                       (always)
           ifc_patch                             (typed per-element patches)
           rebuild_started   if create/delete/retype occurred
           metadata_patch    otherwise (rename / property changes)
```

## Hash gate

The envelope captures `base_model_fingerprint = sha256(live .ifc bytes)` at
snapshot time. When the user clicks Apply, the server compares it against the
live model's current fingerprint:

- **Match** -> the sandbox file is moved into the live path (atomic on the
  same filesystem) and the authoritative handle reloads.
- **Mismatch** -> another write landed in between (a direct fast-path edit,
  another applied sandbox, another client). The Apply fails with HTTP 409
  ("Pending edit is stale"), the sandbox file is deleted, and the agent must
  re-propose against the new model state.

This is the race-safety rule from Invariant 4: two preview panels can never
both Apply on out-of-date views. Concurrent Applies are additionally
serialised by a server-side lock; a second Apply arriving mid-swap gets
HTTP 409 with `{status: "edit_in_progress", retry_after_ms: 1500}` and the
frontend auto-retries.

## Sync tiering (Invariant 5)

Different edits need different frontend reactions; we don't reload geometry
for a pure property change. After a successful Apply the backend inspects the
diff counts and publishes on the model-sync WebSocket (`/api/ifc/sync/ws`):

| Event | When | Frontend reaction |
|---|---|---|
| `pending_applied` | Always | Remove the envelope from the pending list; adopt the new model version + fingerprint. |
| `ifc_patch` | When the diff is non-empty | Typed per-element patch list for incremental consumers. |
| `metadata_patch` | Only renames / property changes | Patch spatial-tree names and stats in place. No geometry reload. |
| `rebuild_started` | Any created / deleted / retyped element | Reload the model geometry while preserving camera and store state. A per-fragment delta endpoint (`GET /api/ifc/frag-delta/{edit_id}`) exists but does not yet provide complete hot-replacement data in v1.1.0, so the full reload path remains the correctness fallback. |

The frontend handler is the model-sync WebSocket subscriber in
`frontend/src/App.tsx`, which feeds the store's `upsertPendingEdit` /
`removePendingEdit` actions and the tree/stats patch logic.

## Undo

The **direct fast path** records inverse deltas. Every immediate edit pushes
an entry like:

```python
{
  "edit_id": "…",
  "timestamp": …,
  "description": "Renamed 'Wall-1' -> 'Exterior Wall N' (#17 IfcWall)",
  "inverse_ops": [
    {"op": "set_name", "express_id": 17, "value": "Wall-1"},
  ],
}
```

`undo_last_edit` pops the top of the stack and applies the inverse ops
directly to the live model (it is itself an immediate edit and emits
`metadata_changed`). The stack is capped at 20 entries. Bulk operations
(`rename_elements_batch`, `update_properties_batch`) record a **single undo
entry** covering all affected elements, so a 100-element batch rename is one
undo step. `get_edit_history` returns the stack newest-first.

**Sandbox applies are atomic file swaps**, so they are outside the
inverse-delta stack; applying a sandbox edit reloads the handle and clears
the stack. Recovery for applied sandbox edits goes through the git-backed
checkpoint history instead: every successful Apply snapshots the IFC bytes,
and `POST /api/ifc/checkpoints/rollback/{sha}` restores any earlier state.

## Pending-edit lifecycle limits

- At most **16 pending edits** can be staged at once; further proposals are
  refused until one is applied or discarded.
- There is no expiry timer. A stale envelope is caught by the hash gate at
  Apply time, and all pending edits (and their sandbox files) are cleared
  when a new model is uploaded.
- A sandbox run whose output hashes identically to the live file is discarded
  silently; no envelope is created. An `execute_ifc_code` run whose hash
  differs but whose structural diff is empty (a serialisation round-trip) is
  likewise treated as read-only.

## `execute_ifc_code`

The most powerful write tool. Accepts a Python string that runs against the
sandbox copy in an **isolated child process**:

- Pre-imported namespace: `model` (the open sandbox handle, also aliased as
  `ifc`), `ifcopenshell` (including `ifcopenshell.api` and
  `ifcopenshell.util.element`), plus `math`, `statistics`, `re`, `json`,
  `collections`, `uuid`.
- Safety comes from a `sys.addaudithook` guard in the child, not from
  stripping builtins: process/shell spawning, sockets and URL fetches, and
  registry access are blocked outright, and file I/O is denied for any path
  other than the sandbox `.ifc` itself.
- Wall-clock timeout: **240 seconds by default**; the LLM can pass
  `timeout_s` (clamped to 1-240 s). On timeout the child is killed and an
  `execute_error` result with `timed_out: true` is returned.
- Code payload is capped at 100,000 characters.
- `print()` output is captured and returned; assigning to a variable named
  `result` surfaces its repr in the chat summary.
- Mutations on `model` become the structural diff. A run that changes
  nothing returns an `execute_result` (read-only); a run that changes the
  model stages a `pending_edit` envelope like any other sandbox tool.

There is an Ask-mode counterpart, `execute_ifc_query_code`, which runs the
same sandbox but in read-only mode: if the code produces a structural change,
the result is `execute_rejected` and nothing is staged.

## Tool allowlist (how a preset restricts writes)

Every preset in [`agent_registry.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/services/agent_registry.py) carries an `allowed_tools` list. Of the two built-in presets, `default` (Ask) uses `null` (every read tool passes the allowlist; the mode gate still blocks writes) and `edit-assistant` carries an explicit list including the write tools. Three router gates apply before any write executes: `EDIT_MODE_ENABLED=0` refuses the entire write tier, ask-category agents are refused every write tool regardless of allowlist, and a tool absent from an explicit allowlist is refused before it reaches any service.

## Frontend contract: `DiffPreviewPanel`

The panel renders the `PendingEditEnvelope` broadcast on the model-sync
WebSocket:

```ts
interface PendingEditEnvelope {
  edit_id: string;
  created_at: number;
  base_model_version: number;
  base_model_fingerprint: string;   // sha256 of the live file at snapshot time
  sandbox_fingerprint: string;      // sha256 of the mutated sandbox file
  summary: string;                  // one-line tagline for the chat + activity log
  operations: Record<string, unknown>[];  // what the LLM asked for
  changes: PendingEditElement[];    // structural diff, one entry per express id
  counts: Record<string, number>;   // {renamed, property_changed, deleted, created, retyped, total}
}

interface PendingEditElement {
  express_id: number;
  ifc_type: string;
  change: 'renamed' | 'retyped' | 'property_changed' | 'deleted' | 'created';
  name_before?: string;
  name_after?: string;
  ifc_type_before?: string;
  ifc_type_after?: string;
  property_changes: { property_set: string; property_name: string; before: unknown; after: unknown }[];
}
```

The panel groups by affected element and shows a before / after table. The
user Applies or Discards the envelope as a whole; per-row selective Apply is
a backlog item (it would require the server to re-run the tool with a
narrower arg set, feasible but adds complexity).

## Error cases

| Case | Response |
|---|---|
| Write tool while Edit is disabled (or agent is ask-category) | Error result with `blocked_by_mode: true` (before any service runs). |
| Tool globally disabled in Chat Manager → Tools | Error result with `blocked_by_global_disable: true`. |
| Tool not in the agent's allowlist | Error result with `blocked_by_allowlist: true`. |
| Tool raises (unknown element, bad op shape, pending-edit cap hit) | `{"error": "..."}` result; the LLM can read it and retry. |
| `execute_ifc_code` script raises or trips the audit hook | `{"action": "execute_error", "error": "...", "stdout": "..."}`; sandbox discarded. |
| `execute_ifc_code` exceeds the timeout | `execute_error` with `timed_out: true`; child process killed, sandbox discarded. |
| Apply with a stale base fingerprint | HTTP 409 "Pending edit is stale"; sandbox dropped, re-propose. |
| Apply with an unknown `edit_id` | HTTP 409 "No pending edit with id ...". |
| Apply while another Apply is in flight | HTTP 409 `{status: "edit_in_progress", retry_after_ms: 1500}`; the client auto-retries. |
| Discard with an unknown `edit_id` | HTTP 404. |
