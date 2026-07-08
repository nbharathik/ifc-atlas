/**
 * Shared helper for timestamped download filenames.
 *
 * Browsers de-duplicate identical filenames by appending " (1)", " (2)" suffixes,
 * which makes it hard to tell exports apart in a user's downloads folder.
 * Embedding an ISO-derived timestamp gives every export a unique, sortable name.
 *
 * Format: `${prefix}-${YYYY-MM-DDTHH-MM-SS}.${ext}`
 *
 * The screenshot capture path in `ViewerPanel.tsx` and `chatExport.buildExportFilename`
 * already used this pattern individually - this module centralises it so new
 * exports inherit the convention for free.
 */
export function exportFilename(
  prefix: string,
  ext: string,
  now: Date = new Date(),
): string {
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cleanPrefix = prefix.replace(/-+$/, '');
  const cleanExt = ext.replace(/^\.+/, '');
  return `${cleanPrefix}-${ts}.${cleanExt}`;
}
