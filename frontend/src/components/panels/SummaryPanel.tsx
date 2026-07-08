import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../store/useStore';
import { collectLeavesUnder } from '../../services/viewer/spatialTreeHelpers';
import type { SpatialNode } from '../../types/ifc';

/**
 * Vertical "model summary" panel. Replaces the bottom StatusBar with a
 * proper tab in the left rail. Shows project metadata, element counts by
 * type, storey list, material list, and live selection/highlight state.
 */
/** Walk the spatial tree to find an IfcBuildingStorey node by name. */
function findStoreyNode(root: SpatialNode | null, name: string): SpatialNode | null {
  if (!root) return null;
  const walk = (n: SpatialNode): SpatialNode | null => {
    if (n.ifc_type.toLowerCase() === 'ifcbuildingstorey' && n.name === name) return n;
    for (const c of n.children) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

export default function SummaryPanel() {
  const project = useStore((s) => s.project);
  const stats = useStore((s) => s.stats);
  const spatialTree = useStore((s) => s.spatialTree);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const hiddenIds = useStore((s) => s.hiddenIds);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);
  const chatProvider = useStore((s) => s.chatProvider);
  const chatModel = useStore((s) => s.chatModel);
  const perfMetrics = useStore((s) => s.perfMetrics);

  const sortedTypes = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.by_type).sort(([, a], [, b]) => b - a);
  }, [stats]);

  const [typesExpanded, setTypesExpanded] = useState(false);
  const [activeStorey, setActiveStorey] = useState<string | null>(null);

  const handleStoreyClick = useCallback((storeyName: string) => {
    if (activeStorey === storeyName) {
      clearVisibility();
      setActiveStorey(null);
      logActivity({ kind: 'show-all', summary: `Cleared storey isolation` });
      return;
    }
    const node = findStoreyNode(spatialTree, storeyName);
    if (!node) return;
    const ids = collectLeavesUnder(node);
    setIsolatedIds(ids);
    setActiveStorey(storeyName);
    logActivity({ kind: 'isolate', summary: `Isolated storey "${storeyName}" (${ids.length} elements)` });
  }, [activeStorey, spatialTree, setIsolatedIds, clearVisibility, logActivity]);
  const topTypes = typesExpanded ? sortedTypes : sortedTypes.slice(0, 8);
  const remaining = sortedTypes.length - topTypes.length;

  return (
    <div className="panel summary-panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="panel-body summary-body">
        {!project && !stats && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No model loaded.
          </p>
        )}

        {/* Project info */}
        {project && (
          <section className="summary-section">
            <h4 className="summary-heading">Project</h4>
            <div className="summary-kv">
              <span>Name</span>
            <span title={project.name}>{project.name || '-'}</span>
            </div>
            <div className="summary-kv">
              <span>Schema</span>
              <span className="summary-mono">{project.schema_version}</span>
            </div>
            {project.author && (
              <div className="summary-kv">
                <span>Author</span>
                <span>{project.author}</span>
              </div>
            )}
            {project.organization && (
              <div className="summary-kv">
                <span>Org</span>
                <span>{project.organization}</span>
              </div>
            )}
          </section>
        )}

        {/* Totals */}
        {stats && (
          <section className="summary-section">
            <h4 className="summary-heading">Totals</h4>
            <div className="summary-stats-grid">
              <div className="summary-stat">
                <span className="summary-stat-value">{stats.total_elements.toLocaleString()}</span>
                <span className="summary-stat-label">Elements</span>
              </div>
              <div className="summary-stat">
                <span className="summary-stat-value">{stats.storeys.length}</span>
                <span className="summary-stat-label">Storeys</span>
              </div>
              <div className="summary-stat">
                <span className="summary-stat-value">{stats.materials.length}</span>
                <span className="summary-stat-label">Materials</span>
              </div>
              <div className="summary-stat">
                <span className="summary-stat-value">{sortedTypes.length}</span>
                <span className="summary-stat-label">Types</span>
              </div>
            </div>
          </section>
        )}

        {/* Type breakdown */}
        {stats && sortedTypes.length > 0 && (
          <section className="summary-section">
            <h4 className="summary-heading">
              By type
              {sortedTypes.length > 8 && (
                <button
                  className="summary-heading-action"
                  onClick={() => setTypesExpanded(!typesExpanded)}
                >
                  {typesExpanded ? 'Show less' : `Show all ${sortedTypes.length}`}
                </button>
              )}
            </h4>
            <div className="summary-type-list">
              {topTypes.map(([type, count]) => (
                <div key={type} className="summary-type-row">
                  <span className="summary-type-name" title={type}>
                    {type.replace('Ifc', '')}
                  </span>
                  <span className="summary-type-count">{count.toLocaleString()}</span>
                </div>
              ))}
              {!typesExpanded && remaining > 0 && (
                <button
                  className="summary-type-row summary-type-row-more"
                  onClick={() => setTypesExpanded(true)}
                >
                  +{remaining} more types
                </button>
              )}
            </div>
          </section>
        )}

        {/* Storeys - clickable isolation buttons */}
        {stats && stats.storeys.length > 0 && (
          <section className="summary-section">
            <h4 className="summary-heading">
              Storeys
              {activeStorey && (
                <button
                  className="summary-heading-action"
                  onClick={() => { clearVisibility(); setActiveStorey(null); logActivity({ kind: 'show-all', summary: 'Cleared storey isolation' }); }}
                >
                  Show all
                </button>
              )}
            </h4>
            <div className="summary-chips">
              {stats.storeys.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`summary-chip summary-chip-btn${activeStorey === s ? ' active' : ''}`}
                  title={activeStorey === s ? `Click to clear isolation of "${s}"` : `Isolate storey "${s}"`}
                  onClick={() => handleStoreyClick(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Materials */}
        {stats && stats.materials.length > 0 && (
          <section className="summary-section">
            <h4 className="summary-heading">Materials</h4>
            <div className="summary-chips">
              {stats.materials.slice(0, 12).map((m) => (
                <span key={m} className="summary-chip" title={m}>{m}</span>
              ))}
              {stats.materials.length > 12 && (
                <span className="summary-chip summary-chip-muted">+{stats.materials.length - 12}</span>
              )}
            </div>
          </section>
        )}

        {/* Current selection/highlight/visibility */}
        {(selectedElementId != null || highlightedIds.length > 0 || isolatedIds.length > 0 || hiddenIds.length > 0) && (
          <section className="summary-section">
            <h4 className="summary-heading">Current state</h4>
            {selectedElementId != null && (
              <div className="summary-kv">
                <span>Selected</span>
                <span className="summary-mono">#{selectedElementId}</span>
              </div>
            )}
            {highlightedIds.length > 0 && (
              <div className="summary-kv">
                <span>Highlighted</span>
                <span>{highlightedIds.length}</span>
              </div>
            )}
            {isolatedIds.length > 0 && (
              <div className="summary-kv">
                <span>Isolated</span>
                <span>{isolatedIds.length}</span>
              </div>
            )}
            {hiddenIds.length > 0 && (
              <div className="summary-kv">
                <span>Hidden</span>
                <span>{hiddenIds.length}</span>
              </div>
            )}
          </section>
        )}

        {/* Assistant / perf */}
        <section className="summary-section summary-section-muted">
          <h4 className="summary-heading">Runtime</h4>
          <div className="summary-kv">
            <span>LLM</span>
            <span className="summary-mono" title={chatModel}>
              {chatProvider === 'openai' ? 'GPT' : 'Claude'} · {chatModel.split('-').slice(0, 3).join('-')}
            </span>
          </div>
          {perfMetrics.fps > 0 && (
            <div className="summary-kv">
              <span>FPS</span>
              <span className="summary-mono">{perfMetrics.fps.toFixed(0)}</span>
            </div>
          )}
          {perfMetrics.triangles > 0 && (
            <div className="summary-kv">
              <span>Triangles</span>
              <span className="summary-mono">{perfMetrics.triangles.toLocaleString()}</span>
            </div>
          )}
          {perfMetrics.memoryMb != null && (
            <div className="summary-kv">
              <span>Memory</span>
              <span className="summary-mono">{perfMetrics.memoryMb.toFixed(0)} MB</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
