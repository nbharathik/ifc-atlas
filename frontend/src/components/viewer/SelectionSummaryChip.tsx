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
import { useMemo } from 'react';
import { useStore } from '../../store/useStore';
import {
  SELECTION_SUMMARY_INSPECT_TAB,
  buildSelectionChipText,
  formatSelectionChipLine,
  truncateTypeLabel,
} from '../../services/viewer/selectionSummaryHelpers';

export default function SelectionSummaryChip() {
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
