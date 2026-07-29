/**
 * Platform detection utilities for multi-edition builds.
 *
 * Three editions share this codebase:
 *  - web    (cloud/demo) - standard browser, backend at localhost:8000 or remote
 *  - tauri  (desktop)   - Tauri v2 shell, backend sidecar at 127.0.0.1:8000
 *                          (or an auto-selected free port, announced at runtime
 *                          via the `backend-ready` event / get_backend_url)
 *
 * Compile-time: VITE_PLATFORM env var (set by tauri:build / beforeBuildCommand).
 * Runtime: window.__TAURI__ injected by Tauri's `withGlobalTauri: true`.
 */

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      event?: {
        listen: <T>(
          event: string,
          handler: (event: { payload: T }) => void,
        ) => Promise<() => void>;
      };
    };
    /** Set by `installBackendReadyListener` once Tauri emits `backend-ready`. */
    __backendReadyPort?: number;
  }
  const __VITE_PLATFORM__: string;
}

/** Compile-time platform string: 'web' | 'tauri'. */
export const PLATFORM: string = typeof __VITE_PLATFORM__ !== 'undefined' ? __VITE_PLATFORM__ : 'web';

/** True when compiled for the Tauri desktop shell (compile-time constant -> dead-code elimination). */
export const isDesktop = PLATFORM === 'tauri';

/** Runtime check - true when actually running inside a Tauri window. */
export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI__' in window;

/**
 * Pre-ready fallback backend origin for the desktop build, used before the
 * sidecar has announced its actual port. Empty on web (same-origin / Vite proxy).
 * Uses 127.0.0.1 (NOT `localhost`) on purpose: on Windows `localhost` can resolve
 * to IPv6 `::1` while uvicorn binds IPv4, giving spurious connection-refused.
 */
export const BACKEND_ORIGIN = isDesktop ? 'http://127.0.0.1:8000' : '';

/**
 * Live backend origin. Lazy by design: reads the port the Tauri sidecar
 * announced (`window.__backendReadyPort`, seeded from the `backend-ready` event
 * or, after a webview reload, re-seeded from the Rust `get_backend_url` command),
 * falling back to 8000 before the announce lands. On web returns '' (same-origin).
 * Call this per-request - do NOT cache it in a module constant, or a fallback
 * port would be frozen in before the real one is known.
 */
export function backendOrigin(): string {
  if (!isDesktop) return '';
  const port =
    (typeof window !== 'undefined' && window.__backendReadyPort) || 8000;
  return `http://127.0.0.1:${port}`;
}

/**
 * Prefix an absolute API path (starting with `/api`) with the backend origin.
 * On web this is a no-op (returns the relative path so the Vite proxy / same
 * origin handles it); on desktop it targets the sidecar's announced port.
 */
export function apiUrl(path: string): string {
  return backendOrigin() + path;
}

/**
 * Build a WebSocket URL for an absolute API path (starting with `/api`).
 * On desktop, derives ws://127.0.0.1:<port> from the announced backend origin;
 * on web, derives ws(s):// from the current page origin (Vite proxy / same host).
 */
export function wsUrl(path: string): string {
  if (isDesktop) {
    return backendOrigin().replace(/^http/, 'ws') + path;
  }
  const proto =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? 'wss:'
      : 'ws:';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
  return `${proto}//${host}${path}`;
}

const API_TOKEN_STORAGE_KEY = 'ifc-atlas.api-token';
let desktopTokenPromise: Promise<string | null> | null = null;
let authenticatedFetchInstalled = false;

