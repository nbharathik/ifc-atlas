# IFC Atlas User Documentation

**An open-source IFC / BIM viewer with a built-in multi-LLM agent.** Load a model, ask questions in plain English, and get answers grounded in real model data through structured tool calls.

> The published site lives at [`nbharathik.github.io/ifc-atlas/docs/`](https://nbharathik.github.io/ifc-atlas/docs/). This page is the in-repo index for the same content.

---

## What it does

- **Viewer.** Three.js with `@thatopen/components`. Backend pre-converts IFC files to fragments; browser `web-ifc` parsing is the fallback. Section planes, linear / polygon / angle measurements, classification browser, multi-select aggregates, snap-to-vertex, screen-space measurement labels, share links.
- **AI Chat.** Streaming WebSocket chat against OpenAI, Anthropic, or OpenRouter. A UI-configurable model catalogue, per-agent tool allowlists, prompt snippets, forkable system prompts, and a Document Index for PDF / Markdown context.
- **Model editing (experimental, disabled by default).** Write tools run inside a sandboxed IfcOpenShell copy with a before-and-after diff and Apply / Discard approval. The capability ships disabled in this release behind the `EDIT_MODE_ENABLED` flag.
- **Integrations.** Full buildingSMART IDS 1.0 validation through `ifctester`. MCP client (consume external tools) and MCP server (expose the viewer toolset to Claude Desktop, Cursor, etc.).
- **Distribution.** Self-host with Docker + Caddy, publish a viewer-only build to GitHub Pages, or package a Tauri 2 desktop app.

---

## Quick start

### Web (full stack)

```bash
git clone https://github.com/nbharathik/ifc-atlas.git
cd ifc-atlas

# Backend
cd backend
pip install -r requirements.txt
python run.py              # http://localhost:8000
# Add provider keys via the in-app AI Keys modal on first launch,
# or set OPENAI_API_KEY / ANTHROPIC_API_KEY in your shell or ~/.ifc-atlas/.env

# Frontend (separate terminal)
cd frontend
npm install
npm run dev                # http://localhost:5173
```

Open <http://localhost:5173>, drag in an `.ifc` file, ask a question. See [`KEYBOARD_SHORTCUTS.md`](KEYBOARD_SHORTCUTS.md) for the key reference.

### Public demo

Browser-only viewer with no backend and no AI chat. Good for sharing a model URL. See [Deploy Your Own → GitHub Pages](DEPLOY_YOUR_OWN.md#4-github-pages-viewer-only).

### Desktop app

Tauri 2 bundles for Windows and Linux (macOS packaging is planned but not shipped yet). See [Running Tauri](RUNNING_TAURI.md) for the local build and current packaging caveats.

---

## Docs index

| Topic | File |
|---|---|
| First run, first model load, first AI query | [Getting Started](GETTING_STARTED.md) |
| Every shipped feature, grouped by area | [Features](FEATURES.md) |
| Full keyboard shortcut reference | [Keyboard Shortcuts](KEYBOARD_SHORTCUTS.md) |
| Built-in agents and example prompts | [AI Agent Guide](AI_AGENT_GUIDE.md) |
| Headless CLI: checks, takeoffs, viewer control, MCP | [Command Line](CLI.md) |
| Where the installed app keeps your data | [Data Storage](DATA_STORAGE.md) |
| Diagnose load, chat, edit, or performance issues | [Troubleshooting](TROUBLESHOOTING.md) |
| Self-host with Docker, Caddy, GitHub Pages, Tauri | [Deploy Your Own](DEPLOY_YOUR_OWN.md) |
| Build the Tauri desktop app | [Running Tauri](RUNNING_TAURI.md) |

---

## Architecture and contributor docs

System-design notes live under [`docs/architecture/`](../architecture/), including the load-bearing invariants summary in `OVERVIEW.md`. They are tracked in the repo for contributors and are not part of the published user site.

## License

MPL 2.0. See [`LICENSE`](https://github.com/nbharathik/ifc-atlas/blob/master/LICENSE).
