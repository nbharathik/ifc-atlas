<h1 align="center">IFC Atlas</h1>

<p align="center">
  <strong>Open-source, AI-native BIM platform: view, inspect, and edit native IFC models - with an AI assistant, git-like history, and an MCP server.</strong><br>
</p>

<p align="center">
  <img alt="IFC Atlas with a sample house model loaded: the model tree on the left, the 3D viewport in the center, and the AI agent summarizing the model on the right." src="docs/assets/viewer.png" width="900">
</p>

## Features

- **3D viewer.** Selection, isolate / hide, section planes, measurements, camera presets, saved viewpoints, share links.
- **Inspector.** Properties, quantities, model tree, search, command palette (`Ctrl+K`).
- **Native IFC editing.** Create projects from templates, edit properties inline, draw walls, create slabs and storeys, delete elements - every change is a logged, undoable IfcOpenShell operation on the IFC file itself, saved with stable IDs. ([guide](docs/user/EDITING.md))
- **AI chat + AI editing.** Multi-provider (OpenAI, Anthropic, OpenRouter) with structured tool calls that act on the 3D view; AI edits are sandboxed, diff-previewed, and health-verified before you apply them.
- **History.** Automatic git checkpoints per change, an actor-attributed timeline (you / AI / MCP), semantic compare via ifcdiff, undo/redo, rollback.
- **Integrations.** buildingSMART IDS 1.0 validation, bSDD + IfcOpenShell docs as AI knowledge tools, MCP client registry, and a built-in MCP server through which external agents (e.g. Claude Desktop) can read and edit models.
- **Deployment.** Desktop app, Docker self-hosting, or a browser-only demo.

Full feature catalogue and shortcuts: [`docs/user/FEATURES.md`](docs/user/FEATURES.md).
Practical workflows and example prompts: [`docs/user/USE_CASES.md`](docs/user/USE_CASES.md).

## Download

| OS | Download |
|---|---|
| **Windows** (10 / 11, x64) | [Installer (.exe)](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-Setup-x64.exe) / [.msi](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x64.msi) |
| **Linux** (x86_64) | [.AppImage](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x86_64.AppImage) / [.deb](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-amd64.deb) / [.rpm](https://github.com/nbharathik/ifc-atlas/releases/latest/download/IFC-Atlas-x86_64.rpm) |
| **macOS** | Not packaged yet; run from source below. |

Launch the app, add an AI provider key when prompted (optional; the viewer works without one), and drag in an `.ifc` file.

## Quick start (from source)

Requires Python 3.11 or 3.12 and Node.js 20+. Chat features need an API key from OpenAI, Anthropic, or OpenRouter.

```bash
git clone https://github.com/nbharathik/ifc-atlas.git
cd ifc-atlas

# Terminal 1: backend (http://localhost:8000)
cd backend && pip install -r requirements.txt && python run.py

# Terminal 2: frontend (http://localhost:5173)
cd frontend && npm install && npm run dev
```

Open <http://localhost:5173> in Chrome or Edge and drop an `.ifc` file onto the upload zone. API keys are set in-app on first launch, via environment variables, or in `~/.ifc-atlas/.env`.

To run with Docker instead:

```bash
docker compose up --build
```

## Documentation

Getting started, features, the AI agent guide, self-hosting, desktop builds, and the API reference live under [`docs/`](docs/), published as a [documentation site](https://nbharathik.github.io/ifc-atlas/).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, quality gates (`npm run verify`), and conventions, and [`docs/architecture/`](docs/architecture/) for the system design. Bug reports and feature requests: [GitHub Issues](https://github.com/nbharathik/ifc-atlas/issues).

## License

[Mozilla Public License 2.0](LICENSE).
