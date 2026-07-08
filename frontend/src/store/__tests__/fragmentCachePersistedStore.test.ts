/**
 * Vitest coverage for the `fragmentCachePersisted` store slice
 * (`setFragmentCachePersisted` setter + initial-state contract).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';

function reset() {
  useStore.setState({ fragmentCachePersisted: null });
}

describe('fragmentCachePersisted store slice', () => {
  beforeEach(reset);

  it('initialises to null (request not yet made)', () => {
    expect(useStore.getState().fragmentCachePersisted).toBe(null);
  });

  it('records the persistent-storage-granted outcome', () => {
    useStore.getState().setFragmentCachePersisted('persistent');
    expect(useStore.getState().fragmentCachePersisted).toBe('persistent');
  });

  it('records the best-effort (denied) outcome', () => {
    useStore.getState().setFragmentCachePersisted('best-effort');
    expect(useStore.getState().fragmentCachePersisted).toBe('best-effort');
  });

  it('records the API-unavailable outcome', () => {
    useStore.getState().setFragmentCachePersisted('unavailable');
    expect(useStore.getState().fragmentCachePersisted).toBe('unavailable');
  });

  it('can be reset back to null', () => {
    useStore.getState().setFragmentCachePersisted('persistent');
    useStore.getState().setFragmentCachePersisted(null);
    expect(useStore.getState().fragmentCachePersisted).toBe(null);
  });
});
