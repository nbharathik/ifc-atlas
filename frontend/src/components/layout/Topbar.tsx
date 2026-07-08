import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';
import type { IconName } from '../ui/Icon';

interface TopbarProps {
  onFitModel: () => void;
  onScreenshot: () => void;
  onCameraView: (view: string) => void;
}

interface ActionSpec {
  id: string;
  icon: IconName;
  tip: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}

/**
 * Top toolbar - icon-only action buttons on the left, selection context
 * chips on the right. The outliner sidebar has its own pane-switcher
 * (see Outliner.tsx); the inspector sidebar has its own tab bar (see
 * RightSidebar.tsx). This bar is for global viewer actions only.
 */
export default function Topbar({
  onFitModel,
  onScreenshot,
  onCameraView: _onCameraView,
}: TopbarProps) {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const selectElement = useStore((s) => s.selectElement);
  const clearSelectedIds = useStore((s) => s.clearSelectedIds);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);

  const measurementMode = useStore((s) => s.measurement.mode);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);

  const gridVisible = useStore((s) => s.gridVisible);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const hoverHighlightEnabled = useStore((s) => s.hoverHighlightEnabled);
  const toggleHoverHighlight = useStore((s) => s.toggleHoverHighlight);
  const furnishingMerged = useStore((s) => s.furnishingMerged);
  const setFurnishingMerged = useStore((s) => s.setFurnishingMerged);

  const selectionFocusMode = useStore((s) => s.selectionFocusMode);
  const setSelectionFocusMode = useStore((s) => s.setSelectionFocusMode);
  const ghostOn = selectionFocusMode === 'ghost';

  const hasHidden = isolatedIds.length > 0 || hiddenIds.length > 0;
  const isMultiSelect = selectedIds.length > 1;

  const cycleMeasure = () => {
    if (measurementMode === 'off') setMeasurementMode('linear');
    else if (measurementMode === 'linear') setMeasurementMode('area');
    else setMeasurementMode('off');
  };

  const actions: ActionSpec[] = [
    {
      id: 'frame',
      icon: 'target',
      tip: 'Frame model (F)',
      onClick: onFitModel,
      disabled: !modelLoaded,
    },
    {
      id: 'screenshot',
      icon: 'camera',
      tip: 'Screenshot (S)',
      onClick: onScreenshot,
      disabled: !modelLoaded,
    },
    {
      id: 'show-all',
      icon: 'eye',
      tip: 'Show all elements',
      onClick: () => {
        clearVisibility();
        logActivity({ kind: 'show-all', summary: 'Showed all elements' });
      },
      disabled: !hasHidden,
    },
    {
      id: 'measure',
      icon: 'ruler',
      tip: measurementMode === 'off'
        ? 'Measure: click to start (line → area → off)'
        : `Measure: ${measurementMode} (click to cycle)`,
      onClick: cycleMeasure,
      disabled: !modelLoaded,
      active: measurementMode !== 'off',
    },
    {
      id: 'grid',
      icon: 'grid-3x3',
      tip: gridVisible ? 'Hide ground grid' : 'Show ground grid',
      onClick: () => {
        toggleGrid();
        logActivity({
          kind: 'view',
          summary: `Ground grid ${gridVisible ? 'hidden' : 'shown'}`,
        });
      },
      // Intentionally never `active` - user feedback: keep this button's
      // visual the same whether the grid is on or off. The tooltip + icon
      // glyph carry enough signal already.
    },
    {
      id: 'hover',
      icon: 'cursor',
      tip: hoverHighlightEnabled
        ? 'Hover preview highlight: ON (click to turn off)'
        : 'Hover preview highlight: OFF (click to turn on)',
      onClick: () => {
        toggleHoverHighlight();
        logActivity({
          kind: 'view',
          summary: `Hover preview ${hoverHighlightEnabled ? 'disabled' : 'enabled'}`,
        });
      },
      disabled: !modelLoaded,
      active: hoverHighlightEnabled,
    },
    {
      id: 'furnishing',
      icon: 'layers' as const,
      tip: furnishingMerged
        ? 'Furnishing simplified (1 draw call) - click to restore detail'
        : 'Simplify furnishings (merge into 1 draw call for better FPS)',
      onClick: () => {
        const next = !furnishingMerged;
        setFurnishingMerged(next);
        logActivity({
          kind: 'view',
          summary: `Furnishing ${next ? 'simplified (perf mode)' : 'restored (full detail)'}`,
        });
      },
      disabled: !modelLoaded,
      active: furnishingMerged,
    },
    {
      id: 'ghost',
      icon: 'ghost' as const,
      tip: ghostOn
        ? 'Ghost mode ON - non-selected elements faded (click to disable)'
        : 'Ghost mode OFF - click to fade non-selected elements',
      onClick: () => {
        const next = ghostOn ? 'off' : 'ghost';
        setSelectionFocusMode(next);
        logActivity({
          kind: 'view',
          summary: `Ghost mode ${next === 'ghost' ? 'enabled' : 'disabled'}`,
        });
      },
      active: ghostOn,
    },
  ];

  return (
    <div className="topbar">
      <div className="topbar-group topbar-actions" role="toolbar" aria-label="Viewer actions">
        {actions.map((t) => {
          const classes = ['topbar-icon-btn'];
          if (t.active) classes.push('active');
          return (
            <button
              key={t.id}
              className={classes.join(' ')}
              onClick={t.onClick}
              disabled={t.disabled}
              title={t.tip}
              aria-label={t.tip}
            >
              <Icon name={t.icon} size={14} />
            </button>
          );
        })}
      </div>

      <div className="topbar-spacer" />

      {modelLoaded && (selectedElementId != null || selectedIds.length > 0 || highlightedIds.length > 0 || hasHidden) && (
        <div className="topbar-group topbar-selection-group">
          {isMultiSelect ? (
            <button
              className="topbar-btn"
              onClick={() => { clearSelectedIds(); selectElement(null); }}
              title="Clear multi-selection (Esc)"
            >
              <Icon name="x" size={12} /> <b>{selectedIds.length}</b> selected
            </button>
          ) : selectedElementId != null && (
            <button
              className="topbar-btn"
              onClick={() => selectElement(null)}
              title="Clear selection (Esc)"
            >
              <Icon name="x" size={12} /> Selected <b>#{selectedElementId}</b>
            </button>
          )}
          {highlightedIds.length > 0 && (
            <button
              className="topbar-btn"
              onClick={() => {
                setHighlightedIds([]);
                logActivity({ kind: 'highlight', summary: 'Cleared highlights' });
              }}
              title="Clear highlights"
            >
              <Icon name="x" size={12} /> {highlightedIds.length} highlighted
            </button>
          )}
          {hasHidden && (
            <button
              className="topbar-btn"
              onClick={() => {
                clearVisibility();
                logActivity({ kind: 'show-all', summary: 'Showed all elements' });
              }}
              title="Show all elements"
            >
              <Icon name="eye" size={12} /> Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
