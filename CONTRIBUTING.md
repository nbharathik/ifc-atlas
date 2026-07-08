# Contributing to IFC Atlas

Thank you for considering a contribution. This guide covers the development
setup, the quality gates every change must pass, and the conventions the
codebase follows.

## Development setup

Requirements: Python 3.11 or 3.12 (not 3.13), Node.js 20+, and at least one
LLM API key (OpenAI or Anthropic) if you want to work on the chat features.

```bash
git clone https://github.com/nbharathik/ifc-atlas.git
cd ifc-atlas

# Terminal 1: backend
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1        # Windows; source .venv/bin/activate elsewhere
pip install -r requirements.txt -r requirements-dev.txt
python run.py                     # http://localhost:8000

# Terminal 2: frontend
cd frontend
npm install
npm run dev                       # http://localhost:5173

# One-time extras needed by the full `npm run verify` gate
npm --prefix backend/sidecar install   # sidecar typecheck (verify:sidecar)
pip install -r requirements-docs.txt   # mkdocs (verify:docs), from the repo root
```

API keys are set in-app on first launch (AI-Keys modal) or in
`~/.ifc-atlas/.env`. The backend keeps all writable state (uploads, caches,
keys) in `~/.ifc-atlas/`, never inside the repo.

A sample model for testing lives at `data/fixtures/BasicHouse.ifc` in
development checkouts. If your clone does not include it, download it with
`scripts/fetch-sample.ps1` (Windows) or `scripts/fetch-sample.sh` (macOS,
Linux).

## Quality gates

Every change must keep the full verification gate green before a PR:

```bash
npm run verify                   # full local gate (a superset of what CI runs)

# Individual gates
npm run verify:backend           # fast pytest + import smoke
npm run verify:frontend          # tsc + vitest
npm run verify:sidecar           # sidecar typecheck
npm run verify:docs              # generated-doc drift + strict mkdocs build
```

Backend notes:

- The fast subset (`-m "not requires_ifc_load and not subprocess_sandbox"`)
  is safe everywhere. The full suite needs Linux/macOS or Python 3.12 on
  Windows (IfcOpenShell segfaults under pytest on Windows + Python 3.13).
- A new test that loads an IFC file through the `svc` fixture must be marked
  `pytestmark = pytest.mark.requires_ifc_load` at module level.

Performance: the viewer has hard budgets on time-to-first-render and
click-to-highlight latency. If your change touches the loader, the viewer, or
the fragment cache, measure its effect on `data/fixtures/BasicHouse.ifc`
before and after. Silent performance regressions are not accepted.

## Architecture rules

Read `docs/architecture/OVERVIEW.md` (including its invariants summary)
before substantive work. The short version:

- The backend owns the authoritative IfcOpenShell model; all metadata,
  querying, and edits go through it.
- The frontend owns rendering and interaction (Three.js +
  `@thatopen/components`, Zustand state).
- Model edits go through the sandboxed diff-preview protocol; nothing writes
  to the model directly.
- The WebGL baseline never breaks; WebGPU stays behind an opt-in flag.

If you believe one of these rules is wrong, open an issue proposing the
change rather than silently working around it.

## Code conventions

- **Frontend:** strict TypeScript; no `any` without an inline justification.
  Single Zustand store; use `useShallow` when destructuring multi-key
  selectors. Keep components under roughly 500 lines; extract hooks and
  helpers early. Never mix React component exports and plain utility exports
  in one file (it breaks Fast Refresh).
- **Backend:** FastAPI handlers stay thin; business logic lives in
  `app/services/`. Pydantic models in `app/models/`. New agent tools go into
  `TOOL_DEFINITIONS` with a clean JSON-schema `parameters` block; that schema
  is exposed verbatim to LLM providers and the MCP server.
- **Comments:** default to none. Add one only when the *why* is non-obvious:
  a hidden constraint, an invariant, or a workaround for a specific bug.

## Documentation

- New agent tool or REST/WS endpoint: run `python scripts/generate_tools_doc.py`
  and `python scripts/generate_api_doc.py` to refresh the generated reference
  pages, then check the descriptions read well.
- New user-visible feature: add it to `docs/user/FEATURES.md`.

## Pull requests

1. Fork, create a topic branch, and keep the diff focused on one change.
2. Run `npm run verify` locally; it must pass.
3. Write an imperative, why-first commit message.
4. Fill in the PR template, including how you tested the change.

Bug reports and feature requests go through
[GitHub Issues](https://github.com/nbharathik/ifc-atlas/issues).

## License

By contributing you agree that your contributions are licensed under the
[Mozilla Public License 2.0](LICENSE), the project license.
