import Icon, { type IconName } from '../ui/Icon';
import * as THREE from 'three';
import { useStore, type MeasurementUnit } from '../../store/useStore';
import {
  type MeasurementMode,
  type MeasurementSnapshot,
  formatMeasurementValue,
  measurementKindLabel,
  type CommittedMeasurement,
} from '../../services/viewer/measurementController';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ViewerRefs } from './ViewerPanel';
import {
  MeasurementLabelRenderer,
  downloadMeasurementsCsv,
  getMeasurementTip,
  subscribeMeasurementTip,
} from '../../services/viewer/measurementPresentation';

const MODE_BUTTONS: Array<{
  mode: Exclude<MeasurementMode, 'off'>;
  label: string;
  icon: IconName;
  hint: string;
}> = [
  { mode: 'linear', label: 'Distance', icon: 'ruler', hint: 'Point-to-point distance' },
  { mode: 'height', label: 'Height', icon: 'height', hint: 'Vertical height between two points' },
  { mode: 'clearance', label: 'Clearance', icon: 'clearance', hint: 'Shortest gap between two picked faces' },
  { mode: 'position', label: 'Position', icon: 'target', hint: 'Drop a coordinate marker' },
  { mode: 'box', label: 'Rectangle', icon: 'square', hint: 'Rectangular area on a face' },
  { mode: 'area', label: 'Polygon area', icon: 'polygon', hint: 'Area of a clicked polygon' },
  { mode: 'angle', label: 'Angle', icon: 'angle', hint: 'Angle between two arms' },
];

/** Static per-tool instruction. Per-step guidance follows the cursor. */
const MODE_STEPS: Record<Exclude<MeasurementMode, 'off'>, string> = {
  linear: 'Click two points. The distance follows your cursor.',
  height: 'Click a base point, then a top point.',
  clearance: 'Pick two faces to measure the shortest gap.',
  position: 'Click anywhere to drop a coordinate marker.',
  box: 'Click two opposite corners on one face.',
  area: 'Click vertices. Enter or double-click finishes.',
  angle: 'Click the corner, then the two arm ends.',
};

const UNIT_BUTTONS: Array<{ unit: MeasurementUnit; label: string; hint: string }> = [
  { unit: 'm', label: 'm', hint: 'Metres' },
  { unit: 'mm', label: 'mm', hint: 'Millimetres' },
  { unit: 'ft', label: 'ft', hint: 'Feet' },
];

interface MeasurementControlsProps {
  snapshot: MeasurementSnapshot | null;
  onFinish: () => void;
  onCancel: () => void;
  onClear: () => void;
}

/**
 * Measurement toolbar, centered at the top of the viewport. Row one picks the
 * tool, unit, and history; row two tells the user what to do and offers
 * Finish/Cancel. Live values render at the cursor (MeasurementCursorTip), so
 * nothing here updates per pointer move.
 */
