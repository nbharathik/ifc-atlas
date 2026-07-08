# Deployment Architecture

Three deployment targets share the same frontend codebase, controlled by build flags.

| Target | Frontend | Backend | Output |
|---|---|---|---|
| **Web (self-hosted)** | Full | Full | Caddy + uvicorn on a VM. |
| **GitHub Pages demo** | Viewer-only (`VITE_PUBLIC_DEMO=true`) | None | Static `gh-pages` branch. |
| **Tauri desktop** | Full (`VITE_PLATFORM=tauri`) | Sidecar (bundled) | `src-tauri/target/release/bundle/*` installers. |

The user-facing version of this document is [Deploy Your Own](../user/DEPLOY_YOUR_OWN.md).

---

## Target 1: Web (self-hosted)

Typical layout: Caddy in front of uvicorn on the same VM; the frontend is prebuilt and served as static files.

### Caddy

```caddy
viewer.example.com {
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "credentialless"
        X-Content-Type-Options "nosniff"
    }

    @ws path /api/chat/ws /api/ifc/sync/ws
    reverse_proxy @ws localhost:8000

    reverse_proxy /api/* localhost:8000
    reverse_proxy /mcp/* localhost:8000

    root * /var/www/viewer/dist
    file_server
    encode zstd gzip

    @wasm path *.wasm
    header @wasm Content-Type "application/wasm"
}
```

### uvicorn

```bash
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000 \
    --workers 2 --access-log --log-level info
```

### Environment

- `FRONTEND_URL=https://viewer.example.com`: CORS allow-list.
- `UPLOAD_DIR=/var/data/viewer-uploads` (persist across restarts).
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`: secrets manager preferred.
- `MCP_SERVER_TOKEN`: required when exposing `/mcp/*` to the internet.

### Health check

`GET /api/health` returns `{"status": "ok"}`.

---

## Target 2: GitHub Pages demo

Viewer only. No backend, no chat, no edit.

### Build

```bash
cd frontend
VITE_PUBLIC_DEMO=true npm run build
```

The flag:

- removes the chat panel from the DOM,
- strips Tier-3 (write) tool code from the bundle,
- short-circuits any `/api/*` call with a friendly empty-state.

The deploy workflow also stages the sample model at `samples/BasicHouse.ifc`
next to the demo bundle; it is not loaded automatically - users drop a file
(or the staged sample) into the empty viewer.

### GitHub Actions

The published demo is rebuilt on every push to `master` by
[`.github/workflows/gh-pages.yml`](https://github.com/nbharathik/ifc-atlas/blob/master/.github/workflows/gh-pages.yml),
which builds the demo bundle with `--base=/ifc-atlas/demo/`, stages the
sample model, builds the MkDocs site, and publishes website + demo + docs
to the `gh-pages` branch (website at the root, demo at `/demo/`, docs at
`/docs/`). The workflow file is the source of truth for the exact steps.

---

## Target 3: Tauri 2 desktop

Bundles the React frontend and a PyInstaller-frozen FastAPI sidecar into one native installer per OS. See [TAURI.md](TAURI.md) for the design contract and [Running Tauri](../user/RUNNING_TAURI.md) for the step-by-step build.

```
┌─────────────────────────────────┐
│  Tauri 2 shell                  │
│  ┌───────────────────────────┐  │
│  │ Frontend (same React app) │  │
│  └────────────┬──────────────┘  │
│               │ HTTP/WS         │
│               ▼                 │
│  ┌───────────────────────────┐  │
│  │ Sidecar python uvicorn    │  │
│  │ (bundled per platform)    │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

### Sidecar

Python backend bundled as a platform-specific binary at `src-tauri/binaries/ifc-backend-{rustc-host-triple}.exe`:

- Windows: PyInstaller via `scripts/build_sidecar.ps1` → `ifc-backend-x86_64-pc-windows-msvc.exe`.
- Linux: PyInstaller via `scripts/build_sidecar.sh` (extensionless binary).
- macOS: planned; needs an Apple Developer certificate for signing.

Spawned by Tauri's sidecar lifecycle API at startup; killed on exit. Listens on `127.0.0.1:8000`; the sidecar announces `BACKEND_READY port=N` on stdout and Tauri relays the port to the frontend via a `backend-ready` event.

### Build

```powershell
powershell -File scripts\build_sidecar.ps1   # freeze backend
npm run tauri:build                          # bundle installer
```

Artefacts:

- `src-tauri/target/release/bundle/msi/IFC Atlas_*.msi` (Windows MSI).
- `src-tauri/target/release/bundle/nsis/IFC Atlas_*.exe` (Windows NSIS).
- `src-tauri/target/release/bundle/appimage|deb|rpm/` (Linux, built by
  `desktop-build.yml` on Ubuntu 22.04).
- macOS `.dmg` is planned; unsigned bundles are blocked by Gatekeeper, so
  it needs an Apple Developer certificate and notarization first.

### Auto-update (planned)

Tauri's updater plugin is wired but not yet pointed at a release feed. Code signing is also outstanding. Tracked in [TAURI.md → Known gaps](TAURI.md#known-gaps-post-10-hardening).

---

## Cross-target guardrails

- **COOP / COEP required** for Target 1: multi-threaded web-ifc refuses to spawn otherwise.
- **Demo mode strips Tier-3**: Target 2 must not ship any write-tool code paths.
- **Tauri sidecar must not leak**: kill-on-exit and graceful signal handling are part of the Tauri test suite.
- **Release gate before publishing**: run `npm run verify` locally (the same gate CI runs on every push).
