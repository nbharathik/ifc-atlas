# Deployment and Distribution

IFC Atlas ships from a single repository as three editions that share the same
frontend tree and the same Python backend. The edition is chosen at build time
via Vite build flags.

| Edition | Frontend | Backend | Chat | Edit | Output |
|---|---|---|---|---|---|
| **Web (self-hosted)** | Full | FastAPI + IfcOpenShell + Node sidecar | Full | Semantic, on by default (`EDIT_MODE_ENABLED=0` to disable) | Caddy + uvicorn on a VM. |
| **Tauri desktop** | Full (`VITE_PLATFORM=tauri`) | PyInstaller-frozen FastAPI sidecar (bundled) | Full | Semantic, on by default | `src-tauri/target/release/bundle/*` installers. |
| **GitHub Pages demo** | Viewer-only (`VITE_PUBLIC_DEMO=true`) | None | Disabled | Disabled | Static `gh-pages` branch. |

The user-facing version of this document is [Deploy Your Own](../user/DEPLOY_YOUR_OWN.md).

---

## Build flags

The frontend reads two Vite flags at build time:

| Flag | Effect |
|---|---|
| `VITE_PUBLIC_DEMO=true` | Hides the chat panel, strips Tier-3 (write) tool code from the bundle, and short-circuits `/api/*` calls with a friendly empty-state. |
| `VITE_PLATFORM=tauri` | Enables Tauri API hooks (sidecar address listener, future native menus). Off by default (`web`). |

```bash
# Web (default)
npm run build

# Desktop (wrapped by `npm run tauri:build`)
VITE_PLATFORM=tauri npm run build

# Public demo
VITE_PUBLIC_DEMO=true npm run build
```

---

## Target 1: Web (self-hosted)

Typical layout: Caddy in front of uvicorn on the same VM; the frontend is prebuilt and served as static files.

- FastAPI serves `/api/*` and `/mcp/*`. WebSocket endpoints at `/api/chat/ws` and `/api/ifc/sync/ws`.
- The Node sidecar (`backend/sidecar/`) handles server-side fragment conversion, orchestrated by `backend/app/services/sidecar_manager.py`.
- Hosting that is known to work: any VM with Docker, Fly.io, or Railway. WebSocket support is required.

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
- `IFC_ATLAS_SECURITY_MODE=server`: required for a shared/public deployment (default `local`).
- `IFC_ATLAS_API_TOKEN`: required in server mode; shared bearer token, at least 32 characters.
- `IFC_ATLAS_ENABLE_CODE_EXECUTION`: free-form Python/plugin execution; leave `0` on shared servers.
- `SIDECAR_CONVERT_TIMEOUT_S`: finite server conversion deadline (default 900 s).
- `MCP_SERVER_TOKEN`: optional separate bearer token for `/mcp/*`; server mode otherwise inherits the main API token.

Full table: [Deploy Your Own](../user/DEPLOY_YOUR_OWN.md#backend-environment-variables).

### Health check

`GET /api/health` returns `{"status": "ok"}`.

---

## Target 2: GitHub Pages demo

Viewer only. No backend reachable, no chat, no edit, no API keys on the wire.

### Build

```bash
cd frontend
VITE_PUBLIC_DEMO=true npm run build
```

The deploy workflow also stages the sample model at `samples/BasicHouse.ifc`
next to the demo bundle; it is not loaded automatically - users drop a file
(or the staged sample) into the empty viewer.

### What ships / what is hidden

- **Ships:** viewer, orbit / pan / zoom, selection, isolate / hide, measurement, clip planes, classification browser, aggregate inspector, share-link URLs, keyboard shortcuts.
- **Hidden:** chat panel, LLM integrations, edit tools, MCP, IDS validator. Models load via in-browser drag-and-drop parsing (`web-ifc`); there is no backend upload. Expect a slower first parse than the server-convert path on large models.

### GitHub Actions

[`.github/workflows/gh-pages.yml`](https://github.com/nbharathik/ifc-atlas/blob/main/.github/workflows/gh-pages.yml)
runs on every push to `main`: it regenerates the auto-generated tool/API
pages, builds the MkDocs site, and publishes it to the root of the
`gh-pages` branch (served at `/ifc-atlas/`). The demo bundle is not
auto-published - build and deploy it yourself using the commands above.
The workflow file is the source of truth for the exact steps.

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

The desktop build bundles **one** sidecar (the frozen FastAPI backend). The Node fragment sidecar is **not bundled**: the installed app has no Node runtime, so server-side fragment conversion is unavailable there and model loads use the in-browser web-ifc worker parse (slower on large models). Writable state is isolated to `~/.ifc-atlas/`.

### Build

```powershell
powershell -File scripts\build_sidecar.ps1   # freeze backend
npm run tauri:build                          # bundle installer
```

Artefacts land in `src-tauri/target/release/bundle/`:

- `msi/IFC Atlas_*.msi` (Windows MSI).
- `nsis/IFC Atlas_*.exe` (Windows NSIS).
- `appimage/`, `deb/`, `rpm/` (Linux, built by `desktop-build.yml` on Ubuntu 22.04; freeze the sidecar with `scripts/build_sidecar.sh` first).
- macOS `.dmg` is planned; unsigned bundles are blocked by Gatekeeper, so it needs an Apple Developer certificate and notarization first.

### Not yet implemented (post-1.0 hardening)

- Code signing for Windows and macOS. Unsigned MSI / NSIS work but show a SmartScreen warning.
- Auto-update: Tauri's updater plugin is wired but not yet pointed at a release feed.
- File-association launch (`get_open_with_path` returns `None` today).
- Native menus, recent files, multi-window pop-outs.

Tracked in [TAURI.md → Known gaps](TAURI.md#known-gaps-post-10-hardening).

---

## License notes

The project is MPL-2.0 (see [`LICENSE`](https://github.com/nbharathik/ifc-atlas/blob/main/LICENSE)). Third-party dependencies are catalogued in [`docs/THIRD_PARTY_NOTICES.md`](https://github.com/nbharathik/ifc-atlas/blob/main/docs/THIRD_PARTY_NOTICES.md).

`IfcOpenShell` is LGPL-3.0 (library-copyleft, not full copyleft). The Web edition is open source so the relink requirement is moot. The Desktop edition ships IfcOpenShell as replaceable `.pyd`/`.so` files; THIRD_PARTY_NOTICES.md documents how a user would swap in their own build. The Demo edition does not ship IfcOpenShell (browser-only).

---

## Release artefacts per edition

| Edition | Output | Where | Trigger |
|---|---|---|---|
| Web | Frontend `dist/` + backend source + Docker image | Container registry + tagged GitHub release | Manual |
| Desktop | `.msi` / `.exe` / `.dmg` / `.AppImage` / `.deb` / `.rpm` | GitHub Releases | Manual |
| Demo | Static frontend | Self-hosted (GitHub Pages, etc.) | Manual |

---

## Cross-target guardrails

- **COOP / COEP required** for Target 1: multi-threaded web-ifc refuses to spawn otherwise.
- **Demo mode strips Tier-3**: Target 2 must not ship any write-tool code paths.
- **Tauri sidecar must not leak**: kill-on-exit and graceful signal handling are part of the Tauri test suite.
- **Release gate before publishing**: run `npm run verify` locally (the same gate CI runs on every push).
