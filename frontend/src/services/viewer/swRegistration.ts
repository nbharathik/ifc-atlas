// Service worker registration for WASM pre-cache.
// Registers /sw.js (from public/) which caches web-ifc.wasm, web-ifc-mt.wasm,
// and worker.mjs so IFC loading doesn't block on network for these files.

export type SwStatus =
  | 'unsupported'
  | 'registered'
  | 'already-active'
  | 'error';

export interface SwRegistrationResult {
  status: SwStatus;
  error?: string;
}

export async function registerWasmServiceWorker(): Promise<SwRegistrationResult> {
  if (!('serviceWorker' in navigator)) {
    return { status: 'unsupported' };
  }
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing?.active) {
      return { status: 'already-active' };
    }
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
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
