import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../../store/useStore';
import type { SpatialNode } from '../../types/ifc';

/** Sort `by_type` entries by count descending, strip the 'Ifc' prefix for display. */
export function sortedTypeEntries(byType: Record<string, number>): Array<[string, number]> {
  return Object.entries(byType).sort((a, b) => b[1] - a[1]);
}

/** Compute storey-level element counts from the spatial tree (excludes storey node itself). */
export function computeStoreyCounts(
  storeys: Array<{ name: string; childCount: number }>,
): Array<{ name: string; count: number }> {
  return storeys.map((s) => ({ name: s.name, count: s.childCount }));
}

function ModelStatsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const statsPanelOpen = useStore((s) => s.statsPanelOpen);
  const setStatsPanelOpen = useStore((s) => s.setStatsPanelOpen);
  const stats = useStore((s) => s.stats);
  const nativeIndexReady = useStore((s) => s.nativeIndexReady);
  const spatialTree = useStore((s) => s.spatialTree);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const logActivity = useStore((s) => s.logActivity);
  const modelLoaded = useStore((s) => s.modelLoaded);

  const close = useCallback(() => setStatsPanelOpen(false), [setStatsPanelOpen]);

  // ESC dismisses the panel, matching every other floating overlay.
  useEffect(() => {
    if (!statsPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't swallow Esc meant for an overlay layered above the Tools tab.
      if (useStore.getState().commandPaletteOpen || useStore.getState().settingsOpen) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [statsPanelOpen, close]);

  // Walk the spatial tree ONCE per tree change to derive both the ids-by-type
  // map and the per-storey id lists. Previously `storeyCounts` was a full-tree
  // walk on every render and `isTypeIsolated` walked the whole tree once per
  // type row (O(types * nodes) per render); deriving everything from these
  // memoized maps collapses that to O(nodes) once per tree change.
  const { idsByType, storeyCounts } = useMemo(() => {
    const byType = new Map<string, number[]>();
    const storeys: Array<{ name: string; count: number; ids: number[] }> = [];
    if (spatialTree) {
      // Full recursion bucketing every node by ifc_type (matches the previous
      // per-type walk, which traversed the whole tree including under storeys).
      const walk = (node: SpatialNode) => {
        let arr = byType.get(node.ifc_type);
        if (!arr) { arr = []; byType.set(node.ifc_type, arr); }
        arr.push(node.id);
        if (node.ifc_type === 'IfcBuildingStorey') {
          const ids: number[] = [];
          const collectIds = (n: SpatialNode) => {
            ids.push(n.id);
            for (const c of n.children) collectIds(c);
          };
          // collect children (not the storey container itself)
          for (const c of node.children) collectIds(c);
          storeys.push({ name: node.name || 'Unnamed storey', count: ids.length, ids });
        }
        for (const c of node.children) walk(c);
      };
      walk(spatialTree);
      // sort ground-up by name
      storeys.sort((a, b) => a.name.localeCompare(b.name));
    }
    return { idsByType: byType, storeyCounts: storeys };
  }, [spatialTree]);

  const isolateType = useCallback(
    (ifcType: string) => {
      const ids = idsByType.get(ifcType);
      if (!ids || ids.length === 0) return;
      setIsolatedIds(ids);
      logActivity({ kind: 'isolate', summary: `Stats: isolated ${ids.length} ${ifcType.replace('Ifc', '')} elements` });
    },
    [idsByType, setIsolatedIds, logActivity],
  );

  if (!statsPanelOpen) return null;
  // Docked in the Tools tab the host always mounts us; show a load-a-model
  // state (like the other tools) rather than an empty body under the breadcrumb.
  if (!modelLoaded) {
    return embedded ? (
      <div className="stats-embed">
        <p className="stats-empty">Load a model to see statistics.</p>
      </div>
    ) : null;
  }

  const typeEntries = stats ? sortedTypeEntries(stats.by_type) : [];
  const totalElements = nativeIndexReady?.elementCount ?? stats?.total_elements ?? 0;
  const psetCount = nativeIndexReady?.psetCount ?? 0;
  const storeyNames = stats?.storeys ?? [];

  const isolateStorey = (entry: { name: string; ids: number[] }) => {
    if (entry.ids.length === 0) return;
    setIsolatedIds(entry.ids);
    logActivity({ kind: 'isolate', summary: `Stats: isolated storey "${entry.name}"` });
  };

  const isTypeIsolated = (ifcType: string) => {
    if (isolatedIds.length === 0) return false;
    const typeIds = idsByType.get(ifcType);
    return (
      typeIds != null &&
      typeIds.length > 0 &&
      isolatedIds.length === typeIds.length &&
      typeIds.every((id) => isolatedIds.includes(id))
    );
  };

  return (
    <div
      className={embedded ? 'stats-embed' : 'stats-overlay'}
      onClick={embedded ? undefined : close}
      role={embedded ? undefined : 'dialog'}
      aria-label={embedded ? undefined : 'Model statistics'}
    >
      <div className="stats-panel" onClick={embedded ? undefined : (e) => e.stopPropagation()}>
        {/* Header - the Tools tab breadcrumb owns the title/close when embedded. */}
        {!embedded && (
          <div className="stats-header">
            <span className="stats-title">Model Statistics</span>
            <button className="stats-close btn-icon" onClick={close} aria-label="Close statistics panel">
              &times;
            </button>
          </div>
        )}

        {/* Summary row */}
        <div className="stats-summary">
          <div className="stats-summary-chip">
            <span className="stats-chip-value">{totalElements.toLocaleString()}</span>
            <span className="stats-chip-label">elements</span>
          </div>
          <div className="stats-summary-chip">
            <span className="stats-chip-value">{storeyCounts.length || storeyNames.length}</span>
            <span className="stats-chip-label">storeys</span>
          </div>
          {psetCount > 0 && (
            <div className="stats-summary-chip">
              <span className="stats-chip-value">{psetCount.toLocaleString()}</span>
              <span className="stats-chip-label">property sets</span>
            </div>
          )}
          {typeEntries.length > 0 && (
            <div className="stats-summary-chip">
              <span className="stats-chip-value">{typeEntries.length}</span>
              <span className="stats-chip-label">IFC types</span>
            </div>
          )}
        </div>

        <div className="stats-body">
          {/* By type */}
          {typeEntries.length > 0 && (
            <section className="stats-section">
              <h3 className="stats-section-title">Elements by type</h3>
              <div className="stats-type-list">
                {typeEntries.map(([type, count]) => {
                  const pct = totalElements > 0 ? Math.round((count / totalElements) * 100) : 0;
                  const active = isTypeIsolated(type);
                  return (
                    <button
                      key={type}
                      className={`stats-type-row${active ? ' active' : ''}`}
                      onClick={() => (active ? clearVisibility() : isolateType(type))}
                      title={active ? 'Click to show all' : `Click to isolate ${type.replace('Ifc', '')} elements`}
                    >
                      <span className="stats-type-name">{type.replace('Ifc', '')}</span>
                      <div className="stats-type-bar-wrap">
                        <div className="stats-type-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="stats-type-count">{count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* By storey */}
          {storeyCounts.length > 0 && (
            <section className="stats-section">
              <h3 className="stats-section-title">Elements by storey</h3>
              <div className="stats-type-list">
                {storeyCounts.map((entry) => {
                  const pct =
                    totalElements > 0 ? Math.round((entry.count / totalElements) * 100) : 0;
                  const isActive =
                    isolatedIds.length > 0 &&
                    entry.ids.length > 0 &&
                    isolatedIds.length === entry.ids.length &&
                    entry.ids.every((id) => isolatedIds.includes(id));
                  return (
                    <button
                      key={entry.name}
                      className={`stats-type-row${isActive ? ' active' : ''}`}
                      onClick={() => (isActive ? clearVisibility() : isolateStorey(entry))}
                      title={isActive ? 'Click to show all' : `Isolate storey "${entry.name}"`}
                    >
                      <span className="stats-type-name">{entry.name}</span>
                      <div className="stats-type-bar-wrap">
                        <div className="stats-type-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="stats-type-count">{entry.count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <div className="stats-footer">
          <span className="stats-hint">Click a row to isolate · click again to show all · Shift+S to close</span>
        </div>
      </div>
    </div>
  );
}

export default ModelStatsPanel;
