import { useStore } from '../../store/useStore';

/** Max legend rows shown per layer before folding into '+N more'
 *  (mirrors the colour-by legend precedent). */
const MAX_LEGEND_ROWS = 10;

/**
 * Floating bottom-left legend for active colour layers (store `colourLayers`).
 *
 * Renders nothing unless at least one layer carries legend rows - layers set
 * without a `legend` paint silently. Each block shows the layer's name (or
 * its id), its legend rows, and a per-layer clear button. Row styling reuses
 * the colour-by legend classes so both legends read identically.
 */
export default function ColourLayerLegend() {
  const colourLayers = useStore((s) => s.colourLayers);
  const clearColourLayer = useStore((s) => s.clearColourLayer);

  const withLegend = Object.entries(colourLayers).filter(
    ([, layer]) => (layer.legend?.length ?? 0) > 0,
  );
  if (withLegend.length === 0) return null;

  return (
    <div className="colour-layer-legend-wrap">
      {withLegend.map(([id, layer]) => {
        const rows = layer.legend ?? [];
        const title = layer.name || id;
        return (
          <div key={id} className="colour-by-legend colour-layer-legend">
            <div className="colour-layer-legend-header">
              <span className="colour-layer-legend-title" title={title}>{title}</span>
              <button
                className="colour-layer-legend-clear"
                onClick={() => clearColourLayer(id)}
                title="Clear this colour layer"
                aria-label={`Clear colour layer ${title}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            {rows.slice(0, MAX_LEGEND_ROWS).map((row, i) => (
              <div key={`${row.label}-${i}`} className="colour-by-legend-row">
                <span className="colour-by-swatch" style={{ background: row.color }} />
                <span className="colour-by-legend-label">{row.label}</span>
              </div>
            ))}
            {rows.length > MAX_LEGEND_ROWS && (
              <div className="colour-by-legend-more">+{rows.length - MAX_LEGEND_ROWS} more</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
