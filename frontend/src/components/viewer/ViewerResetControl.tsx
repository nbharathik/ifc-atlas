/**
 * Bottom-right "applied filters" control.
 *
 * One always-reachable place to see everything currently applied to the model
 * and undo it - individually or all at once - without hunting through the
 * panels that set it. Hidden entirely when the model is in its as-loaded state,
 * so it is a status indicator as much as a button.
 *
 * Rendered from ViewerPanel because clearing measurements needs the
 * MeasurementController, which lives in a ref there rather than in the store.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import {
  describeAppliedFilters,
  type AppliedFilterId,
} from '../../services/viewer/appliedFilters';
import Icon from '../ui/Icon';

interface ViewerResetControlProps {
  /** Committed measurement count, owned by MeasurementController. */
  measurementCount: number;
  /** Drops every committed + pending measurement. */
  onClearMeasurements: () => void;
}

export default function ViewerResetControl({
  measurementCount,
  onClearMeasurements,
}: ViewerResetControlProps) {
  const isolatedIds = useStore((s) => s.isolatedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const ghostModeOn = useStore((s) => s.ghostModeOn);
  const clipPlanes = useStore((s) => s.clipPlanes);
  const sectionBoxEnabled = useStore((s) => s.sectionBoxEnabled);
  const sectionWorkspace = useStore((s) => s.sectionWorkspace);
  const colourBy = useStore((s) => s.colourBy);
  const colourLayers = useStore((s) => s.colourLayers);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const measurementMode = useStore((s) => s.measurement.mode);
  const pickPlaneMode = useStore((s) => s.pickPlaneMode);

  const clearVisibility = useStore((s) => s.clearVisibility);
  const setGhostModeOn = useStore((s) => s.setGhostModeOn);
  const clearClipPlanes = useStore((s) => s.clearClipPlanes);
  const setSectionWorkspace = useStore((s) => s.setSectionWorkspace);
  const setColourBy = useStore((s) => s.setColourBy);
  const clearAllColourLayers = useStore((s) => s.clearAllColourLayers);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);
  const setPickPlaneMode = useStore((s) => s.setPickPlaneMode);
  const clearSelectedIds = useStore((s) => s.clearSelectedIds);
  const selectElement = useStore((s) => s.selectElement);
  const logActivity = useStore((s) => s.logActivity);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const applied = describeAppliedFilters({
    isolatedCount: isolatedIds.length,
    hiddenCount: hiddenIds.length,
    ghostModeOn,
    enabledClipPlaneCount: clipPlanes.filter((p) => p.enabled).length,
    sectionBoxEnabled,
    hasSectionWorkspace: sectionWorkspace !== null,
    colourBy,
    colourLayerCount: Object.keys(colourLayers).length,
    highlightedCount: highlightedIds.length,
    measurementCount,
    measurementMode,
    pickPlaneMode,
  });

  // Close the popover as soon as the last filter goes, otherwise the user is
  // left staring at an empty list anchored to a button that no longer exists.
  useEffect(() => {
    if (applied.length === 0) setOpen(false);
  }, [applied.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Close on Escape without swallowing it: stopping propagation here would
    // kill the global handler that cancels pick-plane mode and selection.
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (applied.length === 0) return null;

  const clearOne = (id: AppliedFilterId) => {
    switch (id) {
      case 'visibility':
        // Also drops ghost mode - it is meaningless without an isolation.
        clearVisibility();
        break;
      case 'ghost':
        setGhostModeOn(false);
        break;
      case 'clip-planes':
        clearClipPlanes();
        break;
      case 'section-box':
        // Clears the workspace AND disables the box in one call; splitting them
        // lets ViewerPanel's effect re-fit a fresh model-bounds box instead.
        setSectionWorkspace(null);
        break;
      case 'colour-by':
        setColourBy('off');
        break;
      case 'colour-layers':
        clearAllColourLayers();
        break;
      case 'highlights':
        setHighlightedIds([]);
        break;
      case 'measurements':
        onClearMeasurements();
        break;
      case 'measure-mode':
        setMeasurementMode('off');
        break;
      case 'pick-plane':
        setPickPlaneMode(false);
        break;
    }
  };

  const clearAll = () => {
    applied.forEach((f) => clearOne(f.id));
    // Not listed as a row (see appliedFilters.ts), but "back to original"
    // should not leave an element sitting selected.
    clearSelectedIds();
    selectElement(null);
    logActivity({
      kind: 'show-all',
      summary: `Reset ${applied.length} applied ${applied.length === 1 ? 'filter' : 'filters'}`,
    });
    setOpen(false);
  };

  return (
    <div className="viewer-reset" ref={rootRef}>
      {open && (
        <div className="viewer-reset-pop" role="dialog" aria-label="Applied filters">
          <div className="viewer-reset-pop-head">
            <span className="viewer-reset-pop-title">Applied to this model</span>
            <button
              className="viewer-reset-pop-close"
              onClick={() => setOpen(false)}
              title="Close"
              aria-label="Close applied filters"
            >
              <Icon name="x" size={11} />
            </button>
          </div>
          <ul className="viewer-reset-list">
            {applied.map((f) => (
              <li key={f.id} className="viewer-reset-row">
                <div className="viewer-reset-row-text">
                  <span className="viewer-reset-row-label">{f.label}</span>
                  <span className="viewer-reset-row-detail">{f.detail}</span>
                </div>
                <button
                  className="viewer-reset-row-btn"
                  onClick={() => clearOne(f.id)}
                  title={`Remove ${f.label.toLowerCase()}`}
                  aria-label={`Remove ${f.label.toLowerCase()}`}
                >
                  <Icon name="x" size={11} />
                </button>
              </li>
            ))}
          </ul>
          <button className="viewer-reset-all" onClick={clearAll}>
            <Icon name="refresh" size={12} />
            Reset all - back to original
          </button>
        </div>
      )}
      <button
        className={`viewer-reset-pill${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`${applied.length} ${applied.length === 1 ? 'filter' : 'filters'} applied - click to review or reset`}
        aria-label={`${applied.length} applied ${applied.length === 1 ? 'filter' : 'filters'}`}
        aria-expanded={open}
      >
        <Icon name="sliders" size={13} />
        <span className="viewer-reset-pill-label">Filters</span>
        <span className="viewer-reset-count">{applied.length}</span>
      </button>
    </div>
  );
}
