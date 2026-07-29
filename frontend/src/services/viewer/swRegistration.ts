// Service worker registration for WASM pre-cache.
// Registers /sw.js (from public/) which caches the active single-thread
// web-ifc.wasm binary and worker.mjs so IFC loading does not block on network.

export type SwStatus =
  | 'unsupported'
  | 'registered'
  | 'already-active'
  | 'error';

export interface SwRegistrationResult {
  status: SwStatus;
  error?: string;
}

/**
 * Build stamp forwarded to the service worker as its cache namespace.
 *
 * The worker caches cache-first, so without a per-build namespace a returning
 * visitor keeps the previous build's `worker.mjs` and wasm forever. The stamp
 * changes on every build, which makes the old cache unreachable and lets the
 * worker's activate handler delete it.
 */
declare const __SW_BUILD_ID__: string | undefined;

const SW_BUILD_ID: string =
  typeof __SW_BUILD_ID__ === 'string' ? __SW_BUILD_ID__ : 'dev';

const SW_QUERY = `?v=${encodeURIComponent(SW_BUILD_ID)}`;

export async function registerWasmServiceWorker(): Promise<SwRegistrationResult> {
  if (!('serviceWorker' in navigator)) {
    return { status: 'unsupported' };
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    // Suffix compare rather than URL parsing: this module is exercised in a
    // node test environment with no global location to resolve against.
    if (existing?.active?.scriptURL?.endsWith(SW_QUERY)) {
      return { status: 'already-active' };
    }
    await navigator.serviceWorker.register(`/sw.js${SW_QUERY}`, { scope: '/' });
    return { status: 'registered' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 'error', error: msg };
  }
}

export async function unregisterWasmServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.unregister() : false;
}

/**
 * Calls `cb` once the service worker controls this page.
 * If a controller is already present the callback fires synchronously.
 * Returns a cleanup function that removes the event listener.
 */
export function listenForSwActivation(cb: () => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  if (navigator.serviceWorker.controller) {
    cb();
    return () => {};
  }
  const handler = () => { if (navigator.serviceWorker.controller) cb(); };
  navigator.serviceWorker.addEventListener('controllerchange', handler);
  return () => navigator.serviceWorker.removeEventListener('controllerchange', handler);
}
