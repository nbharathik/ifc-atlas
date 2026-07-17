import type { CommittedMeasurement } from './measurementController';
import type { MeasurementUnit } from '../../store/useStore';
import { exportFilename } from '../exportFilename';

/** Convert a raw measurement value (metres / m² / degrees) to the display unit's numeric value. */
function toDisplayValue(m: CommittedMeasurement, unit: MeasurementUnit): number {
  if (
    m.kind === 'linear'
    || m.kind === 'height'
    || m.kind === 'clearance'
    || m.kind === 'position'
  ) {
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
  if (m.kind !== 'area') {
    return unit === 'mm' ? 'mm' : unit === 'ft' ? 'ft' : 'm';
  }
  return unit === 'mm' ? 'mm²' : unit === 'ft' ? 'ft²' : 'm²';
}

function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** UTF-8 byte-order mark so Excel decodes non-ASCII unit labels (m²) correctly. */
const UTF8_BOM = String.fromCharCode(0xfeff);

function coordinateValues(
  measurement: CommittedMeasurement,
  unit: MeasurementUnit,
): [string, string, string] {
  if (measurement.kind !== 'position') return ['', '', ''];
  const point = measurement.coordinates?.local ?? measurement.points[0];
  if (!point) return ['', '', ''];
  const factor = unit === 'mm' ? 1000 : unit === 'ft' ? 3.28084 : 1;
  const decimals = unit === 'mm' ? 1 : 3;
  return [point.x, point.y, point.z].map((value) => (value * factor).toFixed(decimals)) as [
    string,
    string,
    string,
  ];
}

/** Serialise committed measurements to CSV text.
 *  The first five columns stay backward-compatible; construction provenance
 *  and position coordinates are appended for lossless round-tripping.
 */
export function measurementsToCsv(
  measurements: CommittedMeasurement[],
  unit: MeasurementUnit,
): string {
  const header = 'index,kind,value,unit,timestamp,x,y,z,coordinate_space,exact,source';
  const rows = measurements.map((m, i) => {
    const num = toDisplayValue(m, unit);
    const decimals = m.kind === 'angle' ? 1 : m.kind === 'area' && unit === 'mm' ? 0 : 3;
    const valueStr = m.kind === 'position' ? '' : num.toFixed(decimals);
    const ts = m.timestamp ?? '';
    const [x, y, z] = coordinateValues(m, unit);
    return [
      String(i + 1),
      m.kind,
      valueStr,
      unitLabel(m, unit),
      csvCell(ts),
      x,
      y,
      z,
      csvCell(m.coordinates?.reference ?? ''),
      m.exact === undefined ? '' : String(m.exact),
      csvCell(m.source ?? ''),
    ].join(',');
  });
  return UTF8_BOM + [header, ...rows].join('\n');
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
