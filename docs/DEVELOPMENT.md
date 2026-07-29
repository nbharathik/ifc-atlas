# IFC Atlas - Development Guide

How to develop and run IFC Atlas locally. Desktop packaging has its own pages:
[Running Tauri](user/RUNNING_TAURI.md) (hands-on build) and
[TAURI.md](architecture/TAURI.md) (design contract).

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
- The sidecar binary must exist at `src-tauri/binaries/ifc-backend-x86_64-pc-windows-msvc.exe`. If it doesn't, build it once (see below); the shell logs a clear error if it's missing.
- Frontend hot reload works; Rust changes need a restart of `npm run tauri:dev`.

---

## 5. Mode C - Desktop installer, other platforms, troubleshooting

The desktop build is documented once, in two canonical pages:

- **[Running Tauri](user/RUNNING_TAURI.md)**: prerequisites, the two build
  steps (`scripts\build_sidecar.ps1`, then `npm run tauri:build`), installer
  output paths, where the installed app stores data, known packaging gaps,
  and troubleshooting for the common failures (`link.exe` not found, missing
  sidecar binary, blank window, port conflicts).
- **[TAURI.md](architecture/TAURI.md)**: the design contract - sidecar
  lifecycle and port-announce handshake, per-user data folder, capabilities,
  build pipeline, auto-update status, and the key `src-tauri/` files.

Two rules worth repeating here because they bite:

> **Always re-run the sidecar freeze after backend changes.** `tauri build` bundles whatever binary is sitting in `src-tauri/binaries/` - a stale sidecar means the installer ships old backend code with no warning.

> **You cannot build mac/Linux installers from a Windows machine.** Neither Tauri nor PyInstaller cross-compiles; every platform freezes its own sidecar and bundles natively. Non-Windows installers build on CI: [`.github/workflows/desktop-build.yml`](https://github.com/nbharathik/ifc-atlas/blob/main/.github/workflows/desktop-build.yml) (manual dispatch or a `v*` tag; Windows + Ubuntu enabled, macOS deferred pending signing).

---

## 6. Verification gates

Run from the repo root. `npm run verify` covers every check CI runs on a pull request, plus the sidecar typecheck and docs gates; CI additionally runs the full backend pytest suite on Linux.

```powershell
npm run verify                  # everything below, in order
npm run verify:backend          # fast pytest subset + import smoke
npm run verify:frontend         # tsc + vitest
npm run verify:sidecar          # Node sidecar typecheck
npm run verify:docs             # generated-doc drift + strict mkdocs
```

Quality bars that apply to every change: load `BasicHouse.ifc` successfully, no TTFR/FPS regressions, WebGL baseline never breaks. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
