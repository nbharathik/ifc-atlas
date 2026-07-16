import { useCallback, useRef } from 'react';
import { useStore } from '../../store/useStore';
import Sidebar from './Sidebar';
import SearchPanel from '../panels/SearchPanel';
import SummaryPanel from '../panels/SummaryPanel';
import ClassificationPanel from '../panels/ClassificationPanel';
import ResizeHandle from './ResizeHandle';
import Icon from '../ui/Icon';
import type { IconName } from '../ui/Icon';
import { nextHorizontalTabIndex } from './tabKeyboardNavigation';

type PaneId = 'tree' | 'search' | 'summary' | 'classify';

interface PaneSpec {
  id: PaneId;
  label: string;
  icon: IconName;
  shortcut: string;
}

const PANES: PaneSpec[] = [
  { id: 'tree',     label: 'Tree',            icon: 'layers',         shortcut: 'T' },
  { id: 'search',   label: 'Search',          icon: 'search',         shortcut: '/' },
  { id: 'summary',  label: 'Summary',         icon: 'clipboard-list', shortcut: 'U' },
  { id: 'classify', label: 'Classifications', icon: 'tag',            shortcut: 'G' },
];

const PANE_LABELS: Record<PaneId, string> = {
  tree: 'Outliner',
  search: 'Search',
  summary: 'Summary',
  classify: 'Classifications',
};

/**
 * Left workspace column with a compact pane-switcher (icon-only) in the
 * header - tree, search, summary and classification panes.
 */
export default function Outliner() {
  const activePane = useStore((s) => s.leftActivePane);
  const focusLeftPane = useStore((s) => s.focusLeftPane);
  const setLeftSidebarOpen = useStore((s) => s.setLeftSidebarOpen);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const pane: PaneId = (activePane ?? 'tree') as PaneId;

  const onTabKeyDown = useCallback((event: React.KeyboardEvent, index: number) => {
    const nextIndex = nextHorizontalTabIndex(index, PANES.length, event.key);
    if (nextIndex === null) return;
    event.preventDefault();
    focusLeftPane(PANES[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }, [focusLeftPane]);

  return (
    <aside className="outliner-column" aria-label="Navigator">
      <div className="outliner-head">
        <Icon name="layers" size={12} />
        <span>{PANE_LABELS[pane]}</span>
        <div className="outliner-head-spacer" />
        <div className="outliner-pane-switcher" role="tablist" aria-label="Navigator panes">
          {PANES.map((p, index) => (
            <button
              key={p.id}
              ref={(element) => { tabRefs.current[index] = element; }}
              id={`navigator-tab-${p.id}`}
              className={`outliner-pane-btn ${pane === p.id ? 'active' : ''}`}
              title={`${p.label} (${p.shortcut})`}
              aria-label={`${p.label} (${p.shortcut})`}
              onClick={() => focusLeftPane(p.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              role="tab"
              aria-selected={pane === p.id}
              aria-controls={`navigator-panel-${p.id}`}
              tabIndex={pane === p.id ? 0 : -1}
            >
              <Icon name={p.icon} size={12} />
            </button>
          ))}
        </div>
        <button
          className="outliner-head-btn"
          onClick={() => setLeftSidebarOpen(false)}
          title="Hide left sidebar"
          aria-label="Hide left sidebar"
        >
          <Icon name="panel-left-close" size={12} />
        </button>
      </div>
      <div
        className="outliner-body"
        id={`navigator-panel-${pane}`}
        role="tabpanel"
        aria-labelledby={`navigator-tab-${pane}`}
      >
        {pane === 'tree' && <Sidebar />}
        {pane === 'search' && <SearchPanel />}
        {pane === 'summary' && <SummaryPanel />}
        {pane === 'classify' && <ClassificationPanel />}
      </div>
      <ResizeHandle
        side="left"
        storageKey="pref.w.outliner"
        cssVar="--w-outliner"
        defaultWidth={244}
        min={200}
        max={520}
      />
    </aside>
  );
}
