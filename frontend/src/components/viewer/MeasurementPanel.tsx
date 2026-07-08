import { useStore } from '../../store/useStore';
import {
  formatLength,
  formatArea,
  formatAngle,
  type CommittedMeasurement,
} from '../../services/viewer/measurementController';
import type { MeasurementUnit } from '../../store/useStore';
import { downloadMeasurementsCsv } from '../../services/viewer/measurementsExport';

interface Props {
  measurements: CommittedMeasurement[];
  unit: MeasurementUnit;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

function formatValue(m: CommittedMeasurement, unit: MeasurementUnit): string {
  if (m.kind === 'linear') return formatLength(m.value, unit);
  if (m.kind === 'area') return formatArea(m.value, unit);
  return formatAngle(m.value);
}

const KIND_COLOURS: Record<CommittedMeasurement['kind'], string> = {
  linear: 'var(--atlas-accent)',
  area: 'var(--atlas-fg-muted)',
  angle: '#ffa040',
};

function KindBadge({ kind }: { kind: CommittedMeasurement['kind'] }) {
  return (
    <span
      style={{
        fontSize: '10px',
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 3,
        background: KIND_COLOURS[kind],
        color: 'var(--atlas-bg)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        flexShrink: 0,
      }}
    >
      {kind === 'linear' ? 'Lin' : kind === 'area' ? 'Area' : '∠'}
    </span>
  );
}

export default function MeasurementPanel({ measurements, unit, onRemove, onClearAll }: Props) {
  const open = useStore((s) => s.measurementPanelOpen);
  if (!open) return null;

  return (
    <div
      className="measurement-panel"
      style={{
        position: 'absolute',
        bottom: '60px',
        right: '16px',
        width: '260px',
        background: 'var(--atlas-surface)',
        border: '1px solid var(--atlas-border)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--atlas-border)',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--atlas-fg)' }}>
          Measurements
          {measurements.length > 0 && (
            <span
              style={{
                marginLeft: 6,
                fontSize: '10px',
                color: 'var(--atlas-fg-muted)',
                fontWeight: 400,
              }}
            >
              {measurements.length}
            </span>
          )}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {measurements.length > 0 && (
            <>
              <button
                onClick={() => downloadMeasurementsCsv(measurements, unit)}
                title="Export measurements as CSV"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                CSV ↓
              </button>
              <button
                onClick={onClearAll}
                title="Clear all measurements"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '11px',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                Clear all
              </button>
            </>
          )}
          <button
            onClick={() => useStore.getState().setMeasurementPanelOpen(false)}
            title="Close (R)"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--atlas-fg-muted)',
              fontSize: '14px',
              padding: '2px 4px',
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          overflowY: 'auto',
          maxHeight: '240px',
          padding: measurements.length === 0 ? '20px 12px' : '4px 0',
        }}
      >
        {measurements.length === 0 ? (
          <p
            style={{
              margin: 0,
              fontSize: '12px',
              color: 'var(--atlas-fg-muted)',
              textAlign: 'center',
            }}
          >
            No measurements yet.
            <br />
            Line, Area, or Angle (R to toggle).
          </p>
        ) : (
          [...measurements].reverse().map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                borderBottom: '1px solid var(--atlas-border-subtle, var(--atlas-border))',
              }}
            >
              <KindBadge kind={m.kind} />
              <span
                style={{
                  flex: 1,
                  fontSize: '12px',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--atlas-fg)',
                }}
              >
                {formatValue(m, unit)}
              </span>
              <button
                onClick={() => onRemove(m.id)}
                title="Remove measurement"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--atlas-fg-muted)',
                  fontSize: '13px',
                  padding: '1px 4px',
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: '5px 12px',
          borderTop: '1px solid var(--atlas-border)',
          fontSize: '10px',
          color: 'var(--atlas-fg-muted)',
          flexShrink: 0,
        }}
      >
        Press <kbd style={{ fontFamily: 'monospace', fontSize: '10px' }}>R</kbd> to toggle
      </div>
    </div>
  );
}
