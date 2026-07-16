import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';
import {
  formatArea,
  formatAngle,
  formatCoordinate,
  formatLength,
  formatMeasurementValue,
  type MeasurementMode,
  type MeasurementSnapshot,
} from '../../services/viewer/measurementController';
import type { MeasurementUnit } from '../../store/useStore';

const MODE_BUTTONS: Array<{
  mode: Exclude<MeasurementMode, 'off'>;
  label: string;
  hint: string;
}> = [
  { mode: 'linear', label: 'Distance', hint: 'Two-click point-to-point distance' },
  { mode: 'height', label: 'Height', hint: 'Two points, constrained to project up' },
  { mode: 'clearance', label: 'Clearance', hint: 'Shortest or perpendicular witness between targets' },
  { mode: 'position', label: 'Position', hint: 'Place a project-coordinate marker' },
  { mode: 'box', label: 'Rectangle', hint: 'Two-click rectangular area on a face plane' },
  { mode: 'area', label: 'Polygon area', hint: 'Click polygon vertices, then Finish' },
  { mode: 'angle', label: 'Angle', hint: 'Click vertex, first arm, then second arm' },
];

const UNIT_BUTTONS: Array<{ unit: MeasurementUnit; label: string; hint: string }> = [
  { unit: 'm', label: 'm', hint: 'Metres' },
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

/** Compact construction-instrument readout. Tool choice lives in one selector
 * so advanced measurement modes do not consume the central viewport. */
export default function MeasurementControls({ snapshot, onFinish, onCancel, onClear, onRemove }: Props) {
  const modelLoaded = useStore((state) => state.modelLoaded);
  const mode = useStore((state) => state.measurement.mode);
  const unit = useStore((state) => state.measurement.unit);
  const setMeasurement = useStore((state) => state.setMeasurement);
  const setMeasurementMode = useStore((state) => state.setMeasurementMode);

  if (!modelLoaded || mode === 'off') return null;

  const pendingCount = snapshot?.pending.length ?? 0;
  const committedCount = snapshot?.committed.length ?? 0;
  const pendingValue = snapshot?.pendingValue ?? null;
  const pendingPerimeter = snapshot?.pendingPerimeter ?? null;
  const pendingAngleDeg = snapshot?.pendingAngleDeg ?? null;
  const snapFeedback = snapshot?.snapFeedback ?? null;
  const canFinish = mode === 'area' && pendingCount >= 3;

  let live: string | null = null;
  if (mode === 'angle') {
    if (pendingAngleDeg !== null) live = formatAngle(pendingAngleDeg);
    else if (pendingCount === 0) live = 'Click vertex…';
    else if (pendingCount === 1) live = 'Click arm 1…';
    else live = 'Click arm 2…';
  } else if (mode === 'position') {
    live = snapshot?.cursor ? formatCoordinate(snapshot.cursor, unit) : 'Click position…';
  } else if (pendingValue !== null) {
    live = mode === 'area' || mode === 'box'
      ? formatArea(pendingValue, unit)
      : formatLength(pendingValue, unit);
  } else if (mode === 'linear') {
    live = pendingCount === 0 ? 'Click start point…' : 'Click second point…';
  } else if (mode === 'height') {
    live = pendingCount === 0 ? 'Click base point…' : 'Click height point…';
  } else if (mode === 'clearance') {
    live = pendingCount === 0 ? 'Pick first target…' : 'Pick second target…';
  } else if (mode === 'box') {
    live = pendingCount === 0 ? 'Click first corner…' : 'Click opposite corner…';
  } else if (mode === 'area') {
    live = pendingCount === 0 ? 'Click first vertex…' : `${pendingCount} / 3+ vertices`;
  }

  return (
    <div className="measurement-toolbar active" role="toolbar" aria-label="Measurement tools">
      <Icon name="ruler" size={12} />

      <label className="measurement-tool-select" title="Choose measurement tool">
        <span>TOOL</span>
        <select
          value={mode}
          onChange={(event) => setMeasurementMode(event.target.value as MeasurementMode)}
          aria-label="Measurement tool"
        >
          {MODE_BUTTONS.map(({ mode: optionMode, label, hint }) => (
            <option key={optionMode} value={optionMode} title={hint}>{label}</option>
          ))}
        </select>
      </label>

      <div className="measurement-live" aria-live="polite">
        {live ?? 'Pick a tool'}
        {(mode === 'area' || mode === 'box') && pendingPerimeter !== null && pendingCount >= 2 && (
          <span className="measurement-live-sub">· {formatLength(pendingPerimeter, unit)}</span>
        )}
      </div>

      {snapFeedback && (
        <span
          className={`measurement-snap-feedback${snapFeedback.exact ? ' exact' : ''}`}
          title={snapFeedback.source ?? `${snapFeedback.kind} snap`}
        >
          <span className="measurement-snap-glyph" aria-hidden="true" />
          {snapFeedback.kind.toUpperCase()}
          <small>{snapFeedback.exact ? 'EXACT' : 'GUIDE'}</small>
        </span>
      )}

      {canFinish && (
        <button
          className="measurement-btn measurement-btn-primary"
          onClick={onFinish}
          title="Close polygon and commit (Enter)"
          aria-label="Finish polygon measurement"
        >
          ✓
        </button>
      )}

      {pendingCount > 0 && (
        <button
          className="measurement-btn"
          onClick={onCancel}
          title="Discard in-flight measurement (Esc)"
          aria-label="Cancel pending measurement"
        >
          ✕
        </button>
      )}

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

      {committedCount > 0 && (
        <div className="measurement-history" aria-label="Committed measurements">
          {snapshot!.committed.slice(0, 2).map((measurement) => (
            <button
              key={measurement.id}
              className="measurement-history-chip"
              onClick={() => onRemove(measurement.id)}
              title={`Remove ${measurement.kind} measurement`}
            >
              <span className="measurement-history-val">
                {formatMeasurementValue(measurement, unit)}
              </span>
            </button>
          ))}
          {committedCount > 2 && (
            <button
              className="measurement-btn"
              onClick={onClear}
              title={`Clear all ${committedCount} measurements`}
            >
              ×{committedCount}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
