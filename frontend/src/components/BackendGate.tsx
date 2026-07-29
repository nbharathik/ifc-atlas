import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  apiUrl,
  clearServerApiToken,
  getBackendUrl,
  getStoredServerApiToken,
  invokeCommand,
  isDesktop,
  isTauri,
  setServerApiToken,
} from '../lib/platform';
import { BROWSER_ONLY } from '../config/featureFlags';

type GateStatus = 'connecting' | 'ready' | 'failed' | 'crashed' | 'reconnecting';

const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 800;

/**
 * Desktop-only startup gate + backend-crash recovery surface.
 *
 * The Tauri shell spawns the Python backend sidecar asynchronously; until it is
 * bound and answering, every REST/WS call would target the wrong/unready port.
 * This blocks the app behind a "Starting..." splash until the backend answers
 * `/api/health`, then renders children. On web it is a transparent pass-through
 * (the `isDesktop` check is a compile-time constant, so the gate is dead-code
 * eliminated from web builds).
 *
 * Readiness is driven by POLLING `get_backend_url()` + `/api/health`. That is
 * authoritative and survives a webview reload, because the announced port lives
 * in Rust state - unlike the one-shot `backend-ready` DOM event, which the poll
 * treats as an optional fast-path. After ~30s with no healthy backend it shows
 * an error card whose button calls the Rust `restart_backend` command - a
 * webview reload alone can never revive a dead sidecar.
 *
 * Post-ready crashes (`backend-crashed` from the Rust stdout watcher) keep the
 * children MOUNTED - the viewer is frontend-first and keeps working without a
 * backend - and show a recovery overlay with Restart / Continue instead of
 * tearing the session down.
 */
export function BackendGate({ children }: { children: ReactNode }) {
  if (BROWSER_ONLY) return <>{children}</>;
  if (isDesktop) return <DesktopBackendGate>{children}</DesktopBackendGate>;
  return <ServerSecurityGate>{children}</ServerSecurityGate>;
}

type SecurityInfo = {
  mode: 'local' | 'server';
  auth_required: boolean;
};

function ServerSecurityGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'ready' | 'token' | 'failed'>(
    'checking',
  );
  const [token, setToken] = useState('');
  const [reason, setReason] = useState('');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const infoResponse = await fetch(apiUrl('/api/security'), {
          cache: 'no-store',
        });
        if (!infoResponse.ok) {
          throw new Error(`security profile returned ${infoResponse.status}`);
        }
        const info = (await infoResponse.json()) as SecurityInfo;
        if (!info.auth_required) {
          if (!cancelled) setStatus('ready');
          return;
        }

        if (!getStoredServerApiToken()) {
          if (!cancelled) setStatus('token');
          return;
        }
        const verify = await fetch(apiUrl('/api/security/verify'), {
          method: 'POST',
          cache: 'no-store',
        });
        if (verify.ok) {
          if (!cancelled) setStatus('ready');
          return;
        }
        clearServerApiToken();
        if (!cancelled) {
          setReason('The saved access token is no longer valid.');
          setStatus('token');
        }
      } catch (error) {
        if (!cancelled) {
          setReason(`Could not reach the IFC Atlas backend: ${String(error)}`);
          setStatus('failed');
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  const authenticate = async () => {
    const normalized = token.trim();
    if (!normalized) {
      setReason('Enter the server access token.');
      return;
    }
    setServerApiToken(normalized);
    try {
      const verify = await fetch(apiUrl('/api/security/verify'), {
        method: 'POST',
        cache: 'no-store',
      });
      if (!verify.ok) {
        clearServerApiToken();
        setReason('The server rejected this access token.');
        return;
      }
      setToken('');
      setReason('');
      setStatus('ready');
    } catch (error) {
      clearServerApiToken();
      setReason(`Could not verify the access token: ${String(error)}`);
    }
  };

  if (status === 'ready') return <>{children}</>;

  return (
    <div style={overlayStyle}>
      <style>{spinnerKeyframes}</style>
      {status === 'checking' ? (
        <>
          <div style={spinnerStyle} />
          <div style={titleStyle}>Checking server security...</div>
        </>
      ) : status === 'token' ? (
        <form
          style={authFormStyle}
          onSubmit={(event) => {
            event.preventDefault();
            void authenticate();
          }}
        >
          <div style={titleStyle}>Server access required</div>
          <div style={subStyle}>
            Enter the access token configured by this IFC Atlas server. It is
            kept only in this browser tab.
          </div>
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            aria-label="IFC Atlas server access token"
            style={tokenInputStyle}
            autoFocus
          />
          {reason && <div style={authErrorStyle}>{reason}</div>}
          <button type="submit" style={retryStyle}>
            Connect
          </button>
        </form>
      ) : (
        <>
          <div style={errIconStyle}>⚠</div>
          <div style={titleStyle}>Backend unavailable</div>
          <div style={subStyle}>{reason}</div>
          <button
            type="button"
            style={retryStyle}
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}

function DesktopBackendGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus>('connecting');
  const [reason, setReason] = useState<string>('');
  const [pollNonce, setPollNonce] = useState(0);

  // Health polling. Runs for the startup gate ('connecting') and after a
  // crash-restart ('reconnecting'); re-armed by bumping pollNonce.
  useEffect(() => {
    if (status !== 'connecting' && status !== 'reconnecting') return;
    const startup = status === 'connecting';
    let cancelled = false;
    let failedReason = '';

    const onFailed = (e: Event) => {
      const detail = (e as CustomEvent<{ reason?: string }>).detail;
      failedReason = detail?.reason || 'The backend failed to start.';
    };
    window.addEventListener('backend-failed', onFailed as EventListener);

    const seedPortFromOrigin = (origin: string) => {
      try {
        const p = Number(new URL(origin).port);
        if (p) window.__backendReadyPort = p;
      } catch {
        /* ignore malformed origin */
      }
    };

    const probeOnce = async (): Promise<boolean> => {
      try {
        // Authoritative: reads the live port from Rust state (survives reload).
        const origin = await getBackendUrl();
        if (!origin) return false;
        const resp = await fetch(`${origin}/api/health`, { cache: 'no-store' });
        if (resp.ok) {
          seedPortFromOrigin(origin);
          return true;
        }
      } catch {
        /* backend not up yet */
      }
      return false;
    };

    const fail = (why: string) => {
      if (cancelled) return;
      setReason(why);
      // Startup failures block (nothing useful behind the splash yet);
      // post-crash failures keep the app mounted behind the overlay.
      setStatus(startup ? 'failed' : 'crashed');
    };

    (async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (!cancelled) {
        if (await probeOnce()) {
          if (!cancelled) {
            setReason('');
            setStatus('ready');
          }
          return;
        }
        if (failedReason) {
          // A hard-failure event arrived. Give health one last chance (the
          // dynamic-port fallback may have recovered) before surfacing it.
          if (await probeOnce()) {
            if (!cancelled) setStatus('ready');
            return;
          }
          fail(failedReason);
          return;
        }
        if (Date.now() > deadline) {
          fail(
            'The backend did not start within 30 seconds. It may have crashed, '
              + 'or a required local port is blocked by another program.',
          );
          return;
        }
        await new Promise((r) => window.setTimeout(r, POLL_INTERVAL_MS));
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('backend-failed', onFailed as EventListener);
    };
  }, [status, pollNonce]);

  // Post-ready crash listener (armed once). The Rust stdout watcher emits
  // `backend-crashed` when the sidecar exits AFTER announcing readiness.
  useEffect(() => {
    const onCrashed = (e: Event) => {
      const detail = (e as CustomEvent<{ code?: number | null }>).detail;
      const codeText = detail?.code != null ? ` (exit code ${detail.code})` : '';
      setReason(`The local engine stopped unexpectedly${codeText}.`);
      // Startup failures keep the blocking 'failed' path; anything later
      // becomes the non-destructive crash overlay.
      setStatus((s) => (s === 'connecting' || s === 'failed' ? s : 'crashed'));
    };
    window.addEventListener('backend-crashed', onCrashed as EventListener);
    return () => window.removeEventListener('backend-crashed', onCrashed as EventListener);
  }, []);

  const restartBackend = async (from: GateStatus) => {
    if (!isTauri()) {
      // Not actually inside Tauri (dev edge case) - old fallback.
      window.location.reload();
      return;
    }
    try {
      await invokeCommand('restart_backend');
      setReason('');
      setStatus(from === 'failed' ? 'connecting' : 'reconnecting');
      setPollNonce((n) => n + 1);
    } catch (err) {
      setReason(`Restart failed: ${String(err)}`);
    }
  };

  if (status === 'ready') return <>{children}</>;

  // Post-ready states keep the app mounted: the viewer core is frontend-first
  // and survives a dead backend; only backend features are degraded.
  if (status === 'crashed' || status === 'reconnecting') {
    return (
      <>
        {children}
        <div style={overlayStyle}>
          <style>{spinnerKeyframes}</style>
          {status === 'reconnecting' ? (
            <>
              <div style={spinnerStyle} />
              <div style={titleStyle}>Restarting the local engine...</div>
            </>
          ) : (
            <>
              <div style={errIconStyle}>⚠</div>
              <div style={titleStyle}>The local engine stopped</div>
              <div style={subStyle}>
                {reason} The 3D viewer keeps working; backend features (chat,
                analysis panels, saving) are unavailable until it restarts.
              </div>
              <div style={buttonRowStyle}>
                <button type="button" style={retryStyle} onClick={() => restartBackend('crashed')}>
                  Restart backend
                </button>
                <button type="button" style={dismissStyle} onClick={() => setStatus('ready')}>
                  Continue without it
                </button>
                <button
                  type="button"
                  style={dismissStyle}
                  onClick={() => void invokeCommand('open_logs_dir')}
                >
                  Open logs
                </button>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div style={overlayStyle}>
      <style>{spinnerKeyframes}</style>
      {status === 'connecting' ? (
        <>
          <div style={spinnerStyle} />
          <div style={titleStyle}>Starting IFC Atlas...</div>
          <div style={subStyle}>
            Launching the local engine. The first run can take a few seconds.
          </div>
        </>
      ) : (
        <>
          <div style={errIconStyle}>⚠</div>
          <div style={titleStyle}>Couldn&rsquo;t start the backend</div>
          <div style={subStyle}>{reason}</div>
          <div style={buttonRowStyle}>
            <button type="button" style={retryStyle} onClick={() => restartBackend('failed')}>
              Restart backend
            </button>
            <button
              type="button"
              style={dismissStyle}
              onClick={() => void invokeCommand('open_logs_dir')}
            >
              Open logs
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Styles: self-contained startup overlay.
const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  background: 'rgba(0,0,0,0.92)',
  color: '#f5f5f5',
  fontFamily:
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  textAlign: 'center',
  padding: 24,
};

const spinnerStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 9999,
  border: '3px solid rgba(245,245,245,0.18)',
  borderTopColor: '#f5f5f5',
  animation: 'ifc-gate-spin 0.8s linear infinite',
};

const errIconStyle: CSSProperties = { fontSize: 32, lineHeight: 1 };

const titleStyle: CSSProperties = { fontSize: 16, fontWeight: 600 };

const subStyle: CSSProperties = {
  fontSize: 13,
  color: 'rgba(245,245,245,0.6)',
  maxWidth: 380,
  lineHeight: 1.5,
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 8,
};

const authFormStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  width: 'min(420px, 100%)',
};

const tokenInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  padding: '10px 12px',
  borderRadius: 6,
  border: '1px solid rgba(245,245,245,0.25)',
  background: 'rgba(255,255,255,0.08)',
  color: '#f5f5f5',
  fontSize: 14,
};

const authErrorStyle: CSSProperties = {
  color: '#ff9a9a',
  fontSize: 13,
  lineHeight: 1.4,
};

const retryStyle: CSSProperties = {
  padding: '8px 20px',
  borderRadius: 6,
  border: '1px solid rgba(245,245,245,0.25)',
  background: 'transparent',
  color: '#f5f5f5',
  fontSize: 13,
  cursor: 'pointer',
};

const dismissStyle: CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid rgba(245,245,245,0.12)',
  background: 'transparent',
  color: 'rgba(245,245,245,0.65)',
  fontSize: 13,
  cursor: 'pointer',
};

const spinnerKeyframes = '@keyframes ifc-gate-spin { to { transform: rotate(360deg); } }';
