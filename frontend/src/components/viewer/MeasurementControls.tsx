import { useStore } from '../../store/useStore';
import Icon, { type IconName } from '../ui/Icon';
import {
  type MeasurementMode,
  type MeasurementSnapshot,
} from '../../services/viewer/measurementController';
import type { MeasurementUnit } from '../../store/useStore';

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

interface Props {
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
export default function MeasurementControls({ snapshot, onFinish, onCancel, onClear }: Props) {
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
