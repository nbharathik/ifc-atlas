# Deploy Your Own

Five supported deployment modes. Pick the one that matches your constraints.

---

## 1. Docker Compose for local validation

```bash
# Set OPENAI_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY in your shell
# (or in ~/.ifc-atlas/.env) first
docker compose up --build
```

Frontend on port 5173, backend on port 8000. This compose file runs the Vite development server and is useful for local validation. For day-to-day development you can also run the backend and frontend directly; see [Getting Started](GETTING_STARTED.md).

---

## 2. Production Docker Compose with Caddy

Build the frontend first, then start the production compose file:

```bash
cd frontend
npm ci
npm run build
cd ..

DOMAIN=your.domain docker compose -f docker-compose.prod.yml up -d --build
```

Caddy serves the built frontend on ports 80/443 and proxies API and WebSocket traffic to the backend container.

---

## 3. Production with Caddy and a separate backend

```
Browser → Caddy (static + WS proxy) → uvicorn (FastAPI)
```

Minimal Caddyfile:

```caddy
your.domain {
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "credentialless"
    }
    @ws {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    reverse_proxy @ws localhost:8000
    reverse_proxy /api/* localhost:8000
    reverse_proxy /mcp/* localhost:8000

    root * /var/www/viewer/dist
    file_server
    encode gzip zstd

    @wasm path *.wasm
    header @wasm Content-Type "application/wasm"
}
```

### Backend environment variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI provider key. |
| `ANTHROPIC_API_KEY` | Anthropic provider key. |
| `OPENROUTER_API_KEY` | OpenRouter provider key. |
| `UPLOAD_DIR` | Where the backend writes uploaded IFC files. |
| `SNAPSHOT_DIR` | Where viewpoint thumbnails are written. |
| `FRONTEND_URL` | Origin allowed in CORS responses. |
| `IFC_VIEWER_MAX_UPLOAD_BYTES` | Max upload size in bytes (default 512 MB). |
| `IFC_ATLAS_HOME` | Override the per-user data folder (absolute path). |
| `MCP_SERVER_TOKEN` | Bearer token required on `/mcp/*` (leave unset to disable auth). |
| `MCP_ALLOW_WRITES` | Set `1` to expose the write tier over MCP. |

### Frontend build-time environment variables

| Variable | Purpose |
|---|---|
| `VITE_PUBLIC_DEMO` | `true` builds the viewer-only public demo (chat and edit are stripped). |
| `VITE_PLATFORM` | `web` (default) or `tauri`. |

The web build always calls `/api` on its own origin; the reverse proxy in
front of it (section 3) routes that to the backend, so there is no
backend-URL build variable to set.

---

## 4. GitHub Pages (viewer only)

The easiest public sharing mode. Chat and Edit are disabled; viewer, measurement, classification, aggregate inspection, and share-link URLs all work.

There is no official hosted demo; publish your own viewer-only build to GitHub Pages.

To publish a fork (GitHub Pages serves project sites under `/<repo>/`, so
the build needs a matching `--base` or every asset URL 404s):

```bash
cd frontend
VITE_PUBLIC_DEMO=true npx vite build --base=/<your-repo>/
npx gh-pages -d dist -b gh-pages
```

---

## 5. Tauri desktop build

Builds a native binary per OS. Bundles the Python backend as a PyInstaller-frozen sidecar so end users install one file and never see Python or Node. Currently produced as an unsigned preview installer; code signing and auto-update are planned for a future release.

```powershell
# Build the frozen backend
powershell -File scripts\build_sidecar.ps1

# Build the Tauri installer
npm run tauri:build
```

Artefacts land in `src-tauri/target/release/bundle/{msi,nsis}/`.

Toolchain prerequisites:

- **Windows.** MSVC build tools (`Microsoft.VisualStudio.2022.BuildTools` with the C++ workload), WebView2 runtime.
- **macOS.** Xcode command-line tools.
- **Linux.** `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`.

See [Running Tauri locally](RUNNING_TAURI.md) for step-by-step instructions and the current packaging caveats.
