# Fragment Converter Sidecar

A small Node.js HTTP service that converts IFC files to `@thatopen/fragments`
binaries and runs the native IFC parser (metadata index + early geometry
extraction). The Python backend resolves it at `backend/sidecar` by default
and can be overridden with `SIDECAR_DIR`.
See `docs/architecture/AI_NATIVE_ENGINE.md` for the full design.

## What it does

The server (`src/index.ts`, plain `node:http`, no framework):

1. Runs the `@thatopen/fragments` IfcImporter on `web-ifc` WASM (one shared
   importer, created lazily on the first conversion and reused).
2. Listens on `127.0.0.1:9100` (configurable via `SIDECAR_PORT` / `SIDECAR_HOST`).
3. `POST /convert` - accepts raw IFC bytes (`application/octet-stream`) with
   query params `profile=balanced|quality|performance|ultra_fast` and
   `modelId=<opaque tag>`. Returns the fragment binary in one response, with
   timing and size info in `X-Sidecar-*` headers.
4. `POST /parse` - parses IFC bytes and returns the metadata-index JSON
   (`?statsOnly=1` returns entity stats only).
5. `POST /geometry` and `POST /geometry/stream` - extract preview meshes from
   the raw IFC; the stream variant emits NDJSON batches over chunked transfer.
6. `GET /health` - liveness check for the backend.

Conversion progress is written to **stderr** as structured lines
(`SIDECAR_PROGRESS` / `SIDECAR_DONE` / `SIDECAR_ERROR` JSON). The Python
manager tails stderr and forwards progress to the frontend as SSE through
`POST /api/ifc/convert`.

## Why Node, not Python

`@thatopen/fragments` is a TypeScript library. A Node build of the exact
same library that runs in the browser means:

- Bit-identical fragment output (same importer, same settings, same
  `.frag` format). The browser's existing `fragmentsManager.core.load()`
  path is reused verbatim.
- One implementation to maintain across server and client.
- No Python binding layer to IfcOpenShell's C++ and then re-serialise;
  the sidecar is a thin process boundary, not a translation layer.

The Python backend remains authoritative for IFC **semantics** (edits,
psets, IDS validation, AI-tool routing). The sidecar owns only the
geometry-conversion fast-path. Python calls the sidecar over localhost
HTTP when it needs a `.frag` built.

## Layout

```
backend/sidecar/
├── README.md              ← this file
├── package.json           ← deps: @thatopen/components, @thatopen/fragments, three, web-ifc, earcut
├── tsconfig.json
├── build.mjs              ← `npm run build`: esbuild-bundle src/ into dist/index.cjs
├── dist/                  ← build output (gitignored): index.cjs + web-ifc*.wasm
├── src/
│   ├── index.ts           ← HTTP server: /convert, /parse, /geometry, /geometry/stream, /health
│   ├── converter.ts       ← IfcImporter wrapper; settings mirrored with the frontend
│   ├── profiles.ts        ← parse-profile importer settings (see below)
│   └── parser/            ← native IFC parser (lexer, metadata index, geometry extraction)
└── test/
    ├── parser.test.ts
    ├── geometry_stream.test.ts
    └── geometry_stream_basichouse.test.ts
```

## Profile-settings alignment

To keep server-built fragments identical to browser-built ones, the
importer settings must be the same on both sides. `src/profiles.ts` is a
mirror of `frontend/src/services/viewer/parseProfiles.ts` and **must stay
in sync with it manually** - any knob that differs between the two sides
causes cache misses at best and subtle visual inconsistencies at worst.

## Cache layout

The fragment cache is owned by the **Python backend**, not the sidecar.
Pre-built fragments live in the per-user data folder:

```
~/.ifc-atlas/fragments/
└── {sha256-of-ifc-bytes}-{profile}.frag
```

The location is `FRAGMENT_CACHE_DIR` in `backend/app/core/config.py`
(overridable via the `FRAGMENT_CACHE_DIR` env var). The cache can be
cleared from Settings → Storage in the app or via
`POST /api/system/flush` with scope `fragments`.

## Python → sidecar protocol

The Python side talks HTTP to `127.0.0.1:9100`. Sidecar lifecycle is
managed by `backend/app/services/sidecar_manager.py`: it spawns the
process on demand (Node 20+ required on PATH), health-gates requests, and
respawns transparently if the process dies. Spawning is idempotent -
concurrent callers converge on one process.

The spawn command is resolved in priority order (first hit wins):

1. `IFC_SIDECAR_CMD` env var - full command line, shlex-split.
2. `node dist/index.cjs` - the esbuild bundle from `npm run build`
   (single file + web-ifc wasm staged alongside; no node_modules or npx
   needed at runtime). While `dist/index.cjs` exists it wins over the dev
   fallback, so rebuild or delete `dist/` after editing sources.
3. `npx tsx src/index.ts` - dev fallback on the TypeScript source
   (requires `npm install` here first).

The **desktop (Tauri) installer does not yet ship the bundle**: the
`scripts/build_sidecar.*` build scripts produce `dist/index.cjs`, but
wiring it into the installer payload is a separate step. Until then,
server-side IFC → fragment conversion is unavailable in the installed app
and the in-browser worker parse covers viewing instead.

## Current limitations

- Single-concurrent-job: Node is single-threaded, so conversions block
  one another.
- No authentication: the sidecar is loopback-only by design.
