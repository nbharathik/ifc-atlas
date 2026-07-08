/** Pure helpers for the IDS CSV download button in ToolCallDisplay.
 *  Kept separate so vitest can test them without mounting React. */

export interface IdsCsvButtonState {
  downloading: boolean;
  error: boolean;
  noModel: boolean;
  failedCount: number | undefined;
}

/** Human-readable label for the IDS CSV download button. */
export function getIdsCsvButtonLabel(s: IdsCsvButtonState): string {
  if (s.downloading) return '⏳ Downloading…';
  if (s.error) return '⚠ Download failed';
  if (s.noModel) return '📥 Download failures CSV';
  if (s.failedCount === 0) return '📥 Download CSV (0 failures)';
  if (typeof s.failedCount === 'number')
    return `📥 Download ${s.failedCount} failure${s.failedCount === 1 ? '' : 's'} as CSV`;
  return '📥 Download failures CSV';
}

/** Tooltip text for the IDS CSV download button. */
export function getIdsCsvButtonTitle(s: IdsCsvButtonState): string {
  if (s.noModel) return 'No IFC model loaded - upload a model first';
  if (s.error) return 'Download failed - is an IFC model loaded?';
  if (s.failedCount === 0) return 'Download CSV report (no validation failures found)';
  if (typeof s.failedCount === 'number')
    return `Download ${s.failedCount} validation failure${s.failedCount === 1 ? '' : 's'} as CSV`;
  return 'Download validation failures as CSV';
}

/** Extract failure count from a parsed ids_validate tool result object.
 *  Returns undefined when the field is absent or not a number. */
export function extractIdsFailedCount(parsed: Record<string, unknown> | null): number | undefined {
  if (!parsed) return undefined;
  const v = parsed['failed'];
  return typeof v === 'number' ? v : undefined;
}
