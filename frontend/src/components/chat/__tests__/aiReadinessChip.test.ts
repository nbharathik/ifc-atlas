import { describe, it, expect } from 'vitest';
import {
  pickOverallState,
  overallLabel,
  formatMs,
  buildTitle,
  readinessFromSyncEvent,
} from '../AIReadinessChip';

// pickOverallState - the reducer that converts the two backend states
// into a single chip color/label.
describe('pickOverallState', () => {
  it('returns "warming" while ifcopenshell is cold', () => {
    expect(pickOverallState('cold', 'absent')).toBe('warming');
  });

  it('returns "warming" while ifcopenshell is warming', () => {
    expect(pickOverallState('warming', 'building')).toBe('warming');
  });

  it('returns "warming" while native index is building even if ifcopenshell is ready early', () => {
    // ifcopenshell load is synchronous and short on the upload thread;
    // native index can take longer. The chip should remain "warming"
    // until *both* settle, except for the explicit degraded edge case
    // (native errored) which we handle separately.
    expect(pickOverallState('ready', 'building')).toBe('warming');
  });

  it('returns "ready" once both backends are ready', () => {
    expect(pickOverallState('ready', 'ready')).toBe('ready');
  });

  it('returns "ready" when ifcopenshell is ready and native is absent (no sidecar)', () => {
    expect(pickOverallState('ready', 'absent')).toBe('ready');
  });

  it('returns "degraded" when ifcopenshell ready but native errored', () => {
    expect(pickOverallState('ready', 'error')).toBe('degraded');
  });

  it('returns "error" when ifcopenshell errored - overrides any native state', () => {
    expect(pickOverallState('error', 'ready')).toBe('error');
    expect(pickOverallState('error', 'building')).toBe('error');
    expect(pickOverallState('error', 'error')).toBe('error');
  });
});

describe('formatMs', () => {
  it('renders sub-second values in milliseconds', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(480)).toBe('480 ms');
    expect(formatMs(999)).toBe('999 ms');
  });

  it('renders ≥1000 ms as fixed-decimal seconds', () => {
    expect(formatMs(1000)).toBe('1.0s');
    expect(formatMs(1670)).toBe('1.7s');
    expect(formatMs(12345)).toBe('12.3s');
  });
});

describe('overallLabel', () => {
  it('shows the load time when ready and timing is known', () => {
    expect(overallLabel('ready', 480)).toBe('AI ready · 480 ms');
    expect(overallLabel('ready', 1670)).toBe('AI ready · 1.7s');
  });

  it('drops the suffix when timing is null', () => {
    expect(overallLabel('ready', null)).toBe('AI ready');
  });

  it('renders distinct labels for each non-ready state', () => {
    expect(overallLabel('warming', null)).toBe('AI warming up…');
    expect(overallLabel('degraded', null)).toBe('AI ready (native index off)');
    expect(overallLabel('error', null)).toBe('AI unavailable');
  });
});

describe('buildTitle', () => {
  it('builds a multi-line tooltip from the snapshot', () => {
    const title = buildTitle({
      model_id: 'a.ifc',
      ifcopenshell: 'ready',
      native_index: 'ready',
      timings_ms: { ifcopenshell_loaded_ms: 480, native_index_built_ms: 1670 },
      ifcopenshell_error: null,
      native_index_error: null,
    });
    expect(title).toContain('IfcOpenShell: ready');
    expect(title).toContain('loaded in 480 ms');
    expect(title).toContain('Native index: ready');
    expect(title).toContain('built in 1.7s');
  });

  it('omits timing lines when timings are null', () => {
    const title = buildTitle({
      model_id: null,
      ifcopenshell: 'warming',
      native_index: 'absent',
      timings_ms: { ifcopenshell_loaded_ms: null, native_index_built_ms: null },
      ifcopenshell_error: null,
      native_index_error: null,
    });
    expect(title).not.toMatch(/loaded in/);
    expect(title).not.toMatch(/built in/);
  });

  it('includes error messages on the matching backend', () => {
    const title = buildTitle({
      model_id: null,
      ifcopenshell: 'error',
      native_index: 'absent',
      timings_ms: { ifcopenshell_loaded_ms: null, native_index_built_ms: null },
      ifcopenshell_error: 'load failed',
      native_index_error: null,
    });
    expect(title).toContain('error: load failed');
  });
});

// WS event extraction. The chip never directly subscribes
// to the model-sync WS; App.tsx routes readiness_changed payloads
// through this helper into the store.
describe('readinessFromSyncEvent', () => {
  it('parses a well-formed payload', () => {
    const payload = {
      readiness: {
        model_id: 'a.ifc',
        ifcopenshell: 'warming',
        native_index: 'building',
        timings_ms: { ifcopenshell_loaded_ms: null, native_index_built_ms: null },
        ifcopenshell_error: null,
        native_index_error: null,
      },
    };
    const snap = readinessFromSyncEvent(payload);
    expect(snap).not.toBeNull();
    expect(snap!.ifcopenshell).toBe('warming');
    expect(snap!.native_index).toBe('building');
    expect(snap!.model_id).toBe('a.ifc');
  });

  it('returns null when the payload is missing or malformed', () => {
    expect(readinessFromSyncEvent(null)).toBeNull();
    expect(readinessFromSyncEvent(undefined)).toBeNull();
    expect(readinessFromSyncEvent({})).toBeNull();
    expect(readinessFromSyncEvent({ readiness: 'oops' })).toBeNull();
  });

  it('rejects unknown ifcopenshell states without crashing', () => {
    expect(
      readinessFromSyncEvent({
        readiness: {
          model_id: null,
          ifcopenshell: 'banana',
          native_index: 'absent',
          timings_ms: {},
        },
      }),
    ).toBeNull();
  });

  it('rejects unknown native_index states', () => {
    expect(
      readinessFromSyncEvent({
        readiness: {
          model_id: null,
          ifcopenshell: 'ready',
          native_index: 'unknown',
          timings_ms: {},
        },
      }),
    ).toBeNull();
  });

  it('coerces missing timing/error fields to null', () => {
    const snap = readinessFromSyncEvent({
      readiness: {
        ifcopenshell: 'ready',
        native_index: 'ready',
      },
    });
    expect(snap).not.toBeNull();
    expect(snap!.model_id).toBeNull();
    expect(snap!.timings_ms.ifcopenshell_loaded_ms).toBeNull();
    expect(snap!.timings_ms.native_index_built_ms).toBeNull();
    expect(snap!.ifcopenshell_error).toBeNull();
    expect(snap!.native_index_error).toBeNull();
  });
});
