/**
 * Tests for the IFC edit checkpoints store slice.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';
import type { IFCCheckpoint } from '../../types/ifc';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function reset() {
  useStore.setState({
    checkpointPanelOpen: false,
    checkpoints: [],
    checkpointsAvailable: false,
    checkpointsLoading: false,
    modelLoaded: false,
  });
}

function makeCheckpoint(overrides: Partial<IFCCheckpoint> = {}): IFCCheckpoint {
  return {
    sha: 'abc123456789',
    message: 'test edit',
    timestamp: new Date().toISOString(),
    edit_count: 1,
    is_initial: false,
    ...overrides,
  };
}

// ─── Panel open/close ─────────────────────────────────────────────────────────

describe('checkpoint panel open/close', () => {
  beforeEach(reset);

  it('defaults: panel closed', () => {
    expect(useStore.getState().checkpointPanelOpen).toBe(false);
  });

  it('setCheckpointPanelOpen(true) opens the panel', () => {
    useStore.getState().setCheckpointPanelOpen(true);
    expect(useStore.getState().checkpointPanelOpen).toBe(true);
  });

  it('setCheckpointPanelOpen(false) closes the panel', () => {
    useStore.getState().setCheckpointPanelOpen(true);
    useStore.getState().setCheckpointPanelOpen(false);
    expect(useStore.getState().checkpointPanelOpen).toBe(false);
  });
});

// ─── setCheckpoints ───────────────────────────────────────────────────────────

describe('setCheckpoints', () => {
  beforeEach(reset);

  it('stores checkpoints and availability flag', () => {
    const cps = [makeCheckpoint({ sha: 'aaa111222333' })];
    useStore.getState().setCheckpoints(cps, true);
    const s = useStore.getState();
    expect(s.checkpoints).toHaveLength(1);
    expect(s.checkpointsAvailable).toBe(true);
  });

  it('stores multiple checkpoints preserving order', () => {
    const cps = [
      makeCheckpoint({ sha: 'bbb000000001', edit_count: 3 }),
      makeCheckpoint({ sha: 'ccc000000002', edit_count: 2 }),
      makeCheckpoint({ sha: 'ddd000000003', edit_count: 1, is_initial: true }),
    ];
    useStore.getState().setCheckpoints(cps, true);
    const stored = useStore.getState().checkpoints;
    expect(stored[0].sha).toBe('bbb000000001');
    expect(stored[2].is_initial).toBe(true);
  });

  it('available=false disables the feature flag', () => {
    useStore.getState().setCheckpoints([], false);
    expect(useStore.getState().checkpointsAvailable).toBe(false);
  });

  it('replaces existing checkpoints on second call', () => {
    useStore.getState().setCheckpoints([makeCheckpoint()], true);
    useStore.getState().setCheckpoints([], true);
    expect(useStore.getState().checkpoints).toHaveLength(0);
  });
});

// ─── setCheckpointsLoading ────────────────────────────────────────────────────

describe('setCheckpointsLoading', () => {
  beforeEach(reset);

  it('defaults to false', () => {
    expect(useStore.getState().checkpointsLoading).toBe(false);
  });

  it('setCheckpointsLoading(true) sets the flag', () => {
    useStore.getState().setCheckpointsLoading(true);
    expect(useStore.getState().checkpointsLoading).toBe(true);
  });

  it('setCheckpointsLoading(false) clears the flag', () => {
    useStore.getState().setCheckpointsLoading(true);
    useStore.getState().setCheckpointsLoading(false);
    expect(useStore.getState().checkpointsLoading).toBe(false);
  });
});

// ─── setModelLoaded clears checkpoints on unload ──────────────────────────────

describe('setModelLoaded resets checkpoints', () => {
  beforeEach(reset);

  it('setModelLoaded(false) clears checkpoints', () => {
    useStore.setState({
      modelLoaded: true,
      checkpoints: [makeCheckpoint()],
    });
    useStore.getState().setModelLoaded(false);
    expect(useStore.getState().checkpoints).toHaveLength(0);
  });

  it('setModelLoaded(true) preserves existing checkpoints', () => {
    const cps = [makeCheckpoint()];
    useStore.setState({
      modelLoaded: false,
      checkpoints: cps,
    });
    useStore.getState().setModelLoaded(true);
    expect(useStore.getState().checkpoints).toHaveLength(1);
  });
});
