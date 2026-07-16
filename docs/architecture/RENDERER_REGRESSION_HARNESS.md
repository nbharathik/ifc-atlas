# Renderer regression and performance harness

The Phase 1 renderer harness exercises the real Chromium/WebGL viewer with
`data/fixtures/BasicHouse.ifc`. It is a correctness gate plus a diagnostic
recorder. It deliberately does **not** fail on one universal FPS number:
headless software rendering, integrated GPUs, discrete GPUs, display refresh
rates, thermal state, and CI virtualization are not directly comparable.

## What the scenario proves

The Playwright scenario loads the IFC through the same hidden file input a
user opens from the upload overlay. Readiness requires all of the following:

- the `ifc-viewer-ready` event, which is emitted after the final fragment
  update and three animation-frame boundaries;
- the loading overlay has unmounted and the status bar says `Ready`;
- the spatial tree and non-zero element statistics exist;
- the renderer reports non-zero draw calls and triangles;
- the render-state coordinator has applied and rendered its latest generation
  without an error.

After load, the scenario performs a scripted orbit, asks the viewer's exact
picking pipeline for a real geometry coordinate, selects it with a genuine
canvas click, and verifies the selection highlight survives another orbit. It
then drives the public keyboard
workflows for hide, show all, isolate, ghost, and restore. A bounded per-frame
probe records any frame that has zero geometry or a lost WebGL context while
those modes change. The selected Express ID and its named appearance layer
must remain stable throughout.

The test records rather than hard-codes these performance measurements:

- upload-to-ready, application TTFR/load metrics, and click-to-highlight;
- orbit frame-time p50, p95, worst frame, effective FPS, and frames over
  33.4 ms;
- draw calls, triangles, geometries, textures, shader programs, and JS heap;
- transition-frame p50/p95 and minimum rendered geometry;
- render coordinator generations, named layers, and last error;
- browser, CPU concurrency, memory hint, WebGL vendor/renderer, ANGLE backend,
  WASM variant, cross-origin isolation, resolution, and device pixel ratio.

Every run attaches `renderer-phase1-diagnostics.json` to the Playwright test
result. Compare percentiles only between runs with materially equivalent
hardware metadata, viewport, browser build, graphics profile, and cold/warm
cache state.

The JSON also carries a cold-load timeline: upload start, visible progress
transitions, converter-worker creation and protocol messages, relevant
WASM/worker resource timings, and browser long tasks. A short diagnostic can
therefore distinguish worker boot/module compilation from IFC conversion even
when the model is intentionally not allowed to run to completion.

## Install and run

Install the test runner and its Chromium build once:

```bash
npm --prefix frontend install --save-dev @playwright/test
npm --prefix frontend exec -- playwright install chromium
```

Run the bounded scenario from the repository root:

```bash
node scripts/run-renderer-e2e.mjs
```

The E2E sources have a separate strict TypeScript project because the normal
frontend typecheck intentionally includes only `src/` (run from `frontend/`;
`npm --prefix` does not change tsc's working directory):

```bash
cd frontend && npx tsc --noEmit -p tsconfig.renderer-e2e.json
```

Useful variants:

```bash
# Observe the interaction in a visible browser.
IFC_E2E_HEADED=1 node scripts/run-renderer-e2e.mjs

# Reuse a separately managed development server.
IFC_E2E_BASE_URL=http://127.0.0.1:5173 node scripts/run-renderer-e2e.mjs

# Allow a slower conversion machine up to six minutes.
IFC_E2E_LOAD_TIMEOUT_MS=360000 node scripts/run-renderer-e2e.mjs

# Retry an infrastructure-flaky run once (default is no retry for this 50 MB gate).
IFC_E2E_RETRIES=1 node scripts/run-renderer-e2e.mjs

# Disable failure video when running a short phase-timeline probe.
IFC_E2E_VIDEO=off node scripts/run-renderer-e2e.mjs

# Deterministic software WebGL fallback for a GPU-less CI worker.
IFC_E2E_FORCE_SWIFTSHADER=1 node scripts/run-renderer-e2e.mjs

# Hardware-qualified run: full Chromium in new-headless mode with the native
# D3D11 ANGLE backend. The default headless shell silently falls back to
# SwiftShader even on GPU machines, so performance baselines need this flag.
IFC_E2E_FORCE_HW=1 node scripts/run-renderer-e2e.mjs
```

PowerShell sets the same variables with `$env:IFC_E2E_HEADED='1'` before the
command. The config starts `npm run dev:web` on port 4174 unless
`IFC_E2E_BASE_URL` is supplied. Browser-only mode avoids coupling this renderer
gate to a running API or sidecar.

If `BasicHouse.ifc` is missing, both the wrapper and direct Playwright test
report a skip with the sample-fetch command. A missing browser executable is
an environment setup error, not a product failure; run the install command
above rather than weakening the WebGL assertions.

## Interpreting results

Correctness failures are release blockers: an uncaught page error, unhandled
rejection, lost WebGL context, zero-geometry transition frame, missing
selection layer, non-persistent selection, stale coordinator generation, or
coordinator error. These checks should be stable across hardware.

Performance values are baselines. Keep the attached JSON from a known-good
run and compare p50/p95 click and frame time, hitch count, draw calls,
triangles, and memory on the same machine. CI may publish artifacts and trend
them, but should not impose a desktop-GPU FPS target on SwiftShader. A later
calibrated gate can compare against a checked-in machine class or a rolling
baseline with an explicit tolerance.

The scenario uses development-only `__ifc*` observability hooks that the
viewer exposes specifically for preview/E2E diagnostics. User actions still go
through the hidden input, canvas pointer handlers, exact fragment raycaster,
and keyboard workflows. The hooks read state, drive the existing scripted
orbit benchmark, and await the same exact-pick path only to locate a stable
geometry coordinate before the measured pointer click. The harness opts into
the normally gated performance HUD metrics inside its isolated browser context.

## Latest local correctness smoke

On 15 July 2026 the cold BasicHouse scenario passed end to end in headless
Chromium using ANGLE/SwiftShader. It retained one durable selection layer across
orbit and all visibility modes, recorded zero zero-geometry transition frames,
zero context-loss frames, no page/console errors, and a final coordinator state
with applied/rendered generation equal to desired generation. SwiftShader
timings are deliberately not promoted as production FPS or latency baselines.

## Latest hardware-qualified run

On 16 July 2026 the full three-spec suite passed on an Intel Arc 140V
(`ANGLE (Intel ... Direct3D11)`, `IFC_E2E_FORCE_HW=1`, 1440x900, cold cache):

- upload-to-ready 10.6 s, application TTFR 8.0 s;
- orbit 60 FPS with p50 16.6 ms / p95 17.8 ms, zero context losses;
- selection orbit at 60 FPS with the durable highlight retained.

The same hardware run initially measured click-to-highlight at ~2.1 s and led
to the acknowledgement-preemption fix in the fragment update path (see the
16 July checkpoint in the Dalux review). After the fix the recorded
multi-click window was 105-219 ms per click on this adapter, with queue wait
down from ~2,000 ms to 25-59 ms. These numbers are one machine's baseline,
not universal targets; compare only against runs with equivalent hardware
metadata.

The transition probe now samples until `finishFrameProbe` explicitly stops it
after the final restore action (the wall-clock duration parameter is only a
60 s safety cap), and `waitForRenderStateIdle` accepts the coordinator
generation observed before an action so idle can never be satisfied by the
previous generation.