/** Store a shared-server bootstrap token for the lifetime of this browser tab. */
export function setServerApiToken(token: string): void {
  if (typeof sessionStorage === 'undefined') return;
  const normalized = token.trim();
  if (normalized) {
    sessionStorage.setItem(API_TOKEN_STORAGE_KEY, normalized);
  } else {
    sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

export function clearServerApiToken(): void {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  }
}

export function getStoredServerApiToken(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(API_TOKEN_STORAGE_KEY)?.trim() || null;
}

/**
 * Resolve the credential for the current deployment profile.
 *
 * Desktop receives a random per-launch token over Tauri IPC. Web/server mode
 * uses a per-tab token entered through BackendGate; it is deliberately not
 * persisted to localStorage or compiled into the frontend bundle.
 */
export async function getApiAccessToken(): Promise<string | null> {
  if (!isDesktop) return getStoredServerApiToken();
  if (desktopTokenPromise === null) {
    desktopTokenPromise = invokeCommand<string>('get_backend_auth_token')
      .then((token) => token?.trim() || null)
      .catch(() => null);
  }
  return desktopTokenPromise;
}

function requestUrl(input: RequestInfo | URL): URL | null {
  if (typeof window === 'undefined') return null;
  try {
    const value =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return new URL(value, window.location.href);
  } catch {
    return null;
  }
}

function isBackendApiRequest(input: RequestInfo | URL): boolean {
  const url = requestUrl(input);
  if (url === null || !url.pathname.startsWith('/api/')) return false;
  if (!isDesktop) return url.origin === window.location.origin;
  try {
    return url.origin === new URL(backendOrigin()).origin;
  } catch {
    return false;
  }
}

function mergeAuthorization(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  token: string,
): RequestInit {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...init, headers };
}

/**
 * Install one narrowly-scoped fetch interceptor for Atlas API URLs.
 *
 * Existing feature modules currently call `fetch(apiUrl(...))` directly. This
 * central boundary secures all of them now; Phase 1's generated API client can
 * replace the interceptor without another backend authentication change.
 */
export function installApiAuthentication(): void {
  if (
    authenticatedFetchInstalled
    || typeof window === 'undefined'
    || typeof window.fetch !== 'function'
  ) {
    return;
  }
  authenticatedFetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isBackendApiRequest(input)) {
      return nativeFetch(input, init);
    }
    const token = await getApiAccessToken();
    return nativeFetch(
      input,
      token ? mergeAuthorization(input, init, token) : init,
    );
  };
}

/** Build an authenticated browser WebSocket URL without logging the token. */
export async function authenticatedWsUrl(path: string): Promise<string> {
  const url = new URL(wsUrl(path));
  const token = await getApiAccessToken();
  if (token) url.searchParams.set('access_token', token);
  return url.toString();
}

/**
 * Call a Tauri IPC command (Rust handler). Returns null on web.
 * Caller must handle the null case gracefully.
 */
export async function invokeCommand<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauri()) return null;
  const tauri = window.__TAURI__;
  if (!tauri?.core) return null;
  return tauri.core.invoke(cmd, args) as Promise<T>;
}

/**
 * Open a native file-open dialog (Tauri desktop only).
 * Returns the selected file path, or null if cancelled / running on web.
 *
 * On web, callers should fall back to <input type="file"> instead.
 */
export async function openNativeFileDialog(
  filters: Array<{ name: string; extensions: string[] }>,
): Promise<string | null> {
  if (!isTauri()) return null;
  // Dynamic import so the package is only loaded inside Tauri builds.
  // The package name is held in a runtime variable so neither TypeScript's
  // resolver nor Vite's import-analysis plugin tries to resolve it at build
  // time - `@vite-ignore` reinforces that intent. The runtime `try/catch`
  // covers both "not installed" (web build) and "installed but capability
  // not declared" (Tauri build missing `dialog:allow-open`).
  const pkg = '@tauri-apps/plugin-dialog';
  try {
    const mod = (await import(/* @vite-ignore */ pkg)) as {
      open: (opts: { filters: typeof filters; multiple: false }) => Promise<string | null>;
    };
    return mod.open({ filters, multiple: false });
  } catch {
    console.warn('[platform] @tauri-apps/plugin-dialog not installed - falling back to null');
    return null;
  }
}

/**
 * Get the backend URL configured at runtime by the Tauri sidecar manager.
 * Returns the default origin when not in a Tauri context.
 */
export async function getBackendUrl(): Promise<string> {
  const fromTauri = await invokeCommand<string>('get_backend_url');
  return fromTauri ?? BACKEND_ORIGIN;
}
