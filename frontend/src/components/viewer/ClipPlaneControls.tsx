import { useEffect, useRef, useState } from 'react';
import { useStore, MAX_CLIP_PLANES } from '../../store/useStore';
import type { ClipAxis, ClipPlaneState } from '../../store/useStore';
import Icon from '../ui/Icon';

/**
 * Apply a live (drag) offset to one plane WITHOUT persisting to localStorage.
 * Mirrors the offset branch of the `updateClipPlane` reducer but skips
 * `writePref`, so a 60 Hz slider drag drives the viewer (the `clipPlanes`
 * subscriber re-runs `controller.sync`) without ~60 JSON.stringify +
 * localStorage.setItem hits. The final value is persisted once on drag-end
 * via the regular `updateClipPlane` action.
 */
function setOffsetTransient(id: string, offset: number): void {
  useStore.setState((s) => ({
    clipPlanes: s.clipPlanes.map((p) => (p.id === id ? { ...p, offset } : p)),
  }));
}

const AXIS_LABELS: Record<ClipAxis, { label: string; hint: string }> = {
  x: { label: 'X', hint: 'Cut along the X axis (side section)' },
  y: { label: 'Y', hint: 'Cut along the Y axis (horizontal / storey cut)' },
  z: { label: 'Z', hint: 'Cut along the Z axis (front section)' },
};

function fmtOffset(v: number): string {
  if (!Number.isFinite(v)) return '0.00';
  const abs = Math.abs(v);
  if (abs < 0.01) return '0.00';
  return v.toFixed(2);
}

function PlaneRow({ plane, index }: { plane: ClipPlaneState; index: number }) {
  const updateClipPlane = useStore((s) => s.updateClipPlane);
  const removeClipPlane = useStore((s) => s.removeClipPlane);
  const halfExtents = useStore((s) => s.modelHalfExtents);

  const axisExtent = halfExtents
    ? (plane.axis === 'x' ? halfExtents.x : plane.axis === 'y' ? halfExtents.y : halfExtents.z)
    : 50;
  const range = Math.max(1, axisExtent * 1.15);
  const step = Math.max(0.01, range / 200);

  // Local mirror of the slider so the thumb tracks smoothly during a drag.
  // While dragging we push transient (non-persisted) offsets coalesced to one
  // per animation frame; when idle we reconcile back to the store value so
  // Centre / Invert / axis-switch / keyboard edits stay reflected.
  const [liveOffset, setLiveOffset] = useState(plane.offset);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef(plane.offset);

  useEffect(() => {
    if (!draggingRef.current) setLiveOffset(plane.offset);
  }, [plane.offset]);

  const flushTransient = () => {
    rafRef.current = null;
    setOffsetTransient(plane.id, pendingRef.current);
  };

  // Drag-end (or pointer-cancel / lost capture): cancel any pending frame and
  // persist the final value exactly once via the regular reducer (writePref).
  const commit = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    updateClipPlane(plane.id, { offset: pendingRef.current });
  };

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const onSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.currentTarget.value);
    pendingRef.current = next;
    setLiveOffset(next);
    if (draggingRef.current) {
      // Coalesce the live drag to one transient store write (and thus one
      // controller.sync) per frame; persistence is deferred to commit().
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushTransient);
    } else {
      // Keyboard (arrows / Home / End) fires onChange with no pointer drag,
      // so persist immediately so those edits are not lost.
      updateClipPlane(plane.id, { offset: next });
    }
  };

  return (
    <div className="clip-plane-row">
      <span className="clip-plane-row-label">Plane {index + 1}</span>

      <div className="clip-plane-axes">
        {(Object.keys(AXIS_LABELS) as ClipAxis[]).map((axis) => (
          <button
            key={axis}
            className={`clip-plane-axis-btn ${axis === plane.axis ? 'active' : ''}`}
            onClick={() => updateClipPlane(plane.id, { axis })}
            title={AXIS_LABELS[axis].hint}
            aria-pressed={axis === plane.axis}
          >
            {AXIS_LABELS[axis].label}
          </button>
        ))}
      </div>

      <div className="clip-plane-slider-wrap">
        <input
          type="range"
          className="clip-plane-slider"
          min={-range}
          max={range}
          step={step}
          value={liveOffset}
          onChange={onSliderChange}
          onPointerDown={() => { draggingRef.current = true; pendingRef.current = plane.offset; }}
          onPointerUp={commit}
          onPointerCancel={commit}
          onLostPointerCapture={commit}
          aria-label={`Plane ${index + 1} offset along ${AXIS_LABELS[plane.axis].label} axis`}
        />
        <span className="clip-plane-offset-value">{fmtOffset(liveOffset)} m</span>
      </div>

      <button
        className={`clip-plane-btn ${plane.inverted ? 'active' : ''}`}
        onClick={() => updateClipPlane(plane.id, { inverted: !plane.inverted })}
        title="Flip which side of the plane is kept"
        aria-pressed={plane.inverted}
      >
        Invert
      </button>

      <button
        className="clip-plane-btn"
        onClick={() => updateClipPlane(plane.id, { offset: 0 })}
        title="Recentre the plane on the model"
      >
        Centre
      </button>

      <button
        className="clip-plane-remove"
        onClick={() => removeClipPlane(plane.id)}
        title="Remove this plane"
        aria-label="Remove plane"
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}

