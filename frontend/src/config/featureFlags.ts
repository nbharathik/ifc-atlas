/**
 * App-wide UI feature flags.
 *
 * Plain build-time constants keep release-gated surfaces explicit.
 */

/**
 * EDIT_MODE_ENABLED gates the LLM "Edit" surface:
 *   - the `Edit` chat-mode pill in the chat panel (Ask is the only mode),
 *   - the `edit-assistant` agent in the Chat Manager > Agents tab,
 *   - the `write_edit`-tier tools in the Chat Manager > Tools registry
 *     (only the query/read tools stay visible).
 *
 * The backend `EDIT_MODE_ENABLED=1` setting must also be enabled before the
 * write-tool tier is offered to the LLM.
 */
// Typed as `boolean` (not the literal `false`) so the gated branches across the
// app don't read as unreachable / always-false to the type-checker and linter.
export const EDIT_MODE_ENABLED: boolean = false;

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
