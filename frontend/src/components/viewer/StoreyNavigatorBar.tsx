import { useMemo, useCallback, useEffect } from 'react';
import { useStore } from '../../store/useStore';
import { extractStoreyNodes } from '../../services/viewer/storeyFrustumCuller';
import {
  collectStoreySubtreeIds,
  shortStoreyName,
  detectActiveStorey,
} from '../../services/viewer/storeyNavigatorHelpers';

export default function StoreyNavigatorBar() {
  const spatialTree = useStore((s) => s.spatialTree);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);

  const storeys = useMemo(() => extractStoreyNodes(spatialTree), [spatialTree]);

  const storeySubtrees = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const s of storeys) map.set(s.id, collectStoreySubtreeIds(s));
    return map;
  }, [storeys]);

  const activeStoreyId = useMemo(
    () => detectActiveStorey(isolatedIds, storeys, storeySubtrees),
    [isolatedIds, storeys, storeySubtrees],
  );

  const isolateStorey = useCallback(
    (storeyId: number, storeyName: string) => {
      if (activeStoreyId === storeyId) {
        clearVisibility();
      } else {
        const ids = storeySubtrees.get(storeyId) ?? [];
        setIsolatedIds(ids);
        logActivity({ kind: 'isolate', summary: `Storey: "${storeyName}"` });
      }
    },
    [activeStoreyId, storeySubtrees, clearVisibility, setIsolatedIds, logActivity],
  );

  useEffect(() => {
    if (storeys.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey) return;
      const digit = parseInt(e.key, 10);
      if (isNaN(digit) || digit < 1 || digit > 9) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const idx = digit - 1;
      if (idx >= storeys.length) return;
      e.preventDefault();
      const s = storeys[idx];
      isolateStorey(s.id, s.name);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [storeys, isolateStorey]);

  if (!modelLoaded || storeys.length < 2) return null;

  return (
    <div className="storey-nav-bar" role="toolbar" aria-label="Storey navigator">
      <button
        className={`storey-nav-pill storey-nav-all${isolatedIds.length === 0 ? ' active' : ''}`}
        onClick={clearVisibility}
        title="Show all storeys"
        aria-pressed={isolatedIds.length === 0}
      >
        All
      </button>
      {storeys.map((storey, i) => {
        const isActive = activeStoreyId === storey.id;
        const subtree = storeySubtrees.get(storey.id);
        const count = subtree ? subtree.length - 1 : 0; // exclude storey container itself
        return (
          <button
            key={storey.id}
            className={`storey-nav-pill${isActive ? ' active' : ''}`}
            onClick={() => isolateStorey(storey.id, storey.name)}
            title={`${storey.name} · ${count} element${count === 1 ? '' : 's'}${i < 9 ? ` · Shift+${i + 1}` : ''}`}
            aria-pressed={isActive}
          >
            <span className="storey-nav-name">{shortStoreyName(storey.name)}</span>
            {count > 0 && <span className="storey-nav-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
