/**
 * App-wide UI feature flags.
 *
 * Plain build-time constants keep release-gated surfaces explicit.
 */

/*
 * Edit-mode gating note: the edit surface (Edit toggle, editable properties,
 * New Project, write-tool tiers, undo/redo UI) is NOT a build-time flag. It
 * gates on the BACKEND's EDIT_MODE_ENABLED setting, probed at runtime from
 * `/api/ifc/edit-state` into the store's `editModeAvailable` - so a backend
 * with editing on lights the UI up with no rebuild, and the two sides can
 * never disagree (ADR 003 phased flip).
 */

/**
 * BROWSER_ONLY - static viewer-only bundle for public hosting (GitHub Pages
 * etc.) where NO backend exists. Set via `VITE_PUBLIC_DEMO=true` at build
 * time (`npm run dev:web` / `npm run build:web` load `.env.webdemo`).
 *
 * When true:
 *   - the cold-load path skips every server step (manifest, capability probe,
 *     server-convert, prebuild-wait) and goes idb-cache -> worker-parse ->
 *     live-parse directly,
 *   - uploads are never persisted to a backend and the raw IFC bytes stay in
 *     memory for the metadata worker,
 *   - the model-sync WebSocket and chat surfaces are not mounted,
 *   - properties come exclusively from the in-browser metadata worker.
 *
 * Mutually exclusive with the Tauri desktop build by construction - never set
 * the env var for desktop builds. Same flag also drives `DemoModeBanner`.
 */
export const BROWSER_ONLY: boolean = import.meta.env.VITE_PUBLIC_DEMO === 'true';

/**
 * STRUCTURAL_EDIT_ENABLED - the structural edit scope (create walls / slabs,
 * delete elements). Off for v0.1.1: geometry edits reload the viewer, too
 * disruptive to ship. Frontend gate only; the backend keeps every structural
 * op for API/MCP clients. Pins `editScope` to semantic (including a persisted
 * structural pref) and hides the scope toggle, banner, and wall-draw tool.
 * See dev/docs/EDIT_SCOPES.md.
 */
export const STRUCTURAL_EDIT_ENABLED: boolean = false;

/**
 * RENDER_ON_DEMAND - optional manual rendering mode. It switches the viewer from the
 * engine's continuous AUTO loop (full scene render every vsync, forever) to
 * MANUAL mode driven by dirty-flag kicks (camera events, fragment flushes,
 * engine tile arrivals, input). Idle GPU cost drops to ~zero; during
 * interaction behavior is unchanged. Enable per session with
 * `localStorage.ifcRenderOnDemand='1'` or per build with
 * `VITE_RENDER_ON_DEMAND=true`.
 */
export const RENDER_ON_DEMAND: boolean =
  import.meta.env.VITE_RENDER_ON_DEMAND === 'true'
  || (typeof localStorage !== 'undefined'
    && localStorage.getItem('ifcRenderOnDemand') === '1');
