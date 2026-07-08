# Tauri 2 Desktop Architecture

How the desktop edition packages the same React + FastAPI codebase as a single native binary. This document is the design contract; for the runtime instructions see [Running Tauri](../user/RUNNING_TAURI.md).

The Tauri shell is **preview tooling**: signed installers, auto-update, native menus, and file-association handling are post-1.0 hardening work.

---

## Shape

```
┌───────────────────────────────────────────────┐
│                Tauri 2 Shell                  │
│   (WebView2 on Win, WKWebView on macOS,       │
│    WebKitGTK on Linux)                        │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │ React frontend bundle                   │  │
│  │   VITE_PLATFORM=tauri                   │  │
│  │                                         │  │
│  │   - Listens for 'backend-ready' event   │  │
│  │   - Sets BACKEND_ORIGIN dynamically     │  │
│  └───────────────┬─────────────────────────┘  │
│                  │ HTTP / WS (localhost)      │
│  ┌───────────────▼─────────────────────────┐  │
│  │ Sidecar: PyInstaller-frozen backend     │  │
│  │                                         │  │
│  │   - binaries/ifc-backend{-triple}.exe   │  │
│  │   - Binds 127.0.0.1:8000 by default     │  │
│  │   - Announces BACKEND_READY port=N      │  │
│  │   - Killed on window close              │  │
│  └─────────────────────────────────────────┘  │
└───────────────────────────────────────────────┘
```

---

## Sidecar lifecycle

### Spawn

`src-tauri/src/lib.rs` registers a `setup` hook that spawns the platform-suffixed sidecar in **both dev and release**:

```
binaries/ifc-backend-{x86_64-pc-windows-msvc,aarch64-apple-darwin,...}.exe
```

The spawn passes `--host 127.0.0.1` (loopback only) and `--port 8000` as the *preferred* port; `run.py` falls back to a free port if 8000 is taken. In `tauri dev` a developer iterating on backend code can kill the sidecar and run `python run.py` instead; the dev webview reaches whatever answers on 8000 through the Vite proxy.

### Port announce

The sidecar writes to stdout on startup:

```
BACKEND_READY port=8000
```

Tauri parses the line and emits a `backend-ready` event with `{ port }`. The frontend listens (`frontend/src/services/tauriBackendReady.ts`) and sets the backend origin before any API call fires.

### Shutdown

The window-close handler drops the sidecar child process. The frozen Python binary handles SIGTERM cleanly.

---

## Platform feature flag

The frontend reads `import.meta.env.VITE_PLATFORM`:

```ts
export const IS_TAURI = import.meta.env.VITE_PLATFORM === 'tauri';

if (IS_TAURI) {
  const { listen } = await import('@tauri-apps/api/event');
  // listen for 'backend-ready', etc.
}
```

When the flag is off, none of the Tauri API modules are imported, so the web bundle stays small.

---

## Per-user data folder

The frozen PyInstaller sidecar detects `sys.frozen=True` and writes every piece of mutable state to a per-user dotfolder:

| Platform | Path |
|---|---|
| Windows | `%USERPROFILE%\.ifc-atlas\` |
| macOS | `~/.ifc-atlas/` |
| Linux | `~/.ifc-atlas/` |

Layout: `uploads/`, `snapshots/`, `data/`, `ifc_history/`, plus an optional `.env` and `secrets.json`. Override with `IFC_ATLAS_HOME` (legacy `IFC_VIEWER_HOME` still honoured).

The install location (e.g. `C:\Program Files\IFC Atlas\`) stays read-only: installers can drop in without needing write access, and uninstalling does not delete user data.

Resolution lives in [`backend/app/core/config.py`](https://github.com/nbharathik/ifc-atlas/blob/master/backend/app/core/config.py) → `_user_data_root()`. Settings → Storage → User data folder shows the resolved paths, per-scope sizes, flush buttons, and an LRU cap. See [Data Storage](../user/DATA_STORAGE.md) for the user-facing description.

---

## Capabilities (Tauri allowlist)

`src-tauri/capabilities/default.json` grants only what the app actually uses:

- `shell:allow-spawn` scoped to `binaries/ifc-backend` with `sidecar: true, args: true`, needed so the release build can spawn the bundled backend.
- `dialog`, `fs`, `process` plugins, enabled for the file-open dialog and graceful child-process management.

No node integration. No unscoped HTTP. The webview runs under a scoped CSP
(`app.security.csp` in `tauri.conf.json`): `default-src 'self'`, with
`script-src` limited to `'self' 'wasm-unsafe-eval'` (web-ifc WASM; Tauri
auto-hashes the inline WASM-warmup script), `worker-src 'self' blob:` (the
fragments worker is spawned from a `blob:` URL), and `connect-src` scoped to
`'self'`, the Tauri IPC (`ipc:` / `http://ipc.localhost`), and the backend
sidecar on `127.0.0.1`/`localhost` (any port). `object-src 'none'`. The webview
makes no external network calls - all LLM/provider traffic goes through the
local sidecar.

---

## Build pipeline

```powershell
# 1. Freeze the Python backend (5-15 min cold; ~70 MB frozen binary)
powershell -File scripts\build_sidecar.ps1

# 2. Bundle the Rust shell + sidecar into an installer (5-10 min cold)
npm run tauri:build
```

