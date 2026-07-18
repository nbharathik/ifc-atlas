import { useEffect, useState } from 'react';

import Icon from '../ui/Icon';
import { invokeCommand, isDesktop } from '../../lib/platform';
import {
  shouldPromptForUpdate,
  skipVersion,
  snoozeVersion,
  truncateNotes,
  type BannerStorage,
  type UpdateCheckResult,
} from './updateBannerHelpers';

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

function getSessionStorage(): BannerStorage {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
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
export default function UpdateBanner() {
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
