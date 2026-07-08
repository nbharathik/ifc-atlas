import { useState, useMemo } from 'react';
import { useStore } from '../../store/useStore';
import type { ColourByProperty } from '../../store/useStore';
import { buildColourGroups, shortIfcType } from '../../services/viewer/colourByHelper';

const OPTIONS: { value: ColourByProperty; label: string }[] = [
  { value: 'off',      label: 'Off' },
  { value: 'type',     label: 'IFC type' },
  { value: 'storey',   label: 'Storey' },
  { value: 'material', label: 'Material' },
];

/**
 * Floating bottom-left control for the colour-by-property overlay.
 * Shows a small legend when active.
 */
export default function ColourByControl() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const colourBy = useStore((s) => s.colourBy);
  const setColourBy = useStore((s) => s.setColourBy);
  const spatialTree = useStore((s) => s.spatialTree);
  const [open, setOpen] = useState(false);

  // Memoised so the full-tree walk runs only when the tree or colour mode
  // changes, not on every unrelated store mutation. Declared before the
  // early return below to keep hook order stable (Rules of Hooks).
  const groups = useMemo(
    () => (colourBy !== 'off' ? buildColourGroups(spatialTree, colourBy) : []),
    [colourBy, spatialTree],
  );

  if (!modelLoaded) return null;

  const activeLabel = OPTIONS.find(o => o.value === colourBy)?.label ?? 'Off';

  return (
    <div className={`colour-by-wrap ${colourBy !== 'off' ? 'colour-by-active' : ''}`}>
      {/* Toggle button */}
      <button
        className="colour-by-toggle"
        onClick={() => setOpen(v => !v)}
        title="Colour elements by property"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
        </svg>
        <span>{colourBy !== 'off' ? activeLabel : 'Color by'}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="colour-by-dropdown">
          {OPTIONS.map(opt => (
            <button
              key={opt.value}
              className={`colour-by-option ${colourBy === opt.value ? 'active' : ''}`}
              onClick={() => { setColourBy(opt.value); setOpen(false); }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Legend */}
      {colourBy !== 'off' && groups.length > 0 && (
        <div className="colour-by-legend">
          {groups.slice(0, 10).map(g => (
            <div key={g.label} className="colour-by-legend-row">
              <span
                className="colour-by-swatch"
                style={{ background: `#${g.color.getHexString()}` }}
              />
              <span className="colour-by-legend-label">
                {colourBy === 'type' ? shortIfcType(g.label) : g.label}
              </span>
              <span className="colour-by-legend-count">{g.ids.length}</span>
            </div>
          ))}
          {groups.length > 10 && (
            <div className="colour-by-legend-more">+{groups.length - 10} more</div>
          )}
        </div>
      )}
    </div>
  );
}
