import { lazy, Suspense } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, activeToolOf } from '../../store/useStore';
import type { ToolId } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import type { IconName } from '../ui/Icon';

/**
 * Tools tab - the single docked surface for every model tool. It shows a
 * launcher of clickable rows; selecting one docks that tool's panel right here
 * (no separate floating window) with a breadcrumb back to the launcher. The
 * four feature panels and the stats / filter / health panels all render in
 * embedded mode so they share this one consistent, scrollable surface and the
 * 3D view stays visible. The sidebar's expand button widens it for big tables.
 *
 * The launcher rows drive the store's openTool (mutually exclusive), so opening
 * a tool here behaves exactly like opening it from the menu / palette / hotkey.
 */

// Tools are lazy so the Tools tab itself stays a tiny chunk; each panel loads
// only when first docked.
const QtoPanel = lazy(() => import('./QtoPanel'));
const IdsPanel = lazy(() => import('./IdsPanel'));
const BcfPanel = lazy(() => import('./BcfPanel'));
const PluginsPanel = lazy(() => import('./PluginsPanel'));
const CostPanel = lazy(() => import('./CostPanel'));
const CarbonPanel = lazy(() => import('./CarbonPanel'));
const CobiePanel = lazy(() => import('./CobiePanel'));
const DiffPanel = lazy(() => import('./DiffPanel'));
const ModelStatsPanel = lazy(() => import('./ModelStatsPanel'));
const ElementFilterPanel = lazy(() =>
  import('./ElementFilterPanel').then((m) => ({ default: m.ElementFilterPanel })),
);
const ModelHealthPanel = lazy(() => import('./ModelHealthPanel'));

interface ToolMeta {
  id: ToolId;
  title: string;
  desc: string;
  icon: IconName;
  /** The tool is unusable until an IFC model is loaded. */
  needsModel: boolean;
  /** The tool needs the backend - hidden from the static viewer-only build.
   *  Model statistics is the only fully client-side tool. */
  backendOnly: boolean;
}

const ANALYSIS_TOOLS: ToolMeta[] = [
  {
    id: 'qto',
    title: 'Quantity takeoff',
    desc: 'Counts, areas and volumes grouped by class or storey',
    icon: 'bar-chart',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'ids',
    title: 'IDS validation',
    desc: 'Check the model against an IDS specification',
    icon: 'list-checks',
    needsModel: false,
    backendOnly: true,
  },
  {
    id: 'bcf',
    title: 'BCF topics',
    desc: 'Create, review and share issue topics from a view',
    icon: 'message-square',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'plugins',
    title: 'Plugins',
    desc: 'Run and write Python scripts over the model',
    icon: 'plug',
    needsModel: false,
    backendOnly: true,
  },
  {
    id: 'cost',
    title: 'Cost takeoff (5D)',
    desc: 'Priced bill of quantities with editable rate library',
    icon: 'tag',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'carbon',
    title: 'Embodied carbon',
    desc: 'kgCO2e by material from quantities x emission factors',
    icon: 'zap',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'diff',
    title: 'Changes since upload',
    desc: 'Added, removed and changed elements vs the original file',
    icon: 'columns',
    needsModel: true,
    backendOnly: true,
  },
];

const MODEL_TOOLS: ToolMeta[] = [
  {
    id: 'stats',
    title: 'Model statistics',
    desc: 'Element counts by type and storey',
    icon: 'layout-dashboard',
    needsModel: true,
    backendOnly: false,
  },
  {
    id: 'filter',
    title: 'Element filter',
    desc: 'Find and isolate elements by type, storey or property',
    icon: 'sliders',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'health',
    title: 'Model health',
    desc: 'Geometry, duplicate and data-quality checks',
    icon: 'shield',
    needsModel: true,
    backendOnly: true,
  },
  {
    id: 'cobie',
    title: 'Data handover (COBie)',
    desc: 'COBie-lite sheets + completeness, export to CSV',
    icon: 'file-text',
    needsModel: true,
    backendOnly: true,
  },
];

const ALL_TOOLS: ToolMeta[] = [...ANALYSIS_TOOLS, ...MODEL_TOOLS];

/** Tools shown in the current build (the viewer-only demo keeps only the
 *  client-side ones - i.e. Model statistics). */
const available = (tools: ToolMeta[]) =>
  BROWSER_ONLY ? tools.filter((t) => !t.backendOnly) : tools;

