# Getting Started

This takes about five minutes if you already have Python 3.11 or 3.12 and Node 20 or newer installed.

!!! tip "No setup at all: the desktop app"
    Prebuilt installers bundle the viewer, the AI agent, and the backend into one file, no Python or Node needed. Grab the one for your OS from the [latest release](https://github.com/nbharathik/ifc-atlas/releases/latest):

    - **Windows** (10 / 11, x64): [Installer (.exe)](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-Setup-x64.exe) or [.msi](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x64.msi)
    - **Linux** (x86_64): [.AppImage](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x86_64.AppImage), [.deb](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-amd64.deb), or [.rpm](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x86_64.rpm)
    - **macOS**: not packaged yet, follow the from-source steps below.

    Install, launch **IFC Atlas**, set an AI key when prompted (or skip it, the viewer works without one), and jump straight to [step 2](#2-load-your-first-model). Details in [Running the Tauri desktop build](RUNNING_TAURI.md).

## 1. Install

```bash
git clone https://github.com/nbharathik/ifc-atlas.git
cd ifc-atlas
```

### Backend

```bash
cd backend
pip install -r requirements.txt
```

Add at least one AI provider key. The easiest route is the **AI Keys** modal that appears on first launch (also reachable later under Chat Manager → **Settings**); keys configured in-app persist to `~/.ifc-atlas/secrets.json`.

Alternatively, set environment variables in your shell or in `~/.ifc-atlas/.env` (the backend never reads a `.env` file from the repo; an environment variable overrides a key stored in `secrets.json`):

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...   # optional
```

Start the backend:

```bash
python run.py        # http://localhost:8000
```

### Frontend (in a second terminal)

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Open <http://localhost:5173> in Chrome or Edge.

---

## 2. Load your first model

1. Drag any `.ifc` file onto the upload zone (or click the **Upload IFC** button).
2. The file uploads to the backend, gets converted to optimised fragment binaries, and streams back to the viewer. Time-to-first-render is roughly 1-3 seconds for a 50 MB house; larger models take proportionally longer.
3. Click any element to see its properties in the right-hand panel.

A sample model lives at `data/fixtures/BasicHouse.ifc` (≈ 50 MB, two storeys, 149 elements). If it is not present in your clone, download it with `scripts/fetch-sample.ps1` (Windows) or `scripts/fetch-sample.sh` (macOS / Linux); the script pulls it from the GitHub release assets. Drag it in to try the app without supplying your own data.

---

## 3. Your first AI query

Open the chat panel from the right sidebar (or press `Ctrl+/`). Chat runs in **Ask** mode: read-only questions about the loaded model. Try:

- *"How many walls are in this model?"*
- *"List every storey and its elevation."*
- *"Highlight all IfcDoor instances."*
- *"Isolate the first storey and fit the camera."*

The agent calls structured tools (`get_model_stats`, `search_elements`, `highlight_elements`, and others) and streams the answer back. Every tool call shows up in the per-message tool-call log so you can audit exactly what ran.

You can tailor the agent's behaviour from the Chat Manager (`Ctrl+Shift+M`): pick a model on the **Models** tab, or activate a specialised system prompt on the **Skills** tab. See the [AI Agent Guide](AI_AGENT_GUIDE.md) for details.

!!! note "Editing and read-only deployments"
    Editing is available by default in the desktop workspace. Ask mode remains read-only. In Edit mode, AI writes are staged through a sandboxed preview with Apply / Discard controls. Administrators can set `EDIT_MODE_ENABLED=0` to hide editing and hard-block write tools.

---

## 4. Next steps

- [Features](FEATURES.md): every shipped feature, grouped by area.
- [Keyboard Shortcuts](KEYBOARD_SHORTCUTS.md): full key reference.
- [AI Agent Guide](AI_AGENT_GUIDE.md): built-in agents and example prompts.
- [Troubleshooting](TROUBLESHOOTING.md): COOP/COEP, WASM, large models, chat reconnects.
- [Deploy Your Own](DEPLOY_YOUR_OWN.md): Docker, Caddy, GitHub Pages.
- [Running the Tauri desktop build](RUNNING_TAURI.md): native packaging.
