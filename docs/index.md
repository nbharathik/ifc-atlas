# ![IFC Atlas](assets/brand/wordmark-dark.svg#only-dark){ width="300" }![IFC Atlas](assets/brand/wordmark-light.svg#only-light){ width="300" }

**An AI-assisted IFC workspace for exploring, understanding, validating, and editing BIM models.**

Explore building models in 3D and ask questions in plain English. Every answer is grounded in real model data via structured tool calls, not guesswork.

<div style="display: flex; gap: 1rem; flex-wrap: wrap; margin: 2rem 0;">
  <a href="https://github.com/nbharathik/ifc-atlas/releases/latest" class="md-button md-button--primary" style="padding: 0.75rem 1.5rem; font-weight: 600;">Download for Windows / Linux →</a>
  <a href="user/GETTING_STARTED/" class="md-button" style="padding: 0.75rem 1.5rem; font-weight: 600;">Get started in 5 minutes →</a>
  <a href="user/FEATURES/" class="md-button" style="padding: 0.75rem 1.5rem; font-weight: 600;">See every feature →</a>
</div>

The desktop installers bundle the viewer, the AI agent, and the backend into a single file (Windows `.exe` / `.msi`, Linux `.AppImage` / `.deb` / `.rpm`). No Python or Node required; see [Getting Started](user/GETTING_STARTED.md) for the direct links.

---

## What it is

- **3D viewer.** Three.js with `@thatopen/components` rendering. Selection, isolate / hide / ghost mode, section planes, measurements (linear / polygon / angle), classification browser, screenshots, saved viewpoints, share links.
- **AI Chat.** Streaming WebSocket chat against OpenAI, Anthropic, or OpenRouter. A UI-configurable model catalogue, per-agent tool allowlists, cost telemetry, and a per-agent monthly budget cap.
- **Native IFC editing.** Editing is available by default in the desktop workspace. Human semantic edits are validated and undoable; AI writes run inside a sandboxed IfcOpenShell copy with an inline Apply / Discard preview. Set `EDIT_MODE_ENABLED=0` for a read-only deployment.
- **Integrations.** Full buildingSMART IDS 1.0 validation, MCP client and server (Claude Desktop / Cursor compatible), Tauri 2 desktop shell.

---

## How the docs are organised

| Section | Best for |
|---|---|
| [Getting Started](user/GETTING_STARTED.md) | First-time setup, first model, first AI query. |
| [Features](user/FEATURES.md) | Every shipped feature, grouped by area. |
| [Practical workflows](user/USE_CASES.md) | BIM use cases and ready-to-run example prompts. |
| [Known limitations](user/KNOWN_LIMITATIONS.md) | Supported IFC scope, editing constraints, and platform caveats. |
| [Keyboard Shortcuts](user/KEYBOARD_SHORTCUTS.md) | Full key reference. |
| [AI Agent Guide](user/AI_AGENT_GUIDE.md) | Built-in agents, example prompts, tool routing. |
| [API Reference](api/index.md) | REST + WebSocket protocol, generated from the live FastAPI app. |
| [Tools Reference](agent/TOOLS_REFERENCE.md) | Every agent tool, generated from the tool registry. |
| [Self-hosting](user/DEPLOY_YOUR_OWN.md) | Docker, Caddy, GitHub Pages, Tauri builds. |
| [Troubleshooting](user/TROUBLESHOOTING.md) | COOP/COEP, WASM, large models, chat reconnects. |

---

## Repository

Source code, issue tracker, and releases live at [github.com/nbharathik/ifc-atlas](https://github.com/nbharathik/ifc-atlas). Licensed under [MPL 2.0](https://github.com/nbharathik/ifc-atlas/blob/main/LICENSE).
