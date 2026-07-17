# IFC Atlas - Development Guide

Everything you need to develop, run, and package IFC Atlas, including the **standalone desktop app** that bundles the frontend *and* backend into a single Windows installer.

> Looking for the project overview? See [`README.md`](../README.md).
> Stuck app, stale caches, or port conflicts? See [`docs/user/TROUBLESHOOTING.md`](user/TROUBLESHOOTING.md).

---

## 1. The three ways to run the app

| Mode | What runs | When to use | Command |
|---|---|---|---|
| **A. Web dev** | Vite dev server + Python backend, two terminals | Day-to-day frontend/backend development (hot reload) | `python run.py` + `npm run dev` |
| **B. Tauri dev** | Native desktop window + Vite dev server + backend sidecar | Testing desktop-specific behaviour with hot reload | `npm run tauri:dev` |
| **C. Desktop installer** | One installed app - Rust shell + frozen Python backend, **no Python/Node needed by the end user** | Shipping the app; final acceptance testing | `scripts\build_sidecar.ps1` then `npm run tauri:build` |

---

## 2. Prerequisites

| Tool | Needed for | Install / verify |
|---|---|---|
| **Node.js ≥ 20** | Frontend, Tauri CLI | `node --version` |
| **Python 3.11 / 3.12** | Backend (3.13 works for running and for the frozen build, but **pytest segfaults on Windows + 3.13** - see note) | `python --version` |
| **Rust + cargo** | Tauri shell (modes B and C only) | `winget install Rustlang.Rustup`, then re-open the terminal; `cargo --version` |
| **MSVC Build Tools** | Rust linking on Windows (B and C only) | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
| **WebView2 runtime** | Tauri's webview (B and C only) | Preinstalled on Windows 11 |
| **PyInstaller** | Freezing the backend (C only) | Auto-installed by `build_sidecar.ps1` if missing |

> **Python version note:** `backend/pyproject.toml` pins `>=3.11,<3.13` because IfcOpenShell 0.8 segfaults under **pytest** on Windows + Python 3.13. The *frozen desktop build* has been verified working on 3.13 (sandbox, geometry, health all OK) - but for a friction-free dev experience use 3.12.

### One-time install

```powershell
# Repo root - Tauri CLI + workspace scripts
npm install

# Frontend
cd frontend
npm install
cd ..

# Backend
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements-dev.txt       # pytest (needed by `npm run verify:backend`)
pip install -r ..\requirements-docs.txt   # mkdocs (needed by `npm run verify:docs`)
# API keys: set them in-app (AI-Keys modal) or put them in %USERPROFILE%\.ifc-atlas\.env
# (see backend\.env.example for every variable - the backend does NOT read backend\.env)
cd sidecar
npm install                   # Node fragment-conversion sidecar (dev only)
cd ..\..
```

---

## 3. Mode A - Web development (daily driver)

Two terminals:

```powershell
# Terminal 1 - backend on http://localhost:8000
cd backend
.venv\Scripts\Activate.ps1
python run.py
```

```powershell
# Terminal 2 - frontend on http://localhost:5173
cd frontend
npm run dev
```

Open <http://localhost:5173> in Chrome/Edge and drop `data/fixtures/BasicHouse.ifc` onto the upload zone (download it once with `scripts\fetch-sample.ps1`). The Vite proxy forwards `/api/*` to port 8000, so there is no CORS setup to think about.

Troubleshooting (stale caches, hung backend, port conflicts): [`docs/user/TROUBLESHOOTING.md`](user/TROUBLESHOOTING.md).

---

## 4. Mode B - Tauri dev window

```powershell
# Repo root
npm run tauri:dev
```

What happens, in order:

1. The Tauri CLI starts the Vite dev server (`beforeDevCommand`) and waits for port 5173.
2. Cargo compiles the Rust shell - **3-5 min on first compile**, <30 s after.
3. The shell **spawns the backend sidecar automatically** (the frozen `ifc-backend` binary from `src-tauri/binaries/`) - you do *not* need a separate `python run.py`.
4. A native **IFC Atlas** window opens rendering the React app via WebView2.

Notes:

- The spawned sidecar is the **frozen** backend. If you are iterating on backend Python code, kill it and run `python run.py` instead - anything answering on port 8000 works, the dev webview reaches it through the Vite proxy.
- The sidecar binary must exist at `src-tauri/binaries/ifc-backend-x86_64-pc-windows-msvc.exe`. If it doesn't, build it once (next section); the shell logs a clear error if it's missing.
- Frontend hot reload works; Rust changes need a restart of `npm run tauri:dev`.

---

## 5. Mode C - Standalone desktop installer (bundle everything)

This is the "one file, double-click, it just works" build. The end user needs **no Python, no Node, no terminal**.

### How the bundling works

```
backend/  ──PyInstaller──►  ifc-backend.exe  (frozen FastAPI + IfcOpenShell, ~70 MB)
                                  │
frontend/ ──vite build──►  dist/  │  (VITE_PLATFORM=tauri flavor)
                                  │
src-tauri ──cargo build──►  IFC Atlas.exe  ◄── bundles both via externalBin + frontendDist
                                  │
                            NSIS .exe + MSI installers
```

