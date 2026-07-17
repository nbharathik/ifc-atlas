import { useSyncExternalStore } from 'react';
import {
  getMeasurementTip,
  subscribeMeasurementTip,
} from '../../services/viewer/measurementTipBridge';

/**
 * Cursor-following readout while a measurement tool is armed. Shows the live
 * value, the slope or perimeter, the snap under the cursor, and the next-step
 * hint, right where the user is looking. Subscribes to the measurementTipBridge
 * external store so per-move updates re-render only this leaf component.
 */
export default function MeasurementCursorTip() {
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
