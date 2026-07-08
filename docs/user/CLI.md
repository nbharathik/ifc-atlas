# Command line

IFC Atlas ships a headless CLI alongside the backend. There is nothing extra to install: if the backend runs, the CLI runs. Use it to inspect models, validate IDS specifications in scripts and CI, export quantity takeoffs, diff two files, drive a running viewer, and connect external LLM clients over MCP.

## Running it

From a clone, run the module from `backend/` with the same Python environment (venv) the backend uses:

```bash
cd backend
pip install -r requirements.txt   # once - the backend's own setup
python -m app.cli --help
```

When the backend package is pip-installed (`pip install .` from `backend/`), the `ifc-atlas` command lands on your `PATH` and is equivalent to `python -m app.cli`.

Every command supports `--help`. Exit codes follow one scheme throughout: `0` success, `1` domain failure (failed IDS specifications, no viewer connected or no answer), `2` usage or environment errors.

---

## Subcommands

### `info`

Summarise an IFC file: schema, project name, element counts by type, and storeys with elevations. Add `--json` for machine-readable output.

```bash
python -m app.cli info BasicHouse.ifc
```

### `validate`

Validate an IFC file against a buildingSMART IDS specification. The report lists each specification with `[PASS]` / `[FAIL]` / `[N/A ]` markers and its failing elements. `--csv OUT` writes all failures as CSV, `--json OUT` writes the full report, and `--limit-per-spec N` caps the failing elements listed per specification (default 25).

```bash
python -m app.cli validate BasicHouse.ifc --ids checks.ids --csv failures.csv
```

The exit code makes it CI-friendly: `0` when every specification passed (or had no applicable elements), `1` when any specification failed, `2` for usage or file errors.

### `qto`

Quantity takeoff: element counts plus summed volume, area, and length per group, from each element's `IfcElementQuantity` sets scaled by the project's declared units. `--group-by` takes a comma-separated list of `ifc_class`, `storey`, `material`, `type_object`, `classification` (default `ifc_class`). `--csv OUT` writes the table as CSV, `--json` prints the full result, and `--include-ids` attaches element ids per group to the JSON.

```bash
python -m app.cli qto BasicHouse.ifc --group-by ifc_class,storey --csv takeoff.csv
```

A `-` cell in the table means no quantity data exists for that group.

### `diff`

Structural diff between two IFC files, matched on express id: created, deleted, renamed, retyped, and property-changed elements. `--json OUT` writes the change list as JSON. Differences are reported, not treated as a failure - the exit code is `0` either way.

```bash
python -m app.cli diff before.ifc after.ifc --json changes.json
```

### `viewer`

Drive the browser viewer of a **running** IFC Atlas app. These commands need the app open with a model loaded; they talk to the backend (default `http://127.0.0.1:8000`, override with `--url`), which relays each command to the connected viewer. When the backend reports that no viewer is connected or the viewer did not answer, the exit code is `1`; an unreachable backend exits `2`.

| Action | Example |
|---|---|
| `state` | `python -m app.cli viewer state` - the last state the viewer reported (camera, selection, isolation, loaded model). |
| `select` / `isolate` / `highlight` | `python -m app.cli viewer isolate --ids "12,45,103"` - act on elements by express id. |
| `show-all` | `python -m app.cli viewer show-all` - clear isolation and show everything. |
| `camera` | `python -m app.cli viewer camera --preset iso` - one of `front`, `back`, `left`, `right`, `top`, `iso`, `fit`. |
| `zoom` | `python -m app.cli viewer zoom --id 42` - frame a single element. |
| `snapshot` | `python -m app.cli viewer snapshot --out view.jpg` - capture the live viewport as an image (`--timeout` seconds to wait, default 6). |

### `serve`

Run the backend API server on a fixed host and port (the desktop app manages its own port; this is the simple path for development and self-hosting).

```bash
python -m app.cli serve --host 127.0.0.1 --port 8000
```

### `mcp`

Run the Model Context Protocol server over stdio for external LLM clients such as Claude Desktop. `--model PATH` loads an IFC file before starting so clients see a loaded model; `--allow-writes` exposes the write tools (equivalent to setting `MCP_ALLOW_WRITES=1`). stdout carries the MCP protocol; status messages go to stderr.

```bash
python -m app.cli mcp --model path/to/model.ifc
```

---

## Connect an LLM via MCP

### Claude Desktop (stdio)

Add an entry to Claude Desktop's `claude_desktop_config.json` that launches the stdio server with a preloaded model:

```json
{
  "mcpServers": {
    "ifc-atlas": {
      "command": "python",
      "args": ["-m", "app.cli", "mcp", "--model", "path/to/model.ifc"],
      "env": {
        "PYTHONPATH": "path/to/ifc-atlas/backend"
      }
    }
  }
}
```

`python -m app.cli` must be able to import the `app` package: either keep the `PYTHONPATH` entry pointing at your `backend/` folder as above, or pip-install the backend and use `"command": "ifc-atlas"` with `"args": ["mcp", "--model", "path/to/model.ifc"]` instead.

### A running app (SSE)

Every running IFC Atlas backend also serves MCP at `/mcp` (SSE endpoint `/mcp/sse`, e.g. `http://127.0.0.1:8000/mcp/sse`) - no separate process needed. Point any SSE-capable MCP client at it. Set `MCP_SERVER_TOKEN` to require bearer-token auth.

This is the endpoint to use for viewer control: the seven viewer tools (`get_viewer_state`, `viewer_select_elements`, `viewer_isolate_elements`, `viewer_highlight_elements`, `viewer_show_all`, `viewer_set_camera`, `get_viewer_snapshot`) reach the browser viewer connected to that same backend, so an MCP client can see what you see (including live viewport screenshots) and drive the view. The stdio server is a separate process with no browser attached - use it for file analysis via `--model`.

### Write tools

Read, validate, and viewer tools are always exposed. The write tier (rename, property updates, wall creation, deletion, scripted edits) only appears with `--allow-writes` on the `mcp` subcommand or `MCP_ALLOW_WRITES=1` in the backend's environment, and every external write goes through the same diff-preview approval as in-app edits.

---

## See also

- [Features](FEATURES.md): the in-app counterparts (takeoff, IDS, BCF, plugins panels).
- [Deploy Your Own](DEPLOY_YOUR_OWN.md): running the backend as a service.
- [Data Storage](DATA_STORAGE.md): where the backend keeps its files.
