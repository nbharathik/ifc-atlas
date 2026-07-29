import Icon from '../ui/Icon';
import { useState, useEffect } from 'react';
import { invokeCommand, isDesktop } from '../../lib/platform';
import { useStore } from '../../store/useStore';

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

function getSessionStorage(): DemoBannerStorage {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // sessionStorage access can throw in strict-cookie sandboxes.
    return null;
  }
}

/**
 * Top-of-app banner shown on the GH-Pages
 * viewer-only bundle (built with `VITE_PUBLIC_DEMO=true`). Dismissable
 * per session; pure frontend, no backend wiring.
 */
export function DemoModeBanner() {
  const [visible, setVisible] = useState(() =>
    shouldShowBanner({
      env: import.meta.env as { VITE_PUBLIC_DEMO?: string | boolean },
      storage: getSessionStorage(),
    }),
  );

  if (!visible) return null;

  const handleDismiss = () => {
    dismissBanner(getSessionStorage());
    setVisible(false);
  };

  return (
    <div className="demo-mode-banner" role="status" aria-label="Demo mode notice">
      <span className="demo-mode-banner-text">
        <strong className="demo-mode-banner-title">Viewer-only demo</strong>
        <span className="demo-mode-banner-sep"> - </span>
        IFC files are parsed locally in your browser and never uploaded.
        AI chat, editing and exports are in the desktop app.{' '}
        <a
          className="demo-mode-banner-link"
          href={SELF_HOST_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Get the desktop app
        </a>
      </span>
      <button
        type="button"
        className="demo-mode-banner-dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss demo banner"
        title="Dismiss for this session"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

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

/**
 * Delay before the first update check. Lets the window paint and the backend
 * sidecar finish coming up so the network poll never competes with startup.
 * The updater endpoint is GitHub, independent of the local backend, so this is
 * purely about not stealing the first frames.
 */
const CHECK_DELAY_MS = 4000;

type InstallPhase = 'idle' | 'installing' | 'error';

function getLocalStorage(): BannerStorage {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // localStorage access can throw in strict-cookie / sandboxed contexts.
    return null;
  }
}

/**
 * Desktop-only floating card that appears when a newer signed build is
 * available on GitHub Releases. Non-modal (bottom-right corner, does not touch
 * the .app-shell grid the top banners use). "Restart & update" downloads,
 * installs and relaunches via the Rust `install_update` command - no manual
 * uninstall/reinstall. The manual Help > "Check for updates…" item stays as a
 * fallback (see Menubar.tsx). On web `isDesktop` is false, so this compiles out.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [phase, setPhase] = useState<InstallPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await invokeCommand<UpdateCheckResult>('check_for_updates');
          if (cancelled) return;
          if (
            shouldPromptForUpdate(res, {
              skipped: getLocalStorage(),
              snoozed: getSessionStorage(),
            })
          ) {
            setUpdate(res);
          }
        } catch {
          // Offline, a dev build without the updater, or an unsigned build:
          // stay silent. The user can still use Help > Check for updates.
        }
      })();
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (!update || !update.version) return null;
  const version = update.version;
  const notes = truncateNotes(update.notes);
  const installing = phase === 'installing';

  const handleInstall = async () => {
    setPhase('installing');
    setErrorMsg(null);
    try {
      // On success the Rust side restarts the app, so control never returns.
      await invokeCommand('install_update');
    } catch (err) {
      setPhase('error');
      setErrorMsg(String(err));
    }
  };

  const handleLater = () => {
    snoozeVersion(getSessionStorage(), version);
    setUpdate(null);
  };

  const handleSkip = () => {
    skipVersion(getLocalStorage(), version);
    setUpdate(null);
  };

  return (
    <div
      className="update-card"
      role="status"
      aria-live="polite"
      aria-label="Update available"
    >
      <button
        type="button"
        className="update-card-skip"
        onClick={handleSkip}
        disabled={installing}
        title={`Skip version ${version} - don't remind me about it again`}
        aria-label={`Skip version ${version}`}
      >
        <Icon name="x" size={14} />
      </button>

      <div className="update-card-head">
        <span className="update-card-icon" aria-hidden="true">
          <Icon name="sparkle" size={16} />
        </span>
        <div className="update-card-titles">
          <strong className="update-card-title">Update available</strong>
          <span className="update-card-version">IFC Atlas {version}</span>
        </div>
      </div>

      {notes && <p className="update-card-notes">{notes}</p>}

      {phase === 'error' && (
        <p className="update-card-error" role="alert">
          Update failed: {errorMsg}
        </p>
      )}

      <div className="update-card-actions">
        <button
          type="button"
          className="btn-secondary"
          onClick={handleLater}
          disabled={installing}
        >
          Later
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            void handleInstall();
          }}
          disabled={installing}
        >
          {installing ? 'Downloading…' : 'Restart & update'}
        </button>
      </div>
    </div>
  );
}

/**
 * Beta warning banner shown while Edit mode is in the **structural** scope.
 *
 * Structural edits (create walls/slabs, delete elements) change geometry and
 * reload the 3D viewer - briefly disruptive. Semantic edits (names, properties)
 * update in place with no reload. This live banner makes the trade-off explicit
 * so the user knows why the viewer reloads after a geometry edit. See
 * dev/docs/EDIT_SCOPES.md.
 */
export function EditScopeBanner() {
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const editMode = useStore((s) => s.editMode);
  const editScope = useStore((s) => s.editScope);
  const setEditScope = useStore((s) => s.setEditScope);

  if (!editModeAvailable || !editMode || editScope !== 'structural') return null;

  return (
    <div className="edit-scope-banner" role="status">
      <Icon name="alert-circle" size={13} strokeWidth={2} />
      <span className="edit-scope-banner-tag">Beta</span>
      <span className="edit-scope-banner-text">
        Structural edits (walls, slabs, delete) <strong>reload the 3D viewer</strong>.
        Property and other semantic edits update instantly without a reload.
      </span>
      <button
        type="button"
        className="edit-scope-banner-switch"
        onClick={() => setEditScope('semantic')}
        title="Switch back to semantic edits (no viewer reload)"
      >
        Switch to Semantic
      </button>
    </div>
  );
}
