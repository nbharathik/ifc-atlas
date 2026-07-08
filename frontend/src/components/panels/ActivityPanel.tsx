import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import type { ActivityEntry } from '../../store/useStore';
import {
  ACTIVITY_KINDS,
  countHiddenEntries,
  filterActivityEntries,
  type ActivityKind,
} from './activityFilterHelpers';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

const KIND_LABELS: Record<ActivityEntry['kind'], { label: string; color: string }> = {
  select:     { label: 'SEL',  color: 'var(--warning)' },
  highlight:  { label: 'HL',   color: 'var(--accent)' },
  isolate:    { label: 'ISO',  color: 'var(--accent)' },
  hide:       { label: 'HIDE', color: 'var(--text-muted)' },
  'show-all': { label: 'SHOW', color: 'var(--success)' },
  tool:       { label: 'TOOL', color: 'var(--accent)' },
  chat:       { label: 'CHAT', color: 'var(--accent)' },
  screenshot: { label: 'SHOT', color: 'var(--success)' },
  view:       { label: 'VIEW', color: 'var(--text-secondary)' },
  error:      { label: 'ERR',  color: 'var(--danger)' },
  info:       { label: 'INFO', color: 'var(--text-secondary)' },
  edit:       { label: 'EDIT', color: 'var(--success)' },
};

interface ActivityPanelProps {
  embedded?: boolean;
}

export default function ActivityPanel({ embedded = false }: ActivityPanelProps = {}) {
  const { activity, mutedKinds, clearActivity, toggleActivity, toggleActivityKindMute, clearActivityKindMutes } =
    useStore(
      useShallow((s) => ({
        activity: s.activity,
        mutedKinds: s.activityMutedKinds,
        clearActivity: s.clearActivity,
        toggleActivity: s.toggleActivity,
        toggleActivityKindMute: s.toggleActivityKindMute,
        clearActivityKindMutes: s.clearActivityKindMutes,
      })),
    );

  const visible = useMemo(() => filterActivityEntries(activity, mutedKinds), [activity, mutedKinds]);
  const hiddenCount = useMemo(() => countHiddenEntries(activity, mutedKinds), [activity, mutedKinds]);
  const filterActive = mutedKinds.size > 0;

  const containerStyle: React.CSSProperties = embedded
    ? { flex: 1, minHeight: 0 }
    : { flex: '0 0 auto', maxHeight: '40%' };

  return (
    <div className="panel activity-panel" style={containerStyle}>
      {!embedded && (
      <div className="panel-header">
        <span>Activity Log</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn-icon"
            title="Clear activity"
            onClick={clearActivity}
            style={{ fontSize: 14 }}
          >
            &#x1F5D1;
          </button>
          <button
            className="btn-icon"
            title="Close activity log (L)"
            onClick={toggleActivity}
            style={{ fontSize: 14 }}
          >
            &times;
          </button>
        </div>
      </div>
      )}
      <div className="activity-filter-bar" role="toolbar" aria-label="Filter activity log by kind">
        {ACTIVITY_KINDS.map((kind) => {
          const k = KIND_LABELS[kind];
          const muted = mutedKinds.has(kind);
          return (
            <button
              key={kind}
              type="button"
              className={`activity-filter-chip${muted ? ' activity-filter-chip--muted' : ''}`}
              onClick={() => toggleActivityKindMute(kind)}
              title={muted ? `Show ${kind}` : `Hide ${kind}`}
              aria-pressed={!muted}
              style={muted ? undefined : { color: k.color, borderColor: k.color }}
            >
              {k.label}
            </button>
          );
        })}
        {filterActive && (
          <button
            type="button"
            className="activity-filter-clear"
            onClick={clearActivityKindMutes}
            title="Reset filter"
          >
            Reset
          </button>
        )}
        {embedded && activity.length > 0 && (
          <button
            type="button"
            className="activity-filter-clear"
            onClick={clearActivity}
            title="Clear activity log"
          >
            Clear log
          </button>
        )}
      </div>
      <div className="panel-body activity-body">
        {activity.length === 0 ? (
          <p className="activity-empty">No activity yet</p>
        ) : visible.length === 0 ? (
          <p className="activity-empty">
            All {hiddenCount} {hiddenCount === 1 ? 'entry' : 'entries'} hidden by filter
          </p>
        ) : (
          <>
            {visible.map((e) => {
              const k = KIND_LABELS[e.kind];
              return (
                <div key={e.id} className="activity-row">
                  <span className="activity-time">{formatTime(e.ts)}</span>
                  <span
                    className="activity-kind"
                    style={{ color: k.color, borderColor: k.color }}
                    title={e.kind}
                  >
                    {k.label}
                  </span>
                  <span className="activity-summary" title={e.detail || e.summary}>
                    {e.summary}
                  </span>
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <div className="activity-hidden-hint" title="Click a chip above to re-enable that kind">
                {hiddenCount} {hiddenCount === 1 ? 'entry' : 'entries'} hidden by filter
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
