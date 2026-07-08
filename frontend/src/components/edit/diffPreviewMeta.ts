/**
 * Pure helpers for ``DiffPreviewPanel``, extracted during A2 finish so
 * the execute_ifc_code badge logic can be unit-tested without standing
 * up a React DOM testing harness.
 *
 * Everything here is side-effect-free and takes a ``PendingEditEnvelope``
 * (or ``null``) as input. JSX lives in ``DiffPreviewPanel.tsx``; anything
 * a future test wants to pin behaviour on should land here.
 */

import type { PendingEditEnvelope } from '../../types/ifc';

/** Metadata surfaced alongside the "execute_ifc_code" badge in the diff
 *  preview header. Both numeric fields are optional - the sandbox might
 *  have trimmed them (very short scripts) or the backend may have shipped
 *  an envelope before the elapsed_ms field landed. */
export interface ExecuteIfcCodeMeta {
  elapsedMs: number | null;
  codeChars: number | null;
}

/** Shape of the synthetic op the sandbox stuffs into the envelope when
 *  ``execute_ifc_code`` produced a structural change. See
 *  ``backend/app/services/sandbox_service.execute_python``. */
interface ExecuteIfcCodeOp {
  op?: string;
  code_chars?: number;
  elapsed_ms?: number;
}

function toPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Returns the execute_ifc_code meta block when the envelope came from
 *  that tier-3 tool, ``null`` otherwise. Safe on undefined / empty
 *  ``operations`` arrays.
 *
 *  Why this shape: the panel renders a badge + an "sandbox ran in Nms ·
 *  K chars" tagline only when BOTH the op kind is execute_ifc_code AND
 *  at least the elapsedMs is present. Keeping this single decision point
 *  in one helper means the vitest suite can freeze the contract. */
export function getExecuteIfcCodeMeta(
  envelope: PendingEditEnvelope | null | undefined,
): ExecuteIfcCodeMeta | null {
  if (!envelope) return null;
  const firstOp = envelope.operations?.[0] as ExecuteIfcCodeOp | undefined;
  if (!firstOp || firstOp.op !== 'execute_ifc_code') return null;
  return {
    elapsedMs: toPositiveInt(firstOp.elapsed_ms),
    codeChars: toPositiveInt(firstOp.code_chars),
  };
}

/** Format a single count-bucket for the header chip row. Pure string
 *  builder kept here so tests can pin pluralisation rules. */
export function formatCountBadge(
  label: 'renamed' | 'property_changed' | 'deleted' | 'created' | 'retyped',
  count: number,
): string {
  if (count <= 0) return '';
  const human = label.replace('_', ' ');
  return `${count} ${human}`;
}
