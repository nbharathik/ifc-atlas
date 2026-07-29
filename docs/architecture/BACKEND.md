# Backend Architecture

FastAPI + uvicorn + IfcOpenShell on Python 3.11 or 3.12. LLM providers: OpenAI SDK, Anthropic SDK, OpenRouter (HTTP). No database: uploads are files on disk, session state lives in-memory per WebSocket connection, and **all writable state lives in the per-user `~/.ifc-atlas/` folder** (see [Data storage](../user/DATA_STORAGE.md)). The backend never writes inside the repo.

---

## Tree

```
backend/
├── app/
│   ├── api/
│   │   ├── ifc_routes.py        REST: upload, native parse, geometry, fragments,
│   │   │                        edits, undo, IDS validate, checkpoints, AABB + sync WS
│   │   ├── chat_routes.py       WS: /api/chat/ws + agent / prompt / snippet /
│   │   │                        tool-set / model CRUD + doc index
│   │   ├── settings_routes.py   /api/settings/secrets, per-user API-key store
│   │   ├── system_routes.py     /api/system/*, data-dir info + cache flush/cap
│   │   ├── mcp_routes.py        /api/mcp/*, external MCP server registry
│   │   └── …                    one module per feature router: qto, cost, carbon,
│   │                            cobie, diff, ids, bcf, plugin, viewer_state
│   │                            (see the endpoint-groups table below)
│   ├── core/
│   │   ├── config.py            env vars + ~/.ifc-atlas folder resolution
│   │   └── security.py          security modes (local / server) + bearer token
│   ├── models/                  Pydantic request / response schemas;
│   │                            contracts.py = engine-neutral model-identity
│   │                            and render-artifact contracts
│   ├── services/                ~60 singletons (see below)
│   ├── mcp_server/              MCP server exposing the viewer toolset
│   └── main.py                  FastAPI entry, lifespan hooks, /mcp mount
├── sidecar/                     Node/TS native IFC parser (spawned on demand)
├── tests/                       pytest suite
├── run.py                       uvicorn launcher (+ frozen-build sandbox child)
└── requirements.txt
```

---

## Service responsibilities

### `ifc_service.py`

- **Reads** through every query helper backing `describe_model`, `query_elements`, `get_element`, and `quantity_summary` (project info, stats, storeys, element details, per-type and per-storey listings, property search, proximity search, quantity totals, …).
- **Writes** through the sandbox flow behind `edit_semantic` (name / property / attribute ops), `edit_structural` (`create_wall` / `delete_element` ops), and `execute_ifc_code`.
- **Undo stack** records `{express_id, attr, before, after}` for every committed write; `undo_last_edit` pops and applies the inverse.
- `load()` copies the upload to a hidden `.working/<name>.ifc` so the original stays pristine; `_file_path` is the working file.
- The `model` accessor is a property without a setter; tests must monkeypatch `_model` directly.

### `sandbox_service.py`

- `sandbox_copy(model)` returns a deep-copied handle.
- A pending-edit store records `{edit_id, sandbox, source_hash, diff}` until the user Applies or Discards.
- `commit_sandbox(live, sandbox, source_hash)` verifies the live model's hash still matches before swapping.

### `llm_service.py`

- Unified streaming interface over OpenAI / Anthropic / OpenRouter; all providers stream and tool-call events are shape-normalised so `chat_routes.py` doesn't branch on provider.
- The LangGraph agent path (`agent_graph.py`) drives multi-turn tool use.
- Keys resolve fresh on every call via `secrets_service.get_api_key()` (env var → `~/.ifc-atlas/secrets.json`).

### `tools.py`

- `TOOL_DEFINITIONS`: the JSON-Schema catalogue passed to the LLM.
- `execute_tool(name, args)` dispatches:
  - **Tier-1 read** → `ifc_service` / `metadata_index_service`, returns JSON.
  - **Tier-2 viewer op** → emits a frontend WS event.
  - **Tier-3 write** → sandbox flow → `pending_edit` event (gated by `EDIT_MODE_ENABLED`).
