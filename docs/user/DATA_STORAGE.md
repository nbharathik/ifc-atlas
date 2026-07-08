# Where IFC Atlas stores your data

The installed app keeps all of its writable state (uploads, viewpoints, custom agents, prompts, edit history, parsed geometry cache, and provider secrets) in a single per-user folder. The install directory (`Program Files`, `/Applications`, `/usr/local`) stays read-only.

## Folder locations

| Platform | Path |
|---|---|
| Windows | `C:\Users\<you>\.ifc-atlas\` |
| macOS | `~/.ifc-atlas/` |
| Linux | `~/.ifc-atlas/` |

Override with the `IFC_ATLAS_HOME` environment variable (absolute path) to relocate everything, for example to a drive with more free space. The legacy `IFC_VIEWER_HOME` variable is still honoured for backward compatibility. If a `~/.ifc-viewer/` folder from an older release exists, it is auto-migrated into `~/.ifc-atlas/` on first launch.

## What lives where

```
~/.ifc-atlas/
├── .env                      ← API keys, IFC_VIEWER_CACHE_MAX_BYTES, etc.
├── secrets.json              ← AI provider keys configured from the UI
├── mcp_servers.json          ← external MCP server registry (optional)
├── uploads/                  ← every IFC you upload (re-uploadable, safe to flush)
├── fragments/                ← server-converted fragment binaries ({sha}-{profile}.frag)
├── snapshots/                ← viewpoint snapshot thumbnails
├── ids/                      ← saved IDS specification library
├── bcf/                      ← BCF topics per model (+ snapshots/ for topic images)
├── plugins/                  ← your installed plugins (manifest.json + script.py each)
├── ifc_history/              ← edit-history git repo (one commit per applied edit)
└── data/
    ├── custom_agents.json    ← your custom chat agents
    ├── models.json           ← the editable LLM model catalogue
    ├── system_prompts.json   ← saved system prompts
    ├── snippets.json         ← user-message templates
    ├── tool_sets.json        ← reusable tool bundles
    ├── tool_settings.json    ← per-tool enable/disable state
    ├── budget_state.json     ← per-agent monthly spend tracker
    ├── ifc-index/            ← native metadata index ({sha256}.json per IFC)
    ├── aabb-cache/           ← bounding-box cache (one JSON per IFC)
    └── doc_index/            ← document-index store (BM25 + optional semantic)
```

Frontend-side state (theme, viewpoints, chat thread id, performance log, panel sizes) lives in the **browser's** localStorage and IndexedDB. In the Tauri desktop app these are scoped to a per-user webview profile, so they are isolated to your user account.

---

## Settings → Storage → User data folder

Open Settings (`Ctrl+,`) → **Storage**. The **User data folder** card shows:

- the resolved base path with a **Copy** button (paste into Explorer / Finder / Nautilus to open it),
- per-scope sizes for `uploads`, `snapshots`, `data`, `checkpoints`, `fragments`,
- a **Flush** button next to each scope,
- a **Clear all caches** button,
- a slider to set the **uploads cap** (0.25 GB to 20 GB),
- an **Apply cap** button that prunes the oldest files until the folder fits under the cap.

The slider is a runtime override: the change applies immediately but does not survive a restart. To persist it, add `IFC_VIEWER_CACHE_MAX_BYTES=<bytes>` to `~/.ifc-atlas/.env`.

---

## Safe vs destructive flushes

| Scope | Effect | Safety |
|---|---|---|
| `uploads` | Deletes uploaded IFC files. | **Safe**: re-upload to recover. |
| `snapshots` | Deletes viewpoint thumbnails. | **Safe**: regenerated lazily. |
| `data` | Deletes parsed indices, custom agents, snippets, prompts, budget state. | **Destructive**: custom agents and prompts are lost. |
| `checkpoints` | Deletes the IFC edit-history git repo. | **Destructive**: undo history is lost. |
| `fragments` | Deletes converted-fragment binaries. | **Safe**: the next load re-converts. |
| `all` | Every scope above. | **Destructive**: removes everything above. |

---

## Dev mode

The per-user dotfolder is the default everywhere: desktop bundle, dev runs, and `python run.py` from the repo. The backend never writes inside the repo. To relocate the folder for a single run, set `IFC_ATLAS_HOME` before launching:

```powershell
$env:IFC_ATLAS_HOME = "D:\ifc-atlas-data"
python run.py
```

---

## Uninstalling

Removing the installer does **not** delete `~/.ifc-atlas/`. If you want a fully clean uninstall, delete that folder by hand after uninstalling the app.
