/**
 * Pure helpers for the desktop auto-update prompt (see UpdateBanner.tsx).
 * Kept separate from the React component so vitest (node env, *.test.ts only -
 * see `vite.config.ts`) can exercise the skip/snooze logic without a DOM.
 *
 * The prompt is desktop-only. On launch the shell asks Rust
 * (`check_for_updates`, which polls the signed GitHub Releases manifest); when a
 * newer signed build exists the card appears. Two dismissals with different
 * memory:
 *  - "Later"  -> snooze in sessionStorage: hidden for this run (survives a
 *               webview reload) but the next app launch (fresh session) asks
 *               again.
 *  - dismiss  -> skip in localStorage: this exact version never prompts again.
 * Both are version-scoped, so a brand-new release always prompts even after a
 * previous version was skipped or snoozed.
 */

/** localStorage key holding the version the user chose to skip permanently. */
export const UPDATE_SKIPPED_VERSION_KEY = 'update_skipped_version';

/** sessionStorage key holding the version snoozed via "Later" for this run. */
export const UPDATE_SNOOZED_VERSION_KEY = 'update_snoozed_version';

/** Max characters of release notes shown in the compact card. */
export const NOTES_MAX_LEN = 220;

/** Shape returned by the Rust `check_for_updates` command. */
export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version?: string | null;
  readonly notes?: string | null;
}

/**
 * Minimal storage surface. Null models SSR / a sandbox where Web Storage is
 * unavailable; reads then fall back to "nothing stored" and writes no-op.
 */
export type BannerStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

/** Read a stored version string, treating empty/absent/throwing as null. */
export function readStoredVersion(storage: BannerStorage, key: string): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return value && value.length > 0 ? value : null;
  } catch {
    // Web Storage can throw in private-mode / blocked-cookie contexts.
    return null;
  }
}

/** Persist a version string; silently no-ops when storage is null or throws. */
export function writeStoredVersion(
  storage: BannerStorage,
  key: string,
  version: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, version);
  } catch {
    // private-mode / quota-exceeded: the prompt just won't persist its state.
  }
}

/** Permanently skip a version (localStorage): never prompt for it again. */
export function skipVersion(storage: BannerStorage, version: string): void {
  writeStoredVersion(storage, UPDATE_SKIPPED_VERSION_KEY, version);
}

/** Snooze a version for this run (sessionStorage): prompt again next launch. */
export function snoozeVersion(storage: BannerStorage, version: string): void {
  writeStoredVersion(storage, UPDATE_SNOOZED_VERSION_KEY, version);
}

export interface ShouldPromptOpts {
  /** localStorage-backed store holding the permanently-skipped version. */
  readonly skipped: BannerStorage;
  /** sessionStorage-backed store holding the snoozed-this-run version. */
  readonly snoozed: BannerStorage;
}

/**
 * Whether the update card should surface for this check result. True only when
 * the updater reports an available build with a version that has not been
 * skipped (permanently) or snoozed (this run).
 */
export function shouldPromptForUpdate(
  res: UpdateCheckResult | null,
  opts: ShouldPromptOpts,
): boolean {
  if (!res || !res.available) return false;
  const version = res.version;
  if (!version) return false;
  if (readStoredVersion(opts.skipped, UPDATE_SKIPPED_VERSION_KEY) === version) return false;
  if (readStoredVersion(opts.snoozed, UPDATE_SNOOZED_VERSION_KEY) === version) return false;
  return true;
}

/**
 * Condense a GitHub release body into a single compact line for the card.
 * Release bodies are multi-line markdown, so we take the first paragraph,
 * collapse whitespace, and clamp the length. Returns null for empty notes so
 * the caller can omit the notes row entirely.
 */
export function truncateNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const trimmed = notes.trim();
  if (trimmed.length === 0) return null;
  const firstBlock = trimmed.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  if (firstBlock.length === 0) return null;
  if (firstBlock.length <= NOTES_MAX_LEN) return firstBlock;
  return `${firstBlock.slice(0, NOTES_MAX_LEN - 1).trimEnd()}…`;
}
