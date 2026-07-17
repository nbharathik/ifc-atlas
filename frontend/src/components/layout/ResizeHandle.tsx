import { useCallback, useEffect, useRef, useState } from 'react';
import { beginPanelResize, endPanelResize } from '../../services/viewer/panelResizeSession';

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

const resizeEnvironment = () => ({ body: document.body, events: window });

/**
 * Thin drag handle that updates a CSS variable without putting the panel width
 * in React state. This keeps pointer-move layout changes out of the app render
 * tree while the viewer receives one explicit resize start/end session.
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
  const [currentWidth, setCurrentWidth] = useState(defaultWidth);

  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    const n = raw ? parseInt(raw, 10) : NaN;
    const width = Number.isFinite(n) && n >= min && n <= max ? n : defaultWidth;
    document.documentElement.style.setProperty(cssVar, `${width}px`);
    setCurrentWidth(width);
  }, [storageKey, cssVar, min, max, defaultWidth]);

  const onPointerMove = useCallback((event: PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - startXRef.current;
    const delta = side === 'left' ? dx : -dx;
    const next = Math.max(min, Math.min(max, startWidthRef.current + delta));
    document.documentElement.style.setProperty(cssVar, `${next}px`);
  }, [side, min, max, cssVar]);

  const onPointerUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    endPanelResize(resizeEnvironment());
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('blur', onPointerUp);

    const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    const width = parseInt(current, 10);
    if (Number.isFinite(width)) {
      setCurrentWidth(width);
      try { localStorage.setItem(storageKey, String(width)); } catch { /* quota ignored */ }
    }
  }, [cssVar, onPointerMove, storageKey]);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    draggingRef.current = true;
    startXRef.current = event.clientX;
    const current = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
    startWidthRef.current = parseInt(current, 10) || defaultWidth;
    beginPanelResize(resizeEnvironment());
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
  }, [cssVar, defaultWidth, onPointerMove, onPointerUp]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 25 : 10;
    let next: number | null = null;
    if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (event.key === 'ArrowLeft') next = currentWidth + (side === 'left' ? -step : step);
    else if (event.key === 'ArrowRight') next = currentWidth + (side === 'left' ? step : -step);
    if (next === null) return;

    event.preventDefault();
    const clamped = Math.max(min, Math.min(max, next));
    beginPanelResize(resizeEnvironment());
    document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    setCurrentWidth(clamped);
    try { localStorage.setItem(storageKey, String(clamped)); } catch { /* quota ignored */ }
    endPanelResize(resizeEnvironment());
  }, [cssVar, currentWidth, max, min, side, storageKey]);

  useEffect(() => () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    window.removeEventListener('blur', onPointerUp);
    endPanelResize(resizeEnvironment());
  }, [onPointerMove, onPointerUp]);

  return (
    <div
      className={`resize-handle resize-handle-${side}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={currentWidth}
      aria-label={`Resize ${side === 'left' ? 'outliner' : 'inspector'} panel`}
    />
  );
}
