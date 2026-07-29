# IFC Atlas - backend

FastAPI service behind the viewer. It handles LLM chat (OpenAI / Anthropic / OpenRouter, streaming, tool calls), IFC uploads and server-side fragment conversion, semantic IfcOpenShell queries and sandboxed edits, IDS validation, and an MCP server that exposes the viewer toolset to external clients. The frontend owns geometry parsing and rendering.

## Run it

```bash
cd backend
python -m venv .venv                     # Python 3.12
# Windows: .venv\Scripts\activate   macOS/Linux: source .venv/bin/activate
pip install --require-hashes -r requirements.lock
python run.py                            # http://localhost:8000  (--verbose for debug logs)
```

The native-parser sidecar (`sidecar/`) is spawned on demand and needs Node 20+ on PATH: when `sidecar/dist/index.cjs` exists (build it with `npm run build` in `sidecar/`) it runs via plain `node`, otherwise via the `npx tsx` dev fallback (requires `npm install` in `sidecar/`). `IFC_SIDECAR_CMD` overrides the launch command entirely. Without Node the backend still runs and falls back to IfcOpenShell-only parsing.

## Where data lives

Nothing is written inside the repo. All writable state (uploads, fragment cache, edit history, custom agents, API keys) lives in the per-user folder **`~/.ifc-atlas/`** (override with `IFC_ATLAS_HOME`). Optional env overrides load from `~/.ifc-atlas/.env`; see [`.env.example`](.env.example) for every variable, and [docs/user/DATA_STORAGE.md](../docs/user/DATA_STORAGE.md) for the full layout.

API keys: easiest in-app (Chat Manager → Settings), stored in `~/.ifc-atlas/secrets.json`; env vars take precedence.

## Security profiles

The backend has two explicit profiles:

- `local` is the default for development and is restricted to loopback. Tauri
  always creates a random 256-bit token for each launch and passes it directly
  to the sidecar and webview.
- `server` requires `IFC_ATLAS_API_TOKEN` with at least 32 characters and
  protects REST and WebSocket API traffic. The current credential is a shared
  deployment token, not user/project authorization.

Example server start:

```bash
IFC_ATLAS_SECURITY_MODE=server \
IFC_ATLAS_API_TOKEN='replace-with-a-random-32-plus-character-value' \
python run.py --host 0.0.0.0
```

Free-form Python and saved Python plugins are trusted-local features.
`IFC_ATLAS_ENABLE_CODE_EXECUTION` defaults to off in server mode. Do not enable
it on an internet-facing or multi-tenant deployment; the current subprocess
restrictions are defense in depth, not an OS security sandbox.

## Tests

```bash
cd backend
pip install --require-hashes -r requirements-dev.lock
python -m ruff check app tests
python -m pytest -q
python -m pytest -m "not requires_ifc_load and not subprocess_sandbox"
python -m pip_audit -r requirements.lock --disable-pip
```

When either input requirements file changes, regenerate both committed locks
with the repository's pinned Python 3.12 target:

```bash
uv pip compile requirements.txt --universal --python-version 3.12 --generate-hashes --output-file requirements.lock
uv pip compile requirements.txt requirements-dev.txt --universal --python-version 3.12 --generate-hashes --output-file requirements-dev.lock
```

The full suite loads the sample model from `data/fixtures/BasicHouse.ifc`, which is not tracked in git. Download it once with `scripts/fetch-sample.ps1` (Windows) or `scripts/fetch-sample.sh` (macOS/Linux); if it is missing, the IFC-load tests are skipped automatically and the rest of the suite still runs.

On **Windows + Python 3.13** the IfcOpenShell wheel segfaults under pytest. Use Python 3.12 for the full suite; the fast subset runs anywhere.

## More

- Architecture and service map: [docs/architecture/BACKEND.md](../docs/architecture/BACKEND.md)
- REST catalogue: [docs/api/REST.md](../docs/api/REST.md) (regenerate: `python scripts/generate_api_doc.py`)
- MCP server: SSE at `/mcp/sse`, stdio via `python -m app.mcp_server`; in
  server mode it inherits `IFC_ATLAS_API_TOKEN` unless `MCP_SERVER_TOKEN`
  overrides it; writes require `MCP_ALLOW_WRITES=1`
