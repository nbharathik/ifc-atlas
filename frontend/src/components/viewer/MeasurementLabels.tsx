import { useEffect, useRef } from 'react';
import type { MeasurementSnapshot } from '../../services/viewer/measurementController';
import type { MeasurementUnit } from '../../store/useStore';
import { useStore } from '../../store/useStore';
import * as THREE from 'three';
import type { ViewerRefs } from './ViewerPanel';
import { MeasurementLabelRenderer } from '../../services/viewer/measurementLabels';

// ─── Component ────────────────────────────────────────────────────────────────
// Screen-projection / centroid / midpoint helpers live in
// `services/viewer/screenSpaceLabelHelpers.ts` (see `worldToScreen` /
// `centroidScreen`) - kept out of this component module so it exports only the
// component, avoiding a Fast Refresh smell from mixing component and pure-
// function exports. The component itself does not project to screen: the
// CSS2DRenderer in `measurementLabels.ts` handles label placement.

interface Props {
  snapshot: MeasurementSnapshot | null;
  viewerRef: { readonly current: ViewerRefs | null };
  containerRef: { readonly current: HTMLDivElement | null };
}

/**
 * CSS2D-based dimension labels for committed measurements.
 *
 * Replaces the previous rAF+setState approach with Three.js CSS2DRenderer,
 * eliminating 60 React re-renders/second. Labels are DOM elements positioned
 * via CSS `transform: translate3d()`, so no React state updates are needed after init.
 *
 * Returns null: all DOM output is managed by the CSS2DRenderer overlay.
 */
export default function MeasurementLabels({ snapshot, viewerRef, containerRef }: Props) {
  const unit = useStore((s) => s.measurement.unit);
  const labelsVisible = useStore((s) => s.measurementLabelsVisible);
  const setLabelsVisible = useStore((s) => s.setMeasurementLabelsVisible);
  const unitRef = useRef<MeasurementUnit>(unit);
  unitRef.current = unit;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const rendererRef = useRef<MeasurementLabelRenderer | null>(null);

  // rAF loop control. The loop is only kept alive while there is at least one
  // committed label to reposition, see the "rAF gate" effect below. Without
  // this, CSS2DRenderer.render() would walk the entire (50-63 MB) scene graph
  // every frame for the whole session even with zero measurements present.
  const rafRunningRef = useRef(false);
  const rafIdRef = useRef<number>(0);

  // Idempotent start: drives CSS2DRenderer at display rate via rAF so labels
  // track the camera during orbit. No React state update; it just calls
  // CSS2DRenderer.render() which applies CSS transforms directly to the DOM.
  // Cost: <0.1 ms per frame, but only paid while labels exist.
  const startRafLoop = useRef(() => {
    if (rafRunningRef.current) return;
    rafRunningRef.current = true;
    const tick = () => {
      if (!rafRunningRef.current) return;
      rendererRef.current?.render();
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  });

  const stopRafLoop = useRef(() => {
    rafRunningRef.current = false;
    cancelAnimationFrame(rafIdRef.current);
  });

  // ── Lifecycle: create/destroy the CSS2DRenderer when scene becomes available ──
  useEffect(() => {
    const container = containerRef.current;
    const world = viewerRef.current?.world;
    if (!container || !world) return;

    const scene = world.scene.three as THREE.Scene;
    const camera = world.camera.three as THREE.Camera;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const labelRenderer = new MeasurementLabelRenderer(scene, camera, container, w, h);
    rendererRef.current = labelRenderer;

    // Sync initial state. Only spin up the rAF loop if labels already exist;
    // otherwise it stays parked until the first measurement is committed (the
    // rAF gate effect restarts it on the snapshot change).
    const snap = snapshotRef.current;
    if (snap?.committed.length) {
      labelRenderer.syncCommitted(snap.committed, unitRef.current);
      startRafLoop.current();
    }

    // Resize sync
    const resizeObs = new ResizeObserver(() => {
      const c = containerRef.current;
      if (c) labelRenderer.setSize(c.clientWidth, c.clientHeight);
    });
    resizeObs.observe(container);

    return () => {
      stopRafLoop.current();
      resizeObs.disconnect();
      labelRenderer.dispose();
      rendererRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerRef.current?.world, containerRef]);

  // ── Sync labels on snapshot change + gate the rAF loop on label count ───────
  // Run the CSS2DRenderer loop only while at least one label is present:
  // restart it on the first committed measurement, park it once they are all
  // removed/cleared. With zero labels there is nothing to reposition, so the
  // per-frame scene-graph traversal is pure waste.
  useEffect(() => {
    const lr = rendererRef.current;
    if (!lr) return;
    const committed = snapshot?.committed ?? [];
    lr.syncCommitted(committed, unit);
    if (committed.length > 0) startRafLoop.current();
    else stopRafLoop.current();
  }, [snapshot?.committed, unit]);

  // ── Store → renderer: sync labelsVisible from store ─────────────────────────
  useEffect(() => {
    const lr = rendererRef.current;
    if (lr) lr.setVisible(labelsVisible);
  }, [labelsVisible]);

  // ── L shortcut: toggle label visibility via store ─────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'l' && e.key !== 'L') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const snap = snapshotRef.current;
      if (!snap || snap.committed.length === 0) return;
      if (!rendererRef.current) return;
      e.stopPropagation();
      setLabelsVisible(!rendererRef.current.isVisible());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setLabelsVisible]);

  return null;
}
