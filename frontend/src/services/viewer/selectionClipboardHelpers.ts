/**
 * Pure helpers that turn a SpatialNode into clipboard text. Used by the
 * viewer context menu ("Copy GlobalId", "Copy details") and the Ctrl+Shift+C
 * keyboard shortcut.
 *
 * Why three formats: BIM users round-trip element identifiers between
 * Solibri, Navisworks, BCF reports, Revit IDs, and free-form spreadsheets.
 * Express ID is the in-session integer (fast, but model-local), GlobalId is
 * the IFC GUID (canonical across tools and sessions), and "details" is the
 * everything-at-once paste for issue tickets and reviews.
 *
 * Kept pure (no clipboard side-effect, no THREE, no Zustand) so a) the
 * format choice is easy to unit-test and b) the helper composes with the
 * context-menu code path and the keyboard-shortcut code path without
 * duplicating logic.
 */
import type { SpatialNode } from '../../types/ifc';

export type ClipboardFormat = 'express-id' | 'global-id' | 'details' | 'json';

/** Minimal slice of SpatialNode we care about - accepts the full node or
 *  any object with the same shape (so tests can pass plain literals). */
export interface ClipboardNodeLike {
  id: number;
  global_id?: string | null;
  name?: string | null;
  ifc_type?: string | null;
  storey?: string | null;
}

/** Just the integer express id. Matches the legacy "Copy Express ID" copy
 *  behaviour. */
export function formatExpressIdOnly(node: ClipboardNodeLike): string {
  return String(node.id);
}

/** Just the IFC GlobalId / GUID. Returns empty string if absent - callers
 *  should fall back to express id and surface "no GUID" rather than copying
 *  a literal "null". */
export function formatGlobalId(node: ClipboardNodeLike): string {
  const g = node.global_id;
  if (!g || typeof g !== 'string') return '';
  return g;
}

/** Multi-line human-readable summary. Suitable for pasting into a BCF issue
 *  body, a clash report, or a Slack message. Lines are key-value pairs; the
 *  blank-value lines are omitted so a paste from a node missing storey/name
 *  doesn't carry "Storey: " / "Name: " stubs. */
export function formatElementDetails(node: ClipboardNodeLike): string {
  const lines: string[] = [];
  if (node.ifc_type) lines.push(`IFC Type: ${node.ifc_type}`);
  if (node.name) lines.push(`Name: ${node.name}`);
  lines.push(`Express ID: ${node.id}`);
  const gid = formatGlobalId(node);
  if (gid) lines.push(`GlobalId: ${gid}`);
  if (node.storey) lines.push(`Storey: ${node.storey}`);
  return lines.join('\n');
}

/** Structured JSON object as a string. Omits null / missing fields so the
 *  paste isn't full of `"name": null` noise. */
export function formatElementDetailsJson(node: ClipboardNodeLike): string {
  const payload: Record<string, string | number> = { express_id: node.id };
  const gid = formatGlobalId(node);
  if (gid) payload.global_id = gid;
  if (node.name) payload.name = node.name;
  if (node.ifc_type) payload.ifc_type = node.ifc_type;
  if (node.storey) payload.storey = node.storey;
  return JSON.stringify(payload, null, 2);
}

/** Pick the right formatter for the requested `format`. Single entry point
 *  the context menu + keyboard shortcut both call so the format-to-string
 *  mapping lives in one place. */
export function formatClipboardPayload(
  format: ClipboardFormat,
  node: ClipboardNodeLike,
): string {
  switch (format) {
    case 'express-id':
      return formatExpressIdOnly(node);
    case 'global-id':
      return formatGlobalId(node);
    case 'json':
      return formatElementDetailsJson(node);
    case 'details':
    default:
      return formatElementDetails(node);
  }
}

/** Short toast label for the activity log after a successful copy. The
 *  payload itself is too long to log; this is the human-readable variant. */
export function describeClipboardCopy(
  format: ClipboardFormat,
  node: ClipboardNodeLike,
): string {
  switch (format) {
    case 'express-id':
      return `Copied Express ID ${node.id}`;
    case 'global-id': {
      const gid = formatGlobalId(node);
      return gid ? `Copied GlobalId ${gid}` : `No GlobalId for #${node.id}`;
    }
    case 'json':
      return `Copied element JSON (#${node.id})`;
    case 'details':
    default:
      return `Copied element details (#${node.id})`;
  }
}

/** Write `text` to the clipboard. Swallows the SecurityError that fires on
 *  non-https origins / when the user denied permission - the call-site
 *  decides whether to log a failure or stay silent. Returns true if the
 *  write succeeded.
 *
 *  Kept out of the formatter functions so unit tests can exercise the
 *  format logic without stubbing `navigator.clipboard`. */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  if (!clip || typeof clip.writeText !== 'function') return false;
  try {
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Convenience wrapper used by the keyboard-shortcut path: look up the
 *  node, decide whether it's worth copying, format, write. Returns the
 *  activity-log summary string (or null if there was nothing to copy).
 *
 *  Note: caller is responsible for locating the SpatialNode - this stays
 *  free of the tree-walk so a test can pass a synthetic node. */
export async function copyNodeToClipboard(
  format: ClipboardFormat,
  node: ClipboardNodeLike | null,
): Promise<{ ok: boolean; summary: string } | null> {
  if (!node) return null;
  const payload = formatClipboardPayload(format, node);
  if (payload.length === 0) {
    return { ok: false, summary: describeClipboardCopy(format, node) };
  }
  const ok = await writeClipboardText(payload);
  return { ok, summary: describeClipboardCopy(format, node) };
}

/** A typed SpatialNode passes the structural check above. Re-exported so
 *  upstream code can keep using the canonical type while still going
 *  through the same helpers. */
export type { SpatialNode };

/** Project a `SpatialNode | null` (or anything with the same shape) into
 *  the minimal `ClipboardNodeLike` slice. Centralises the small adapter
 *  that the context menu and the Ctrl+Shift+C shortcut both need, so the
 *  field list (and the `?? null` default for `storey`) lives in one place.
 *  Returns null when the input is null so the caller can short-circuit. */
export function spatialNodeToClipboardNode(
  node: SpatialNode | null | undefined,
): ClipboardNodeLike | null {
  if (!node) return null;
  return {
    id: node.id,
    global_id: node.global_id,
    name: node.name,
    ifc_type: node.ifc_type,
    storey: node.storey ?? null,
  };
}
