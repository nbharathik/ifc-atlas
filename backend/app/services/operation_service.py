"""Operation layer, the single audited write path for the IFC model.

Every mutation of the authoritative ``ifcopenshell`` model is expressed as a
named :class:`OpSpec` with typed params and driven through
:class:`OperationService`. One call site, one vocabulary, shared by the UI, the
AI chat, and the MCP server. The service:

* validates params against the op's declared schema,
* dispatches to the op's executor (which calls into :class:`IfcService` or, for
  free-form Python, the sandbox),
* classifies the resulting change into a sync **patch tier** so the frontend can
  pick the cheapest correct update (Invariant 5),
* records it to an append-only, per-model **operation log** with **actor**
  attribution (``user`` / ``agent`` / ``mcp`` / ``system``), the durable
  "who changed what" audit trail that the history timeline (Workstream C) and
  undo/redo build on,
* returns a normalized :class:`OperationResult`.

This is the Bonsai / FreeCAD-NativeIFC "operator" pattern adapted to our
client/server split: the IFC file stays the single source of truth, and every
surface drives the *same* operations. See
``dev/docs/AI_BIM_EDITOR_MASTER_PLAN.md`` (Workstream A) and ADR 003.

Design notes
------------
* Executors take ``(ifc_service, params)`` and are passed the service at call
  time rather than importing it, so this module has no import cycle with
  :mod:`app.services.ifc_service` and unit tests can drive it with a fake.
* Nothing here raises for ordinary bad input. Unknown op, invalid params, and
  executor failures all come back as ``ok=False`` results with ``error`` set,
  because the primary callers are LLM tools that must receive structured JSON,
  never an exception. Truly exceptional misuse (no model loaded) surfaces as an
  ``ok=False`` result too.
* Undo delegates to :meth:`IfcService.undo_last_edit` (the existing, robust
  inverse-delta stack). Redo is reconstructed from the operation log: an undone
  edit is looked up by its ``edit_id`` and, when the forward op is
  deterministically replayable, pushed onto a redo stack. Geometry-creating ops
  become redoable once transaction-backed undo lands (plan A8); until then their
  undo simply breaks the redo chain, which is safe.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from app.core.config import DATA_DIR

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Vocabulary
# ──────────────────────────────────────────────────────────────────────


class Actor(str, Enum):
    """Who initiated an operation. Recorded on every log entry so history can
    answer "what did the AI change" vs "what did I change"."""

    USER = "user"       # a human, via the editor UI
    AGENT = "agent"     # the in-app chat LLM
    MCP = "mcp"         # an external MCP client (Claude Desktop, etc.)
    SYSTEM = "system"   # generators, migrations, internal maintenance


class PatchTier(str, Enum):
    """The cheapest correct frontend update for a change (Invariant 5, extended
    with a transform-only tier for the editor's move/rotate path)."""

    NONE = "none"               # no-op; nothing to sync
    METADATA = "metadata"       # names/props/psets/quantities, no geometry
    TRANSFORM = "transform"     # placement only; update instance matrices, no re-tessellation
    GEOMETRY = "geometry"       # shapes added/removed/reshaped for specific elements
    BULK = "bulk"               # structural churn; full model refresh


# The ``action`` string that IfcService write methods already return, mapped to
# the tier vocabulary above. Unknown/absent actions on a real change default to
# METADATA (the safe cheap tier for attribute edits).
_ACTION_TO_TIER: dict[str, PatchTier] = {
    "metadata_changed": PatchTier.METADATA,
    "transform_changed": PatchTier.TRANSFORM,
    "geometry_changed": PatchTier.GEOMETRY,
    "model_refresh": PatchTier.BULK,
}

# Marker for a param that accepts any non-None value (e.g. a property value that
# may be str/int/float/bool).
ANY: Any = object()

# Cap on serialized params stored per log line, so a 100k-char ``execute_ifc_code``
# blob or a huge batch never bloats the oplog.
_MAX_PARAM_CHARS = 4000


# ──────────────────────────────────────────────────────────────────────
# Op spec + result
# ──────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class OpSpec:
    """A named, typed, executable operation."""

    name: str
    summary: str
    executor: Callable[[Any, dict[str, Any]], dict[str, Any]]
    required: dict[str, Any] = field(default_factory=dict)   # param -> expected type / ANY
    optional: dict[str, Any] = field(default_factory=dict)
    writes: bool = True
    default_tier: PatchTier = PatchTier.METADATA
    # Redoable = re-running the op with the same params deterministically
    # reproduces the effect (true for pure attribute edits on existing entities;
    # false for anything that mints new express ids).
    redoable: bool = True

    def validate(self, params: dict[str, Any]) -> Optional[str]:
        """Return an error string if *params* is invalid, else ``None``."""
        if not isinstance(params, dict):
            return "params must be an object"
        for key, expected in self.required.items():
            if key not in params or params[key] is None:
                return f"missing required param '{key}'"
            if expected is ANY:
                continue
            if not isinstance(params[key], expected):
                type_name = (
                    "/".join(t.__name__ for t in expected)
                    if isinstance(expected, tuple)
                    else expected.__name__
                )
                return f"param '{key}' must be {type_name}"
        return None


@dataclass
class OperationResult:
    """Normalized outcome of one operation."""

    op_id: str
    name: str
    actor: Actor
    ok: bool
    changed: bool
    changed_ids: list[int]
    patch_tier: PatchTier
    description: str
    detail: dict[str, Any]           # the raw executor return, for the caller
    edit_id: Optional[str] = None    # links to IfcService undo/checkpoint bookkeeping
    error: Optional[str] = None
    ts: float = field(default_factory=time.time)

    def to_public_dict(self) -> dict[str, Any]:
        """Shape returned to tool/MCP callers."""
        out: dict[str, Any] = {
            "op_id": self.op_id,
            "operation": self.name,
            "actor": self.actor.value,
            "ok": self.ok,
            "changed": self.changed,
            "changed_ids": self.changed_ids,
            "patch_tier": self.patch_tier.value,
            "description": self.description,
            # Preserve the legacy sync-action field so existing route/WS code
            # that reads result["action"] keeps working unchanged.
            "action": self.detail.get("action"),
            **({k: v for k, v in self.detail.items() if k not in {"action"}}),
        }
        if self.edit_id:
            out["edit_id"] = self.edit_id
        if self.error:
            out["error"] = self.error
        return out

    def to_log_entry(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "op_id": self.op_id,
            "ts": self.ts,
            "actor": self.actor.value,
            "name": self.name,
            "params": _truncate_params(params),
            "ok": self.ok,
            "changed": self.changed,
            "patch_tier": self.patch_tier.value,
            "changed_ids": self.changed_ids[:200],
            "description": self.description,
            "edit_id": self.edit_id,
            "error": self.error,
        }


def _truncate_params(params: dict[str, Any]) -> dict[str, Any]:
    """Keep the oplog small: replace oversized param blobs with a marker."""
    try:
        blob = json.dumps(params, default=str)
    except (TypeError, ValueError):
        return {"_unserializable": True}
    if len(blob) <= _MAX_PARAM_CHARS:
        return params
    return {"_truncated": True, "_bytes": len(blob), "keys": sorted(params.keys())}


# ──────────────────────────────────────────────────────────────────────
# Operation log (append-only JSONL, per model)
# ──────────────────────────────────────────────────────────────────────


class OperationLog:
    """Append-only JSONL log bound to one model. All IO is best-effort: a
    logging failure must never fail the edit it is recording."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, entry: dict[str, Any]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, default=str) + "\n")
        except OSError as exc:  # pragma: no cover - defensive
            logger.warning("operation log append failed (%s): %s", self.path, exc)

    def read_recent(self, limit: int = 100) -> list[dict[str, Any]]:
        """Newest-first list of recent entries."""
        if not self.path.exists():
            return []
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:  # pragma: no cover - defensive
            logger.warning("operation log read failed (%s): %s", self.path, exc)
            return []
        out: list[dict[str, Any]] = []
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(out) >= limit:
                break
        return out

    def find_edit(self, edit_id: str) -> Optional[dict[str, Any]]:
        """Return the most recent *forward* op entry that produced *edit_id*.

        Undo bookkeeping entries carry the reverted edit_id too, so they are
        skipped, we want the original op that can be replayed for redo.
        """
        for entry in self.read_recent(limit=10000):
            if entry.get("name") in ("undo", "redo"):
                continue
            if entry.get("edit_id") == edit_id:
                return entry
        return None


# ──────────────────────────────────────────────────────────────────────
# Service
# ──────────────────────────────────────────────────────────────────────


class OperationService:
    """Global registry + dispatcher for model operations."""

    def __init__(self) -> None:
        self._registry: dict[str, OpSpec] = {}
        self._log: Optional[OperationLog] = None
        self._log_key: Optional[str] = None
        # Redo entries: (op_name, params, actor) for undone, replayable ops.
        self._redo_stack: list[tuple[str, dict[str, Any], Actor]] = []

    # -- registry ------------------------------------------------------

    def register(self, spec: OpSpec) -> None:
        self._registry[spec.name] = spec

    def get(self, name: str) -> Optional[OpSpec]:
        return self._registry.get(name)

    def catalogue(self) -> list[dict[str, Any]]:
        """Machine-readable list of registered ops (for docs / tool wiring)."""
        return [
            {
                "name": s.name,
                "summary": s.summary,
                "writes": s.writes,
                "required": {k: ("any" if v is ANY else _type_name(v)) for k, v in s.required.items()},
                "optional": {k: ("any" if v is ANY else _type_name(v)) for k, v in s.optional.items()},
                "default_tier": s.default_tier.value,
            }
            for s in sorted(self._registry.values(), key=lambda s: s.name)
        ]

    # -- log binding ---------------------------------------------------

    def _bind_log(self, ifc_service: Any) -> None:
        """(Re)point the op log at the currently loaded model. Keyed by the
        model's *original* fingerprint so the log survives across edits (which
        re-fingerprint the working file every write)."""
        key = _stable_model_key(ifc_service)
        if key == self._log_key and self._log is not None:
            return
        self._log_key = key
        self._log = OperationLog(DATA_DIR / "oplog" / f"{key}.jsonl")
        # A new model context invalidates any redo chain from the old one.
        self._redo_stack.clear()

    # -- execution -----------------------------------------------------

    def execute(
        self,
        name: str,
        params: dict[str, Any],
        *,
        actor: Actor,
        ifc_service: Any,
        clear_redo: bool = True,
    ) -> OperationResult:
        """Run one operation. Never raises for ordinary bad input."""
        op_id = uuid.uuid4().hex
        spec = self._registry.get(name)
        if spec is None:
            return self._failed(op_id, name, actor, f"unknown operation '{name}'")

        err = spec.validate(params)
        if err is not None:
            return self._failed(op_id, name, actor, err)

        try:
            detail = spec.executor(ifc_service, params)
        except Exception as exc:  # executor / IfcOpenShell failure
            logger.warning("operation %s failed: %s", name, exc)
            result = self._failed(op_id, name, actor, str(exc))
            self._record(result, params, ifc_service)
            return result

        if not isinstance(detail, dict):
            detail = {"result": detail}

        changed = _derive_changed(detail)
        tier = _classify_tier(detail, spec.default_tier) if changed else PatchTier.NONE
        result = OperationResult(
            op_id=op_id,
            name=name,
            actor=actor,
            ok=True,
            changed=changed,
            changed_ids=[int(x) for x in detail.get("changed_ids", []) if _is_int(x)],
            patch_tier=tier,
            description=str(detail.get("description") or _synthesize_description(name, detail)),
            detail=detail,
            edit_id=detail.get("edit_id") or detail.get("reverted_edit_id"),
        )
        self._record(result, params, ifc_service)

        # A fresh forward edit invalidates the redo chain.
        if clear_redo and result.changed:
            self._redo_stack.clear()
        if result.changed:
            _auto_checkpoint(result, ifc_service)
        return result

    def record_external(
        self,
        *,
        name: str,
        actor: Actor,
        description: str,
        ifc_service: Any,
        changed_ids: Optional[list[int]] = None,
        edit_id: Optional[str] = None,
        patch_tier: PatchTier = PatchTier.BULK,
        params: Optional[dict[str, Any]] = None,
    ) -> OperationResult:
        """Append a synthetic entry for a mutation that happened OUTSIDE the op
        registry - a sandbox apply, a checkpoint rollback, a legacy undo.

        Keeps ``/operations/history`` a complete account of every model
        mutation (the C4 timeline must never contradict the model), and
        invalidates the redo chain, because the model just changed under any
        armed replay. Never raises; history recording must not break the
        mutation it describes.
        """
        result = OperationResult(
            op_id=uuid.uuid4().hex,
            name=name,
            actor=actor,
            ok=True,
            changed=True,
            changed_ids=[int(x) for x in (changed_ids or []) if _is_int(x)],
            patch_tier=patch_tier,
            description=description,
            detail={"external": True},
            edit_id=edit_id,
        )
        self._record(result, params or {}, ifc_service)
        self._redo_stack.clear()
        return result

    # -- undo / redo ---------------------------------------------------

    def undo(self, ifc_service: Any, *, actor: Actor = Actor.USER) -> OperationResult:
        """Reverse the most recent edit and, when possible, arm redo."""
        op_id = uuid.uuid4().hex
        try:
            detail = ifc_service.undo_last_edit()
        except Exception as exc:  # pragma: no cover - defensive
            return self._failed(op_id, "undo", actor, str(exc))

        undone = bool(detail.get("undone"))
        result = OperationResult(
            op_id=op_id,
            name="undo",
            actor=actor,
            ok=True,
            changed=undone,
            changed_ids=[int(x) for x in detail.get("changed_ids", []) if _is_int(x)],
            patch_tier=_classify_tier(detail, PatchTier.METADATA) if undone else PatchTier.NONE,
            description=str(detail.get("description") or "Undo"),
            detail=detail,
            edit_id=detail.get("reverted_edit_id"),
            error=None if undone else str(detail.get("reason") or "nothing to undo"),
        )
        self._record(result, {}, ifc_service)

        if not undone:
            return result

        # Try to make the just-undone edit redoable by finding its forward op in
        # the log. If we can't (pre-oplog edit, non-replayable op), the redo
        # chain is broken, which is correct.
        reverted = detail.get("reverted_edit_id")
        forward = self._log.find_edit(reverted) if (self._log and reverted) else None
        spec = self._registry.get(forward["name"]) if forward else None
        if forward and spec and spec.redoable and not forward.get("params", {}).get("_truncated"):
            self._redo_stack.append((forward["name"], forward["params"], actor))
        else:
            self._redo_stack.clear()
        return result

    def redo(self, ifc_service: Any, *, actor: Actor = Actor.USER) -> OperationResult:
        """Re-apply the most recently undone replayable op."""
        # Bind BEFORE popping: switching models clears the redo stack inside
        # _bind_log. Without this, a redo armed on model A would replay A's
        # params (element ids) against a freshly loaded model B.
        self._bind_log(ifc_service)
        if not self._redo_stack:
            return self._failed(uuid.uuid4().hex, "redo", actor, "nothing to redo")
        # Redo is replay-by-params: the redoer becomes the acting party (the
        # original actor is still on the forward op's log entry).
        name, params, _orig_actor = self._redo_stack.pop()
        # Re-executing must not itself clear the rest of the redo chain.
        return self.execute(
            name, params, actor=actor, ifc_service=ifc_service, clear_redo=False
        )

    def can_redo(self, ifc_service: Any = None) -> bool:
        if ifc_service is not None:
            self._bind_log(ifc_service)
        return bool(self._redo_stack)

    # -- history -------------------------------------------------------

    def history(self, ifc_service: Any, *, limit: int = 100) -> list[dict[str, Any]]:
        """Newest-first operation log for the current model."""
        self._bind_log(ifc_service)
        return self._log.read_recent(limit) if self._log else []

    # -- internals -----------------------------------------------------

    def _record(self, result: OperationResult, params: dict[str, Any], ifc_service: Any) -> None:
        try:
            self._bind_log(ifc_service)
            if self._log is not None:
                self._log.append(result.to_log_entry(params))
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("failed to record operation %s: %s", result.name, exc)

    def _failed(self, op_id: str, name: str, actor: Actor, error: str) -> OperationResult:
        return OperationResult(
            op_id=op_id,
            name=name,
            actor=actor,
            ok=False,
            changed=False,
            changed_ids=[],
            patch_tier=PatchTier.NONE,
            description=f"{name}: {error}",
            detail={},
            error=error,
        )

    # Test / lifecycle helpers.
    def _reset_redo(self) -> None:
        self._redo_stack.clear()


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _type_name(expected: Any) -> str:
    if isinstance(expected, tuple):
        return "/".join(t.__name__ for t in expected)
    return getattr(expected, "__name__", str(expected))


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _derive_changed(detail: dict[str, Any]) -> bool:
    if "changed" in detail:
        return bool(detail["changed"])
    if "changed_count" in detail:
        return int(detail.get("changed_count") or 0) > 0
    if "undone" in detail:
        return bool(detail["undone"])
    if "changed_ids" in detail:
        return len(detail.get("changed_ids") or []) > 0
    return False


def _classify_tier(detail: dict[str, Any], default: PatchTier) -> PatchTier:
    action = detail.get("action")
    if action in _ACTION_TO_TIER:
        return _ACTION_TO_TIER[action]
    return default


def _synthesize_description(name: str, detail: dict[str, Any]) -> str:
    if "changed_count" in detail:
        return f"{name}: {detail.get('changed_count', 0)} changed"
    return name


def _auto_checkpoint(result: "OperationResult", ifc_service: Any) -> None:
    """Best-effort git checkpoint after every applied operation (plan C1).

    Direct ops (UI inline edits, agent write tools) were previously
    checkpoint-invisible - only sandbox applies snapshotted - so a rollback
    could silently lose them. The message carries op name + actor so the
    history timeline can correlate commits with op-log entries.

    Uses the same read_bytes() source as the routes' _snapshot_after_edit;
    unit-test fakes without read_bytes are skipped. Never raises.
    """
    try:
        read_bytes = getattr(ifc_service, "read_bytes", None)
        if read_bytes is None:
            return
        data = read_bytes()
        if not data:
            return
        from app.services.ifc_checkpoint_service import ifc_checkpoint_service

        message = f"{result.name} ({result.actor.value}): {result.description}"[:200]
        ifc_checkpoint_service.snapshot(data, message)
    except Exception:  # pragma: no cover - checkpointing must never fail the edit
        logger.warning("auto-checkpoint after %s failed", result.name, exc_info=True)


def _stable_model_key(ifc_service: Any) -> str:
    """A key that is stable for one loaded model across its edits.

    Coerces defensively: a real IfcService returns str fingerprints, but a mock
    (in unit tests) returns non-str attributes, which must not become a garbage
    file path. Non-str → fall through to the ``session`` sentinel.
    """
    fp = getattr(ifc_service, "original_fingerprint", "")
    if isinstance(fp, str) and fp:
        return fp[:32]
    name = getattr(ifc_service, "original_filename", None)
    if isinstance(name, str) and name:
        return f"name-{Path(name).stem}"
    return "session"


# ──────────────────────────────────────────────────────────────────────
# Built-in op catalogue v1 (thin wrappers over existing IfcService writes).
# The write TOOLS route through these so every AI/UI/MCP edit is logged with
# actor attribution and a normalized result. Geometry/creation ops (create_wall,
# move_element, …) land in Workstream A2 on top of this same registry.
# ──────────────────────────────────────────────────────────────────────


def _op_set_name(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.rename_element(int(p["element_id"]), str(p["new_name"]))


def _op_set_property(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.update_property_value(
        int(p["element_id"]),
        str(p["property_name"]),
        p["new_value"],
        p.get("pset_name"),
    )


def _op_set_names_batch(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.rename_elements_batch(list(p["renames"]))


def _op_set_properties_batch(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.update_properties_batch(list(p["updates"]))


def _op_create_wall(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.create_wall(
        start=list(p["start"]),
        end=list(p["end"]),
        height=p.get("height"),
        thickness=p.get("thickness"),
        storey_name=p.get("storey_name"),
        name=str(p.get("name") or "Wall"),
    )


def _op_create_slab(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.create_slab(
        outline=list(p["outline"]),
        depth=p.get("depth"),
        storey_name=p.get("storey_name"),
        name=str(p.get("name") or "Slab"),
    )


def _op_create_storey(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.create_storey(
        name=str(p["name"]),
        elevation=float(p.get("elevation") or 0.0),
    )


def _op_assign_to_storey(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.assign_to_storey(int(p["element_id"]), int(p["storey_id"]))


def _op_set_storey_elevation(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.set_storey_elevation(int(p["storey_id"]), float(p["elevation"]))


def _op_delete_element(svc: Any, p: dict[str, Any]) -> dict[str, Any]:
    return svc.delete_element(int(p["element_id"]))


def _register_builtins(service: OperationService) -> None:
    service.register(OpSpec(
        name="set_name",
        summary="Rename a single element.",
        executor=_op_set_name,
        required={"element_id": int, "new_name": str},
        default_tier=PatchTier.METADATA,
    ))
    service.register(OpSpec(
        name="set_property",
        summary="Set a single property value on an element's property set.",
        executor=_op_set_property,
        required={"element_id": int, "property_name": str, "new_value": ANY},
        optional={"pset_name": str},
        default_tier=PatchTier.METADATA,
    ))
    service.register(OpSpec(
        name="set_names_batch",
        summary="Rename many elements in one undoable batch.",
        executor=_op_set_names_batch,
        required={"renames": list},
        default_tier=PatchTier.METADATA,
    ))
    service.register(OpSpec(
        name="set_properties_batch",
        summary="Set property values on many elements in one undoable batch.",
        executor=_op_set_properties_batch,
        required={"updates": list},
        default_tier=PatchTier.METADATA,
    ))
    # Structural ops (plan A2). BULK tier → viewers reload (correct-first per
    # ADR 005; targeted re-tessellation upgrades this later). Creations are
    # not redoable: replaying them would mint different express ids.
    service.register(OpSpec(
        name="create_wall",
        summary=(
            "Create a wall between two XY points (metres) on a storey work "
            "plane. Params: start [x,y], end [x,y]; optional height (m), "
            "thickness (m), storey_name, name."
        ),
        executor=_op_create_wall,
        required={"start": list, "end": list},
        optional={"height": (int, float), "thickness": (int, float), "storey_name": str, "name": str},
        default_tier=PatchTier.BULK,
        redoable=False,
    ))
    service.register(OpSpec(
        name="create_slab",
        summary=(
            "Create a slab from a closed XY polygon (metres) on a storey. "
            "Params: outline [[x,y],...] (≥3 points); optional depth (m), "
            "storey_name, name."
        ),
        executor=_op_create_slab,
        required={"outline": list},
        optional={"depth": (int, float), "storey_name": str, "name": str},
        default_tier=PatchTier.BULK,
        redoable=False,
    ))
    service.register(OpSpec(
        name="create_storey",
        summary="Create a building storey. Params: name; optional elevation (m).",
        executor=_op_create_storey,
        required={"name": str},
        optional={"elevation": (int, float)},
        default_tier=PatchTier.BULK,
        redoable=False,
    ))
    service.register(OpSpec(
        name="assign_to_storey",
        summary="Move an element to another storey (spatial containment).",
        executor=_op_assign_to_storey,
        required={"element_id": int, "storey_id": int},
        default_tier=PatchTier.BULK,
    ))
    service.register(OpSpec(
        name="set_storey_elevation",
        summary="Set a storey's Elevation attribute (metres).",
        executor=_op_set_storey_elevation,
        required={"storey_id": int, "elevation": (int, float)},
        default_tier=PatchTier.METADATA,
    ))
    service.register(OpSpec(
        name="delete_element",
        summary="Delete an IfcProduct (undo restores a pre-delete snapshot).",
        executor=_op_delete_element,
        required={"element_id": int},
        default_tier=PatchTier.BULK,
    ))


# Global singleton, mirrors ifc_service / sandbox_service.
operation_service = OperationService()
_register_builtins(operation_service)
