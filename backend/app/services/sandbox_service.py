"""
Edit sandbox for LLM write tools: every change is staged against a copy
and diffed before the user applies it.

Any LLM-originated edit that is NOT a trusted, bounded inverse-delta op
(rename_element / update_property_value ship through a direct fast path)
flows through here:

    1. Snapshot the live IfcOpenShell file to a throwaway `.ifc` on disk.
    2. Open that copy as a fresh IfcOpenShell handle ("sandbox").
    3. Apply the requested ops against the sandbox.
    4. Hash the sandbox. If it matches the live fingerprint the run was a
       no-op (e.g. setting a name to its current value) - discard silently.
    5. Otherwise walk the two handles by Express id, compute a structural
       diff (renamed / property-changed / deleted / created / retyped) and
       register a `PendingEditEnvelope` keyed by a fresh edit_id.

The envelope is what the frontend renders as an Apply/Discard preview.
Apply:   ``apply_pending`` swaps the sandbox path into the authoritative
         file, reloads the handle, returns the surviving express ids.
Discard: ``discard_pending`` unlinks the sandbox file.

Everything is in-process + on-local-disk - no DB, no worker. Fits the
"50 MB BasicHouse.ifc loads in ~1-2 s" performance budget.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import ifcopenshell

from app.models.ifc_models import PendingEditElement, PendingEditEnvelope
from app.services.code_runner import (
    DEFAULT_TIMEOUT_S as _CODE_DEFAULT_TIMEOUT_S,
    CodeRunResult,
    run_ifc_code,
)

logger = logging.getLogger(__name__)


# Maximum number of simultaneously registered pending edits. The LLM can
# stack multiple proposals before the user reviews any; we cap the backlog
# so a runaway loop can't fill the tmp dir.
MAX_PENDING = 16

# Hard cap on ops per propose call. The prototype handles small,
# enumerable edit batches; execute_ifc_code-style free-form Python is
# handled separately.
MAX_OPS_PER_PROPOSAL = 128


# ──────────────────────────────────────────────────────────────────────
# Supported op shapes (prototype subset of the eventual execute_ifc_code)
# ──────────────────────────────────────────────────────────────────────

SUPPORTED_OPS = {"set_name", "set_property", "create_wall", "delete_element"}


@dataclass
class _PendingRecord:
    envelope: PendingEditEnvelope
    sandbox_path: Path
    # kept so Apply can publish "here is exactly what the LLM asked for"
    operations: list[dict[str, Any]] = field(default_factory=list)


class SandboxService:
    """Dict-backed registry for hash-gated, not-yet-applied edits."""

    def __init__(self) -> None:
        self._pending: dict[str, _PendingRecord] = {}
        # Keep sandbox scratch in a single dir so we can nuke it on demand.
        self._scratch_dir = Path(tempfile.gettempdir()) / "ifc_sandbox"
        self._scratch_dir.mkdir(exist_ok=True)

    # ------------------------------------------------------------------
    # Public API - propose / apply / discard / inspect
    # ------------------------------------------------------------------

    def propose_edit(
        self,
        *,
        ifc_service: "Any",  # app.services.ifc_service.IfcService
        operations: list[dict[str, Any]],
        summary: Optional[str] = None,
    ) -> Optional[PendingEditEnvelope]:
        """Run ``operations`` in a sandbox and register the diff.

        Returns ``None`` when the run was a structural no-op (hash match).
        Raises ``ValueError`` for malformed ops, unknown entities, etc.
        """
        if not ifc_service.is_loaded:
            raise ValueError("No IFC model is currently loaded")

        if not operations:
            raise ValueError("operations must be a non-empty list")
        if len(operations) > MAX_OPS_PER_PROPOSAL:
            raise ValueError(
                f"Too many ops in one proposal (max {MAX_OPS_PER_PROPOSAL})"
            )
        if len(self._pending) >= MAX_PENDING:
            raise ValueError(
                f"Too many pending edits already in flight ({MAX_PENDING}); "
                "apply or discard one before proposing another"
            )

        live_path = ifc_service._file_path  # noqa: SLF001 - internal access
        if live_path is None:
            raise ValueError("Live model has no backing file path")

        base_fingerprint = ifc_service.model_fingerprint
        base_version = ifc_service.model_version
        live_model = ifc_service.model

        # --- Step 1: deep-copy via file snapshot --------------------------------
        edit_id = uuid.uuid4().hex
        sandbox_path = self._scratch_dir / f"sandbox_{edit_id}.ifc"
        shutil.copy(live_path, sandbox_path)

        try:
            sandbox_model = ifcopenshell.open(str(sandbox_path))
        except Exception as exc:
            sandbox_path.unlink(missing_ok=True)
            raise ValueError(f"Failed to open sandbox copy: {exc}") from exc

        # --- Step 2: apply ops against the sandbox ------------------------------
        try:
            self._apply_ops_to_sandbox(sandbox_model, operations)
        except Exception:
            sandbox_path.unlink(missing_ok=True)
            raise

        # --- Step 3: persist + hash ---------------------------------------------
        sandbox_model.write(str(sandbox_path))
        sandbox_fingerprint = _sha256_file(sandbox_path)

        if sandbox_fingerprint == base_fingerprint:
            # No structural change. Discard silently - don't clutter the UI.
            sandbox_path.unlink(missing_ok=True)
            return None

        # --- Step 4: structural diff --------------------------------------------
        changes = _compute_diff(live_model, sandbox_model)
        counts = _count_changes(changes)

        envelope = PendingEditEnvelope(
            edit_id=edit_id,
            created_at=time.time(),
            base_model_version=base_version,
            base_model_fingerprint=base_fingerprint,
            sandbox_fingerprint=sandbox_fingerprint,
            summary=summary or _default_summary(operations, counts),
            operations=list(operations),
            changes=changes,
            counts=counts,
            verifier_verdict=_verify_sandbox(
                sandbox_model, live_model, base_fingerprint, changes
            ),
        )
        self._pending[edit_id] = _PendingRecord(
            envelope=envelope,
            sandbox_path=sandbox_path,
            operations=list(operations),
        )
        return envelope

    def execute_python(
        self,
        *,
        ifc_service: "Any",  # app.services.ifc_service.IfcService
        code: str,
        summary: Optional[str] = None,
        timeout_s: float = _CODE_DEFAULT_TIMEOUT_S,
        read_only: bool = False,
    ) -> dict[str, Any]:
        """Run arbitrary LLM-authored Python against a sandbox copy.

        This is the full sandbox-then-apply path. Returns one of four dict shapes:

        - ``{"action": "execute_error", ...}`` - child raised or timed out.
          No pending edit is registered; the sandbox is discarded. The LLM
          can read the error + any stdout it produced and try again.
        - ``{"action": "execute_result", ...}`` - child ran cleanly but the
          hash did not change. Read-only call. Sandbox discarded. Returns
          stdout + ``result`` repr + elapsed_ms.
        - ``{"action": "pending_edit", ...}`` - child ran cleanly and the
          hash differs. Diff computed, envelope registered, sandbox kept
          on disk for Apply. Returns the usual envelope preview tuple.
        - ``{"action": "pending_noop", ...}`` - child ran cleanly, mutated
          object state, but when re-serialised the sandbox file hashed
          identically to the live file (rare - e.g. a float round-trip
          that canonicalises to the same STEP bytes). Treated as no-op.
        """
        if not ifc_service.is_loaded:
            raise ValueError("No IFC model is currently loaded")

        if not read_only and len(self._pending) >= MAX_PENDING:
            raise ValueError(
                f"Too many pending edits already in flight ({MAX_PENDING}); "
                "apply or discard one before proposing another"
            )

        live_path = ifc_service._file_path  # noqa: SLF001
        if live_path is None:
            raise ValueError("Live model has no backing file path")

        base_fingerprint = ifc_service.model_fingerprint
        base_version = ifc_service.model_version
        live_model = ifc_service.model

        # --- Step 1: deep-copy via file snapshot --------------------------------
        edit_id = uuid.uuid4().hex
        sandbox_path = self._scratch_dir / f"sandbox_{edit_id}.ifc"
        shutil.copy(live_path, sandbox_path)

        # --- Step 2: subprocess-run the LLM code -------------------------------
        try:
            run: CodeRunResult = run_ifc_code(
                sandbox_path=sandbox_path,
                code=code,
                timeout_s=timeout_s,
            )
        except ValueError:
            sandbox_path.unlink(missing_ok=True)
            raise
        except Exception:
            sandbox_path.unlink(missing_ok=True)
            raise

        # --- Step 3: hard-error branch (child raised or timed out) -------------
        if run.error is not None:
            sandbox_path.unlink(missing_ok=True)
            return {
                "action": "execute_error",
                "error": run.error,
                "stdout": run.stdout,
                "elapsed_ms": run.elapsed_ms,
                "timed_out": run.timed_out,
            }

        # --- Step 4: hash + branch on read vs write ----------------------------
        # ``ifcopenshell.file.write`` is NOT byte-stable vs the input STEP;
        # timestamps / whitespace / instance ordering can round-trip
        # differently even when no entity changed. A naive hash-match
        # therefore over-reports writes for pure-read code. We:
        #   1. Check the file hash first. Same → definitely read-only.
        #   2. If different, compute the STRUCTURAL diff (by express id +
        #      properties). Empty diff → still treat as read-only (the
        #      STEP was re-serialised but nothing we care about moved).
        #   3. Only a non-empty structural diff registers a pending edit.
        sandbox_fingerprint = _sha256_file(sandbox_path)

        if sandbox_fingerprint == base_fingerprint:
            sandbox_path.unlink(missing_ok=True)
            return {
                "action": "execute_result",
                "stdout": run.stdout,
                "result": run.result_repr,
                "elapsed_ms": run.elapsed_ms,
            }

        # --- Step 5: compute diff + register envelope (write path) -------------
        try:
            sandbox_model = ifcopenshell.open(str(sandbox_path))
        except Exception as exc:
            sandbox_path.unlink(missing_ok=True)
            raise ValueError(
                f"execute_ifc_code: sandbox produced an IFC file that "
                f"ifcopenshell cannot re-open: {exc}"
            ) from exc

        changes = _compute_diff(live_model, sandbox_model)
        counts = _count_changes(changes)

        # Hash-different but structurally-identical: treat as read-only.
        # Saves the user from an Apply button that does nothing.
        if counts.get("total", 0) == 0:
            del sandbox_model
            sandbox_path.unlink(missing_ok=True)
            return {
                "action": "execute_result",
                "stdout": run.stdout,
                "result": run.result_repr,
                "elapsed_ms": run.elapsed_ms,
            }

        if read_only:
            del sandbox_model
            sandbox_path.unlink(missing_ok=True)
            return {
                "action": "execute_rejected",
                "error": (
                    "Read-only IFC query code produced structural model changes. "
                    "Use execute_ifc_code from Edit mode when you intend to stage "
                    "a sandboxed edit."
                ),
                "stdout": run.stdout,
                "result": run.result_repr,
                "elapsed_ms": run.elapsed_ms,
                "counts": counts,
                "change_preview": [c.model_dump() for c in changes[:10]],
            }

        # Synthesise a pseudo-operation so the envelope's ``operations``
        # field is non-empty - existing UI code expects at least the LLM
        # intent to surface somewhere. We never re-run this op on Apply;
        # Apply just moves the sandbox file into place.
        pseudo_op = {
            "op": "execute_ifc_code",
            "code_chars": len(code),
            "elapsed_ms": run.elapsed_ms,
        }
        envelope = PendingEditEnvelope(
            edit_id=edit_id,
            created_at=time.time(),
            base_model_version=base_version,
            base_model_fingerprint=base_fingerprint,
            sandbox_fingerprint=sandbox_fingerprint,
            summary=summary or _default_summary([pseudo_op], counts),
            operations=[pseudo_op],
            changes=changes,
            counts=counts,
            verifier_verdict=_verify_sandbox(
                sandbox_model, ifc_service.model, base_fingerprint, changes
            ),
        )
        self._pending[edit_id] = _PendingRecord(
            envelope=envelope,
            sandbox_path=sandbox_path,
            operations=[pseudo_op],
        )
        return {
            "action": "pending_edit",
            "edit_id": envelope.edit_id,
            "summary": envelope.summary,
            "counts": envelope.counts,
            "change_preview": [c.model_dump() for c in envelope.changes[:10]],
            "stdout": run.stdout,
            "result": run.result_repr,
            "elapsed_ms": run.elapsed_ms,
            "verifier_verdict": envelope.verifier_verdict,
            "note": (
                "Code ran successfully and produced a structural change. "
                "The edit is PENDING - the user must click Apply in the "
                "Diff Preview panel. Nothing mutates the live model yet."
                + _verifier_note(envelope.verifier_verdict)
            ),
        }

    def get_pending(self, edit_id: str) -> Optional[PendingEditEnvelope]:
        record = self._pending.get(edit_id)
        return record.envelope if record else None

    def list_pending(self) -> list[PendingEditEnvelope]:
        return [r.envelope for r in self._pending.values()]

    def apply_pending(
        self,
        *,
        edit_id: str,
        ifc_service: "Any",
    ) -> PendingEditEnvelope:
        """Swap the sandbox into the live path and reload the handle.

        The caller (route) publishes the appropriate ``metadata_patch`` /
        ``geometry_patch`` sync events based on the envelope's ``counts``.
        """
        record = self._pending.pop(edit_id, None)
        if record is None:
            raise ValueError(f"No pending edit with id {edit_id}")

        # Check nobody else mutated the model in between.
        if record.envelope.base_model_fingerprint != ifc_service.model_fingerprint:
            # Stale proposal - refuse. Caller can re-propose.
            record.sandbox_path.unlink(missing_ok=True)
            raise ValueError(
                "Pending edit is stale - the live model has been mutated "
                "since the proposal was created. Re-propose to refresh the diff."
            )

        live_path = ifc_service._file_path  # noqa: SLF001
        if live_path is None:
            record.sandbox_path.unlink(missing_ok=True)
            raise ValueError("Live model has no backing file path")

        # Atomic swap within the same filesystem.
        shutil.move(str(record.sandbox_path), str(live_path))

        # Reload the authoritative handle. This bumps model_version inside
        # load() and invalidates caches for us.
        ifc_service.reload_after_sandbox(edit_id=edit_id)

        return record.envelope

    def discard_pending(self, edit_id: str) -> PendingEditEnvelope:
        record = self._pending.pop(edit_id, None)
        if record is None:
            raise ValueError(f"No pending edit with id {edit_id}")
        record.sandbox_path.unlink(missing_ok=True)
        return record.envelope

    def clear_all(self) -> int:
        """Wipe every pending edit (used on new model upload)."""
        count = len(self._pending)
        for record in self._pending.values():
            record.sandbox_path.unlink(missing_ok=True)
        self._pending.clear()
        return count

    # ------------------------------------------------------------------
    # Private - op application
    # ------------------------------------------------------------------

    def _apply_ops_to_sandbox(
        self, model: ifcopenshell.file, operations: list[dict[str, Any]]
    ) -> None:
        for idx, op in enumerate(operations):
            kind = op.get("op")
            if kind not in SUPPORTED_OPS:
                raise ValueError(
                    f"Op #{idx} uses unsupported kind '{kind}'. "
                    f"Allowed: {sorted(SUPPORTED_OPS)}"
                )

            # create_wall and delete_element don't use a pre-looked-up entity
            if kind == "create_wall":
                _create_wall_in_sandbox(model, op, idx)
                continue
            if kind == "delete_element":
                _delete_element_in_sandbox(model, op, idx)
                continue

            expr_id = op.get("element_id")
            if expr_id is None:
                raise ValueError(f"Op #{idx} is missing element_id")
            try:
                entity = model.by_id(int(expr_id))
            except RuntimeError:
                entity = None
            if entity is None:
                raise ValueError(f"Op #{idx}: element {expr_id} not found in sandbox")

            if kind == "set_name":
                new_name = str(op.get("new_name", "")).strip()
                if not new_name:
                    raise ValueError(f"Op #{idx}: new_name must be a non-empty string")
                if not hasattr(entity, "Name"):
                    raise ValueError(
                        f"Op #{idx}: element {expr_id} ({entity.is_a()}) has no Name attribute"
                    )
                entity.Name = new_name

            elif kind == "set_property":
                prop_name = str(op.get("property_name") or "").strip()
                if not prop_name:
                    raise ValueError(f"Op #{idx}: property_name must be non-empty")
                pset_name = op.get("pset_name") or None
                new_value = op.get("new_value")
                _apply_property_edit(entity, prop_name, pset_name, new_value)


# ──────────────────────────────────────────────────────────────────────
# Create / delete op helpers
# ──────────────────────────────────────────────────────────────────────


def _create_wall_in_sandbox(
    model: "ifcopenshell.file", op: dict[str, Any], idx: int
) -> None:
    """Create a wall between two XY endpoints in *model*.

    Required op keys: start ([x,y] or [x,y,z]), end ([x,y] or [x,y,z]).
    Optional: height (default 3.0 m), thickness (default 0.2 m),
              storey_name (fuzzy match; None → lowest storey),
              name (element Name attribute).

    Thin wrapper over the shared ``element_factory.create_wall`` recipe -
    the SAME code the operation layer's direct ``create_wall`` op runs, so
    the AI's staged walls and the editor's drawn walls are identical. (The
    previous hand-rolled ShapeBuilder recipe silently broke on ifcopenshell
    0.8.5 keyword drift - keep this a delegation, never a re-implementation.)
    """
    from app.services import element_factory

    start_raw = op.get("start")
    end_raw = op.get("end")
    if not start_raw or not end_raw:
        raise ValueError(f"Op #{idx} (create_wall): 'start' and 'end' are required")
    try:
        element_factory.create_wall(
            model,
            start=start_raw,
            end=end_raw,
            height=float(op.get("height") or element_factory.DEFAULT_WALL_HEIGHT_M),
            thickness=float(op.get("thickness") or element_factory.DEFAULT_WALL_THICKNESS_M),
            storey_name=op.get("storey_name") or None,
            name=str(op.get("name") or "Wall"),
        )
    except ValueError as exc:
        raise ValueError(f"Op #{idx} (create_wall): {exc}") from exc


def _delete_element_in_sandbox(
    model: "ifcopenshell.file", op: dict[str, Any], idx: int
) -> None:
    """Remove an IfcProduct from *model* by express id (shared factory recipe)."""
    from app.services import element_factory

    element_id = op.get("element_id")
    if element_id is None:
        raise ValueError(f"Op #{idx} (delete_element): 'element_id' is required")

    try:
        entity = model.by_id(int(element_id))
    except (RuntimeError, ValueError):
        entity = None
    if entity is None:
        raise ValueError(f"Op #{idx} (delete_element): element {element_id} not found")
    try:
        element_factory.delete_product(model, entity)
    except ValueError as exc:
        raise ValueError(f"Op #{idx} (delete_element): {exc}") from exc


# ──────────────────────────────────────────────────────────────────────
# D4 verifier - health delta + geometry sanity on the sandbox BEFORE the
# pending edit is presented (Text2BIM checker pattern). Advisory: a verifier
# crash must never block a proposal, and a 'fail' verdict still lets the
# user apply (they see the verdict in the diff preview and decide).
# ──────────────────────────────────────────────────────────────────────

# Health baselines are expensive on big models; the live model's baseline is
# stable per fingerprint, so cache the most recent few.
_HEALTH_BASELINE_CACHE: dict[str, dict[str, int]] = {}
_HEALTH_BASELINE_CACHE_MAX = 4
_VERIFIER_GEOMETRY_CAP = 20


def _verify_sandbox(
    sandbox_model: "ifcopenshell.file",
    live_model: "ifcopenshell.file",
    live_fingerprint: str,
    changes: list,
) -> Optional[dict[str, Any]]:
    """Verdict dict for the envelope, or None when verification is impossible."""
    try:
        from app.services.model_health import run_health_check

        baseline = _HEALTH_BASELINE_CACHE.get(live_fingerprint)
        if baseline is None:
            baseline = dict(
                run_health_check(live_model, limit_per_rule=5).get("by_severity") or {}
            )
            _HEALTH_BASELINE_CACHE[live_fingerprint] = baseline
            while len(_HEALTH_BASELINE_CACHE) > _HEALTH_BASELINE_CACHE_MAX:
                _HEALTH_BASELINE_CACHE.pop(next(iter(_HEALTH_BASELINE_CACHE)))

        after = dict(
            run_health_check(sandbox_model, limit_per_rule=5).get("by_severity") or {}
        )
        new_errors = max(0, int(after.get("error", 0)) - int(baseline.get("error", 0)))
        new_warnings = max(0, int(after.get("warning", 0)) - int(baseline.get("warning", 0)))

        geometry = _geometry_sanity(sandbox_model, changes)

        if new_errors or geometry["failures"]:
            status = "fail"
        elif new_warnings:
            status = "warn"
        else:
            status = "pass"
        note_bits: list[str] = []
        if new_errors:
            note_bits.append(f"{new_errors} new health error(s)")
        if new_warnings:
            note_bits.append(f"{new_warnings} new warning(s)")
        if geometry["failures"]:
            note_bits.append(f"{len(geometry['failures'])} created element(s) with degenerate geometry")
        return {
            "status": status,
            "new_errors": new_errors,
            "new_warnings": new_warnings,
            "baseline": baseline,
            "after": after,
            "geometry": geometry,
            "note": "; ".join(note_bits) or "no new issues introduced",
        }
    except Exception:  # noqa: BLE001 - advisory only
        logger.warning("sandbox verifier failed (proposal continues)", exc_info=True)
        return None


def _geometry_sanity(sandbox_model: "ifcopenshell.file", changes: list) -> dict[str, Any]:
    """Tessellate created products and flag failures/degenerate AABBs (F7-lite).

    This is exactly the check that would have caught the broken wall recipe:
    a wall whose representation fails to tessellate or collapses to a plane.
    """
    created_ids = [
        c.express_id for c in changes if getattr(c, "change", None) == "created"
    ][:_VERIFIER_GEOMETRY_CAP]
    failures: list[dict[str, Any]] = []
    checked = 0
    if not created_ids:
        return {"checked": 0, "failures": []}

    try:
        import ifcopenshell.geom as geom

        settings = geom.settings()
        try:
            settings.set("use-world-coords", True)
        except Exception:  # pragma: no cover - pre-0.8 settings API
            settings.set(settings.USE_WORLD_COORDS, True)
    except Exception:  # pragma: no cover - geom module unavailable
        return {"checked": 0, "failures": []}

    for eid in created_ids:
        try:
            entity = sandbox_model.by_id(eid)
        except RuntimeError:
            continue
        if entity is None or not entity.is_a("IfcProduct"):
            continue
        # Products without their own representation (e.g. storeys) are fine.
        if getattr(entity, "Representation", None) is None:
            continue
        checked += 1
        try:
            shape = geom.create_shape(settings, entity)
            verts = shape.geometry.verts
            if not verts:
                failures.append({"express_id": eid, "reason": "no geometry produced"})
                continue
            xs, ys, zs = verts[0::3], verts[1::3], verts[2::3]
            extents = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
            degenerate = sum(1 for e in extents if e < 1e-6) >= 2
            if degenerate:
                failures.append({
                    "express_id": eid,
                    "reason": f"degenerate bounding box {tuple(round(e, 6) for e in extents)}",
                })
        except Exception as exc:  # tessellation failure IS the finding
            failures.append({"express_id": eid, "reason": f"tessellation failed: {exc}"})
    return {"checked": checked, "failures": failures}


def _verifier_note(verdict: Optional[dict[str, Any]]) -> str:
    """One-line suffix for LLM-facing tool results so the agent can
    self-repair in the same turn when verification flags problems."""
    if not verdict:
        return ""
    if verdict.get("status") == "pass":
        return " Verifier: PASS (no new issues)."
    return (
        f" Verifier: {str(verdict.get('status', '')).upper()} - {verdict.get('note', '')}. "
        "Consider discarding this pending edit and proposing a corrected one."
    )


# ──────────────────────────────────────────────────────────────────────
# Helpers - hashing, diff, summary
# ──────────────────────────────────────────────────────────────────────


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _apply_property_edit(
    entity, property_name: str, pset_name: Optional[str], new_value: Any
) -> None:
    """Find the single-value property + assign. Raises if not found."""
    wanted_pset = (pset_name or "").strip().lower()
    wanted_prop = property_name.strip().lower()

    for rel in getattr(entity, "IsDefinedBy", []) or []:
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        pset = rel.RelatingPropertyDefinition
        if not pset.is_a("IfcPropertySet"):
            continue
        if wanted_pset and (pset.Name or "").strip().lower() != wanted_pset:
            continue
        for prop in pset.HasProperties:
            if not prop.is_a("IfcPropertySingleValue"):
                continue
            if (prop.Name or "").strip().lower() != wanted_prop:
                continue
            nominal = prop.NominalValue
            if nominal is None:
                raise ValueError(
                    f"Property {property_name} on element {entity.id()} has no nominal value"
                )
            current = nominal.wrappedValue
            nominal.wrappedValue = _coerce_value(new_value, current)
            return
    raise ValueError(
        f"Property '{property_name}'"
        + (f" in '{pset_name}'" if pset_name else "")
        + f" not found on element {entity.id()}"
    )


def _coerce_value(value: Any, current: Any) -> Any:
    if isinstance(current, bool):
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)
    if isinstance(current, int) and not isinstance(current, bool):
        return int(value) if value is not None else 0
    if isinstance(current, float):
        return float(value) if value is not None else 0.0
    if value is None:
        return None
    return str(value) if isinstance(current, str) else value


# Sentinel property-name used to represent pset attach/detach churn via
# IfcRelDefinesByProperties. Surfaces in the diff as
# ``<pset>.<pset binding>: None → attached`` when a pset is wired to a new
# element (and vice-versa on detach). Without this marker a proposal that
# only rewires an IfcRel without editing a single-value property would
# produce a hash-different-but-empty diff and the Apply button would stay
# disabled.
PSET_BINDING_KEY = "<pset binding>"


def _fmt_enumerated(prop) -> str:
    """Stable string repr for an ``IfcPropertyEnumeratedValue``.

    We don't care about the reference-identity enumeration (``EnumerationReference``)
    - only the enumerated values matter for diffing.
    """
    try:
        vals = [getattr(v, "wrappedValue", v) for v in (prop.EnumerationValues or [])]
    except Exception:
        vals = []
    return "enum:" + repr(vals)


def _fmt_list(prop) -> str:
    try:
        vals = [getattr(v, "wrappedValue", v) for v in (prop.ListValues or [])]
    except Exception:
        vals = []
    return "list:" + repr(vals)


def _fmt_bounded(prop) -> str:
    lo = getattr(prop, "LowerBoundValue", None)
    up = getattr(prop, "UpperBoundValue", None)
    lo_v = getattr(lo, "wrappedValue", None) if lo is not None else None
    up_v = getattr(up, "wrappedValue", None) if up is not None else None
    return f"bounded:[{lo_v}..{up_v}]"


def _read_properties_by_pset(entity) -> dict[str, dict[str, Any]]:
    """Flatten an element's property sets into ``{pset_name: {prop_name: value}}``.

    The prototype originally only handled ``IfcPropertySingleValue``. That was
    enough for the ``set_property`` op but left a gap: any ``execute_ifc_code``
    proposal that added / removed a pset (churning an ``IfcRelDefinesByProperties``)
    or edited a ``IfcPropertyEnumeratedValue`` / ``IfcPropertyListValue`` /
    ``IfcPropertyBoundedValue`` produced a hash-different sandbox with an
    empty diff - a footgun for the Apply/Discard UX.

    Two widenings here:

    1. Every touched pset gets a ``PSET_BINDING_KEY`` sentinel entry so
       attach/detach via ``IfcRelDefinesByProperties`` surfaces in the diff
       even when the pset has no readable values.
    2. ``IfcPropertyEnumeratedValue``, ``IfcPropertyListValue``, and
       ``IfcPropertyBoundedValue`` are normalised to stable string reprs so
       their mutations show up as ``property_changed`` rows.
    """
    out: dict[str, dict[str, Any]] = {}
    for rel in getattr(entity, "IsDefinedBy", []) or []:
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        pset = rel.RelatingPropertyDefinition
        if not pset.is_a("IfcPropertySet"):
            continue
        bucket = out.setdefault(pset.Name or "Unnamed", {})
        # Binding sentinel - ensures attach/detach surfaces even when the
        # pset carries no diff-visible properties.
        bucket[PSET_BINDING_KEY] = "attached"
        for prop in pset.HasProperties:
            if prop.is_a("IfcPropertySingleValue"):
                nominal = prop.NominalValue
                bucket[prop.Name] = nominal.wrappedValue if nominal else None
            elif prop.is_a("IfcPropertyEnumeratedValue"):
                bucket[prop.Name] = _fmt_enumerated(prop)
            elif prop.is_a("IfcPropertyListValue"):
                bucket[prop.Name] = _fmt_list(prop)
            elif prop.is_a("IfcPropertyBoundedValue"):
                bucket[prop.Name] = _fmt_bounded(prop)
            # Other property shapes (table, reference) are ignored here;
            # attach/detach of their parent pset is still captured by the
            # binding sentinel above.
    return out


def _compute_diff(base: ifcopenshell.file, sandbox: ifcopenshell.file) -> list[PendingEditElement]:
    """Walk IfcProducts by express id and bucket differences.

    We only iterate the base + sandbox IfcProduct+IfcElementType universe to
    keep the prototype cheap - that covers every tier-3 write tool we ship
    today. Relationship churn surfaces as property_changed on touched
    products.
    """
    changes: list[PendingEditElement] = []

    base_by_id: dict[int, Any] = {}
    for kind in ("IfcProduct", "IfcElementType"):
        for e in base.by_type(kind):
            base_by_id[e.id()] = e

    sandbox_by_id: dict[int, Any] = {}
    for kind in ("IfcProduct", "IfcElementType"):
        for e in sandbox.by_type(kind):
            sandbox_by_id[e.id()] = e

    # Deleted in sandbox (present in base, missing in sandbox)
    for expr_id, base_entity in base_by_id.items():
        if expr_id in sandbox_by_id:
            continue
        changes.append(
            PendingEditElement(
                express_id=expr_id,
                ifc_type=base_entity.is_a(),
                change="deleted",
                name_before=getattr(base_entity, "Name", None),
            )
        )

    # Created in sandbox (present in sandbox, missing in base)
    for expr_id, sandbox_entity in sandbox_by_id.items():
        if expr_id in base_by_id:
            continue
        changes.append(
            PendingEditElement(
                express_id=expr_id,
                ifc_type=sandbox_entity.is_a(),
                change="created",
                name_after=getattr(sandbox_entity, "Name", None),
            )
        )

    # Mutated in sandbox (present in both)
    for expr_id, base_entity in base_by_id.items():
        sandbox_entity = sandbox_by_id.get(expr_id)
        if sandbox_entity is None:
            continue

        base_type = base_entity.is_a()
        sandbox_type = sandbox_entity.is_a()
        base_name = getattr(base_entity, "Name", None)
        sandbox_name = getattr(sandbox_entity, "Name", None)

        if base_type != sandbox_type:
            changes.append(
                PendingEditElement(
                    express_id=expr_id,
                    ifc_type=sandbox_type,
                    change="retyped",
                    name_before=base_name,
                    name_after=sandbox_name,
                    ifc_type_before=base_type,
                    ifc_type_after=sandbox_type,
                )
            )
            continue

        # Property diff first so a rename+property-edit gets both.
        prop_changes: list[dict[str, Any]] = []
        base_props = _read_properties_by_pset(base_entity)
        sandbox_props = _read_properties_by_pset(sandbox_entity)
        for pset_name in set(base_props) | set(sandbox_props):
            b = base_props.get(pset_name, {})
            s = sandbox_props.get(pset_name, {})
            for prop_name in set(b) | set(s):
                if b.get(prop_name) != s.get(prop_name):
                    prop_changes.append(
                        {
                            "property_set": pset_name,
                            "property_name": prop_name,
                            "before": b.get(prop_name),
                            "after": s.get(prop_name),
                        }
                    )

        if prop_changes:
            changes.append(
                PendingEditElement(
                    express_id=expr_id,
                    ifc_type=sandbox_type,
                    change="property_changed",
                    name_before=base_name,
                    name_after=sandbox_name,
                    property_changes=prop_changes,
                )
            )
        elif base_name != sandbox_name:
            changes.append(
                PendingEditElement(
                    express_id=expr_id,
                    ifc_type=sandbox_type,
                    change="renamed",
                    name_before=base_name,
                    name_after=sandbox_name,
                )
            )

    # Stable order: affected express ids ascending.
    changes.sort(key=lambda c: c.express_id)
    return changes


def _count_changes(changes: list[PendingEditElement]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for c in changes:
        counts[c.change] = counts.get(c.change, 0) + 1
    counts["total"] = len(changes)
    return counts


def _default_summary(operations: list[dict[str, Any]], counts: dict[str, int]) -> str:
    """Short one-liner for the envelope + activity log.

    Two refinements over a bare summary:

    1. Correct pluralisation on the no-op branch (``1 op, no ...`` /
       ``2 ops, no ...``) - the old ``op(s)`` spelling leaked into the
       activity log.
    2. ``execute_ifc_code``-originated envelopes get a ``script: ``
       prefix so they're distinguishable from structured propose_edit
       summaries in a long activity log. Cheap, reversible, and keeps
       the activity-log filter "was this a scripted edit?" a substring
       match away.
    """
    bits: list[str] = []
    for label in ("renamed", "property_changed", "deleted", "created", "retyped"):
        n = counts.get(label, 0)
        if n:
            bits.append(f"{n} {label.replace('_', ' ')}")

    is_script = len(operations) == 1 and operations[0].get("op") == "execute_ifc_code"

    if not bits:
        if is_script:
            return "script ran, no structural change"
        n_ops = len(operations)
        return f"{n_ops} op{'s' if n_ops != 1 else ''}, no structural change"

    joined = ", ".join(bits)
    return f"script: {joined}" if is_script else joined


# Singleton
sandbox_service = SandboxService()
