# Release notes draft: viewer overhaul

Draft for the next tag. Numbers are measured on the release build; re-measure
after the final commit if anything else lands. Pick the version at tag time
(1.3.0 by semver; 2.0.0 if the headline is the overhaul itself).

## Headline

The IFC viewer has been rebuilt for speed and size: the same features, a far
leaner engine underneath. Every capability from the previous release is intact;
the code that delivers it is smaller, faster to download, and faster to first
frame.

A note on wording: this was an aggressive optimization pass over the existing
architecture, keeping the proven web-ifc, Fragments and IfcOpenShell engines.
"Rebuilt viewer runtime" is defensible in public notes; "rewritten from
scratch" is not, and claiming it invites bug reports asking why behavior is
identical.

## What users will notice

- Viewer no longer flickers or goes blank while resizing the side panels.
  The drawing buffer was being cleared by the engine's resize handling after
  each frame's render; the viewport now repaints synchronously in the same
  frame.
- Production deployments are dramatically lighter on the wire: compression was
  missing entirely from the server config. First paint drops from 536 kB to
  131 kB transferred; opening a model drops from 8.6 MB to 1.7 MB.
- Cut sections now render with solid cap fills instead of hollow shells.
- Clearance measurement now reports the true shortest distance between the
  clicked faces. Previously it measured a fabricated triangle, and silently
  fell back to a point-to-point line when a face was unavailable.
- Snappier UI around the viewer: the largest component no longer re-renders on
  unrelated state changes, two panels stopped re-rendering on every store
  write, and clip-plane slider drags no longer write to localStorage per frame.
- Faster model-open on the geometry side: the chat panel is no longer
  downloaded with the viewer, and the culling subsystem gets its bounding
  boxes from the worker instead of shipping raw vertex buffers to the main
  thread.

## Reliability

- The Fragments geometry worker now always matches the installed engine
  version. It was a hand-copied binary from the first commit, version-skewed
  against the library on the main thread, and pinned in returning users'
  browsers by a cache-first service worker with a hand-bumped cache name. The
  worker is generated from the package at build time and the service-worker
  cache namespace derives from the build, so it can never go stale again.
- Section-box changes made while a model is still loading are no longer lost.
- The server pre-build load path no longer starts models at reduced quality
  after the user orbited during the wait.

## Size

- dist: 23.3 MB to 18.7 MB (measured before this stretch's final build;
  re-measure at tag time)
- Entry stylesheet: 232 kB to 203 kB, with 256 orphaned rules removed
- web-ifc-mt.wasm (1.3 MB, unreachable) and a duplicate 3.2 MB Fragments
  worker no longer ship
- About 5,600 lines of dead or duplicated frontend source removed, including
  three unreferenced components, seven test-only modules, 25 dead API-client
  functions, and a permanently disabled progressive-reveal path

## Codebase consolidation

The repository was restructured for navigability: one file per feature instead
of many small fragments, with zero behavior change and every merge gated by the
full test suites.

- Frontend: 218 to 138 production source files. Chat is 5 files instead of 18;
  the viewer services folder halved.
- Backend: 87 to 65 Python modules, merged along verified one-directional
  dependency lines.
- Documentation: the active hand-written set went from 8,668 to under 5,000
  lines; the refactoring decision history is archived intact under
  docs/architecture/history/.

## AI assistant: leaner tool catalog

The chat assistant's tool catalog was consolidated from 46 tools to 13. The
schema payload sent with every AI request dropped 58 percent (33,330 to 13,889
characters), which materially helps smaller models pick the right tool.
Capabilities are unchanged: related operations became one parameterized tool
(query_elements, get_element, viewer_control, describe_model, quantity_summary,
validate_model, get_docs, edit_semantic, edit_structural), and the
code-execution tools remain for long-tail queries. Saved custom agents and tool
sets migrate automatically through a legacy-name map; old chat transcripts still
label correctly.

## Engineering

- ViewerPanel shrank from 6,887 lines toward a capability-module structure:
  load-progress pacing is a hook, express-to-local resolution is a tested
  service, the culler ownership ladder is one implementation instead of four
  divergent copies, and navigation enter/exit handlers exist once instead of
  five times.
- An engine-reuse audit confirmed the app delegates selection, hover, ghost,
  visibility, colour groups and the spatial tree to the engines, and recorded
  the deliberate exceptions so they are not re-implemented.
- Verified by 2,650+ unit tests and a hardware-GPU Playwright renderer suite
  covering paint stability, click selection, measurement snapping, section
  workspaces, and filter reset.
