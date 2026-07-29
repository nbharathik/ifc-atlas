export interface ViewerSelectionState {
  readonly selectedId: number | null;
  readonly highlightedIds: readonly number[];
}

export interface ViewerVisibilityState {
  readonly isolatedIds: readonly number[];
  readonly hiddenIds: readonly number[];
}

export interface ViewerSelectionCapability {
  select(expressId: number | null): void;
  highlight(expressIds: readonly number[]): void;
  apply(state: ViewerSelectionState): void;
}

export interface ViewerVisibilityCapability {
  isolate(expressIds: readonly number[]): void;
  hide(expressIds: readonly number[]): void;
  showAll(): void;
  apply(state: ViewerVisibilityState): void;
}

export interface ViewerStateCapabilities {
  readonly selection: ViewerSelectionCapability;
  readonly visibility: ViewerVisibilityCapability;
  dispose(): void;
}

interface ViewerCommandState {
  selectElement(id: number | null): void;
  setHighlightedIds(ids: number[]): void;
  setIsolatedIds(ids: number[]): void;
  setHiddenIds(ids: number[]): void;
  clearVisibility(): void;
}

/**
 * Typed command boundary between UI integrations and the viewer store.
 *
 * Rendering remains owned by RenderStateCoordinator subscriptions. Callers
 * describe selection or visibility intent instead of writing engine state.
 */
export function createViewerStateCapabilities(
  getState: () => ViewerCommandState,
): ViewerStateCapabilities {
  let active = true;
  const run = (command: (state: ViewerCommandState) => void) => {
    if (active) command(getState());
  };

  const selection: ViewerSelectionCapability = {
    select: (expressId) => run((state) => state.selectElement(expressId)),
    highlight: (expressIds) => run(
      (state) => state.setHighlightedIds([...expressIds]),
    ),
    apply: ({ selectedId, highlightedIds }) => run((state) => {
      state.setHighlightedIds([...highlightedIds]);
      state.selectElement(selectedId);
    }),
  };

  const visibility: ViewerVisibilityCapability = {
    isolate: (expressIds) => run(
      (state) => state.setIsolatedIds([...expressIds]),
    ),
    hide: (expressIds) => run(
      (state) => state.setHiddenIds([...expressIds]),
    ),
    showAll: () => run((state) => state.clearVisibility()),
    apply: ({ isolatedIds, hiddenIds }) => run((state) => {
      if (isolatedIds.length > 0) {
        state.setIsolatedIds([...isolatedIds]);
      } else if (hiddenIds.length > 0) {
        state.setHiddenIds([...hiddenIds]);
      } else {
        state.clearVisibility();
      }
    }),
  };

  return {
    selection,
    visibility,
    dispose: () => {
      active = false;
    },
  };
}
