# Distribution: Three Editions, One Repo

IFC Atlas ships from a single repository as three editions that share the same frontend tree and the same Python backend. The edition is chosen at build time via Vite build flags.

| Edition | Target | Backend | Chat | Edit |
|---|---|---|---|---|
| **Cloud (self-host)** | Hosted SaaS or self-host on a VM | FastAPI + IfcOpenShell + Node sidecar | Full | Off by default (`EDIT_MODE_ENABLED`) |
| **Tauri desktop** | Windows / macOS / Linux installer | PyInstaller-frozen FastAPI as Tauri sidecar | Full | Off by default (`EDIT_MODE_ENABLED`) |
| **GitHub Pages demo** | Static public site | None | Disabled | Disabled |

The companion docs:

- Ops runbook: [`DEPLOY.md`](DEPLOY.md).
- Desktop shell contract: [`TAURI.md`](TAURI.md).
- Engine internals: [`AI_NATIVE_ENGINE.md`](AI_NATIVE_ENGINE.md).

---

## Build flags

The frontend reads two Vite flags at build time:

| Flag | Effect |
|---|---|
| `VITE_PUBLIC_DEMO=true` | Hides the chat panel, strips Tier-3 (write) tool code from the bundle, and short-circuits `/api/*` calls with a friendly empty-state. |
| `VITE_PLATFORM=tauri` | Enables Tauri API hooks (sidecar address listener, future native menus). Off by default (`web`). |

```bash
# Cloud (default)
npm run build

# Desktop (wrapped by `npm run tauri:build`)
VITE_PLATFORM=tauri npm run build

# Public demo
VITE_PUBLIC_DEMO=true npm run build
```

---

## Edition 1: Cloud (self-host)

The full feature set. Same Caddy + uvicorn stack documented in [`DEPLOY.md`](DEPLOY.md).

- FastAPI serves `/api/*` and `/mcp/*`. WebSocket endpoints at `/api/chat/ws` and `/api/ifc/sync/ws`.
- The Node sidecar (`backend/sidecar/`) handles server-side fragment conversion, orchestrated by `backend/app/services/sidecar_manager.py`.
- The frontend is prebuilt and served as static files behind Caddy.

Hosting that is known to work: any VM with Docker, [Fly.io](https://fly.io/), or [Railway](https://railway.app/). WebSocket support is required.

---

## Edition 2: Tauri desktop

The offline / power-user edition. Opens `.ifc` files via the OS file picker (file-association handler is a stub today), works without internet if you bring your own LLM keys, and isolates writable state to `~/.ifc-atlas/`.

The full design lives in [`TAURI.md`](TAURI.md). The desktop build today bundles **one** sidecar (the PyInstaller-frozen FastAPI backend). The Node fragment sidecar is **not bundled**: in a source checkout the Python process spawns it from `backend/sidecar/` (needs Node and `npm install`), but the installed app has no Node runtime, so server-side fragment conversion is unavailable there and model loads use the in-browser web-ifc worker parse (slower on large models).

Build:

```powershell
powershell -File scripts\build_sidecar.ps1   # freeze backend
npm run tauri:build                          # bundle installer
```

Artefacts land in `src-tauri/target/release/bundle/`:

- `msi/IFC Atlas_*.msi` (Windows MSI)
- `nsis/IFC Atlas_*.exe` (Windows NSIS)
- `appimage/`, `deb/`, `rpm/` (Linux; freeze the sidecar with
  `scripts/build_sidecar.sh` first - CI builds these on Ubuntu 22.04)
- macOS `.dmg` is planned; it needs an Apple Developer certificate and
  notarization before unsigned bundles would even launch.

### Features unique to desktop

- Per-user data folder at `~/.ifc-atlas/` (read-only install dir, writable user state).
- Sidecar lifecycle managed by Tauri; the child process is killed on window close.

### Not yet implemented (post-1.0 hardening)

- Code signing for Windows and macOS. Unsigned MSI / NSIS work but show a SmartScreen warning.
- Auto-update plumbing.
- File-association launch (`get_open_with_path` returns `None` today).
- Native menus, recent files, multi-window pop-outs.

---

## Edition 3: GitHub Pages demo

Zero-friction public marketing site. Browser-only, no backend reachable, no API keys on the wire.

### Build

```bash
cd frontend
VITE_PUBLIC_DEMO=true npm run build
npx gh-pages -d dist -b gh-pages
```

In CI, [`.github/workflows/gh-pages.yml`](https://github.com/nbharathik/ifc-atlas/blob/master/.github/workflows/gh-pages.yml) does the same on every push to `master`.

The `VITE_PUBLIC_DEMO=true` build:

- removes the chat panel from the DOM,
- strips Tier-3 (write) tool code from the bundle,
- short-circuits any `/api/*` call with a friendly empty-state.

The CI deploy stages `BasicHouse.ifc` at `samples/` next to the bundle; it
is not loaded automatically.

### What ships in the demo

- Viewer, orbit / pan / zoom, selection, isolate / hide, measurement, clip planes, classification browser, aggregate inspector, share-link URLs, keyboard shortcuts.

### What is hidden

- Chat panel, LLM integrations, edit tools, MCP, IDS validator. Models load
  via in-browser drag-and-drop parsing (`web-ifc`); there is no backend
  upload.

### Fallback parser

Demo relies on the in-browser `web-ifc` parser (the cloud sidecar path is unreachable). Expect TTFR roughly 8-12 seconds for `BasicHouse.ifc` (≈ 50 MB) on a mid-range laptop versus 3-5 s for the cloud sidecar.

---

## License notes

The project is MPL-2.0 (see [`LICENSE`](https://github.com/nbharathik/ifc-atlas/blob/master/LICENSE)). Third-party dependencies are catalogued in [`docs/THIRD_PARTY_NOTICES.md`](https://github.com/nbharathik/ifc-atlas/blob/master/docs/THIRD_PARTY_NOTICES.md).

`IfcOpenShell` is LGPL-3.0 (library-copyleft, not full copyleft). The Cloud edition is open source so the relink requirement is moot. The Desktop edition ships IfcOpenShell as replaceable `.pyd`/`.so` files; THIRD_PARTY_NOTICES.md documents how a user would swap in their own build. The Demo edition does not ship IfcOpenShell (browser-only).

---

## Release artefacts per edition

| Edition | Output | Where | Trigger |
|---|---|---|---|
| Cloud | Frontend `dist/` + backend source + Docker image | Container registry + tagged GitHub release | Manual |
| Desktop | `.msi` / `.exe` / `.dmg` / `.AppImage` / `.deb` / `.rpm` | GitHub Releases | Manual |
| Demo | Static frontend | `gh-pages` branch | Every push to `master` |
