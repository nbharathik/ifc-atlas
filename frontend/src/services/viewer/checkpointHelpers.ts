/**
 * Pure helpers for the CheckpointPanel.
 * Extracted so they can be unit-tested without mounting React components.
 */

/** Format an ISO-8601 timestamp as "Mon DD, HH:MM". */
export function formatCheckpointTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Short SHA label used in the UI. Input may be any length; we show at most 12 chars. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Build an accessible title for a restore button. */
export function restoreButtonTitle(sha: string, message: string): string {
  return `Restore model to checkpoint ${sha} - "${message}"`;
}
