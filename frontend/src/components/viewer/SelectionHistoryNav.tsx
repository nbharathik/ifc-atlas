/**
 * Floating viewport overlay for browser-style selection history
 * navigation. Two arrow buttons + a position indicator. Hidden until at
 * least 2 selections have happened in this session.
 *
 * Keyboard shortcuts: Alt+[ / Alt+], wired in KeyboardShortcuts.tsx.
 */

import { useStore } from '../../store/useStore';
import {
  canGoBack,
  canGoForward,
  shouldShowSelectionHistoryNav,
} from '../../services/viewer/selectionHistoryHelpers';

export default function SelectionHistoryNav() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const history = useStore((s) => s.selectionHistory);
  const navigate = useStore((s) => s.navigateSelectionHistory);

  if (!shouldShowSelectionHistoryNav(modelLoaded, history)) return null;

  const back = canGoBack(history);
  const forward = canGoForward(history);
  const position = history.pointer + 1; // 1-indexed for display

  return (
    <div
      className="selection-history-nav"
      role="toolbar"
      aria-label="Selection history navigation"
    >
      <button
        type="button"
        className="selection-history-btn"
        onClick={() => navigate('back')}
        disabled={!back}
        title="Previous selection (Alt+[)"
        aria-label="Previous selection"
      >
        ‹
      </button>
      <span className="selection-history-pos" aria-live="polite">
        {position}
        <span className="selection-history-pos-sep">/</span>
        {history.stack.length}
      </span>
      <button
        type="button"
        className="selection-history-btn"
        onClick={() => navigate('forward')}
        disabled={!forward}
        title="Next selection (Alt+])"
        aria-label="Next selection"
      >
        ›
      </button>
    </div>
  );
}
