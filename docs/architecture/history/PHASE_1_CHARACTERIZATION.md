# Phase 1 characterization and contract baseline

**Date:** 2026-07-26

**Active converter:** web-ifc through the existing Node sidecar

**Active renderer:** Three.js/WebGL with That Open Fragments
**Migration rule:** preserve geometry and behavior; introduce Atlas-owned contracts

## Protected workflows

| Workflow | Characterization evidence | Contract added in Phase 1 |
|---|---|---|
| Upload IFC and hydrate project/tree/stats | backend upload validation and route tests; frontend model-refresh tests | `ModelIdentityV1` is included in upload/meta |
| Restore an existing session | renderer context-restore Playwright specification | immutable revision identity |
| Prebuild, cache hit, and fragment serve | backend fragment-cache, prebuild, convert-status, and serve tests | artifact manifest v1 |
| Convert IFC with fallback | frontend server-convert tests and sidecar converter tests | converter provenance in the manifest |
| Load, select, filter, clip, measure, edit, undo, and export | existing frontend unit and renderer Playwright specifications | compound `ElementKeyV1` for new boundaries |
| Conversion progress and failure | backend prebuild registry tests | `JobContractV1` and `ErrorCode` |

The committed identity golden is
`backend/tests/fixtures/contracts_v1_golden.json`. It fixes the canonical
output for a known project GlobalId, source hash, revision hash, and model
version. Artifact tests fix canonical hash behavior and reject tampered
metadata or payload fields.

All current backend conversion entry points resolve the application-owned
`IfcConverter` protocol. The active `WebIfcSidecarConverter` is a thin adapter
over the existing manager, so this boundary does not copy or retriangulate
geometry.

## Stable failure vocabulary

Job states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`.
Stable error codes include `cancelled`, `resource_limit_exceeded`,
`unsupported_ifc`, `invalid_input`, `not_found`, `conflict`,
`converter_unavailable`, `conversion_failed`, and `internal_error`.

The current prebuild registry maps to the new job contract. It does not yet
provide reliable process cancellation, so exposed jobs are
`cancellable=false`. End-to-end cancellation is Phase 4 work; the state and
error vocabulary are stable now so that implementation will not require
another client migration.

## Generated contract workflow

1. Run `python scripts/export_openapi_schema.py`.
2. Run `npm run generate:api-types` in `frontend`.
3. Never edit `frontend/src/generated/openapi.json` or
   `frontend/src/generated/api-schema.ts` by hand.
4. CI checks both generated files for drift.

## Deferred validation

Docker execution is skipped because Docker is not available in the current
environment. The Phase 0 structural Docker checks remain the recorded
evidence.

Local contract verification passed with 1,700 backend fast tests, 2,746
frontend tests, 34 sidecar tests, frontend production build/typecheck,
backend Ruff, generated-file checks, production dependency audit, and strict
documentation build. The main Phase 1 renderer Playwright parity scenario
passes on BasicHouse under local SwiftShader with a measured 420-second load
budget (4.8 minutes in the passing run). It covers painted geometry,
selection, navigation, and visibility modes.

The WebGL context-loss recovery scenario remains an explicit repository
`fixme`: That Open Fragments currently does not re-upload fragment GPU
geometry after context restoration. Playwright therefore skips it before
fixture load. This is recorded as an existing engine limitation rather than a
passed feature or a Phase 1 regression. A larger IFC corpus remains a later
release-gate check.
