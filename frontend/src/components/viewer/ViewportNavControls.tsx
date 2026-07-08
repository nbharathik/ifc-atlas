import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';

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
export default function ViewportNavControls({ onFitModel }: ViewportNavControlsProps) {
  const selectedElementId = useStore((s) => s.selectedElementId);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const zoomToElement = useStore((s) => s.zoomToElement);
  const addHiddenIds = useStore((s) => s.addHiddenIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);

  const hasSelection = selectedElementId != null;
  // Same target priority as the H shortcut: the selected element wins,
  // otherwise the highlighted set (e.g. search results) is hidden.
  const hideTargets = hasSelection ? [selectedElementId!] : highlightedIds;
  const hasHidden = hiddenIds.length > 0 || isolatedIds.length > 0;

  const onHide = () => {
    if (hideTargets.length === 0) return;
    addHiddenIds(hideTargets);
    logActivity({
      kind: 'hide',
      summary: hideTargets.length === 1 ? `Hide #${hideTargets[0]}` : `Hide ${hideTargets.length} elements`,
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
          if (hasSelection) zoomToElement(selectedElementId!);
        }}
        disabled={!hasSelection}
        title={hasSelection ? 'Zoom to selected element' : 'Select an element to zoom to it'}
        aria-label="Zoom to selection"
      >
        <Icon name="focus" size={14} />
      </button>
      <button
        className="vp-nav-btn"
        onClick={onHide}
        disabled={hideTargets.length === 0}
        title={hideTargets.length > 0 ? 'Hide selected (H)' : 'Select an element to hide it'}
        aria-label="Hide selected"
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
