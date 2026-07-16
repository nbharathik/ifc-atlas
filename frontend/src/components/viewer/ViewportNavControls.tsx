import { useStore } from '../../store/useStore';
import { resolveViewerActionTargets } from '../../services/viewer/viewerActionTargetHelpers';
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
