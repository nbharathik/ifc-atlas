---
name: backend-test-env
description: How to actually run the IFC Atlas backend tests on this Windows machine (which interpreter has which deps).
metadata:
  type: reference
---

Running backend pytest on this Windows box:

- `backend/.venv/Scripts/python.exe` has the real backend deps (ifcopenshell
  0.8.5, fastapi, anthropic, httpx) but is **Python 3.13** and did NOT ship with
  pytest — I `pip install`ed pytest 9.1.1 into it. Set
  `$env:PYTHONPATH = (Resolve-Path "backend").Path` then run
  `& backend/.venv/Scripts/python.exe -m pytest backend/tests/<file> -q`.
- The unit lane (`-m "not requires_ifc_load"`) is safe and fast.
- `requires_ifc_load` tests DID run OK here despite the project's 3.13-segfault
  warning (simple BasicHouse loads work; save/reload round-trips are slow ~90s).
  CI runs the full lane on Python 3.12 (Linux) — that's the authoritative gate.
- System Python is also 3.13 with pytest 8.4.0 + ifcopenshell 0.8.4 (used by the
  bsdd agent for its offline unit tests).
- `fastembed`/`hnswlib` are now in requirements.txt but NOT installed in the
  venv; imports are guarded so tests still pass without them.

Related: [[ai-bim-editor-initiative]].
