/**
 * External store for the cursor-following measurement tip.
 *
 * Same shape as hoverTooltipBridge and for the same reason: the tip updates on
 * every pointer move while measuring, and routing that through ViewerPanel
 * state would reconcile the whole viewer per move. The move handler writes
 * here; the leaf MeasurementCursorTip component is the only React subscriber.
 */

export interface MeasurementTipData {
  x: number;
  y: number;
  /** Main value, already formatted: "2.348 m", "12.4 m2", "34.2deg". */
  primary: string | null;
  /** Extra context: slope for distances, perimeter for areas. */
  secondary: string | null;
  /** What to do next, shown until a value exists: "Click start point". */
  hint: string | null;
  snap: { label: string; exact: boolean } | null;
}

let current: MeasurementTipData | null = null;
const listeners = new Set<() => void>();

export function setMeasurementTip(next: MeasurementTipData | null): void {
  if (next === null && current === null) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getMeasurementTip(): MeasurementTipData | null {
  return current;
}

export function subscribeMeasurementTip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