export function MeasurementControls({ snapshot, onFinish, onCancel, onClear }: MeasurementControlsProps) {
  const modelLoaded = useStore((state) => state.modelLoaded);
  const mode = useStore((state) => state.measurement.mode);
  const unit = useStore((state) => state.measurement.unit);
  const setMeasurement = useStore((state) => state.setMeasurement);
  const setMeasurementMode = useStore((state) => state.setMeasurementMode);
  const panelOpen = useStore((state) => state.measurementPanelOpen);
  const setPanelOpen = useStore((state) => state.setMeasurementPanelOpen);

  if (!modelLoaded || mode === 'off') return null;

  const pendingCount = snapshot?.pending.length ?? 0;
  const committedCount = snapshot?.committed.length ?? 0;
  const canFinish = mode === 'area' && pendingCount >= 3;
  const activeTool = MODE_BUTTONS.find((button) => button.mode === mode);

  return (
    <div className="measurement-toolbar" role="toolbar" aria-label="Measurement tools">
      <div className="measurement-row">
        <div className="measurement-tools" role="group" aria-label="Measurement tool">
          {MODE_BUTTONS.map(({ mode: optionMode, label, icon, hint }) => (
            <button
              key={optionMode}
              className={`measurement-tool-btn${mode === optionMode ? ' active' : ''}`}
              onClick={() => setMeasurementMode(optionMode)}
              title={`${label}. ${hint}`}
              aria-label={label}
              aria-pressed={mode === optionMode}
            >
              <Icon name={icon} size={13} />
            </button>
          ))}
        </div>

        <div className="measurement-sep" aria-hidden="true" />

        <div className="measurement-units" aria-label="Measurement units">
          {UNIT_BUTTONS.map(({ unit: optionUnit, label, hint }) => (
            <button
              key={optionUnit}
              className={`measurement-unit-btn ${unit === optionUnit ? 'active' : ''}`}
              onClick={() => setMeasurement({ unit: optionUnit })}
              title={hint}
              aria-pressed={unit === optionUnit}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="measurement-sep" aria-hidden="true" />

        <button
          className={`measurement-btn${panelOpen ? ' active' : ''}`}
          onClick={() => setPanelOpen(!panelOpen)}
          title="Show the list of placed measurements"
          aria-label="Measurement history"
          aria-pressed={panelOpen}
        >
          <Icon name="clipboard-list" size={12} />
          {committedCount > 0 && committedCount}
        </button>

        {committedCount > 0 && (
          <button
            className="measurement-btn"
            onClick={onClear}
            title={`Clear all ${committedCount} measurement${committedCount === 1 ? '' : 's'}`}
            aria-label={`Clear all ${committedCount} measurements`}
          >
            <Icon name="trash" size={12} />
          </button>
        )}

        <button
          className="measurement-btn"
          onClick={() => setMeasurementMode('off')}
          title="Exit measurement (R or Esc)"
          aria-label="Exit measurement mode"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      <div className="measurement-row measurement-row-status">
        <span className="measurement-tool-name">{activeTool?.label}</span>
        <span className="measurement-step">{activeTool ? MODE_STEPS[activeTool.mode] : ''}</span>
        {canFinish && (
          <button
            className="measurement-btn measurement-btn-primary"
            onClick={onFinish}
            title="Close the polygon (Enter)"
            aria-label="Finish polygon measurement"
          >
            <Icon name="check" size={12} />
            Finish
          </button>
        )}
        {pendingCount > 0 && (
          <button
            className="measurement-btn"
            onClick={onCancel}
            title="Discard the points placed so far (Esc)"
            aria-label="Cancel pending measurement"
          >
            <Icon name="x" size={12} />
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
// This component does not project to screen: the CSS2DRenderer in
// `measurementLabels.ts` handles label placement.

interface MeasurementLabelsProps {
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
export function MeasurementLabels({ snapshot, viewerRef, containerRef }: MeasurementLabelsProps) {
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

interface MeasurementPanelProps {
  measurements: CommittedMeasurement[];
  unit: MeasurementUnit;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

function formatValue(m: CommittedMeasurement, unit: MeasurementUnit): string {
  return formatMeasurementValue(m, unit);
}

const KIND_COLOURS: Record<CommittedMeasurement['kind'], string> = {
  linear: 'var(--atlas-accent)',
  area: 'var(--atlas-fg-muted)',
  angle: '#ffa040',
  height: '#ffa040',
  clearance: '#c58cff',
  position: '#63d391',
};

const KIND_CODES: Record<CommittedMeasurement['kind'], string> = {
  linear: 'DIST',
  area: 'AREA',
  angle: 'ANG',
  height: 'HGT',
  clearance: 'CLR',
  position: 'POS',
};

function KindBadge({ kind }: { kind: CommittedMeasurement['kind'] }) {
  return (
    <span
      style={{
        fontSize: '10px',
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 3,
        background: KIND_COLOURS[kind],
        color: 'var(--atlas-bg)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        flexShrink: 0,
      }}
    >
      {KIND_CODES[kind]}
    </span>
  );
}

export function MeasurementPanel({ measurements, unit, onRemove, onClearAll }: MeasurementPanelProps) {
  const open = useStore((s) => s.measurementPanelOpen);
  if (!open) return null;

  return (
    <div
      className="measurement-panel"
      style={{
        position: 'absolute',
        bottom: '60px',
        right: '16px',
        width: '260px',
        background: 'var(--atlas-surface)',
        border: '1px solid var(--atlas-border)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--atlas-border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--atlas-fg)' }}>
          Measurements
          {measurements.length > 0 && (
            <span
              style={{
                marginLeft: 6,
                fontSize: '10px',
                color: 'var(--atlas-fg-muted)',
                fontWeight: 400,
              }}
            >
              {measurements.length}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {measurements.length > 0 && (
            <>
              <button
                onClick={() => downloadMeasurementsCsv(measurements, unit)}
                title="Export measurements as CSV"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                CSV ↓
              </button>
              <button
                onClick={onClearAll}
                title="Clear all measurements"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                Clear all
              </button>
            </>
          )}
          <button
            onClick={() => useStore.getState().setMeasurementPanelOpen(false)}
            title="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--atlas-fg-muted)',
              fontSize: '14px',
              padding: '2px 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          overflowY: 'auto',
          maxHeight: '240px',
          padding: measurements.length === 0 ? '20px 12px' : '4px 0',
        }}
      >
        {measurements.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: '12px',
              color: 'var(--atlas-fg-muted)',
              textAlign: 'center',
            }}
          >
            No measurements yet.
            <br />
            Choose a measurement tool, then pick geometry in the viewer.
          </p>
        ) : (
          [...measurements].reverse().map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderBottom: '1px solid var(--atlas-border-subtle, var(--atlas-border))',
              }}
            >
              <KindBadge kind={m.kind} />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span
                  title={formatValue(m, unit)}
                  style={{
                    fontSize: '12px',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--atlas-fg)',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {formatValue(m, unit)}
                </span>
                {(m.source || m.exact !== undefined || m.coordinates) && (
                  <span
                    title={m.source}
                    style={{
                      fontSize: '9px',
                      color: 'var(--atlas-fg-muted)',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {measurementKindLabel(m.kind)}
                    {m.exact !== undefined ? ` · ${m.exact ? 'EXACT' : 'GUIDE'}` : ''}
                    {m.coordinates?.reference ? ` · ${m.coordinates.reference}` : ''}
                    {m.source ? ` · ${m.source}` : ''}
                  </span>
                )}
              </div>
              <button
                onClick={() => onRemove(m.id)}
                title="Remove measurement"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '13px',
                  padding: '1px 4px',
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: '5px 12px',
          borderTop: '1px solid var(--atlas-border)',
          fontSize: '10px',
          color: 'var(--atlas-fg-muted)',
          flexShrink: 0,
        }}
      >
        Remove entries with their x button. Toggle this list from the measure toolbar.
      </div>
    </div>
  );
}

/**
 * Cursor-following readout while a measurement tool is armed. Shows the live
 * value, the slope or perimeter, the snap under the cursor, and the next-step
 * hint, right where the user is looking. Subscribes to the measurementTipBridge
 * external store so per-move updates re-render only this leaf component.
 */
export function MeasurementCursorTip() {
  const tip = useSyncExternalStore(subscribeMeasurementTip, getMeasurementTip);

  if (!tip) return null;
  return (
    <div
      className="measure-tip"
      style={{ left: tip.x, top: tip.y }}
      aria-hidden="true"
    >
      {tip.primary && <span className="measure-tip-value">{tip.primary}</span>}
      {tip.secondary && <span className="measure-tip-sub">{tip.secondary}</span>}
      {!tip.primary && tip.hint && <span className="measure-tip-hint">{tip.hint}</span>}
      {tip.snap && (
        <span className={`measure-tip-snap${tip.snap.exact ? ' exact' : ''}`}>
          {tip.snap.label}
        </span>
      )}
    </div>
  );
}