function renderTool(id: ToolId, closeTool: () => void) {
  switch (id) {
    case 'qto':
      return <QtoPanel embedded onClose={closeTool} />;
    case 'ids':
      return <IdsPanel embedded onClose={closeTool} />;
    case 'bcf':
      return <BcfPanel embedded onClose={closeTool} />;
    case 'plugins':
      return <PluginsPanel embedded onClose={closeTool} />;
    case 'cost':
      return <CostPanel embedded onClose={closeTool} />;
    case 'carbon':
      return <CarbonPanel embedded onClose={closeTool} />;
    case 'stats':
      return <ModelStatsPanel embedded />;
    case 'filter':
      return <ElementFilterPanel embedded />;
    case 'health':
      return <ModelHealthPanel embedded />;
    case 'cobie':
      return <CobiePanel embedded onClose={closeTool} />;
    case 'diff':
      return <DiffPanel embedded onClose={closeTool} />;
  }
}

interface LauncherRowProps {
  tool: ToolMeta;
  modelLoaded: boolean;
  onOpen: (id: ToolId) => void;
}

function LauncherRow({ tool, modelLoaded, onOpen }: LauncherRowProps) {
  const disabled = tool.needsModel && !modelLoaded;
  return (
    <button
      type="button"
      className="feature-row"
      onClick={() => onOpen(tool.id)}
      disabled={disabled}
      title={disabled ? `${tool.title} - load a model to use this` : `Open ${tool.title}`}
    >
      <span className="feature-row-icon">
        <Icon name={tool.icon} size={17} />
      </span>
      <span className="feature-row-text">
        <span className="feature-row-title">{tool.title}</span>
        <span className="feature-row-desc">
          {disabled ? (
            <span className="feature-row-note">Load a model to use this</span>
          ) : (
            tool.desc
          )}
        </span>
      </span>
      <span className="feature-row-cue" aria-hidden="true">
        <Icon name="chevron-right" size={14} />
      </span>
    </button>
  );
}

export default function FeatureLauncherPanel() {
  const { activeFeaturePanel, statsPanelOpen, filterPanelOpen, healthPanelOpen, modelLoaded, openTool, closeTool } =
    useStore(
      useShallow((s) => ({
        activeFeaturePanel: s.activeFeaturePanel,
        statsPanelOpen: s.statsPanelOpen,
        filterPanelOpen: s.filterPanelOpen,
        healthPanelOpen: s.healthPanelOpen,
        modelLoaded: s.modelLoaded,
        openTool: s.openTool,
        closeTool: s.closeTool,
      })),
    );

  const activeTool = activeToolOf({
    activeFeaturePanel,
    statsPanelOpen,
    filterPanelOpen,
    healthPanelOpen,
  });

  // A tool is docked: breadcrumb + the embedded panel.
  if (activeTool) {
    const meta = ALL_TOOLS.find((t) => t.id === activeTool);
    return (
      <div className="tool-embed-host">
        <nav className="tool-breadcrumb" aria-label="Tools breadcrumb">
          <button
            type="button"
            className="tool-crumb tool-crumb--home"
            onClick={closeTool}
            title="Back to all tools"
          >
            <Icon name="wrench" size={12} />
            Tools
          </button>
          <Icon name="chevron-right" size={12} className="tool-crumb-sep" aria-hidden="true" />
          <span className="tool-crumb tool-crumb--current">
            {meta && <Icon name={meta.icon} size={12} />}
            {meta?.title ?? 'Tool'}
          </span>
        </nav>
        <div className="tool-embed-body">
          <Suspense fallback={<div className="tool-embed-loading">Loading...</div>}>
            {renderTool(activeTool, closeTool)}
          </Suspense>
        </div>
      </div>
    );
  }

  // No tool docked: the launcher.
  const analysisTools = available(ANALYSIS_TOOLS);
  const modelTools = available(MODEL_TOOLS);
  return (
    <div className="feature-launcher">
      <div className="feature-launcher-scroll">
        <p className="feature-launcher-intro">
          Available tools for analyzing and working with your model.
        </p>

        {analysisTools.length > 0 && (
          <div className="feature-launcher-group">
            <div className="feature-launcher-group-label">Analysis &amp; review</div>
            {analysisTools.map((t) => (
              <LauncherRow key={t.id} tool={t} modelLoaded={modelLoaded} onOpen={openTool} />
            ))}
          </div>
        )}

        {modelTools.length > 0 && (
          <div className="feature-launcher-group">
            <div className="feature-launcher-group-label">Model tools</div>
            {modelTools.map((t) => (
              <LauncherRow key={t.id} tool={t} modelLoaded={modelLoaded} onOpen={openTool} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
