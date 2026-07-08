import { useState } from 'react';

import {
  SELF_HOST_GUIDE_URL,
  dismissBanner,
  shouldShowBanner,
  type DemoBannerStorage,
} from './demoModeBannerHelpers';

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
export default function DemoModeBanner() {
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
