# Phase 0 performance and quality baseline

**Measured:** 2026-07-26

**Purpose:** Reference point for the repository refactor and future IFC converter bake-off
**Fixture:** `data/fixtures/BasicHouse.ifc`, 52,702,577 bytes (50.3 MiB)

This is a reproducible starting point, not a performance claim. Results from
other machines must record their hardware, dependency lock, build mode and
fixture hash before they are compared with these values.

## Reference machine

| Item | Value |
|---|---|
| OS | Windows NT 10.0.26200 |
| CPU | Intel Core Ultra 7 258V, 8 cores / 8 logical processors |
| Memory | 31.5 GiB |
| Python | CPython 3.12.11 |
| Node / npm | Node 22.16.0 / npm 10.9.2 |
| Rust | rustc 1.95.0 / cargo 1.95.0 |

## Quality gates

| Check | Result |
|---|---|
| Backend Ruff | Passed |
| Backend fast suite | 1,684 passed; 120 deselected |
| Python runtime dependency audit | No known vulnerabilities |
| Frontend typecheck | Passed |
| Frontend tests | 2,744 passed; 1 skipped |
| Frontend production dependency audit | No known vulnerabilities |
| Sidecar typecheck / tests / build | Passed; 34 tests |
| Tauri format / tests | Passed; 6 tests |

The backend suite still emits two upstream-facing warnings: Starlette warns
that its `httpx` TestClient compatibility layer is deprecated, and one
Ifcopenshell destructor path reports a non-fatal registry `KeyError`. Track
both, but neither failed this checkpoint.

## Frontend production build

The production directory contains 63 files and is 23,251,643 bytes
(22.17 MiB). Largest minified files:

| Artifact | Bytes |
|---|---:|
| `viewer-engine-*.js` | 6,725,668 |
| `ifc-convert.worker-*.js` | 4,253,590 |
| `metadata.worker-*.js` | 3,592,084 |
| Fragments `worker-*.mjs` | 3,216,090 |
| Additional `worker.mjs` | 1,335,963 |
| `web-ifc-mt.wasm` | 1,314,227 |
| `web-ifc.wasm` | 1,303,940 |

Vite reports the viewer engine as 1,285.74 KiB gzip. These values establish
the initial bundle budget and show why Phase 3 should deduplicate converter
runtimes and make the browser fallback lazy. They do not justify replacing
web-ifc before the converter contract and correctness corpus exist.

## BasicHouse conversion

The backend ran in local mode with a new empty `IFC_ATLAS_HOME`, a built Node
sidecar, the `balanced` profile and three sequential requests:

| Run | End-to-end | Source | Sidecar time |
|---:|---:|---|---:|
| 1 | 4,136.0 ms | sidecar | 3,437.0 ms |
| 2 | 152.1 ms | cache | 0 ms |
| 3 | 137.1 ms | cache | 0 ms |

The generated fragment artifact is 3,744,781 bytes. A post-conversion process
sample observed:

| Process | Working set | Peak working set | Private memory |
|---|---:|---:|---:|
| Node converter | 551.9 MiB | 551.9 MiB | 626.7 MiB |
| Python backend | 162.4 MiB | 263.3 MiB | 353.8 MiB |

The memory figures are operating-system process counters sampled after the
request. They are useful as a coarse ceiling, but the next benchmark block
must add time-series sampling and separate clean-process runs before using
them as release thresholds.

Reproduce the latency run after starting a clean backend:

```bash
python scripts/benchmark_coldload.py \
  --base-url http://127.0.0.1:8000 \
  --fixtures data/fixtures/BasicHouse.ifc \
  --runs 3 \
  --label phase-0 \
  --no-log
```

## Future converter benchmark contract

Keep the same source bytes and compare candidates through the Atlas converter
contract. At minimum, record:

- schema acceptance, warning set and unsupported representations;
- stable element ID/GUID mapping and visible-geometry parity;
- cold p50/p95 latency and first-useful-view latency;
- peak native, Wasm, JavaScript and GPU memory;
- artifact bytes, cache-hit latency and deterministic artifact hash;
- platform packaging size and startup cost;
- malformed-input behavior and enforced resource limits.

The current Node/web-ifc/Fragments result is the reference implementation.
IfcOpenShell-native and Rust/IFC Lite experiments may be added later, but no
candidate should become production code until it passes the correctness vetoes
and promotion gates in the repository refactoring plan.
