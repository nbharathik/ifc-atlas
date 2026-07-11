---
name: ai-bim-editor-initiative
description: The large active initiative to turn IFC Atlas from a viewer into a native-IFC AI/BIM editor; plan approved, implementation underway.
metadata:
  type: project
---

User approved (2026-07-09) a full plan to evolve IFC Atlas from an IFC **viewer**
into a native-IFC **AI/BIM editor**: create + edit IFC files in the viewer
(Blender/Revit-style), AI-assisted, with git-like history/undo-redo, knowledge
tools (bSDD + IfcOpenShell docs), generative pipelines (parametric + freeform
houses, text→CAD, text→mesh, image gen), and an expanded MCP server. Humans and
AI must drive the SAME operations (dual-audience). Keep current viewer
performance.

Master plan: `dev/docs/AI_BIM_EDITOR_MASTER_PLAN.md` (Workstreams A–H, Phases 0–6;
its **Execution status** section is the source of truth for progress). Decisions:
§5 recommendations all accepted; **D5 = both** parametric `generate_house(spec)`
AND freeform `execute_ifc_code` house generation (co-equal).

Architecture (ADRs 003/004/005, all Accepted): ifcopenshell is the only writer;
the 3D scene is a disposable projection; every mutation is a named **operation**
through `operation_service` (the single audited write path — see Invariant 12),
logged with actor attribution; history = git + ifcdiff + native-IFC ID contract;
geometry edits use a classified patch protocol (metadata/transform/geometry/bulk)
via the frontend `onFragDelta` seam.

**Phase 0 + Phase-2 spine DONE (verified 2026-07-10):** ADRs 003–005;
ARCHITECTURE_INVARIANTS amended (Inv 4/5/7/9 + new Inv 12); operation layer
`backend/app/services/operation_service.py` built + tested (20 tests); the 4
write tools + undo in `tools.py` now route through it (actor=AGENT), dispatch
tests still green; `bsdd_service.py` built + tested (18); ID-contract tests (4);
semantic deps promoted. Full backend fast lane 1490 pass, 0 regressions (3
pre-existing `langgraph.prebuilt` env failures unrelated).

**Knowledge tools DONE (verified 2026-07-10, fast lane 1506 pass):** async→sync
bridge `_run_coro_sync` in tools.py (worker-thread, resolves the sync-in-loop
constraint at chat_routes.py); bSDD tools + unified `get_docs` (sources
ifcopenshell/bsdd/user/ifc-schema); new `read_knowledge` tier (warming-exempt,
no-model-needed); `reference_docs_service.py` indexes installed ifcopenshell.api
docstrings (35 domains) + `scripts/fetch_reference_docs.py`; endpoints
`/api/chat/reference-docs/{status,fetch}`. Docs regenerated.

**Phase 2 editor UX first slice DONE (verified 2026-07-10):** backend
`POST /api/ifc/operations/execute|undo|redo` + `GET /operations/catalogue|history`
(actor=USER fast-path, gated by EDIT_MODE_ENABLED, emits sync event) — 7 route
tests; frontend `editMode`+`applyOperation` store slice, `OperationResult` type,
operation fns in api.ts, and `PropertiesPanel` `EditableText` making Name +
property values inline-editable in Edit mode (gated
`editMode && EDIT_MODE_ENABLED && !BROWSER_ONLY`). Post-edit the panel re-fetches
backend-authoritative via ModelService `authoritativeOnlyIds`. Backend fast lane
1513 pass; frontend typecheck+vitest+build green.

**A3 create-new-IFC-project DONE (verified 2026-07-10):** backend
`project_template_service.py` + `POST /api/ifc/new` (empty/single_storey/two_storey
scaffolds via ifcopenshell.api) — 9 tests; frontend `api.newProject` + reusable
`useNewProject` hook that loads the template through the EXISTING upload pipeline
(no new load-path code); "New Project" buttons on UploadOverlay + File→New menu
item. Backend fast lane 1522 pass; frontend typecheck+vitest+build green.

NEXT: A2 create_wall/slab ops (display via model_refresh reload first,
onFragDelta later); then geometry transform/gizmo — DEFERRED until the
@thatopen/fragments per-item transform API can be exercised visually (no clean
public setter found; can't verify headless). Also C4 timeline UI, D1 planner, D4
verifier, E4 Knowledge-tab buttons. EDIT_MODE_ENABLED still OFF by default (dev
enables via env; release flip at Phase 3 GA per ADR 003).

Key existing seams to reuse (do not rebuild): sandbox edit pipeline + write
tools exist but were gated behind `EDIT_MODE_ENABLED` (backend `config.py` +
frontend `featureFlags.ts`, flip together, phased per ADR 003); MCP server is
live at `/mcp`; frontend `patchApplier.ts` `onFragDelta` is the unwired geometry
seam. Commit convention: NO AI attribution / Co-authored-by (see CLAUDE.md).