At runtime:

1. The Rust shell spawns `ifc-backend` on loopback (`127.0.0.1`), preferring port **8000** and **falling back to any free port** if 8000 is taken.
2. The backend prints `BACKEND_READY port=N`; the shell forwards this to the webview as a `backend-ready` event.
3. The frontend's `BackendGate` splash waits for that event (or polls `/api/health`), then every REST/WebSocket call targets the announced port.
4. On app exit the shell kills the sidecar - no orphan processes.

### Build steps

```powershell
# Step 1 - freeze the backend (~5-10 min)
# Produces src-tauri\binaries\ifc-backend-x86_64-pc-windows-msvc.exe
powershell -File scripts\build_sidecar.ps1

# Step 2 - build the installer (~5-10 min)
# Runs the Tauri-flavored frontend build automatically, then cargo release build
npm run tauri:build
```

Output:

```
src-tauri\target\release\bundle\nsis\IFC Atlas_1.1.0_x64-setup.exe   (~80 MB)
src-tauri\target\release\bundle\msi\IFC Atlas_1.1.0_x64_en-US.msi    (~81 MB)
```

> **Always re-run Step 1 after backend changes.** `tauri build` bundles whatever binary is sitting in `src-tauri/binaries/` - a stale sidecar means the installer ships old backend code with no warning.

### Acceptance checklist for a built installer

1. Install the NSIS `.exe` (SmartScreen will warn - the installer is unsigned, click "More info → Run anyway").
2. Launch **IFC Atlas** from the Start menu. The splash should clear within a few seconds (sidecar boot).
3. Drop `data/fixtures/BasicHouse.ifc` - geometry, model tree, and properties must load.
4. Open chat and send a message - verifies the WebSocket path to the announced port.
5. Close the app, open Task Manager - there must be **no lingering `ifc-backend.exe`**.

### Where the installed app stores data

