import Icon from '../ui/Icon';
import { useSyncExternalStore, useMemo, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { getHoverTooltipData, subscribeHoverTooltip } from '../../services/viewer/hover';
import {
  SELECTION_SUMMARY_INSPECT_TAB,
  buildSelectionChipText,
  formatSelectionChipLine,
  truncateTypeLabel,
} from '../../services/viewer/selectionSummaryHelpers';
import { resolveViewerActionTargets } from '../../services/viewer/viewerActionTargetHelpers';
import { describeAppliedFilters, type AppliedFilterId } from '../../services/viewer/appliedFilters';

export function HighlightBadge() {
  const highlightedIds = useStore((s) => s.highlightedIds);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);

  if (highlightedIds.length === 0) return null;

  return (
    <div className="highlight-badge">
      <span>{highlightedIds.length} element{highlightedIds.length !== 1 ? 's' : ''} highlighted</span>
      <button onClick={() => setHighlightedIds([])} title="Clear highlights">
        x
      </button>
    </div>
  );
}

/**
 * Leaf renderer for the 3D-canvas hover tooltip. Subscribes to the
 * hoverTooltipBridge external store so tooltip updates (up to ~12 Hz during
 * hover sweeps) re-render only this component, never ViewerPanel.
 * Markup and classes are identical to the previous inline block.
 */
export function ViewerHoverTooltip() {
  const tooltip = useSyncExternalStore(subscribeHoverTooltip, getHoverTooltipData);
  const hoverHighlightEnabled = useStore((s) => s.hoverHighlightEnabled);

  if (!tooltip || !hoverHighlightEnabled) return null;
  return (
    <div
      className="viewer-hover-tooltip"
      style={{ left: tooltip.x, top: tooltip.y }}
      aria-hidden="true"
    >
      <span className="viewer-hover-tooltip-name">{tooltip.name}</span>
      <span className="viewer-hover-tooltip-type">{tooltip.type.replace('Ifc', '')}</span>
      {tooltip.storey && (
        <span className="viewer-hover-tooltip-storey">{tooltip.storey}</span>
      )}
    </div>
  );
}

/**
 * SelectionSummaryChip: floating viewport HUD for multi-selection.
 *
 * Shows a compact "5 selected · 3 Wall · 1 Door · 1 Window" chip at the
 * top-left of the viewer area whenever the user has >=1 element selected
 * via `selectedIds`. Two quick actions: "Inspect" focuses the right-sidebar
 * Properties tab; "Clear" wipes the multi-selection.
 *
 * Distinct from `HighlightBadge` which mirrors AI-driven `highlightedIds`.
 *
 * All histogram + formatting logic lives in `selectionSummaryHelpers.ts`
 * (pure, unit-tested). This component is a thin Zustand→DOM adapter.
 */

export function SelectionSummaryChip() {
  const selectedIds = useStore((s) => s.selectedIds);
  const spatialTree = useStore((s) => s.spatialTree);
  const clearSelectedIds = useStore((s) => s.clearSelectedIds);
  const focusRightTab = useStore((s) => s.focusRightTab);

  const chip = useMemo(
    () => buildSelectionChipText(spatialTree, selectedIds),
    [spatialTree, selectedIds],
  );

  if (chip.empty) return null;

  const ariaLabel = formatSelectionChipLine(chip);

  return (
    <div
      className="selection-summary-chip"
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span className="selection-summary-count">{chip.header}</span>
      {chip.visibleBuckets.length > 0 && (
        <span className="selection-summary-sep" aria-hidden="true">·</span>
      )}
      <span className="selection-summary-types">
        {chip.visibleBuckets.map((b, i) => (
          <span key={b.type} className="selection-summary-bucket">
            <span className="selection-summary-bucket-count">{b.count}</span>
            <span
              className="selection-summary-bucket-type"
              title={b.type}
            >
              {truncateTypeLabel(b.type)}
            </span>
            {i < chip.visibleBuckets.length - 1 && (
              <span className="selection-summary-sep" aria-hidden="true">·</span>
            )}
          </span>
        ))}
        {chip.moreSuffix && (
          <>
            <span className="selection-summary-sep" aria-hidden="true">·</span>
            <span className="selection-summary-more">{chip.moreSuffix}</span>
          </>
        )}
      </span>
      <span className="selection-summary-actions">
        <button
          type="button"
          className="selection-summary-action"
          onClick={() => focusRightTab(SELECTION_SUMMARY_INSPECT_TAB)}
          title="Open Properties panel for the selection"
        >
          Inspect
        </button>
        <button
          type="button"
          className="selection-summary-action selection-summary-action-clear"
          onClick={() => clearSelectedIds()}
          aria-label="Clear selection"
          title="Clear selection"
        >
          ×
        </button>
      </span>
    </div>
  );
}

interface ViewportNavControlsProps {
  onFitModel: () => void;
}

/**
 * Horizontal tool pill rendered at the bottom-center of the viewport,
 * next to the ghost-mode toggle. @thatopen's camera controls already
 * handle orbit/pan/zoom via mouse+modifiers, so we don't surface those
 * as mode toggles (that would be misleading). The buttons here mirror
 * existing keyboard shortcuts so the features are discoverable:
 * Frame model (F), Zoom to selection, Hide selection (H), Show all (A).
 */
