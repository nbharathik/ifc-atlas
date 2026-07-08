import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../store/useStore';
import {
  collectIdsByType,
  collectLeavesUnder,
  findNodeById,
  findStoreyFor,
} from '../../services/viewer/spatialTreeHelpers';
import {
  copyNodeToClipboard,
  spatialNodeToClipboardNode,
  type ClipboardFormat,
  type ClipboardNodeLike,
} from '../../services/viewer/selectionClipboardHelpers';

/** Context-menu state; `expressId: null` means the right-click landed on
 *  empty space (no raycast hit), so only generic actions are shown. */
export interface ContextMenuState {
  x: number;
  y: number;
  expressId: number | null;
  ifcType: string | null;
}

interface Props {
  state: ContextMenuState | null;
  onClose: () => void;
}

// Approximate menu dimensions used only to clamp the anchor inside the
// viewport so the menu never opens off-screen on far-right / bottom clicks.
// Element-mode height covers 12 rows + 3 separators + header on the Atlas
// font stack (~380 px); empty-mode is just the "Show all" entry.
const MENU_WIDTH = 240;
const MENU_HEIGHT_ELEMENT = 380;
const MENU_HEIGHT_EMPTY = 110;

export default function ViewerContextMenu({ state, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const spatialTree = useStore((s) => s.spatialTree);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const addHiddenIds = useStore((s) => s.addHiddenIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const selectElement = useStore((s) => s.selectElement);
  const zoomToElement = useStore((s) => s.zoomToElement);
  const logActivity = useStore((s) => s.logActivity);

  const clipToElement = useStore((s) => s.clipToElement);
  const clipToElementFn = useStore((s) => s.clipToElementFn);

  const sameTypeIds = useMemo(() => {
    if (!state?.ifcType) return [] as number[];
    return collectIdsByType(spatialTree, state.ifcType);
  }, [state, spatialTree]);

  const storeyLeaves = useMemo(() => {
    if (!state || state.expressId == null) return [] as number[];
    const storey = findStoreyFor(spatialTree, state.expressId);
    return storey ? collectLeavesUnder(storey) : [];
  }, [state, spatialTree]);

  // Dismiss on Escape, outside-click, window blur, or scroll. These are
  // the expectations set by every other viewer context menu (BIMcollab,
  // Navisworks, xeokit): scrolling or blurring should close, not keep
  // the menu anchored to a stale screen position.
  useEffect(() => {
    if (!state) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        onClose();
      }
    };
    const onPointer = (ev: PointerEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const prettyType = state.ifcType ? state.ifcType.replace(/^Ifc/, '') : null;
  const hasElement = state.expressId != null;
  const menuH = hasElement ? MENU_HEIGHT_ELEMENT : MENU_HEIGHT_EMPTY;
  const left = Math.max(4, Math.min(state.x, window.innerWidth - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(state.y, window.innerHeight - menuH - 4));

  const run = (label: string, fn: () => void, kind: 'isolate' | 'hide' | 'show-all' | 'select' | 'view' | 'info' = 'info') => {
    fn();
    logActivity({ kind, summary: label });
    onClose();
  };

  const onIsolateThis = () =>
    hasElement && run(`Isolate #${state.expressId}`, () => setIsolatedIds([state.expressId!]), 'isolate');
  const onHideThis = () =>
    hasElement && run(`Hide #${state.expressId}`, () => addHiddenIds([state.expressId!]), 'hide');
  const onIsolateSameType = () => {
    if (sameTypeIds.length === 0 || !prettyType) return;
    run(`Isolate ${sameTypeIds.length} ${prettyType}`, () => setIsolatedIds(sameTypeIds), 'isolate');
  };
  const onHideSameType = () => {
    if (sameTypeIds.length === 0 || !prettyType) return;
    run(`Hide ${sameTypeIds.length} ${prettyType}`, () => addHiddenIds(sameTypeIds), 'hide');
  };
  const onIsolateFamily = () => {
    if (storeyLeaves.length === 0) return;
    run(`Isolate storey (${storeyLeaves.length} elements)`, () => setIsolatedIds(storeyLeaves), 'isolate');
  };
  const onSelect = () =>
    hasElement && run(`Select #${state.expressId}`, () => selectElement(state.expressId!), 'select');
  const onZoom = () =>
    hasElement && run(`Zoom to #${state.expressId}`, () => zoomToElement(state.expressId!), 'view');
  const onClipToElement = () =>
    hasElement && run(`Clip section box to #${state.expressId}`, () => clipToElement(state.expressId!), 'view');
  // Memoise the SpatialNode lookup so the disabled-flag derivation and the
  // three Copy handlers share one tree walk per menu open. findNodeById is
  // O(n) but menus open at click cadence, not per frame, so this is cheap
  // even on large models; useMemo is for clarity, not perf.
  const treeNodeForCopy = useMemo(() => {
    if (state?.expressId == null) return null;
    return findNodeById(spatialTree, state.expressId);
  }, [state?.expressId, spatialTree]);
  const hasGlobalId = !!treeNodeForCopy?.global_id;

  const onCopy = (format: ClipboardFormat) => async () => {
    if (!hasElement) return;
    const node: ClipboardNodeLike =
      spatialNodeToClipboardNode(treeNodeForCopy) ??
      { id: state.expressId!, ifc_type: state.ifcType };
    const result = await copyNodeToClipboard(format, node);
    if (result) run(result.summary, () => {}, 'info');
  };
  const onShowAll = () => run('Show all elements', () => clearVisibility(), 'show-all');

  return (
    <div
      ref={ref}
      className="viewer-context-menu"
      style={{ left, top }}
      role="menu"
      aria-label="Viewer context menu"
      onPointerDown={(ev) => ev.stopPropagation()}
      onContextMenu={(ev) => ev.preventDefault()}
    >
      {hasElement && (
        <div className="viewer-context-menu__header">
          <span className="viewer-context-menu__type">{prettyType}</span>
          <span className="viewer-context-menu__id">#{state.expressId}</span>
        </div>
      )}
      {hasElement && (
        <>
          <button className="viewer-context-menu__item" onClick={onSelect} role="menuitem">
            Select
          </button>
          <button className="viewer-context-menu__item" onClick={onIsolateThis} role="menuitem">
            Isolate this element
          </button>
          <button className="viewer-context-menu__item" onClick={onHideThis} role="menuitem">
            Hide this element
          </button>
          <div className="viewer-context-menu__sep" />
          <button
            className="viewer-context-menu__item"
            onClick={onIsolateSameType}
            role="menuitem"
            disabled={sameTypeIds.length <= 1}
            title={sameTypeIds.length <= 1 ? 'Only element of this type' : undefined}
          >
            Isolate all {prettyType}
            <span className="viewer-context-menu__count">{sameTypeIds.length}</span>
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onHideSameType}
            role="menuitem"
            disabled={sameTypeIds.length === 0}
          >
            Hide all {prettyType}
            <span className="viewer-context-menu__count">{sameTypeIds.length}</span>
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onIsolateFamily}
            role="menuitem"
            disabled={storeyLeaves.length === 0}
            title={storeyLeaves.length === 0 ? 'No enclosing storey found' : 'Isolate every element on the same building storey'}
          >
            Isolate storey
            <span className="viewer-context-menu__count">{storeyLeaves.length}</span>
          </button>
          <div className="viewer-context-menu__sep" />
          <button className="viewer-context-menu__item" onClick={onZoom} role="menuitem">
            Zoom to element
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onClipToElement}
            role="menuitem"
            disabled={!clipToElementFn}
            title={clipToElementFn ? 'Fit section box to this element' : 'Load a model first'}
          >
            Clip section box to element
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onCopy('express-id')}
            role="menuitem"
          >
            Copy Express ID
            <span className="viewer-context-menu__count">{state.expressId}</span>
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onCopy('global-id')}
            role="menuitem"
            disabled={!hasGlobalId}
            title={hasGlobalId ? 'Copy IFC GlobalId (GUID) - cross-tool reference' : 'No GlobalId on this element'}
          >
            Copy GlobalId
          </button>
          <button
            className="viewer-context-menu__item"
            onClick={onCopy('details')}
            role="menuitem"
            title="Copy multi-line element details (type, name, IDs, storey)"
          >
            Copy details
          </button>
          <div className="viewer-context-menu__sep" />
        </>
      )}
      <button className="viewer-context-menu__item" onClick={onShowAll} role="menuitem">
        Show all
      </button>
    </div>
  );
}