- Read-only results are memoised within a single LLM turn (`tool_memo.py`).

### `agent_registry.py`

Two built-in presets (read-only): `default` (Ask mode) and `edit-assistant` (hidden behind the `EDIT_MODE_ENABLED` flag). Custom agents are CRUD-able through `/api/chat/agents/*` and persist to `~/.ifc-atlas/data/custom_agents.json`. Built-ins cannot be deleted; unknown agent ids fall back to `default`.

### `model_registry.py`

UI-editable LLM model catalogue persisted to `~/.ifc-atlas/data/models.json`. Built-in entries are seeded once and merge non-destructively on upgrade; `provider_params.py` maps each entry's sampling/reasoning settings onto provider-specific request params.

### `metadata_index_service.py` + `sidecar_manager.py`

The Node/TS sidecar (`backend/sidecar/`) parses IFC natively (~30× faster than IfcOpenShell on large files) and produces a read-only `MetadataIndex` (spatial tree, element catalog, psets, GlobalId↔ExpressId map) that serves Ask-mode tools and `GET /api/ifc/native-index` while IfcOpenShell warms in the background. `readiness_service.py` tracks both backends' warm-up state.

Fragment conversion reuses one WASM-warmed `IfcImporter`. The importer is
mutable, so conversion jobs run through a process-local FIFO executor that
makes the complete profile-configure/process/restore transaction exclusive.
Callers may submit concurrently, but the shared importer never processes two
profiles at once; a rejected job does not poison the queue. A future bounded
worker pool must use one importer per worker rather than sharing this instance.

### `ifc_ingestion_service.py`, `ifc_conversion_service.py`, `ifc_converter.py`

Upload and conversion orchestration extracted from the routes: `ifc_ingestion_service` owns model-state transition ordering, readiness broadcasts, checkpoint rebinding, background prebuild, metadata indexing, and AABB warm-up for one source revision. `ifc_conversion_service` owns hashing, cache lookup, in-flight prebuild coordination, converter invocation, artifact validation, and atomic publication. `ifc_converter` is the engine-neutral conversion boundary (the active adapter delegates to the web-ifc Node sidecar). The stable identity and render-artifact types live in `app/models/contracts.py`.

### `fragment_prebuild_service.py`

Background server-side IFC→fragments conversion on upload; results are cached in `~/.ifc-atlas/fragments/{sha}-{profile}.frag` and served by `/api/ifc/fragments/serve`. `fragment_prebuild_gc.py` reaps abandoned jobs every 30 s.

### Spatial preprocessing and exact tile artifacts

`spatial_tile_splitter.py` persists versioned, checksummed manifests under
`DATA_DIR/spatial-tile-cache`. The cache identity includes source SHA, grid and
algorithm version, storey membership, AABB provenance, and the complete AABB
lookup digest. Writes are atomic; restart can reuse a valid manifest without
IFC extraction; a corrupt checksum or placement/mixed/real transition rebuilds.

`spatial_fragment_service.py` maps each manifest's Express IDs through the full
fragment artifact's GUID table and asks the sidecar for `getSubsetBuffer` output.
The sidecar reloads that subset standalone and must affirm local-ID/GUID,
geometry/sample, and material parity before the service publishes it. Subset
jobs are serialized to bound cold-build memory, duplicate requests coalesce,
and cache keys include source, profile, exact membership, full-artifact key,
and sidecar provenance. Parity failures are fail-closed and never cached.

`GET /api/ifc/fragments/tile` serves those independently loadable exact
artifacts. SHA/tile mismatches return 404; missing prerequisite artifacts,
sidecar errors, and identity/parity failures return 503. Response identity is
carried in `X-Fragment-Source`, `X-Fragment-Profile`, `X-Fragment-Tile-Id`,
`X-Fragment-Grid`, `X-Fragment-AABB-Source`, and the standard artifact/cache
headers.

