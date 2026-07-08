import { useStore } from '../../store/useStore';

export default function HighlightBadge() {
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

