/**
 * Share-link URL state encoding.
 *
 * Packs camera + isolatedIds + highlightedIds + rightActiveTab into the
 * URL hash fragment (`#share:<base64url>`). The hash is safe to share -
 * it contains no auth tokens, no file data, only viewer state.
 *
 * Schema version 1:
 *   v   - version (always 1)
 *   cam - camera position + look-at target (rounded to 3 dp)
 *   iso - sorted isolatedIds array
 *   hi  - sorted highlightedIds array
 *   tab - rightActiveTab string ('props' | 'views' | 'log' | 'chat' | 'tools')
 */

export interface ShareCameraState {
  /** Camera eye position. */
  p: [number, number, number];
  /** Camera look-at target. */
  t: [number, number, number];
}

export interface ShareState {
  /** Schema version. Must be 1. */
  v: 1;
  cam?: ShareCameraState;
  iso?: number[];
  hi?: number[];
  tab?: string;
}

const HASH_PREFIX = 'share:';

// ─── Encoding ────────────────────────────────────────────────────────────────

function base64UrlEncode(str: string): string {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function roundVec3(v: [number, number, number]): [number, number, number] {
  return [
    Math.round(v[0] * 1000) / 1000,
    Math.round(v[1] * 1000) / 1000,
    Math.round(v[2] * 1000) / 1000,
  ];
}

/**
 * Encode a ShareState to a base64url string for embedding in the URL hash.
 * The caller sets `window.location.hash = HASH_PREFIX + result`.
 */
export function encodeShareState(state: ShareState): string {
  const compact: ShareState = { v: 1 };

  if (state.cam) {
    compact.cam = {
      p: roundVec3(state.cam.p),
      t: roundVec3(state.cam.t),
    };
  }
  if (state.iso && state.iso.length > 0) {
    compact.iso = [...state.iso].sort((a, b) => a - b);
  }
  if (state.hi && state.hi.length > 0) {
    compact.hi = [...state.hi].sort((a, b) => a - b);
  }
  if (state.tab) {
    compact.tab = state.tab;
  }

  return base64UrlEncode(JSON.stringify(compact));
}

/**
 * Build the full URL hash fragment for a share link.
 */
export function buildShareHash(state: ShareState): string {
  return `${HASH_PREFIX}${encodeShareState(state)}`;
}

/**
 * Build a complete share URL (current origin + path + encoded hash).
 */
export function buildShareUrl(state: ShareState, base = window.location.href.split('#')[0]): string {
  return `${base}#${buildShareHash(state)}`;
}

// ─── Decoding ────────────────────────────────────────────────────────────────

function base64UrlDecode(str: string): string {
  // Pad to a multiple of 4
  const padded = str + '==='.slice((str.length + 3) % 4);
  return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

/**
 * Decode and validate a base64url-encoded share state.
 * Returns null if the hash is missing, malformed, or an unsupported version.
 */
export function decodeShareState(encoded: string): ShareState | null {
  try {
    const json = base64UrlDecode(encoded);
    const parsed = JSON.parse(json) as Partial<ShareState>;
    if (parsed.v !== 1) return null;

    const result: ShareState = { v: 1 };

    if (parsed.cam) {
      const { p, t } = parsed.cam;
      if (Array.isArray(p) && p.length === 3 && Array.isArray(t) && t.length === 3) {
        result.cam = {
          p: p as [number, number, number],
          t: t as [number, number, number],
        };
      }
    }
    if (Array.isArray(parsed.iso) && parsed.iso.every((x) => typeof x === 'number')) {
      result.iso = parsed.iso;
    }
    if (Array.isArray(parsed.hi) && parsed.hi.every((x) => typeof x === 'number')) {
      result.hi = parsed.hi;
    }
    if (typeof parsed.tab === 'string') {
      result.tab = parsed.tab;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Parse the current `window.location.hash` into a ShareState.
 * Returns null when the hash is absent or not a share link.
 */
export function parseShareHash(hash = window.location.hash): ShareState | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(HASH_PREFIX)) return null;
  return decodeShareState(raw.slice(HASH_PREFIX.length));
}

/**
 * Clear the share hash from the URL without triggering a navigation.
 */
export function clearShareHash(): void {
  const url = new URL(window.location.href);
  if (url.hash.startsWith(`#${HASH_PREFIX}`)) {
    history.replaceState(null, '', url.pathname + url.search);
  }
}
