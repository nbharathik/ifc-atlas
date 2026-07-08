import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { getReadiness } from '../../services/api';

/** How long the "AI ready" chip lingers before auto-hiding. */
const READY_VISIBLE_MS = 3500;

/**
 * AI readiness chip - push-driven via the model-sync WS.
 *
 * Mounted at the top of `ChatPanel.tsx`. Bootstraps once on mount with a
 * single `/api/ifc/readiness` call so the chip never starts blank, then
 * listens for `readiness_changed` events on the model-sync WS (handled in
 * `App.tsx` → store) for live updates - no more 1.5 s polling.
 *
 * A 10 s safety-net poll runs only while `ifcopenshell` is still pre-ready,
 * to recover if a WS event was missed during reconnect.
 *
 * Visible only when a model is loaded (`modelLoaded === true`).
 */
export default function AIReadinessChip() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const readiness = useStore((s) => s.readiness);
  const setReadiness = useStore((s) => s.setReadiness);
  const pollTimerRef = useRef<number | null>(null);
  // Hide the chip a few seconds after it settles in the "ready" state so it
  // doesn't sit on top of the chat forever. Warming / degraded / error stay
  // visible (those are actionable). Re-mounting the chat panel resets this.
  const [dismissed, setDismissed] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!modelLoaded) {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const snap = await getReadiness();
        if (cancelled) return;
        setReadiness(snap);
        // Stop the safety-net poll once IfcOpenShell is settled - live
        // transitions arrive over the model-sync WS.
        if (
          (snap.ifcopenshell === 'ready' || snap.ifcopenshell === 'error') &&
          pollTimerRef.current !== null
        ) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } catch {
        // Network blip - WS reconnect or next safety-net tick will retry.
      }
    };

    // Bootstrap fetch - covers the case where the WS event for the current
    // state already fired before the chip mounted.
    fetchOnce();
    // Safety-net poll at a low cadence so a dropped WS event still recovers.
    pollTimerRef.current = window.setInterval(fetchOnce, 10000);

    return () => {
      cancelled = true;
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [modelLoaded, setReadiness]);

  const overall = readiness
    ? pickOverallState(readiness.ifcopenshell, readiness.native_index)
    : null;

  // Schedule auto-hide when (and only when) the chip settles in "ready".
  // Any transition AWAY from "ready" - warming again, degrade, error - must
  // un-dismiss so the user sees the new state.
  useEffect(() => {
    if (overall === 'ready') {
      if (hideTimerRef.current === null) {
        hideTimerRef.current = window.setTimeout(() => {
          setDismissed(true);
          hideTimerRef.current = null;
        }, READY_VISIBLE_MS);
      }
    } else {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (dismissed) setDismissed(false);
    }
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [overall, dismissed]);

  if (!modelLoaded) return null;
  if (dismissed && overall === 'ready') return null;
  if (!readiness) {
    return (
      <div className="ai-readiness-chip ai-readiness-chip--loading" title="Checking AI backend status…">
        <span className="ai-readiness-chip__dot ai-readiness-chip__dot--pulse" />
        <span className="ai-readiness-chip__label">AI: checking…</span>
      </div>
    );
  }

  const { timings_ms, ifcopenshell_error, native_index_error } = readiness;

  const label = overallLabel(overall!, timings_ms.ifcopenshell_loaded_ms ?? null);
  const title = buildTitle(readiness);
  const errorMsg = ifcopenshell_error || native_index_error || null;

  return (
    <div
      className={`ai-readiness-chip ai-readiness-chip--${overall}`}
      title={title}
      data-error={errorMsg || undefined}
    >
      <span
        className={`ai-readiness-chip__dot${overall === 'warming' ? ' ai-readiness-chip__dot--pulse' : ''}`}
      />
      <span className="ai-readiness-chip__label">{label}</span>
    </div>
  );
}

type OverallState = 'warming' | 'ready' | 'degraded' | 'error';

export function pickOverallState(
  ifcos: 'cold' | 'warming' | 'ready' | 'error',
  native: 'absent' | 'building' | 'ready' | 'error',
): OverallState {
  if (ifcos === 'error') return 'error';
  if (ifcos === 'ready' && (native === 'ready' || native === 'absent')) return 'ready';
  if (ifcos === 'ready' && native === 'error') return 'degraded';
  return 'warming';
}

export function overallLabel(state: OverallState, ifcMs: number | null): string {
  switch (state) {
    case 'ready':
      return ifcMs === null ? 'AI ready' : `AI ready \u00b7 ${formatMs(ifcMs)}`;
    case 'warming':
      return 'AI warming up…';
    case 'degraded':
      return 'AI ready (native index off)';
    case 'error':
      return 'AI unavailable';
  }
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function buildTitle(snap: NonNullable<ReturnType<typeof useStore.getState>['readiness']>): string {
  const lines: string[] = [];
  lines.push(`IfcOpenShell: ${snap.ifcopenshell}`);
  if (snap.timings_ms.ifcopenshell_loaded_ms !== null) {
    lines.push(`  loaded in ${formatMs(snap.timings_ms.ifcopenshell_loaded_ms)}`);
  }
  if (snap.ifcopenshell_error) {
    lines.push(`  error: ${snap.ifcopenshell_error}`);
  }
  lines.push(`Native index: ${snap.native_index}`);
  if (snap.timings_ms.native_index_built_ms !== null) {
    lines.push(`  built in ${formatMs(snap.timings_ms.native_index_built_ms)}`);
  }
  if (snap.native_index_error) {
    lines.push(`  error: ${snap.native_index_error}`);
  }
  return lines.join('\n');
}

/**
 * Extract a readiness snapshot from a `readiness_changed`
 * model-sync WS event. Returns `null` when the payload shape is
 * malformed so the caller can safely ignore the event.
 *
 * Pure helper - the actual WS handler lives in `App.tsx`; this function
 * is the testable seam.
 */
export function readinessFromSyncEvent(
  payload: unknown,
): NonNullable<ReturnType<typeof useStore.getState>['readiness']> | null {
  if (!payload || typeof payload !== 'object') return null;
  const r = (payload as { readiness?: unknown }).readiness;
  if (!r || typeof r !== 'object') return null;
  const obj = r as Record<string, unknown>;
  const ifcos = obj.ifcopenshell;
  const native = obj.native_index;
  if (
    ifcos !== 'cold' && ifcos !== 'warming' && ifcos !== 'ready' && ifcos !== 'error'
  ) return null;
  if (
    native !== 'absent' && native !== 'building' && native !== 'ready' && native !== 'error'
  ) return null;
  const timings = (obj.timings_ms ?? {}) as Record<string, unknown>;
  return {
    model_id: typeof obj.model_id === 'string' ? obj.model_id : null,
    native_index: native,
    ifcopenshell: ifcos,
    timings_ms: {
      native_index_built_ms:
        typeof timings.native_index_built_ms === 'number'
          ? timings.native_index_built_ms
          : null,
      ifcopenshell_loaded_ms:
        typeof timings.ifcopenshell_loaded_ms === 'number'
          ? timings.ifcopenshell_loaded_ms
          : null,
    },
    native_index_error:
      typeof obj.native_index_error === 'string' ? obj.native_index_error : null,
    ifcopenshell_error:
      typeof obj.ifcopenshell_error === 'string' ? obj.ifcopenshell_error : null,
  };
}
