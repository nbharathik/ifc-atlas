/**
 * Pure helpers for the demo-mode banner shown on the
 * GH-Pages viewer-only bundle. Kept separate from the React component
 * so vitest (node env, *.test.ts only - see `vite.config.ts`) can
 * exercise the dismissal logic without a DOM.
 *
 * The banner activates when `import.meta.env.VITE_PUBLIC_DEMO === 'true'`
 * (Vite stringifies env values at build time, so we accept both the
 * string `'true'` and the boolean `true` for forward-compat).
 *
 * Dismissal is per-session: stored in `sessionStorage` so a refresh
 * within the same tab keeps it hidden, but a new tab shows it again.
 */
export const DEMO_BANNER_DISMISSED_KEY = 'demo_banner_dismissed';

/**
 * Self-host guide on GitHub. Exported so tests can lock the path in and the
 * component imports the single source of truth.
 */
export const SELF_HOST_GUIDE_URL =
  'https://github.com/nbharathik/ifc-atlas/blob/main/docs/user/DEPLOY_YOUR_OWN.md';

export interface DemoBannerEnv {
  readonly VITE_PUBLIC_DEMO?: string | boolean;
}

export type DemoBannerStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

export function isDemoMode(env: DemoBannerEnv): boolean {
  return env.VITE_PUBLIC_DEMO === 'true' || env.VITE_PUBLIC_DEMO === true;
}

export function isBannerDismissed(storage: DemoBannerStorage): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DEMO_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissBanner(storage: DemoBannerStorage): void {
  if (!storage) return;
  try {
    storage.setItem(DEMO_BANNER_DISMISSED_KEY, '1');
  } catch {
    /* sessionStorage can throw in private-mode / quota-exceeded; ignore. */
  }
}

export interface ShouldShowBannerOpts {
  readonly env: DemoBannerEnv;
  readonly storage: DemoBannerStorage;
}

export function shouldShowBanner(opts: ShouldShowBannerOpts): boolean {
  return isDemoMode(opts.env) && !isBannerDismissed(opts.storage);
}
