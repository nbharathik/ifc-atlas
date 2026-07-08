import type { CommittedMeasurement } from './measurementController';
import type { MeasurementUnit } from '../../store/useStore';
import { exportFilename } from '../exportFilename';

/** Convert a raw measurement value (metres / m² / degrees) to the display unit's numeric value. */
function toDisplayValue(m: CommittedMeasurement, unit: MeasurementUnit): number {
  if (m.kind === 'linear') {
    switch (unit) {
      case 'mm': return m.value * 1000;
      case 'ft': return m.value * 3.28084;
      default:   return m.value;
    }
  }
  if (m.kind === 'angle') return m.value; // degrees, unit-independent
  // area
  switch (unit) {
    case 'mm': return m.value * 1_000_000;
    case 'ft': return m.value * 10.7639;
    default:   return m.value;
  }
}

/** Return the unit label string for the given kind + unit combination. */
function unitLabel(m: CommittedMeasurement, unit: MeasurementUnit): string {
  if (m.kind === 'angle') return 'deg';
  if (m.kind === 'linear') {
    return unit === 'mm' ? 'mm' : unit === 'ft' ? 'ft' : 'm';
  }
  return unit === 'mm' ? 'mm²' : unit === 'ft' ? 'ft²' : 'm²';
}

/** Serialise committed measurements to CSV text.
 *  Columns: index, kind, value, unit, timestamp
 */
export function measurementsToCsv(
  measurements: CommittedMeasurement[],
  unit: MeasurementUnit,
): string {
  const header = 'index,kind,value,unit,timestamp';
  const rows = measurements.map((m, i) => {
    const num = toDisplayValue(m, unit);
    const decimals = m.kind === 'linear' ? 3 : m.kind === 'angle' ? 1 : (unit === 'mm' ? 0 : 3);
    const valueStr = num.toFixed(decimals);
    const ts = m.timestamp ?? '';
    return `${i + 1},${m.kind},${valueStr},${unitLabel(m, unit)},${ts}`;
  });
  return [header, ...rows].join('\n');
}

/** Trigger a browser download of the CSV file. */
export function downloadMeasurementsCsv(
  measurements: CommittedMeasurement[],
  unit: MeasurementUnit,
): void {
  const csv = measurementsToCsv(measurements, unit);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename('measurements', 'csv');
  a.click();
  URL.revokeObjectURL(url);
}

// Export helpers for testing
export { toDisplayValue, unitLabel };
