/**
 * Aggregate-inspector helpers for multi-select.
 *
 * Mirrors `backend/app/services/ifc_service.py:get_aggregate` algorithm so the
 * Properties panel can compute selection summaries from already-fetched element
 * details without a backend round-trip. Pure functions only - no React, no
 * fetch, easy to test.
 */
import type { AggregateResult, ElementDetail } from '../../types/ifc';
import { exportFilename } from '../exportFilename';

/** Priority-ordered area / volume quantity names (first found wins per element). */
const AREA_NAMES = ['GrossArea', 'NetArea', 'GrossFloorArea', 'NetFloorArea', 'Area'] as const;
const VOL_NAMES = ['GrossVolume', 'NetVolume', 'GrossBodyVolume', 'Volume'] as const;

/**
 * Aggregate ΣArea / ΣVolume / material+type histograms from a list of element details.
 *
 * Implementation matches the backend `/api/ifc/aggregate` endpoint:
 * - Type histogram strips the `Ifc` prefix (e.g. `IfcWall` → `Wall`).
 * - Per-element area picks the first named quantity that matches `AREA_NAMES`,
 *   then falls back to any quantity whose key contains "area".
 * - Volume mirrors area with `VOL_NAMES` / "volume" substring.
 * - Elements with no quantity data are listed in `missing_quantity_ids`.
 * - Histograms are sorted by descending count.
 */
export function computeAggregates(elements: ElementDetail[]): AggregateResult {
  let totalArea = 0;
  let totalVolume = 0;
  let areaName: string | null = null;
  let volName: string | null = null;
  let foundArea = false;
  let foundVol = false;
  const materialHist: Record<string, number> = {};
  const typeHist: Record<string, number> = {};
  const missingQty: number[] = [];

  for (const el of elements) {
    const rawType = el.ifc_type.replace(/^Ifc/, '');
    typeHist[rawType] = (typeHist[rawType] ?? 0) + 1;

    if (el.material) {
      materialHist[el.material] = (materialHist[el.material] ?? 0) + 1;
    }

    const qtys = el.quantities ?? {};
    if (!qtys || Object.keys(qtys).length === 0) {
      missingQty.push(el.id);
      continue;
    }

    // Area: try priority names first, then any "area" substring
    let elArea: number | null = null;
    let elAreaKey: string | null = null;
    for (const n of AREA_NAMES) {
      if (n in qtys && typeof qtys[n] === 'number') {
        elArea = qtys[n];
        elAreaKey = n;
        break;
      }
    }
    if (elArea === null) {
      for (const k of Object.keys(qtys)) {
        if (k.toLowerCase().includes('area') && typeof qtys[k] === 'number') {
          elArea = qtys[k];
          elAreaKey = k;
          break;
        }
      }
    }
    if (elArea !== null) {
      totalArea += elArea;
      if (areaName === null) areaName = elAreaKey;
      foundArea = true;
    }

    // Volume: same pattern
    let elVol: number | null = null;
    let elVolKey: string | null = null;
    for (const n of VOL_NAMES) {
      if (n in qtys && typeof qtys[n] === 'number') {
        elVol = qtys[n];
        elVolKey = n;
        break;
      }
    }
    if (elVol === null) {
      for (const k of Object.keys(qtys)) {
        if (k.toLowerCase().includes('volume') && typeof qtys[k] === 'number') {
          elVol = qtys[k];
          elVolKey = k;
          break;
        }
      }
    }
    if (elVol !== null) {
      totalVolume += elVol;
      if (volName === null) volName = elVolKey;
      foundVol = true;
    }
  }

  const sortDescByCount = (rec: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(rec).sort(([, a], [, b]) => b - a));

  return {
    count: elements.length,
    total_area: foundArea ? Math.round(totalArea * 10000) / 10000 : null,
    total_volume: foundVol ? Math.round(totalVolume * 10000) / 10000 : null,
    area_quantity_name: areaName,
    volume_quantity_name: volName,
    material_histogram: sortDescByCount(materialHist),
    type_histogram: sortDescByCount(typeHist),
    missing_quantity_ids: missingQty,
  };
}

/** Escape a single CSV field per RFC 4180 (quote if it contains ",", ";", "\n", "\r", or "). */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",;\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Serialise an `AggregateResult` to CSV text.
 *
 * Two sections:
 * 1. Summary table - count / ΣArea / ΣVolume / counts of distinct types / materials.
 * 2. Histogram rows - one row per type and per material, with `kind`, `key`, `count`.
 * 3. ID list - express IDs, one per row.
 *
 * Field separator is comma; per-row newline is `\n`.
 */
export function aggregatesToCsv(agg: AggregateResult, ids: number[]): string {
  const lines: string[] = [];

  lines.push('section,key,value');
  lines.push(`summary,count,${agg.count}`);
  lines.push(`summary,total_area_m2,${agg.total_area ?? ''}`);
  lines.push(`summary,total_volume_m3,${agg.total_volume ?? ''}`);
  lines.push(`summary,area_quantity_name,${escapeCsvField(agg.area_quantity_name)}`);
  lines.push(`summary,volume_quantity_name,${escapeCsvField(agg.volume_quantity_name)}`);
  lines.push(`summary,distinct_types,${Object.keys(agg.type_histogram).length}`);
  lines.push(`summary,distinct_materials,${Object.keys(agg.material_histogram).length}`);
  lines.push(`summary,missing_quantity_count,${agg.missing_quantity_ids.length}`);

  for (const [type, count] of Object.entries(agg.type_histogram)) {
    lines.push(`type,${escapeCsvField(type)},${count}`);
  }
  for (const [mat, count] of Object.entries(agg.material_histogram)) {
    lines.push(`material,${escapeCsvField(mat)},${count}`);
  }
  for (const id of ids) {
    lines.push(`id,,${id}`);
  }

  return lines.join('\n');
}

/** Trigger a browser download of the aggregates CSV. Filename defaults to selection-N.csv. */
export function downloadAggregatesCsv(
  agg: AggregateResult,
  ids: number[],
  filename?: string,
): void {
  const csv = aggregatesToCsv(agg, ids);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? exportFilename(`selection-${ids.length}`, 'csv');
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Copy the aggregates CSV to the clipboard. Returns true on success, false on
 * failure (clipboard unavailable, permission denied, or empty input).
 *
 * Used as a fallback when the user can't trigger downloads (e.g. embedded
 * Tauri webview without download permission, sandboxed iframe, file:// origin).
 */
export async function copyAggregatesCsvToClipboard(
  agg: AggregateResult,
  ids: number[],
): Promise<boolean> {
  const csv = aggregatesToCsv(agg, ids);
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(csv);
    return true;
  } catch {
    return false;
  }
}
