// Listen for the `backend-ready` event emitted by the Tauri Rust side once the
// FastAPI sidecar prints `BACKEND_READY port=N` on stdout. See
// `src-tauri/src/lib.rs` (Stdout watcher) and `docs/architecture/TAURI.md`.
//
// The event tells us the backend is bound and accepting connections, and which
// port it actually chose (it may have fallen back off 8000). We store the port
// in `window.__backendReadyPort` so the lazy API/WS base helpers in platform.ts
// target it, and re-dispatch a DOM event so the BackendGate can drop its splash.
//
// Browser builds (Vite dev, GH-Pages demo) have no `window.__TAURI__` global,
// so these listeners silently no-op.

// The `window.__TAURI__` and `__backendReadyPort` globals are declared in
// `frontend/src/lib/platform.ts`; we just consume them here.

export interface BackendReadyPayload {
  port: number;
}

export interface BackendFailedPayload {
  reason: string;
}

export interface BackendCrashedPayload {
  code: number | null;
}

let installed = false;

export function installBackendReadyListener(): void {
  if (installed) return;
  installed = true;

  const api = typeof window !== 'undefined' ? window.__TAURI__?.event : undefined;
  if (!api) return;

  api
    .listen<BackendReadyPayload>('backend-ready', ({ payload }) => {
      window.__backendReadyPort = payload.port;
      window.dispatchEvent(
        new CustomEvent<BackendReadyPayload>('backend-ready', { detail: payload }),
      );
      console.info('[tauri] backend-ready', payload);
    })
    .catch((err) => {
      console.warn('[tauri] failed to attach backend-ready listener', err);
    });

  // The Rust side emits `backend-failed` if the sidecar can't spawn or exits
  // before announcing readiness. Re-dispatch as a DOM event so the BackendGate
  // can show an error/retry card. Best-effort fast-path: the gate's health-poll
  // timeout is the guaranteed backstop if this event fires before JS attaches.
  api
    .listen<BackendFailedPayload>('backend-failed', ({ payload }) => {
      window.dispatchEvent(
        new CustomEvent<BackendFailedPayload>('backend-failed', { detail: payload }),
      );
      console.warn('[tauri] backend-failed', payload);
    })
    .catch((err) => {
      console.warn('[tauri] failed to attach backend-failed listener', err);
    });

  // `backend-crashed` fires when the sidecar exits AFTER it was ready. The
  // BackendGate flips back to its error card, whose Restart button calls the
  // `restart_backend` command - a plain reload can never revive a dead sidecar.
  api
    .listen<BackendCrashedPayload>('backend-crashed', ({ payload }) => {
      window.dispatchEvent(
        new CustomEvent<BackendCrashedPayload>('backend-crashed', { detail: payload }),
      );
      console.warn('[tauri] backend-crashed', payload);
    })
    .catch((err) => {
      console.warn('[tauri] failed to attach backend-crashed listener', err);
    });
}