`npm run tauri:build` runs `scripts/tauri-build.mjs`, which resolves the updater
signing key automatically: it uses `TAURI_SIGNING_PRIVATE_KEY` if already set
(CI), else the key at `TAURI_SIGNING_PRIVATE_KEY_PATH` or the conventional
`~/.tauri/ifc-atlas.key`, producing **signed** updater artifacts. With no key
anywhere (fresh clone / fork) it builds the installers **keyless** (merges
`src-tauri/updater-off.conf.json` to skip updater artifacts) instead of failing.
To force a keyless build even when a key is present, temporarily move the key
or pass `-- --config src-tauri/updater-off.conf.json`.

Artefacts:

```
src-tauri/target/release/bundle/msi/IFC Atlas_<version>_x64_en-US.msi
src-tauri/target/release/bundle/nsis/IFC Atlas_<version>_x64-setup.exe
```

Both bundles are self-contained; install on any Windows 11 machine with WebView2 (preinstalled), launch IFC Atlas, drag in an IFC file.

---

## Provider keys in the installed app

The frozen backend reads `~/.ifc-atlas/.env` (not the repo `.env`). Configure keys one of three ways:

1. Drop a `.env` at `~/.ifc-atlas/.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`).
2. Use the AI Keys modal on first launch.
3. Use Chat Manager → **Settings**; keys persist to `~/.ifc-atlas/secrets.json`.

Without any keys the viewer (3D + selection + properties + measurement) still works; chat and edit are disabled until at least one provider is configured.

---

## Auto-updates

Installed apps poll `https://github.com/nbharathik/ifc-atlas/releases/latest/download/latest.json`
(configured in `tauri.conf.json` -> `plugins.updater`) via Help -> "Check for
updates". The manifest is generated by the release job in
`.github/workflows/desktop-build.yml` from the signed installer artifacts.
Windows updates ride the NSIS exe (passive install mode); on Linux only the
AppImage channel self-updates (deb/rpm users re-download).

Signing setup (one-time, maintainer):

- The keypair lives at `~/.tauri/ifc-atlas.key` (private) and
  `~/.tauri/ifc-atlas.key.pub` (public, committed into `tauri.conf.json`).
  **Back the private key up - losing it strands every existing install**
  (they would reject updates signed with a new key).
- CI needs two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the private
  key file's full contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty
  string for the current key). Without them, CI builds still succeed but
  skip updater artifacts and `latest.json`.
- Local release builds: no setup needed - `npm run tauri:build` auto-detects
  the key at `~/.tauri/ifc-atlas.key` (override with `TAURI_SIGNING_PRIVATE_KEY`
  / `TAURI_SIGNING_PRIVATE_KEY_PATH`). Without a key it builds keyless rather
  than failing.

## File associations + single instance

`bundle.fileAssociations` registers `.ifc`; the runtime handling lives in
`lib.rs`: the first launch stashes an argv path for the webview
(`get_open_with_path`, take-once), and later launches are captured by
`tauri-plugin-single-instance` (registered first), which focuses the running
window and emits an `open-file` event. `DesktopOpenFileBridge` (frontend)
reads the bytes over binary IPC (`read_ifc_file`) and feeds the normal upload
pipeline.

## Backend crash recovery

The stdout watcher distinguishes exit-before-ready (`backend-failed`) from
exit-after-ready (`backend-crashed`). On a crash the BackendGate keeps the app
mounted (the viewer is frontend-first) and offers "Restart backend" - the
`restart_backend` command kills any leftover process tree and respawns the
sidecar; a spawn-generation counter keeps deliberate restarts from surfacing
as phantom crashes. "Open logs" reveals `~/.ifc-atlas/logs`.

## Linux graphics troubleshooting (safe graphics mode)

WebKitGTK (the Linux webview) has documented rendering failures on some
graphics stacks - typically a blank or garbled window right after launch on
NVIDIA proprietary drivers, Wayland sessions, or the DMABUF renderer path.
The standard workarounds are two environment variables that WebKitGTK reads
when the webview is created.

IFC Atlas wraps them as an opt-in **safe graphics mode**:

- **Toggle:** Help -> "Safe graphics mode: on/off" (Linux only; confirms, then
  restarts the app - a restart is required because the env vars only apply at
  webview creation).
- **Mechanism:** a marker file at `~/.ifc-atlas/safe-graphics`. When it exists,
  the shell sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` and
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` before `tauri::Builder` is constructed
  (see the top of `run()` in `src-tauri/src/lib.rs`) and logs a line to stderr.
- **If the window is blank you cannot reach the Help menu.** Enable it
  manually and relaunch:

  ```bash
  mkdir -p ~/.ifc-atlas && touch ~/.ifc-atlas/safe-graphics
  ```

  Delete the file to go back to normal rendering.

The trade-off: disabling the compositing mode forces WebKitGTK off GPU
compositing, which noticeably hurts WebGL - i.e. the 3D viewer itself renders
slower. That is why this is opt-in rather than the default; use it only when
the app launches to a blank/corrupted window. The CI launch smoke test runs
the AppImage under Xvfb with both vars set (GPU-less runners exercise exactly
this software path), so the safe-mode configuration is what CI verifies boots.

---

## Known gaps (post-1.0 hardening)

- **No code signing of the installers.** Windows SmartScreen shows "Unknown
  publisher" on first install (updater artifacts ARE minisign-signed; this is
  about OS-level Authenticode/notarization).
- **Native menus, recent-files/jump lists**: not yet implemented.
- **CSP is still `null`**: tightening it is a known hardening item.

---

## Related docs

- [Running Tauri](../user/RUNNING_TAURI.md): step-by-step build instructions.
- [Distribution](DISTRIBUTION.md): how the desktop edition relates to Cloud and Demo.
- [Data Storage](../user/DATA_STORAGE.md): user-facing description of `~/.ifc-atlas/`.
