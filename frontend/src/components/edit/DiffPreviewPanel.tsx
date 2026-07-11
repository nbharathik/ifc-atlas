import { useEffect, useMemo, useState } from 'react';

import { applyPendingEditWithRetry, discardPendingEdit } from '../../services/api';
import { useStore } from '../../store/useStore';
import type {
  PendingEditChangeKind,
  PendingEditElement,
  PendingEditEnvelope,
} from '../../types/ifc';
import Icon from '../ui/Icon';
import { getExecuteIfcCodeMeta } from './diffPreviewMeta';

const CHANGE_LABELS: Record<PendingEditChangeKind, string> = {
  renamed: 'Renamed',
  retyped: 'Retyped',
  property_changed: 'Property changed',
  deleted: 'Deleted',
  created: 'Created',
};

const CHANGE_COLORS: Record<PendingEditChangeKind, string> = {
  renamed: 'var(--acc)',
  retyped: 'var(--warning)',
  property_changed: 'var(--text-secondary)',
  deleted: 'var(--danger)',
  created: 'var(--success, var(--acc))',
};

function formatValue(v: string | number | boolean | null): string {
  if (v === null) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function ChangeRow({ change }: { change: PendingEditElement }) {
  const color = CHANGE_COLORS[change.change];
  const label = CHANGE_LABELS[change.change] ?? change.change;

  return (
    <li
      style={{
        listStyle: 'none',
        padding: '10px 12px',
        borderRadius: 6,
        background: 'var(--bg-elevated, rgba(255,255,255,0.02))',
        border: '1px solid var(--border, rgba(255,255,255,0.08))',
        marginBottom: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 9999,
            background: 'var(--acc-dim)',
            color,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        <code style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
          #{change.express_id} · {change.ifc_type}
        </code>
      </div>

      {change.change === 'created' && change.name_after && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>name:</span>
          <code style={{ color: 'var(--text)' }}>{formatValue(change.name_after)}</code>
        </div>
      )}

      {change.change === 'deleted' && change.name_before && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>was:</span>
          <code style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>
            {formatValue(change.name_before)}
          </code>
        </div>
      )}

      {change.change === 'renamed' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>
            {formatValue(change.name_before)}
          </code>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
          <code style={{ color: 'var(--text)' }}>{formatValue(change.name_after)}</code>
        </div>
      )}

      {change.change === 'retyped' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>
            {formatValue(change.ifc_type_before)}
          </code>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>→</span>
          <code style={{ color: 'var(--text)' }}>{formatValue(change.ifc_type_after)}</code>
        </div>
      )}

      {change.property_changes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
          {change.property_changes.map((pc, idx) => (
            <div key={idx} style={{ fontSize: 11 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                {pc.property_set}.{pc.property_name}
              </span>
              <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>·</span>
              <code style={{ color: 'var(--text-muted)', textDecoration: 'line-through' }}>
                {formatValue(pc.before)}
              </code>
              <span style={{ margin: '0 4px', color: 'var(--text-muted)' }}>→</span>
              <code style={{ color: 'var(--text)' }}>{formatValue(pc.after)}</code>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function CountBadge({ label, count, color }: { label: string; count: number; color: string }) {
  if (count <= 0) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 10px',
        borderRadius: 9999,
        background: 'var(--acc-dim)',
        color,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {count} {label}
    </span>
  );
}

export default function DiffPreviewPanel() {
  const pendingEdits = useStore((s) => s.pendingEdits);
  const activePendingEditId = useStore((s) => s.activePendingEditId);
  const setActivePendingEditId = useStore((s) => s.setActivePendingEditId);
  const removePendingEdit = useStore((s) => s.removePendingEdit);
  const logActivity = useStore((s) => s.logActivity);

  const envelope: PendingEditEnvelope | undefined = useMemo(
    () => pendingEdits.find((e) => e.edit_id === activePendingEditId),
    [pendingEdits, activePendingEditId],
  );

  const [busy, setBusy] = useState<'apply' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setBusy(null);
  }, [activePendingEditId]);

  // Esc closes the panel (keeps the pending edit in the store; user can
  // reopen from the activity log / CommandPalette later).
  useEffect(() => {
    if (!envelope) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setActivePendingEditId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [envelope, busy, setActivePendingEditId]);

  if (!envelope) return null;

  const { counts } = envelope;
  const executeMeta = getExecuteIfcCodeMeta(envelope);
  const isExecuteIfcCode = executeMeta !== null;

  async function onApply() {
    if (!envelope || busy) return;
    setBusy('apply');
    setError(null);
    try {
      await applyPendingEditWithRetry(envelope.edit_id);
      logActivity({
        kind: 'edit',
        summary: `Applied: ${envelope.summary}`,
        detail: Object.entries(envelope.counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(' '),
      });
      removePendingEdit(envelope.edit_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function onDiscard() {
    if (!envelope || busy) return;
    setBusy('discard');
    setError(null);
    try {
      await discardPendingEdit(envelope.edit_id);
      logActivity({
        kind: 'edit',
        summary: `Discarded: ${envelope.summary}`,
      });
      removePendingEdit(envelope.edit_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={() => !busy && setActivePendingEditId(null)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="diff-preview-title"
    >
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 720, width: '94vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="modal-header" style={{ gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="pencil" size={16} />
            <h2 id="diff-preview-title" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              Pending edit: review before apply
            </h2>
          </div>
          <button
            onClick={() => !busy && setActivePendingEditId(null)}
            disabled={busy !== null}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: busy ? 'not-allowed' : 'pointer',
              padding: 4,
            }}
            aria-label="Close"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div
          className="modal-body"
          style={{
            padding: '12px 16px',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 13, color: 'var(--text)' }}>
                {envelope.summary || '(no summary)'}
              </div>
              {isExecuteIfcCode && (
                <span
                  title="Generated by execute_ifc_code: arbitrary Python ran in a sandbox subprocess"
                  style={{
                    padding: '2px 8px',
                    borderRadius: 9999,
                    background: 'var(--acc-dim)',
                    color: 'var(--acc)',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    textTransform: 'uppercase',
                  }}
                >
                  execute_ifc_code
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Edit id <code>{envelope.edit_id.slice(0, 12)}</code> · base model v
              {envelope.base_model_version}
              {executeMeta && executeMeta.elapsedMs !== null && (
                <>
                  {' · sandbox ran in '}
                  <code>{executeMeta.elapsedMs}ms</code>
                  {executeMeta.codeChars !== null && (
                    <>
                      {' · '}
                      <code>{executeMeta.codeChars}</code>
                      {' chars of Python'}
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <CountBadge label="renamed" count={counts.renamed ?? 0} color={CHANGE_COLORS.renamed} />
            <CountBadge label="retyped" count={counts.retyped ?? 0} color={CHANGE_COLORS.retyped} />
            <CountBadge
              label="props changed"
              count={counts.property_changed ?? 0}
              color={CHANGE_COLORS.property_changed}
            />
            <CountBadge label="deleted" count={counts.deleted ?? 0} color={CHANGE_COLORS.deleted} />
            <CountBadge label="created" count={counts.created ?? 0} color={CHANGE_COLORS.created} />
          </div>

          {/* D4 verifier verdict: health delta + geometry sanity computed on
              the sandbox BEFORE this edit was offered. Advisory - Apply stays
              enabled, but a fail is loud. */}
          {envelope.verifier_verdict && (
            <div
              title={envelope.verifier_verdict.note ?? ''}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 6, fontSize: 12,
                background:
                  envelope.verifier_verdict.status === 'pass' ? 'color-mix(in srgb, var(--ok, #3a8) 12%, transparent)'
                  : envelope.verifier_verdict.status === 'warn' ? 'color-mix(in srgb, var(--warn, #ca3) 14%, transparent)'
                  : 'color-mix(in srgb, var(--err, #c55) 14%, transparent)',
                color:
                  envelope.verifier_verdict.status === 'pass' ? 'var(--ok, #3a8)'
                  : envelope.verifier_verdict.status === 'warn' ? 'var(--warn, #ca3)'
                  : 'var(--err, #c55)',
              }}
            >
              <Icon
                name={envelope.verifier_verdict.status === 'pass' ? 'check' : 'alert-circle'}
                size={13}
              />
              <span style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.4 }}>
                Verifier: {envelope.verifier_verdict.status}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                {envelope.verifier_verdict.note || 'model health checked against the live baseline'}
              </span>
            </div>
          )}

          {envelope.changes.length === 0 ? (
            <div
              style={{
                padding: 12,
                border: '1px dashed var(--border, rgba(255,255,255,0.08))',
                borderRadius: 6,
                color: 'var(--text-muted)',
                fontSize: 12,
                textAlign: 'center',
              }}
            >
              No structural differences were detected in the sandbox.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: 0, maxHeight: '46vh', overflow: 'auto' }}>
              {envelope.changes.map((c) => (
                <ChangeRow key={`${c.express_id}-${c.change}`} change={c} />
              ))}
            </ul>
          )}

          {error && (
            <div
              style={{
                padding: 10,
                border: '1px solid var(--danger)',
                borderRadius: 6,
                color: 'var(--danger)',
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          className="modal-footer"
          style={{
            display: 'flex',
            gap: 8,
            padding: '12px 16px',
            borderTop: '1px solid var(--border, rgba(255,255,255,0.08))',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onDiscard}
            disabled={busy !== null}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--border, rgba(255,255,255,0.14))',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 12,
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
          <button
            onClick={onApply}
            disabled={busy !== null || envelope.changes.length === 0}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--acc)',
              background: 'var(--acc)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: busy || envelope.changes.length === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || envelope.changes.length === 0 ? 0.6 : 1,
            }}
          >
            {busy === 'apply' ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