LOD generation follows the same rule: publication requires a complete positive
identity proof and records target/achieved error. On BasicHouse, the current
smoke reduced 249,075 to 81,316 triangles (3.66 MB to 1.61 MB), retained all 331
identities, and measured maximum error 0.00570 under the 0.05 target. This is a
contract check, not a production navigation benchmark.

### `ids_service.py`

IDS 1.0 validator backed by the `ifctester` reference engine (all five facet types). Falls back to a minimal v0 implementation if `ifctester` is unavailable.

### `ifc_checkpoint_service.py`

Git-backed snapshots of the model in `~/.ifc-atlas/ifc_history/`, one commit per applied edit; `/api/ifc/checkpoints/*` lists, diffs, and rolls back.

### `mcp_registry.py` and `mcp_server/`

- `mcp_registry.py` is the **client** registry: external MCP servers the viewer connects out to. CRUD via `/api/mcp/*`, configured in `~/.ifc-atlas/mcp_servers.json`.
- `mcp_server/` is the **server** that exposes the viewer toolset to external LLM clients (Claude Desktop, Cursor, …) over SSE at `/mcp/sse` or stdio via `python -m app.mcp_server`. Bearer-token gated by `MCP_SERVER_TOKEN`; write tools gated by `MCP_ALLOW_WRITES=1`.

### Smaller singletons

`aabb_service` (real-AABB warm-up for culling), `storey_splitter` /
`spatial_tile_splitter` / `spatial_fragment_service` (durable spatial manifests
and exact fragment subsets), `element_index_service` / `document_index_service`
(BM25 search), `budget_tracker` (per-agent monthly spend), `session_memory`
(per-WS fact memory), `snippet_service` / `prompt_library` / `tool_sets` /
`tool_settings_service` (Chat-Manager CRUD stores), `ifc_checkpoint_service`,
`code_runner` (subprocess sandbox for `execute_ifc_code`), `frag_delta_service`
/ `patch_generator` (staged fragment-patch work).

---

## REST endpoint groups

| Prefix | Module | Purpose |
|---|---|---|
| `/api/ifc/*` | `ifc_routes.py` | Upload, native parse, geometry, fragment convert / cache, edits, undo, checkpoints, IDS validation, AABB, sync WS. |
| `/api/chat/*` | `chat_routes.py` | Agents / prompts / snippets / tool sets / models CRUD, budget, document index, chat WS. |
| `/api/settings/*` | `settings_routes.py` | `secrets.json` status / PUT / DELETE. |
| `/api/system/*` | `system_routes.py` | User-data folder paths + cache flush / cap. |
| `/api/mcp/*` | `mcp_routes.py` | External MCP server registry. |
| `/api/qto/*` | `qto_routes.py` | Quantity-takeoff summaries + CSV export. |
| `/api/cost/*` | `cost_routes.py` | 5D cost / bill of quantities built on the takeoff. |
| `/api/carbon/*` | `carbon_routes.py` | Embodied-carbon estimates built on the takeoff. |
| `/api/cobie/*` | `cobie_routes.py` | COBie-style handover summary + CSV export. |
| `/api/diff/*` | `diff_routes.py` | Working-vs-original model diff. |
| `/api/ids/*` | `ids_routes.py` | Persistent IDS document library + validation runs. |
| `/api/bcf/*` | `bcf_routes.py` | BCF 2.1 topics + `.bcfzip` import / export. |
| `/api/plugins/*` | `plugin_routes.py` | Plugin script CRUD + sandboxed runs. |
| `/api/viewer/*` | `viewer_state_routes.py` | Viewer state / command bridge for headless clients (CLI, MCP). |
| `/mcp/*` | `mcp_server/` | SSE server exposing the viewer toolset to external clients. |

Full endpoint catalogue: [REST API](../api/REST.md) (regenerate with `python scripts/generate_api_doc.py`).

## WebSocket endpoints

| Path | Purpose |
|---|---|
| `/api/chat/ws` | Main chat: agent responses, tool calls, pending edits, budget warnings, memory updates. |
| `/api/ifc/sync/ws` | Live model-sync broadcasts (`ifc_patch` after commits, `pending_edit`, `readiness_changed`). |

