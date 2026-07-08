# Running the Tauri Desktop Build Locally

How to launch IFC Atlas inside the Tauri 2 native shell on Windows for local verification, plus how to produce the desktop installer. Pairs with `docs/DEVELOPMENT.md` (web stack) and `docs/architecture/TAURI.md` (design contract).

!!! tip "Just want the app?"
    You do not need any of this to *use* IFC Atlas on desktop. Prebuilt installers for Windows (`.exe` / `.msi`) and Linux (`.AppImage` / `.deb` / `.rpm`) are attached to every [GitHub release](https://github.com/nbharathik/ifc-atlas/releases/latest). This page is for building the shell or the installer yourself.

## TL;DR

```powershell
# One-time setup
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Microsoft.EdgeWebView2Runtime   # usually preinstalled on Win11
# Re-open PowerShell so `cargo` lands on PATH
npm install                                    # repo root: installs @tauri-apps/cli
cd frontend; npm install; cd ..

# Each run: two terminals
# Terminal A
cd backend; python run.py

# Terminal B (repo root)
npm run tauri:dev
```

---

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| **Rust + cargo** | Tauri compiles a native Rust shell. | `winget install Rustlang.Rustup`, then re-open PowerShell. |
| **MSVC build tools** | Rust on Windows links via MSVC. | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| **WebView2 runtime** | Tauri's webview on Windows. | Usually preinstalled on Win11. Otherwise: `winget install Microsoft.EdgeWebView2Runtime`. |
| **Node ≥ 20** | Vite dev server. | `node --version` to confirm. |
| **Python 3.11 or 3.12** | FastAPI backend. | `python --version` to confirm. |
| **`@tauri-apps/cli`** | `tauri` CLI invoked by `npm run tauri:dev`. | `npm install` at the **repo root** (NOT inside `frontend/`). |

Verify Rust landed on PATH after a fresh terminal:

```powershell
rustc --version    # expect: rustc 1.X.X
cargo --version    # expect: cargo 1.X.X
```

---

## Develop with hot reload

### 1. Install JavaScript dependencies

```powershell
# Repo root: installs @tauri-apps/cli
npm install

# Frontend deps if not yet installed
cd frontend
npm install
cd ..
```

### 2. Backend: sidecar or live Python

The Rust shell spawns the frozen `ifc-backend` sidecar automatically in **both** dev and release, provided the binary exists at `src-tauri/binaries/ifc-backend-<triple>.exe` (build it once with `scripts\build_sidecar.ps1`).

If you are iterating on backend Python code, skip the sidecar and run the live backend instead; anything answering on port 8000 works in dev:

```powershell
cd backend
python run.py
```

Confirm the startup line (`Starting backend ... port=8000 ...`). Leave the terminal running. (If the frozen sidecar is also running and holding 8000, kill `ifc-backend.exe` first.)

### 3. Launch the Tauri dev window

In a second terminal at the repo root:

```powershell
npm run tauri:dev
```

What happens:

1. The Tauri CLI runs `cd ../frontend && npm run dev` and waits for `http://localhost:5173`.
2. Cargo compiles the Rust shell. **First compile takes 3-5 min** on a warm machine; subsequent rebuilds are under 30 s.
3. A native window titled **IFC Atlas** opens (1440 × 900), rendering the React app via WebView2.
4. The frontend's `BACKEND_ORIGIN = http://127.0.0.1:8000` (set when `__VITE_PLATFORM__=tauri`; `127.0.0.1` rather than `localhost` to dodge the Windows IPv6-localhost pitfall) talks to the backend you started in step 2.

Hot reload works for frontend changes. Rust changes require restarting `npm run tauri:dev`.

### 4. Smoke-test the build

In the new native window:

1. **Drag `data/fixtures/BasicHouse.ifc`** into the viewport (download it once with `scripts\fetch-sample.ps1` if missing). Should load in roughly the same time as the web build.
2. **Open the chat panel** and send a query; the backend roundtrip should work.
3. **Try `Shift+S`** (Model Stats) or any other shortcut: same behaviour as the web build.
4. **Devtools**: right-click → Inspect, or `Ctrl+Shift+I`.

---

## Build the desktop installer

This produces a `.msi` and `.exe` (NSIS) installer that bundle the Python backend as a PyInstaller-frozen sidecar. End users install one file; the app starts, the Rust shell launches the frozen backend on localhost, and the WebView2 frontend talks to it.

```powershell
# 1. Build the frozen backend (5-15 min the first time; ~70 MB output)
powershell -File scripts\build_sidecar.ps1

# 2. Build the Tauri installer (5-10 min the first time)
npm run tauri:build

# Output (each installer is roughly 80 MB):
#   src-tauri\target\release\bundle\msi\IFC Atlas_<version>_x64_en-US.msi
#   src-tauri\target\release\bundle\nsis\IFC Atlas_<version>_x64-setup.exe
```

Either installer is self-contained. Install it on any Windows 11 machine with WebView2 (preinstalled), launch **IFC Atlas**, and drag in an IFC file.

### Where state lives in the installed app

When run as the frozen sidecar, the backend redirects all writable state to the per-user folder so `Program Files` stays read-only:

| Platform | Path |
|---|---|
| Windows | `%USERPROFILE%\.ifc-atlas\` |
| macOS | `~/.ifc-atlas/` |
| Linux | `~/.ifc-atlas/` |

Subfolders created on demand: `uploads/`, `fragments/`, `snapshots/`, `ifc_history/`, and `data/` (metadata index, custom agents, prompts, snippets), plus the optional `.env` for env overrides. See [Data Storage](DATA_STORAGE.md) for the full layout.

### Provider keys in the installed app

The frozen backend reads `~/.ifc-atlas/.env` (not the repo `.env`). Configure keys one of three ways:

1. **Drop a `.env`** at `~/.ifc-atlas/.env` with whichever of these you want active:

   ```env
   OPENAI_API_KEY=sk-...
   ANTHROPIC_API_KEY=sk-ant-...
   OPENROUTER_API_KEY=sk-or-...
   ```

2. **AI Keys modal**, which pops up on first launch.

3. **Chat Manager → Settings tab**: keys entered here persist to `~/.ifc-atlas/secrets.json`.

Without any keys, the viewer (3D, selection, properties, measurement) still works; AI chat is disabled until at least one provider is configured.

### Known gaps in the desktop packaging

- **No code signing yet.** Windows SmartScreen shows "Unknown publisher" on first install. Not blocking but rough UX.
- **Console flash on launch.** The frozen exe is built with `console=True`. A short console window may briefly appear when Tauri spawns the sidecar.

---

## Troubleshooting

### `error: linker 'link.exe' not found`

MSVC build tools are missing. Re-run the BuildTools `winget` command from the prerequisites table.

### Tauri window opens but the page is blank / `ERR_CONNECTION_REFUSED`

The Vite dev server didn't come up. Check the Tauri CLI output for a `beforeDevCommand` failure (port 5173 conflict, missing frontend deps). Run `cd frontend && npm run dev` separately to debug.

### `cannot find binaries/ifc-backend`

You ran `tauri build`, not `tauri dev`. Production builds need the PyInstaller-frozen sidecar (see "Build the desktop installer" above). For verification, stick with `npm run tauri:dev`.

### Backend can't bind port 8000

The backend no longer fails on a taken port: `run.py` prefers 8000 and **automatically falls back to a free port**, announcing the real one via `BACKEND_READY port=N`. The Tauri shell forwards that to the frontend (`backend-ready` event), so no config change is needed.

If you want to see who is holding 8000 anyway:

```powershell
Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue
```

### Cargo is slow / `src-tauri/target/` keeps growing

`src-tauri/target/` is gitignored and can grow to ~2 GB. Safe to delete; the next `tauri dev` will recompile (slow first run only).
