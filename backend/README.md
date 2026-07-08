# IFC Atlas - backend

FastAPI service behind the viewer. It handles LLM chat (OpenAI / Anthropic / OpenRouter, streaming, tool calls), IFC uploads and server-side fragment conversion, semantic IfcOpenShell queries and sandboxed edits, IDS validation, and an MCP server that exposes the viewer toolset to external clients. The frontend owns geometry parsing and rendering.

## Run it

```bash
cd backend
python -m venv .venv                     # Python 3.11 or 3.12
# Windows: .venv\Scripts\activate   macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python run.py                            # http://localhost:8000  (--verbose for debug logs)
```

The native-parser sidecar (`sidecar/`) is spawned on demand and needs Node 20+ on PATH: when `sidecar/dist/index.cjs` exists (build it with `npm run build` in `sidecar/`) it runs via plain `node`, otherwise via the `npx tsx` dev fallback (requires `npm install` in `sidecar/`). `IFC_SIDECAR_CMD` overrides the launch command entirely. Without Node the backend still runs and falls back to IfcOpenShell-only parsing.

## Where data lives

Nothing is written inside the repo. All writable state (uploads, fragment cache, edit history, custom agents, API keys) lives in the per-user folder **`~/.ifc-atlas/`** (override with `IFC_ATLAS_HOME`). Optional env overrides load from `~/.ifc-atlas/.env`; see [`.env.example`](.env.example) for every variable, and [docs/user/DATA_STORAGE.md](../docs/user/DATA_STORAGE.md) for the full layout.

API keys: easiest in-app (Chat Manager → Settings), stored in `~/.ifc-atlas/secrets.json`; env vars take precedence.

## Tests

```bash
cd backend
pytest -q                                                      # full suite
pytest -m "not requires_ifc_load and not subprocess_sandbox"   # fast subset, <60 s
```

The full suite loads the sample model from `data/fixtures/BasicHouse.ifc`, which is not tracked in git. Download it once with `scripts/fetch-sample.ps1` (Windows) or `scripts/fetch-sample.sh` (macOS/Linux); if it is missing, the IFC-load tests are skipped automatically and the rest of the suite still runs.

On **Windows + Python 3.13** the IfcOpenShell wheel segfaults under pytest. Use Python 3.12 for the full suite; the fast subset runs anywhere.

## More

- Architecture and service map: [docs/architecture/BACKEND.md](../docs/architecture/BACKEND.md)
- REST catalogue: [docs/api/REST.md](../docs/api/REST.md) (regenerate: `python scripts/generate_api_doc.py`)
- MCP server: SSE at `/mcp/sse`, stdio via `python -m app.mcp_server`; auth via `MCP_SERVER_TOKEN`, writes via `MCP_ALLOW_WRITES=1`
