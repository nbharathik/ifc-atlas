import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';

describe('visibility mode store invariants', () => {
  beforeEach(() => {
    useStore.setState({ isolatedIds: [], hiddenIds: [], ghostModeOn: false });
  });

  it('setHiddenIds atomically leaves a previous isolate mode', () => {
    useStore.setState({ isolatedIds: [1, 2], hiddenIds: [] });

    useStore.getState().setHiddenIds([8, 9]);

    expect(useStore.getState().isolatedIds).toEqual([]);
    expect(useStore.getState().hiddenIds).toEqual([8, 9]);
  });

  it('an empty hidden-only viewpoint still clears the previous isolate set', () => {
    useStore.setState({ isolatedIds: [1, 2], hiddenIds: [3] });

    useStore.getState().setHiddenIds([]);

    expect(useStore.getState().isolatedIds).toEqual([]);
    expect(useStore.getState().hiddenIds).toEqual([]);
  });
});
