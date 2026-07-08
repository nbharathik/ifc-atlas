import { useCallback, useEffect, useRef } from 'react';

interface ResizeHandleProps {
  /** Which side's width to resize. Determines the drag direction. */
  side: 'left' | 'right';
  /** localStorage key so the width persists across sessions. */
  storageKey: string;
  /** Clamp bounds in pixels. */
  min?: number;
  max?: number;
  /** Default width if nothing in localStorage yet. */
  defaultWidth: number;
  /** CSS custom property on :root that consumers read for width. */
  cssVar: string;
}

/**
 * Thin 4px drag handle. The handle sits at the edge of a panel and, when
 * dragged, updates a CSS custom property on :root - the panel's stylesheet
 * reads that variable so the width updates live. Persists to localStorage
 * so the user's sizing sticks across reloads.
 *
 * The dragged width is CLAMPED per [min, max] to prevent the panel from
 * becoming unusably small or larger than the viewport.
 */
export default function ResizeHandle({
  side,
  storageKey,
  min = 180,
  max = 600,
  defaultWidth,
  cssVar,
}: ResizeHandleProps) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);

  // Initialise CSS var from localStorage on mount so the panel renders
  // at the user's preferred width from the first paint.
  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    const n = raw ? parseInt(raw, 10) : NaN;
    const w = Number.isFinite(n) && n >= min && n <= max ? n : defaultWidth;
    document.documentElement.style.setProperty(cssVar, `${w}px`);
  }, [storageKey, cssVar, min, max, defaultWidth]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startXRef.current;
    // Dragging right of a left-side handle grows the LEFT panel.
    // Dragging left of a right-side handle (sitting at the left edge
    // of the right panel) grows the RIGHT panel.
    const delta = side === 'left' ? dx : -dx;
    const next = Math.max(min, Math.min(max, startWidthRef.current + delta));
    document.documentElement.style.setProperty(cssVar, `${next}px`);
  }, [side, min, max, cssVar]);

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.classList.remove('is-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    // Persist the final width from the CSS var
    const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    const n = parseInt(current, 10);
    if (Number.isFinite(n)) {
      try { localStorage.setItem(storageKey, String(n)); } catch { /* quota ignored */ }
    }
  }, [cssVar, onPointerMove, storageKey]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    startWidthRef.current = parseInt(current, 10) || defaultWidth;
    document.body.classList.add('is-resizing');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, [cssVar, defaultWidth, onPointerMove, onPointerUp]);

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side === 'left' ? 'outliner' : 'inspector'} panel`}
    />
  );
}
