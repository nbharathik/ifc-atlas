/**
 * Tiny external store for the 3D-canvas hover tooltip.
 *
 * Why not ViewerPanel state: the tooltip updates at up to ~12 Hz during hover
 * sweeps, and a `useState` on ViewerPanel reconciled the entire ~5k-line
 * component per update. The pointermove handler writes here; the
 * leaf `ViewerHoverTooltip` component is the only React subscriber, so a
 * tooltip move re-renders ~20 DOM nodes instead of the whole viewer.
 *
 * Kept dependency-free (no zustand, no THREE) - it's a five-line pub/sub
 * consumed via useSyncExternalStore.
 */

export interface HoverTooltipData {
  x: number;
  y: number;
  name: string;
  type: string;
  storey?: string | null;
}

let current: HoverTooltipData | null = null;
const listeners = new Set<() => void>();

export function setHoverTooltipData(next: HoverTooltipData | null): void {
  // Cheap dedupe: clearing an already-cleared tooltip is the common case
  // (every void crossing / pointer-leave) - skip the notify storm.
  if (next === null && current === null) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getHoverTooltipData(): HoverTooltipData | null {
  return current;
}

export function subscribeHoverTooltip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