/**
 * Floating toolbar rendered over the top-centre of the 3D viewport.
 * Visible when a model is loaded and at least one clip plane is enabled.
 * Supports up to MAX_CLIP_PLANES simultaneous section planes.
 */
export default function ClipPlaneControls() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const clipPlanes = useStore((s) => s.clipPlanes);
  const addClipPlane = useStore((s) => s.addClipPlane);
  const toggleClipPlane = useStore((s) => s.toggleClipPlane);
  const pickPlaneMode = useStore((s) => s.pickPlaneMode);
  const setPickPlaneMode = useStore((s) => s.setPickPlaneMode);

  const enabledPlanes = clipPlanes.filter(p => p.enabled);

  if (!modelLoaded || enabledPlanes.length === 0) return null;

  return (
    <div className="clip-plane-toolbar" role="toolbar" aria-label="Section / clip plane controls">
      <div className="clip-plane-header">
        <div className="clip-plane-title">
          <Icon name="section" size={13} />
          <span>Section</span>
        </div>

        {enabledPlanes.length < MAX_CLIP_PLANES && !pickPlaneMode && (
          <button
            className="clip-plane-add"
            onClick={addClipPlane}
            title={`Add section plane (max ${MAX_CLIP_PLANES})`}
          >
            <Icon name="plus" size={11} />
            <span>Add</span>
          </button>
        )}

        {enabledPlanes.length < MAX_CLIP_PLANES && (
          <button
            className={`clip-plane-add${pickPlaneMode ? ' active' : ''}`}
            onClick={() => setPickPlaneMode(!pickPlaneMode)}
            title={pickPlaneMode ? 'Click on model surface to place plane (Esc to cancel)' : 'Pick surface to place plane (Shift+X)'}
            aria-pressed={pickPlaneMode}
          >
            <Icon name="cursor" size={11} />
            <span>{pickPlaneMode ? 'Click surface…' : 'Pick'}</span>
          </button>
        )}

        <button
          className="clip-plane-close"
          onClick={toggleClipPlane}
          title="Disable section planes (X)"
          aria-label="Disable section planes"
        >
          <Icon name="x" size={12} />
        </button>
      </div>

      {pickPlaneMode && (
        <div className="clip-plane-pick-hint">
          Click a surface to place the section plane. Press Esc to cancel.
        </div>
      )}

      {enabledPlanes.map((plane, i) => (
        <PlaneRow key={plane.id} plane={plane} index={i} />
      ))}
    </div>
  );
}
