import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';
import { MAX_CLIP_PLANES } from '../useStore';

function resetClipPlanes() {
  useStore.setState({
    clipPlanes: [{ id: 'primary', enabled: false, axis: 'y', offset: 0, inverted: false }],
  });
}

describe('clipPlanes store - multi-plane actions', () => {
  beforeEach(resetClipPlanes);

  it('initial state has one primary plane, disabled', () => {
    const { clipPlanes } = useStore.getState();
    expect(clipPlanes).toHaveLength(1);
    expect(clipPlanes[0].id).toBe('primary');
    expect(clipPlanes[0].enabled).toBe(false);
  });

  it('toggleClipPlane enables the primary plane', () => {
    useStore.getState().toggleClipPlane();
    expect(useStore.getState().clipPlanes[0].enabled).toBe(true);
  });

  it('toggleClipPlane is a true toggle', () => {
    useStore.getState().toggleClipPlane();
    useStore.getState().toggleClipPlane();
    expect(useStore.getState().clipPlanes[0].enabled).toBe(false);
  });

  it('setClipPlane patches the first plane', () => {
    useStore.getState().setClipPlane({ axis: 'x', enabled: true });
    const p = useStore.getState().clipPlanes[0];
    expect(p.axis).toBe('x');
    expect(p.enabled).toBe(true);
  });

  it('setClipPlane resets offset when axis changes', () => {
    useStore.getState().setClipPlane({ offset: 3 });
    useStore.getState().setClipPlane({ axis: 'x' });
    expect(useStore.getState().clipPlanes[0].offset).toBe(0);
  });

  it('addClipPlane appends a new enabled plane', () => {
    useStore.getState().addClipPlane();
    const { clipPlanes } = useStore.getState();
    expect(clipPlanes).toHaveLength(2);
    expect(clipPlanes[1].enabled).toBe(true);
  });

  it(`addClipPlane is a no-op when at MAX_CLIP_PLANES (${MAX_CLIP_PLANES})`, () => {
    for (let i = 0; i < MAX_CLIP_PLANES; i++) useStore.getState().addClipPlane();
    useStore.getState().addClipPlane(); // one over the limit
    expect(useStore.getState().clipPlanes.length).toBeLessThanOrEqual(MAX_CLIP_PLANES);
  });

  it('removeClipPlane removes the correct plane by id', () => {
    useStore.getState().addClipPlane();
    const { clipPlanes } = useStore.getState();
    const secondId = clipPlanes[1].id;
    useStore.getState().removeClipPlane(secondId);
    expect(useStore.getState().clipPlanes).toHaveLength(1);
    expect(useStore.getState().clipPlanes[0].id).toBe('primary');
  });

  it('updateClipPlane updates only the targeted plane', () => {
    useStore.getState().addClipPlane();
    const secondId = useStore.getState().clipPlanes[1].id;
    // Change axis first (resets offset to 0), then set offset separately
    useStore.getState().updateClipPlane(secondId, { axis: 'z' });
    useStore.getState().updateClipPlane(secondId, { offset: 2 });
    const planes = useStore.getState().clipPlanes;
    expect(planes[0].axis).toBe('y');  // primary unchanged
    expect(planes[1].axis).toBe('z');
    expect(planes[1].offset).toBe(2);
  });

  it('updateClipPlane resets offset on axis change', () => {
    useStore.getState().updateClipPlane('primary', { offset: 4 });
    useStore.getState().updateClipPlane('primary', { axis: 'z' });
    expect(useStore.getState().clipPlanes[0].offset).toBe(0);
  });

  it('removeClipPlane is a no-op for unknown id', () => {
    useStore.getState().removeClipPlane('does-not-exist');
    expect(useStore.getState().clipPlanes).toHaveLength(1);
  });

  it('can add then remove extra planes leaving primary intact', () => {
    useStore.getState().addClipPlane();
    useStore.getState().addClipPlane();
    expect(useStore.getState().clipPlanes).toHaveLength(3);
    const ids = useStore.getState().clipPlanes.map(p => p.id);
    useStore.getState().removeClipPlane(ids[1]);
    useStore.getState().removeClipPlane(ids[2]);
    expect(useStore.getState().clipPlanes).toHaveLength(1);
    expect(useStore.getState().clipPlanes[0].id).toBe('primary');
  });
});

describe('pick-plane mode', () => {
  beforeEach(() => {
    useStore.setState({
      clipPlanes: [{ id: 'primary', enabled: true, axis: 'y', offset: 0, inverted: false }],
      pickPlaneMode: false,
    });
  });

  it('setPickPlaneMode enables pick mode', () => {
    useStore.getState().setPickPlaneMode(true);
    expect(useStore.getState().pickPlaneMode).toBe(true);
  });

  it('setPickPlaneMode disables pick mode', () => {
    useStore.getState().setPickPlaneMode(true);
    useStore.getState().setPickPlaneMode(false);
    expect(useStore.getState().pickPlaneMode).toBe(false);
  });

  it('addClipPlaneAt creates a plane with correct axis and offset', () => {
    useStore.getState().addClipPlaneAt('x', 2.5);
    const planes = useStore.getState().clipPlanes;
    const added = planes.find(p => p.id !== 'primary');
    expect(added).toBeDefined();
    expect(added!.axis).toBe('x');
    expect(added!.offset).toBeCloseTo(2.5);
    expect(added!.enabled).toBe(true);
  });

  it('addClipPlaneAt resets pickPlaneMode', () => {
    useStore.getState().setPickPlaneMode(true);
    useStore.getState().addClipPlaneAt('z', -1.0);
    expect(useStore.getState().pickPlaneMode).toBe(false);
  });

  it('addClipPlaneAt is a no-op when at MAX_CLIP_PLANES limit', () => {
    // Fill to max
    for (let i = 1; i < MAX_CLIP_PLANES; i++) {
      useStore.getState().addClipPlane();
    }
    const countBefore = useStore.getState().clipPlanes.length;
    useStore.getState().addClipPlaneAt('y', 1.0);
    expect(useStore.getState().clipPlanes).toHaveLength(countBefore);
  });

  it('addClipPlaneAt plane is inverted=false by default', () => {
    useStore.getState().addClipPlaneAt('y', 0.5);
    const added = useStore.getState().clipPlanes.find(p => p.id !== 'primary');
    expect(added!.inverted).toBe(false);
  });
});
