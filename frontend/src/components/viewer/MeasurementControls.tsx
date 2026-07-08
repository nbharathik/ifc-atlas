import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';
import {
  formatArea,
  formatAngle,
  formatLength,
  type MeasurementSnapshot,
} from '../../services/viewer/measurementController';
import type { MeasurementMode, MeasurementUnit } from '../../store/useStore';

const MODE_BUTTONS: Array<{ mode: Exclude<MeasurementMode, 'off'>; label: string; hint: string }> = [
  { mode: 'linear', label: 'Line',  hint: 'Two-click linear distance (Esc to cancel)' },
  { mode: 'box',    label: 'Box',   hint: 'Two-click rectangle on the face plane - instant area' },
  { mode: 'area',   label: 'Poly',  hint: 'Polygon area: click vertices, Finish to close' },
  { mode: 'angle',  label: 'Angle', hint: 'Three-click angle: vertex → arm1 → arm2 (N to toggle)' },
];

const UNIT_BUTTONS: Array<{ unit: MeasurementUnit; label: string; hint: string }> = [
  { unit: 'm',  label: 'm',  hint: 'Metres' },
  { unit: 'mm', label: 'mm', hint: 'Millimetres' },
  { unit: 'ft', label: 'ft', hint: 'Feet' },
];

interface Props {
  snapshot: MeasurementSnapshot | null;
  onFinish: () => void;
  onCancel: () => void;
  onClear: () => void;
  onRemove: (id: string) => void;
}

/** Floating measurement toolbar + live readout. Visible only when a model
 *  is loaded. Hidden while the viewer is initialising so it never flashes
 *  before the scene is ready.
 *
 *  Design notes:
 *  - Bottom-centre of the viewport so it doesn't collide with the top-centre
 *    section/clip-plane bar or the top-right performance HUD.
 *  - Mode buttons are a single-select pill group (off / linear / area) so
 *    the state is always unambiguous and the active tool is at a glance.
 *  - The live readout shows the in-flight measurement value while the user
 *    is dropping vertices, flipping to the final committed value on commit.
 *  - Unit toggle sits on the right, persisted in Zustand (see `setMeasurement`).
 */
export default function MeasurementControls({ snapshot, onFinish, onCancel, onClear, onRemove }: Props) {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const mode = useStore((s) => s.measurement.mode);
  const unit = useStore((s) => s.measurement.unit);
  const setMeasurement = useStore((s) => s.setMeasurement);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);

  if (!modelLoaded || mode === 'off') return null;

  const pendingCount = snapshot?.pending.length ?? 0;
  const committedCount = snapshot?.committed.length ?? 0;
  const pendingValue = snapshot?.pendingValue ?? null;
  const pendingPerimeter = snapshot?.pendingPerimeter ?? null;
  const pendingAngleDeg = snapshot?.pendingAngleDeg ?? null;
  const canFinish = mode === 'area' && pendingCount >= 3;

  // Live label: what the user sees while placing vertices.
  let live: string | null = null;
  if (mode === 'angle') {
    if (pendingAngleDeg !== null) {
      live = formatAngle(pendingAngleDeg);
    } else if (pendingCount === 0) {
      live = 'Click vertex…';
    } else if (pendingCount === 1) {
      live = 'Click arm 1…';
    } else {
      live = 'Click arm 2…';
    }
  } else if (pendingValue !== null) {
    if (mode === 'linear') {
      live = formatLength(pendingValue, unit);
    } else {
      live = formatArea(pendingValue, unit);
    }
  } else if (mode === 'linear' && pendingCount === 1) {
    live = 'Click second point…';
  } else if (mode === 'box') {
    live = pendingCount === 0 ? 'Click first corner…' : 'Click opposite corner…';
  } else if (mode === 'area' && pendingCount < 3) {
    live = pendingCount === 0 ? 'Click first vertex…' : `${pendingCount} / 3+ vertices`;
  } else if (mode === 'linear' && pendingCount === 0) {
    live = 'Click start point…';
  }

  return (
    <div
      className="measurement-toolbar active"
      role="toolbar"
      aria-label="Measurement tools"
    >
      <Icon name="ruler" size={12} />

      <div className="measurement-modes">
        {MODE_BUTTONS.map(({ mode: m, label, hint }) => (
          <button
            key={m}
            className={`measurement-mode-btn ${mode === m ? 'active' : ''}`}
            onClick={() => setMeasurementMode(m)}
            title={hint}
            aria-pressed={mode === m}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="measurement-live" aria-live="polite">
        {live ?? 'Pick a tool'}
        {(mode === 'area' || mode === 'box') && pendingPerimeter !== null && pendingCount >= 2 && (
          <span className="measurement-live-sub">
            · {formatLength(pendingPerimeter, unit)}
          </span>
        )}
      </div>

      {mode === 'area' && canFinish && (
        <button
          className="measurement-btn measurement-btn-primary"
          onClick={onFinish}
          title="Close polygon and commit (Enter)"
        >
          ✓
        </button>
      )}

      {pendingCount > 0 && (
        <button
          className="measurement-btn"
          onClick={onCancel}
          title="Discard in-flight measurement (Esc)"
        >
          ✕
        </button>
      )}

      <div className="measurement-units">
        {UNIT_BUTTONS.map(({ unit: u, label, hint }) => (
          <button
            key={u}
            className={`measurement-unit-btn ${unit === u ? 'active' : ''}`}
            onClick={() => setMeasurement({ unit: u })}
            title={hint}
            aria-pressed={unit === u}
          >
            {label}
          </button>
        ))}
      </div>

      {committedCount > 0 && (
        <div className="measurement-history" aria-label="Committed measurements">
          {snapshot!.committed.slice(0, 2).map((m) => (
            <button
              key={m.id}
              className="measurement-history-chip"
              onClick={() => onRemove(m.id)}
              title="Click to remove"
            >
              <span className="measurement-history-val">
                {m.kind === 'linear'
                  ? formatLength(m.value, unit)
                  : m.kind === 'area'
                  ? formatArea(m.value, unit)
                  : formatAngle(m.value)}
              </span>
            </button>
          ))}
          {committedCount > 2 && (
            <button
              className="measurement-btn"
              onClick={onClear}
              title={`Clear all ${committedCount}`}
            >
              ×{committedCount}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
