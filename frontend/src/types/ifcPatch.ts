/**
 * Typed patch-protocol payloads for the AI-native IFC engine.
 *
 * Mirror of `backend/app/models/patch.py`, part of the engine described in
 * `docs/architecture/AI_NATIVE_ENGINE.md`. Hand-maintained parity for now; a
 * future codegen step could generate both from a shared JSON schema.
 *
 * These types define the wire format of the `ifc_patch` WebSocket event.
 * Nothing consumes them yet - this is foundation for future work.
 */

/** Common fields on every patch. */
export interface IfcPatchBase {
  /** Monotonic sequence number within the session. */
  seq: number;
  /** SHA-256 of the authoritative IFC bytes at emission time. */
  source_sha256: string;
  /** Server wall-clock at emission (ms since epoch). */
  timestamp_ms: number;
  /** Who caused the change. Surfaces in activity log. */
  actor: 'user' | 'agent' | 'system';
  /** Which agent preset emitted this (only when actor = 'agent'). */
  agent_id?: string | null;
}

export interface AttributeChanged extends IfcPatchBase {
  kind: 'attribute_changed';
  express_id: number;
  attribute: string;
  old_value?: unknown;
  new_value: unknown;
}

export interface PsetChanged extends IfcPatchBase {
  kind: 'pset_changed';
  express_id: number;
  pset_name: string;
  /** Property name → new value. null deletes the property. */
  changes: Record<string, unknown>;
}

export interface ElementAdded extends IfcPatchBase {
  kind: 'element_added';
  express_id: number;
  ifc_type: string;
  storey_express_id?: number | null;
  /**
   * URL to a mini-.frag containing geometry for the new element. If null,
   * the element is metadata-only (e.g. an IfcPropertySet).
   */
  frag_delta_url?: string | null;
}

export interface ElementRemoved extends IfcPatchBase {
  kind: 'element_removed';
  express_id: number;
  ifc_type: string;
}

export interface GeometryChanged extends IfcPatchBase {
  kind: 'geometry_changed';
  express_ids: number[];
  /** URL to the mini-.frag containing replacement geometry. */
  frag_delta_url: string;
}

export interface StoreyChanged extends IfcPatchBase {
  kind: 'storey_changed';
  express_id: number;
  old_storey_express_id?: number | null;
  new_storey_express_id?: number | null;
}

/** Discriminated union - narrow on `kind`. */
export type IfcPatch =
  | AttributeChanged
  | PsetChanged
  | ElementAdded
  | ElementRemoved
  | GeometryChanged
  | StoreyChanged;

/**
 * Multiple patches delivered atomically in one WS message. Single edits
 * with multiple side-effects (e.g. "rename wall + reassign storey")
 * arrive as a batch so the frontend applies them without an intermediate
 * inconsistent visual state.
 */
export interface IfcPatchBatch {
  patches: IfcPatch[];
}

/** Runtime type-narrowing helper. */
export function patchKind(patch: IfcPatch): IfcPatch['kind'] {
  return patch.kind;
}
