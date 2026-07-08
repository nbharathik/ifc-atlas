import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  DEMO_BANNER_DISMISSED_KEY,
  SELF_HOST_GUIDE_URL,
  dismissBanner,
  isBannerDismissed,
  isDemoMode,
  shouldShowBanner,
  type DemoBannerStorage,
} from '../demoModeBannerHelpers';

// __tests__ → layout → components → src → frontend → repo root
const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

function makeStorage(initial: Record<string, string> = {}): DemoBannerStorage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

function makeThrowingStorage(): DemoBannerStorage {
  return {
    getItem() {
      throw new Error('sessionStorage disabled');
    },
    setItem() {
      throw new Error('sessionStorage disabled');
    },
  };
}

describe('demoModeBannerHelpers - isDemoMode', () => {
  it('returns true for the string "true" (Vite stringifies env at build time)', () => {
    expect(isDemoMode({ VITE_PUBLIC_DEMO: 'true' })).toBe(true);
  });

  it('returns true for the boolean true (forward-compat)', () => {
    expect(isDemoMode({ VITE_PUBLIC_DEMO: true })).toBe(true);
  });

  it('returns false for undefined / missing flag', () => {
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ VITE_PUBLIC_DEMO: undefined })).toBe(false);
  });

  it('returns false for the string "false" or any other truthy-ish value', () => {
    expect(isDemoMode({ VITE_PUBLIC_DEMO: 'false' })).toBe(false);
    expect(isDemoMode({ VITE_PUBLIC_DEMO: '1' })).toBe(false);
    expect(isDemoMode({ VITE_PUBLIC_DEMO: '' })).toBe(false);
  });

  it('is case-sensitive: "TRUE" / "True" do NOT match', () => {
    // Vite stringifies env values verbatim - we only accept the canonical
    // lowercase form so misspelled build flags do not silently enable demo
    // mode on a self-hosted full-app build.
    expect(isDemoMode({ VITE_PUBLIC_DEMO: 'TRUE' })).toBe(false);
    expect(isDemoMode({ VITE_PUBLIC_DEMO: 'True' })).toBe(false);
  });
});

describe('demoModeBannerHelpers - SELF_HOST_GUIDE_URL', () => {
  it('points at the published deploy-your-own user doc', () => {
    expect(SELF_HOST_GUIDE_URL).toMatch(/^https:\/\/github\.com\//);
    expect(SELF_HOST_GUIDE_URL).toMatch(/docs\/user\/DEPLOY_YOUR_OWN\.md$/);
  });

  it('targets a file that actually exists in the repo (catches link rot)', () => {
    // The regex pin above protects the URL shape but not the path. If
    // someone renames or relocates the doc, the URL still matches the
    // pattern yet 404s in browsers. This test resolves the /blob/master/
    // path against the repo root and asserts the file is present, so a
    // rename surfaces here before the banner ships broken.
    const match = SELF_HOST_GUIDE_URL.match(/\/blob\/master\/(.+)$/);
    expect(match, 'URL must use /blob/master/{path} shape').not.toBeNull();
    const repoRelPath = match![1];
    const fullPath = resolve(REPO_ROOT, repoRelPath);
    expect(
      existsSync(fullPath),
      `SELF_HOST_GUIDE_URL points to ${repoRelPath} but no file found at ${fullPath}`,
    ).toBe(true);
  });
});

describe('demoModeBannerHelpers - dismissal storage', () => {
  it('isBannerDismissed returns false when storage is null (SSR / disabled)', () => {
    expect(isBannerDismissed(null)).toBe(false);
  });

  it('isBannerDismissed returns false when key is absent', () => {
    expect(isBannerDismissed(makeStorage())).toBe(false);
  });

  it('isBannerDismissed returns true after dismissBanner sets the flag', () => {
    const storage = makeStorage();
    dismissBanner(storage);
    expect(isBannerDismissed(storage)).toBe(true);
    expect(storage!.getItem(DEMO_BANNER_DISMISSED_KEY)).toBe('1');
  });

  it('isBannerDismissed treats unrelated values as "not dismissed"', () => {
    // Sanity: only the exact sentinel '1' counts. Older / partial states
    // (e.g. left over from a malformed write) shouldn't suppress the banner.
    expect(isBannerDismissed(makeStorage({ [DEMO_BANNER_DISMISSED_KEY]: '0' }))).toBe(false);
    expect(isBannerDismissed(makeStorage({ [DEMO_BANNER_DISMISSED_KEY]: 'true' }))).toBe(false);
  });

  it('dismissBanner is a silent no-op when storage is null', () => {
    expect(() => dismissBanner(null)).not.toThrow();
  });

  it('dismissBanner swallows storage exceptions (incognito / quota)', () => {
    expect(() => dismissBanner(makeThrowingStorage())).not.toThrow();
  });

  it('isBannerDismissed returns false (not crash) when storage throws', () => {
    expect(isBannerDismissed(makeThrowingStorage())).toBe(false);
  });
});

describe('demoModeBannerHelpers - shouldShowBanner composition', () => {
  it('returns false when demo flag is off, regardless of storage', () => {
    expect(shouldShowBanner({ env: {}, storage: makeStorage() })).toBe(false);
    expect(
      shouldShowBanner({
        env: {},
        storage: makeStorage({ [DEMO_BANNER_DISMISSED_KEY]: '1' }),
      }),
    ).toBe(false);
  });

  it('returns false when demo flag is on but banner was previously dismissed', () => {
    expect(
      shouldShowBanner({
        env: { VITE_PUBLIC_DEMO: 'true' },
        storage: makeStorage({ [DEMO_BANNER_DISMISSED_KEY]: '1' }),
      }),
    ).toBe(false);
  });

  it('returns true when demo flag is on and storage is fresh', () => {
    expect(
      shouldShowBanner({
        env: { VITE_PUBLIC_DEMO: 'true' },
        storage: makeStorage(),
      }),
    ).toBe(true);
  });

  it('flips from true to false after a dismissBanner call on the same storage', () => {
    const storage = makeStorage();
    const env = { VITE_PUBLIC_DEMO: 'true' as const };
    expect(shouldShowBanner({ env, storage })).toBe(true);
    dismissBanner(storage);
    expect(shouldShowBanner({ env, storage })).toBe(false);
  });

  it('shows the banner when storage is null (SSR / sandboxed iframe)', () => {
    // Server-rendering and strict-cookie iframes both yield a null storage.
    // Demo mode users should still see the banner in that path - they just
    // can't persist a dismissal across reloads.
    expect(
      shouldShowBanner({
        env: { VITE_PUBLIC_DEMO: 'true' },
        storage: null,
      }),
    ).toBe(true);
  });

  it('shows the banner when storage throws on read', () => {
    // sessionStorage can throw in private-mode / blocked-cookies. The banner
    // should still render rather than crash-hide.
    const throwingStorage: DemoBannerStorage = {
      getItem() {
        throw new Error('disabled');
      },
      setItem() {
        throw new Error('disabled');
      },
    };
    expect(
      shouldShowBanner({
        env: { VITE_PUBLIC_DEMO: 'true' },
        storage: throwingStorage,
      }),
    ).toBe(true);
  });
});