All writable state goes to `%USERPROFILE%\.ifc-atlas\` (uploads, fragment cache, custom agents, secrets). API keys: drop a `.env` there, or use the AI-Keys modal on first launch. Details: [`docs/user/DATA_STORAGE.md`](user/DATA_STORAGE.md).

### Known limitations of the desktop build

| Limitation | Impact | Status |
|---|---|---|
| Installer is **unsigned** | SmartScreen "unknown publisher" warning | Accepted for now; needs a code-signing cert |
| Onefile exe **re-extracts on every launch** | Slower cold start; also slows each AI code-sandbox call | Known; switching to onedir would fix it but complicates `externalBin` |
| **Node fragment sidecar not bundled** | Server-side IFC→fragment conversion unavailable in the installed app; the in-browser worker parse covers viewing (slower on big models) | Deliberately deferred |
| Frozen with **Python 3.13** | Verified working (health, geometry, AI sandbox), but outside the official `<3.13` pin | Rebuild with 3.12 if IFC ops ever crash in the field |

---

## 6. Building for macOS and Linux

**Short version: you cannot build mac/Linux installers from a Windows machine.** Two layers of this app are OS-locked:

1. **Tauri does not cross-compile.** A Windows build produces only NSIS/MSI; the `.dmg`/`.app` (macOS) and `.deb`/`.rpm`/`.AppImage` (Linux) bundles can only be produced *on* those operating systems.
2. **PyInstaller does not cross-compile either.** The frozen `ifc-backend` sidecar must be frozen on each target OS, against that OS's IfcOpenShell wheel.

So every supported platform needs both steps run natively: freeze the backend there, then `tauri build` there.

### What each platform involves

| Platform | Bundle output | Extra work needed | Status |
|---|---|---|---|
| **Windows x64** | NSIS `.exe` + `.msi` | None - done | ✅ Built and verified locally |
| **Linux x64** | `.AppImage` + `.deb` + `.rpm` | None - `scripts/build_sidecar.sh` + the CI workflow below cover it | 🟡 Sidecar freeze + boot **verified in WSL Ubuntu 24.04** (health OK, clean SIGTERM shutdown); the Tauri bundling step awaits its first CI run |
| **macOS Apple Silicon** (`aarch64-apple-darwin`) | `.app` + `.dmg` | Unsigned apps are blocked by Gatekeeper (users must right-click → Open); proper distribution needs an Apple Developer account ($99/yr) for signing + notarization | Deferred (matrix entry commented out) |
| **macOS Intel** (`x86_64-apple-darwin`) | `.app` + `.dmg` | As above, built on an Intel runner - each mac architecture is a separate build with its own frozen sidecar | Deferred (matrix entry commented out) |
| iOS / Android | - | Not feasible: the Python sidecar cannot run there | Out of scope |

### The pieces that make non-Windows builds work

- **`scripts/build_sidecar.sh`** - bash port of the PowerShell freeze script: same PyInstaller invocation, stages the output as `src-tauri/binaries/ifc-backend-<target-triple>` (no `.exe` suffix).
- **Unix orphan fix in `src-tauri/src/lib.rs`** - on app exit, Unix sends SIGTERM to the PyInstaller bootloader (which forwards it to its Python child and reaps it) before the hard `child.kill()`; Windows uses `taskkill /T /F`. Without this, closing the app would leave the backend running.
- IfcOpenShell ships wheels for macOS (x64 + arm64) and manylinux, so the backend itself needs no changes.

### The CI workflow: `.github/workflows/desktop-build.yml`

Since the dev machine is Windows-only, the other platforms build on GitHub Actions runners (free for public repos). The workflow runs on **manual dispatch** (Actions tab → "Desktop installers" → Run workflow) or on pushing a `v*` tag. Per OS it: sets up Node 22 + Python 3.12 + Rust → installs the Linux webkit2gtk build deps → freezes the sidecar with the platform's script → `npm run tauri:build` → uploads the bundles as run artifacts.

The matrix currently enables `windows-latest` and `ubuntu-22.04` (oldest supported distro = widest glibc compatibility). The two macOS entries are present but commented out - enable them when signing/notarization is sorted.

> **Verified so far (WSL Ubuntu 24.04, Python 3.12):** `build_sidecar.sh` froze the backend cleanly (106 MB), the frozen binary booted, announced `BACKEND_READY`, served `/api/health`, and shut down cleanly on SIGTERM (bootloader forwards it to the Python child - the mechanism the Unix exit handler relies on). **Not yet exercised:** the `tauri build` bundling step on Linux (webkit2gtk compile + AppImage tooling) - that needs the workflow's first manual dispatch. If the sidecar ever exits at boot on a new platform, check the freeze step's `warn-ifc-backend.txt` for missing hidden imports.

### Recommendation

Ship **Windows now** (built and verified end-to-end) and **Linux via the workflow** once its first run is green. Treat **macOS as demand-driven**: the build itself is small work now, but unsigned mac apps are genuinely painful for end users (Gatekeeper), doing it properly costs the Apple Developer fee, and without mac hardware you can't debug what CI can't catch.

---

## 7. Verification gates

Run from the repo root. `npm run verify` covers every check CI runs on a pull request, plus the sidecar typecheck and docs gates; CI additionally runs the full backend pytest suite on Linux.

```powershell
npm run verify                  # everything below, in order
npm run verify:backend          # fast pytest subset + import smoke
npm run verify:frontend         # tsc + vitest
npm run verify:sidecar          # Node sidecar typecheck
npm run verify:docs             # generated-doc drift + strict mkdocs
```

Quality bars that apply to every change: load `BasicHouse.ifc` successfully, no TTFR/FPS regressions, WebGL baseline never breaks. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 8. Troubleshooting the desktop build

| Symptom | Cause | Fix |
|---|---|---|
| `cannot find binaries/ifc-backend` during `tauri build` | Sidecar never built | Run `scripts\build_sidecar.ps1` first |
| Frozen exe exits instantly, no `BACKEND_READY` | Missing hidden import in `backend/ifc-backend.spec` | Check `backend\build\ifc-backend\warn-ifc-backend.txt`; the `app.main` + `collect_submodules("app")` lines in the spec are load-bearing - don't remove them |
| Splash never clears in the installed app | Sidecar crashed before announcing | Run `src-tauri\binaries\ifc-backend-*.exe --host 127.0.0.1 --port 8000` directly in a terminal and read the traceback |
| `error: linker 'link.exe' not found` | MSVC Build Tools missing | Install per the prerequisites table |
| Port 8000 already in use | Another backend instance | Nothing to do - the sidecar auto-falls-back to a free port and announces it |
| Installer huge / build slow | Stale PyInstaller cache | `Remove-Item -Recurse backend\build, backend\dist`, rebuild |
| `src-tauri/target/` eats gigabytes | Normal cargo behaviour | Safe to delete; next build recompiles |

---

## 9. Key files for the desktop packaging

| File | Role |
|---|---|
| `src-tauri/tauri.conf.json` | Product name, window, `externalBin`, build hooks |
| `src-tauri/src/lib.rs` | Spawns the sidecar, port-announce handshake, kill-on-exit |
| `src-tauri/capabilities/default.json` | Permission to spawn the sidecar, dialogs, fs |
| `backend/ifc-backend.spec` | PyInstaller recipe (hidden imports, excludes) |
| `backend/run.py` | Port resolution + `BACKEND_READY` announce + frozen-sandbox re-entry |
| `scripts/build_sidecar.ps1` | Freezes the backend and stages it with the target-triple name |
| `frontend/src/lib/platform.ts` | `apiUrl()`/`wsUrl()` - desktop-aware backend addressing |
| `frontend/src/components/BackendGate.tsx` | Desktop splash that waits for backend readiness |

Architecture contract and deeper rationale: [`docs/architecture/TAURI.md`](architecture/TAURI.md) · Hands-on guide: [`docs/user/RUNNING_TAURI.md`](user/RUNNING_TAURI.md).
