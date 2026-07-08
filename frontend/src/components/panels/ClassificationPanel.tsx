import { useEffect, useState, useCallback, useMemo, useRef, KeyboardEvent } from 'react';
import { useStore } from '../../store/useStore';
import { modelService } from '../../services/ifc/ModelService';
import type { ClassificationGroup } from '../../types/ifc';
import Icon from '../ui/Icon';

interface ItemRowProps {
  code: string | null;
  name: string;
  count: number;
  isActive: boolean;
  onHighlight: () => void;
}

function ItemRow({ code, name, count, isActive, onHighlight }: ItemRowProps) {
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onHighlight();
    }
  };

  return (
    <button
      type="button"
      className={`classify-item${isActive ? ' classify-item--active' : ''}`}
      onClick={onHighlight}
      onKeyDown={handleKeyDown}
      title={`Highlight ${count} element${count === 1 ? '' : 's'}`}
    >
      <span className="classify-item-label">
        {code && <span className="classify-item-code">{code}</span>}
        <span className="classify-item-name">{name}</span>
      </span>
      <span className={`classify-item-badge${isActive ? ' classify-item-badge--active' : ''}`}>
        {count}
      </span>
    </button>
  );
}

interface GroupBlockProps {
  group: ClassificationGroup;
  highlightedIds: Set<number>;
  onHighlight: (ids: number[]) => void;
  searchQuery: string;
}