---

## Configuration

Env vars are read from the shell and from `~/.ifc-atlas/.env` (the backend does not read a repo-side `.env`). Everything is optional.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | (unset) | Provider keys. Env beats `secrets.json`; the in-app AI-keys UI writes the latter. |
| `IFC_ATLAS_HOME` | `~/.ifc-atlas` | Relocate the per-user data folder (legacy alias: `IFC_VIEWER_HOME`). |
| `UPLOAD_DIR` / `SNAPSHOT_DIR` / `DATA_DIR` / `CHECKPOINT_DIR` / `FRAGMENT_CACHE_DIR` | under `IFC_ATLAS_HOME` | Re-point individual dirs. |
| `IFC_VIEWER_CACHE_MAX_BYTES` | `2147483648` | Uploads-dir LRU cap; `0` disables. |
| `IFC_VIEWER_MAX_UPLOAD_BYTES` | `536870912` | Per-request IFC body cap; `0` disables. |
| `IFC_ATLAS_SECURITY_MODE` | `local` | `local` allows only loopback binds with no auth; `server` is for shared deployments and requires the API token. |
| `IFC_ATLAS_API_TOKEN` | (unset) | Shared bearer token; required (32+ characters) in server mode. |
| `IFC_ATLAS_ENABLE_CODE_EXECUTION` | `1` local / `0` server | Free-form Python (`execute_ifc_code`, plugins). Trusted-local; defaults off in server mode. |
| `SIDECAR_CONVERT_TIMEOUT_S` | `900` | Finite deadline for server-side fragment conversion. |
| `HOST` / `PORT` | `127.0.0.1` / `8000` | Bind address (run.py falls back to a free port if taken). |
| `FRONTEND_URL` | `http://localhost:5173` | CORS allow-list entry. |
| `LOG_LEVEL` | `info` | uvicorn + app log level. |
| `BACKEND_VERBOSE` | `0` | `1` = DEBUG logs + per-request timing. |
| `MCP_SERVER_TOKEN` | (unset) | Require bearer auth on `/mcp/*`. |
| `MCP_ALLOW_WRITES` | unset | `1` exposes the MCP write tier. |
| `EDIT_MODE_ENABLED` | `1` | Enables the chat write-tool tier. Set `0` for a read-only deployment; the frontend probes it at runtime via `/api/ifc/edit-state`. |
| `SIDECAR_DIR` / `SIDECAR_PORT` / `SIDECAR_HOST` / `SIDECAR_SPAWN_TIMEOUT_S` | auto | Advanced: native-parser sidecar overrides. |

---

## Testing

- **pytest** runs under `cd backend && pytest -q` (needs `ifctester` installed for the IDS suite).
- Fixtures load `data/fixtures/BasicHouse.ifc` once per session; `conftest.py` points `IFC_ATLAS_HOME` at a throwaway temp dir so tests never touch your real `~/.ifc-atlas`.
- Write-tool tests cover the happy path, missing-entity errors, inverse-delta round-trips, and sandbox hash gating.

**Windows + Python 3.13 caveat:** the IfcOpenShell wheel SIGSEGVs on import. Use Python 3.12, or skip IFC-loading tests:

```bash
pytest -m "not requires_ifc_load and not subprocess_sandbox"
```

---

## Conventions

- **Services are stateless** except for in-memory caches (`ifc_service` holds the parsed IfcOpenShell file).
- **No ORM, no DB.** Persistent state would require an ADR first.
- **Every write goes through the sandbox.** No direct `model.add()` / `model.write()` on the live handle outside `sandbox_service.commit_sandbox`.
- **Tool-call results are JSON-serialisable.** Binary outputs (screenshots, archives) are written to disk and returned as URLs.
- **No repo-side writes.** Anything the backend persists belongs under `app.core.config.BASE_DIR` (`~/.ifc-atlas`).