export function ViewportNavControls({ onFitModel }: ViewportNavControlsProps) {
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const frameElements = useStore((s) => s.frameElements);
  const addHiddenIds = useStore((s) => s.addHiddenIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);

  const actionTargets = resolveViewerActionTargets({
    selectedIds,
    selectedElementId,
    highlightedIds,
  });
  const hasHidden = hiddenIds.length > 0 || isolatedIds.length > 0;

  const onHide = () => {
    if (actionTargets.length === 0) return;
    addHiddenIds(actionTargets);
    logActivity({
      kind: 'hide',
      summary: actionTargets.length === 1 ? `Hide #${actionTargets[0]}` : `Hide ${actionTargets.length} elements`,
    });
  };

  const onShowAll = () => {
    if (!hasHidden) return;
    clearVisibility();
    logActivity({ kind: 'show-all', summary: 'Show all elements' });
  };

  return (
    <div className="vp-bottom-tools" aria-label="Viewer tools">
      <button
        className="vp-nav-btn"
        onClick={onFitModel}
        title="Frame model (F)"
        aria-label="Frame model"
      >
        <Icon name="target" size={14} />
      </button>
      <button
        className="vp-nav-btn"
        onClick={() => {
          if (actionTargets.length > 0) frameElements(actionTargets);
        }}
        disabled={actionTargets.length === 0}
        title={actionTargets.length > 0
          ? `Frame ${actionTargets.length === 1 ? 'target element' : `${actionTargets.length} selected/highlighted elements`}`
          : 'Select or highlight elements to frame them'}
        aria-label="Frame selection"
      >
        <Icon name="focus" size={14} />
      </button>
      <button
        className="vp-nav-btn"
        onClick={onHide}
        disabled={actionTargets.length === 0}
        title={actionTargets.length > 0 ? 'Hide selected/highlighted (H)' : 'Select or highlight elements to hide them'}
        aria-label="Hide selected or highlighted elements"
      >
        <Icon name="eye-off" size={14} />
      </button>
      <button
        className="vp-nav-btn"
        onClick={onShowAll}
        disabled={!hasHidden}
        title={hasHidden ? 'Show all elements (A)' : 'Nothing is hidden'}
        aria-label="Show all elements"
      >
        <Icon name="eye" size={14} />
      </button>
    </div>
  );
}

// Lazy so the markdown pipeline and chat transport stay off the model-open path.
const ChatPanel = lazy(() => import('../chat/ChatPanel'));

/**
 * The minimised "Ask AI" pill. Split out from the expanded dock below so it can
 * sit as a flex child of the bottom-right row (next to ViewerResetControl),
 * while the dock stays absolutely positioned against the viewer. Rendering both
 * from one component would force the dock to anchor to the row instead.
 */
export function FloatingChatPill() {
  const chatLoading = useStore((s) => s.chatLoading);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightActiveTab = useStore((s) => s.rightActiveTab);
  const minimized = useStore((s) => s.floatingChatMinimized);
  const setMinimized = useStore((s) => s.setFloatingChatMinimized);

  const sidebarChatActive = rightSidebarOpen && rightActiveTab === 'chat';
  if (sidebarChatActive || !minimized) return null;

  return (
    <button
      className="floating-chat-pill"
      onClick={() => setMinimized(false)}
      title="Open AI chat  Ctrl+/"
      aria-label="Open AI chat"
    >
      <Icon name="sparkle" size={13} />
      <span className="floating-chat-pill-label">Ask AI</span>
      <kbd className="floating-chat-pill-kbd">Ctrl /</kbd>
      {chatLoading && <span className="floating-chat-pill-dot" aria-hidden="true" />}
    </button>
  );
}

export function FloatingChatDock() {
  const chatProvider = useStore((s) => s.chatProvider);
  const chatModel = useStore((s) => s.chatModel);
  const clearChat = useStore((s) => s.clearChat);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightActiveTab = useStore((s) => s.rightActiveTab);
  const minimized = useStore((s) => s.floatingChatMinimized);
  const setMinimized = useStore((s) => s.setFloatingChatMinimized);

  const sidebarChatActive = rightSidebarOpen && rightActiveTab === 'chat';
  if (sidebarChatActive || minimized) return null;

  const providerLabel = chatProvider === 'openai' ? 'GPT' : 'Claude';
  const modelLabel = chatModel.replace(/^claude-/, '').replace(/-(\d{8})$/, '');

  return (
    <div className="floating-chat-dock" role="dialog" aria-label="AI assistant">
      <div className="floating-chat-head">
        <Icon name="sparkle" size={13} />
        <span className="floating-chat-title">AI Assistant</span>
        <div className="floating-chat-head-spacer" />
        <span className="floating-chat-model" title={chatModel}>
          {providerLabel} · {modelLabel}
        </span>
        <button
          className="floating-chat-head-btn"
          onClick={() => clearChat()}
          title="Clear chat history"
          aria-label="Clear chat history"
        >
          <Icon name="trash" size={11} />
        </button>
        <button
          className="floating-chat-head-btn"
          onClick={() => focusRightTab('chat')}
          title="Dock to sidebar"
          aria-label="Dock to right sidebar"
        >
          <Icon name="panel-right-open" size={11} />
        </button>
        <button
          className="floating-chat-head-btn"
          onClick={() => setMinimized(true)}
          title="Minimize"
          aria-label="Minimize chat"
        >
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="floating-chat-body">
        <Suspense fallback={null}>
          <ChatPanel embedded />
        </Suspense>
      </div>
    </div>
  );
}

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


interface ViewerResetControlProps {
  /** Committed measurement count, owned by MeasurementController. */
  measurementCount: number;
  /** Drops every committed + pending measurement. */
  onClearMeasurements: () => void;
}

export function ViewerResetControl({
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