function GroupBlock({ group, highlightedIds, onHighlight, searchQuery }: GroupBlockProps) {
  const [expanded, setExpanded] = useState(true);

  const filteredItems = searchQuery
    ? group.items.filter(
        (it) =>
          it.name.toLowerCase().includes(searchQuery) ||
          (it.code && it.code.toLowerCase().includes(searchQuery)),
      )
    : group.items;

  const totalCount = filteredItems.reduce((s, it) => s + it.memberIds.length, 0);
  const allIds = filteredItems.flatMap((it) => it.memberIds);
  const groupName = group.name.toLowerCase();
  const groupMatchesSearch = searchQuery
    ? groupName.includes(searchQuery) || filteredItems.length > 0
    : true;

  // How many of the group's elements are currently highlighted
  const activeCount = allIds.filter((id) => highlightedIds.has(id)).length;
  const allActive = allIds.length > 0 && activeCount === allIds.length;

  // Hooks must run before any early return (Rules of Hooks)
  const handleHighlightGroup = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onHighlight(allActive ? [] : allIds);
    },
    [allIds, allActive, onHighlight],
  );

  if (!groupMatchesSearch) return null;

  return (
    <div className="classify-group">
      <div className="classify-group-header">
        <button
          type="button"
          className="classify-group-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        </button>
        <Icon name="tag" size={11} className="classify-group-icon" />
        <span className="classify-group-name">{group.name}</span>
        {group.edition && <span className="classify-group-edition">{group.edition}</span>}
        <span className={`classify-item-badge${allActive ? ' classify-item-badge--active' : ''}`}>
          {activeCount > 0 && !allActive ? `${activeCount}/` : ''}{totalCount}
        </span>
        {allIds.length > 0 && (
          <button
            type="button"
            className={`classify-group-highlight-btn${allActive ? ' classify-group-highlight-btn--active' : ''}`}
            onClick={handleHighlightGroup}
            title={allActive ? 'Clear highlight' : `Highlight all ${totalCount} elements in ${group.name}`}
          >
            <Icon name={allActive ? 'eye-off' : 'eye'} size={11} />
          </button>
        )}
      </div>

      {/* Animated collapse container */}
      <div
        className="classify-group-items-wrap"
        style={{ maxHeight: expanded ? '2000px' : '0px' }}
        aria-hidden={!expanded}
      >
        {filteredItems.length === 0 && searchQuery && (
          <p className="classify-empty-items" style={{ padding: '4px 24px', fontSize: 11 }}>
            No matches
          </p>
        )}
        {filteredItems.length === 0 && !searchQuery && (
          <p className="classify-empty-items">No classified elements</p>
        )}
        {filteredItems.length > 0 && (
          <div className="classify-group-items">
            {filteredItems.map((item) => {
              const isActive = item.memberIds.length > 0 && item.memberIds.every((id) => highlightedIds.has(id));
              return (
                <ItemRow
                  key={item.refExpressId}
                  code={item.code}
                  name={item.name}
                  count={item.memberIds.length}
                  isActive={isActive}
                  onHighlight={() => onHighlight(isActive ? [] : item.memberIds)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClassificationPanel() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const logActivity = useStore((s) => s.logActivity);

  const [groups, setGroups] = useState<ClassificationGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Build a Set for O(1) membership tests (memoized so unrelated renders don't reallocate)
  const highlightedSet = useMemo(() => new Set(highlightedIds), [highlightedIds]);

  // Focus search on Ctrl+F / Cmd+F within the panel
  const handlePanelKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (e.key === 'Escape' && searchQuery) {
      setSearchQuery('');
    }
  }, [searchQuery]);

  useEffect(() => {
    if (!modelLoaded) {
      setGroups([]);
      return;
    }
    setLoading(true);
    setError(null);
    modelService
      .getClassifications()
      .then((result) => { setGroups(result); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load classifications');
      })
      .finally(() => { setLoading(false); });
  }, [modelLoaded]);

  const handleHighlight = useCallback(
    (ids: number[]) => {
      setHighlightedIds(ids);
      if (ids.length > 0) {
        logActivity({
          kind: 'highlight',
          summary: `Highlighted ${ids.length} element${ids.length === 1 ? '' : 's'} via classification`,
        });
      } else {
        logActivity({ kind: 'highlight', summary: 'Classification highlight cleared' });
      }
    },
    [setHighlightedIds, logActivity],
  );

  const totalClassified = groups.reduce(
    (s, g) => s + g.items.reduce((si, it) => si + it.memberIds.length, 0),
    0,
  );

  const query = searchQuery.toLowerCase().trim();

  return (
    <div className="panel" style={{ height: '100%' }} onKeyDown={handlePanelKeyDown}>
      <div className="panel-header">
        <span>Classifications</span>
        {totalClassified > 0 && (
          <span className="panel-header-badge">{totalClassified} elements</span>
        )}
      </div>

      {/* Search bar */}
      {groups.length > 0 && (
        <div className="classify-search-row">
          <Icon name="search" size={11} style={{ opacity: 0.4, flexShrink: 0 }} />
          <input
            ref={searchRef}
            type="text"
            className="classify-search-input"
            placeholder="Filter classifications…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Filter classifications"
          />
          {searchQuery && (
            <button
              className="classify-search-clear"
              onClick={() => setSearchQuery('')}
              title="Clear filter"
              aria-label="Clear filter"
            >×</button>
          )}
        </div>
      )}

      <div className="panel-body">
        {!modelLoaded && (
          <p style={{ color: 'var(--text-muted)', padding: 8, fontSize: 12 }}>No model loaded</p>
        )}
        {modelLoaded && loading && (
          <p style={{ color: 'var(--text-muted)', padding: 8, fontSize: 12 }}>Loading…</p>
        )}
        {modelLoaded && !loading && error && (
          <p style={{ color: 'var(--color-error, #ef4444)', padding: 8, fontSize: 12 }}>{error}</p>
        )}
        {modelLoaded && !loading && !error && groups.length === 0 && (
          <div style={{ padding: '16px 12px', color: 'var(--text-muted)', fontSize: 12 }}>
            <p style={{ marginBottom: 6 }}>No IfcClassification data found in this model.</p>
            <p>Classifications appear when elements are assigned IfcClassificationReference entries (e.g. OmniClass, Uniclass, NF).</p>
          </div>
        )}
        {!loading && groups.map((g) => (
          <GroupBlock
            key={g.classificationExpressId}
            group={g}
            highlightedIds={highlightedSet}
            onHighlight={handleHighlight}
            searchQuery={query}
          />
        ))}
      </div>
    </div>
  );
}
