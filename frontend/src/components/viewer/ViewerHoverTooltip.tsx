import { useSyncExternalStore } from 'react';
import { useStore } from '../../store/useStore';
import {
  getHoverTooltipData,
  subscribeHoverTooltip,
} from '../../services/viewer/hoverTooltipBridge';

/**
 * Leaf renderer for the 3D-canvas hover tooltip. Subscribes to the
 * hoverTooltipBridge external store so tooltip updates (up to ~12 Hz during
 * hover sweeps) re-render only this component, never ViewerPanel.
 * Markup and classes are identical to the previous inline block.
 */
export default function ViewerHoverTooltip() {
  const tooltip = useSyncExternalStore(subscribeHoverTooltip, getHoverTooltipData);
  const hoverHighlightEnabled = useStore((s) => s.hoverHighlightEnabled);

  if (!tooltip || !hoverHighlightEnabled) return null;
  return (
    <div
      className="viewer-hover-tooltip"
      style={{ left: tooltip.x, top: tooltip.y }}
      aria-hidden="true"
    >
      <span className="viewer-hover-tooltip-name">{tooltip.name}</span>
      <span className="viewer-hover-tooltip-type">{tooltip.type.replace('Ifc', '')}</span>
      {tooltip.storey && (
        <span className="viewer-hover-tooltip-storey">{tooltip.storey}</span>
      )}
    </div>
  );
}
