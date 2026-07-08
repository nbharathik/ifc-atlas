# Troubleshooting

A reference of the issues most users hit and how to fix them. Open a [GitHub issue](https://github.com/nbharathik/ifc-atlas/issues) if your problem isn't listed.

---

## Viewer fails to load a model

### "Failed to load WASM" in the browser console

Multi-threaded `web-ifc` refuses to spawn when `crossOriginIsolated` is `false`. The fix is to send the COOP and COEP headers:

- **Dev server.** Already configured in [`frontend/vite.config.ts`](https://github.com/nbharathik/ifc-atlas/blob/main/frontend/vite.config.ts). If you proxy through nginx, Caddy, or Cloudflare, mirror the headers:

  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  ```

- **Production.** Mirror the same headers in your reverse proxy. See [Deploy Your Own](DEPLOY_YOUR_OWN.md) for full self-hosting examples.

### "pako.inflate ... invalid block type"

Something has enabled `IfcLoader.processData.raw = true`. Leave that flag off; the fragments pipeline expects compressed input.

### The viewer hangs on a very large model

The backend server-convert path is the default cold-load route. The backend produces fragment binaries and streams them to the browser, avoiding the in-browser WASM parse for big files. If the viewer still hangs on models above ~200 MB:

- Confirm the backend is running. The activity log entry should read **"Server convert chosen as default cold-load path."** If it does not, the viewer fell back to in-browser parsing.
- Increase the browser tab memory budget. On Chrome: `--js-flags="--max-old-space-size=8192"`.
- Split the file in IfcOpenShell before loading.

---

## Chat

### "Agent returned no tool calls"

The model decided no tool was needed. Refine the prompt with a specific IFC type (`IfcWall`), property (`FireRating`), or an explicit count request. Generic questions are answered from chat memory alone without any tool calls.

### "tool_not_allowed: rename_element"

You asked for a write operation. Model editing is an experimental capability that ships disabled in this release, so the backend rejects every write tool at the API layer. The agent should describe the change it would make instead of applying it.

### WebSocket reconnects constantly

Confirm `backend/run.py` is running and at least one provider key is configured. If the connection succeeds but closes after about 30 seconds, your reverse proxy is timing it out. Caddy's default is generous; on nginx set `proxy_read_timeout` to a high value.

### Chat shows "no provider configured"

Add a key under Chat Manager → **Settings** (persists to `~/.ifc-atlas/secrets.json`), or set the matching variable in your shell or `~/.ifc-atlas/.env` and restart the backend. Supported variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. An environment variable overrides a stored key.

---

## Edit and Diff Preview

These issues only apply when writes are enabled (the experimental edit mode, or MCP writes via `MCP_ALLOW_WRITES=1`); both are off by default in this release.

### Diff Preview shows "no changes"

The sandboxed tool call succeeded but the before/after hash is identical, usually because the tool ran against the wrong element. Open the tool-call log to confirm the arguments.

### Apply fails with "sandbox stale"

Another edit landed on the live model between the preview and your Apply click, so the sandbox's source hash no longer matches. Close the panel and re-run the prompt. The agent will produce a fresh diff against the current state.

### Undo says "nothing to undo"

The inverse-delta stack is empty. Either the last action wasn't a committed edit, or you've already undone everything in this session. The Checkpoints panel (`Shift+H`) provides longer-term rollback through git snapshots.

---

## Backend

### `ModuleNotFoundError: ifcopenshell`

```bash
cd backend
pip install -r requirements.txt
```

If pip can't find a wheel, confirm you are on Python 3.11 or 3.12. `ifcopenshell` ships wheels for Python 3.9-3.12 on PyPI; Python 3.13 is not yet supported.

### Port 8000 in use

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
# then export VITE_BACKEND_URL=http://localhost:8001 before npm run dev
```

### Backend tests SIGSEGV on Windows + Python 3.13

Known issue with IfcOpenShell on Python 3.13. Use Python 3.12, or run the fast subset:

```bash
pytest -m "not requires_ifc_load and not subprocess_sandbox"
```

---

## Desktop (Tauri)

### "Sidecar python failed to spawn"

The backend sidecar is bundled at `src-tauri/binaries/`. If it is missing, rebuild it:

```powershell
powershell -File scripts\build_sidecar.ps1
npm run tauri:build
```

On macOS the signed sidecar may be quarantined; clear it with `xattr -d com.apple.quarantine <path>`.

### Tauri window opens but the page is blank

The Vite dev server didn't come up. Check the Tauri CLI output for a `beforeDevCommand` failure (port 5173 conflict, missing frontend deps, etc). Run `cd frontend && npm run dev` separately to debug.

---

## Performance

### TTFR feels slow

- Open the Performance HUD (`M`) and the Performance Dashboard (`Shift+M`) to confirm the load source. If the entry colour is **live parse**, the server-convert path is not being used.
- Check Settings → Storage → User data folder: the **uploads** and **data** scopes should show non-zero sizes. An empty `aabb-cache` means the bounding-box warm-up never ran.
- Hover the chip below an assistant message: an Anthropic `⚡N%` badge confirms the prompt cache is hitting.

### IndexedDB fragment cache is full

Settings → Storage shows live cache size and entry count. The cache is LRU-evicted at 500 MB. You can also flush it from the **User data folder** card.

---

Still stuck? Open a GitHub issue with the browser console output and the `backend/run.py` log. A clear reproduction usually lands a fix quickly.
