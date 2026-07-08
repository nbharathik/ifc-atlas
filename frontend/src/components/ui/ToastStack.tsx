import { useStore } from '../../store/useStore';

export default function ToastStack() {
  const toasts = useStore((s) => s.toasts);
  const removeToast = useStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 48,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 6,
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => removeToast(t.id)}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            padding: '7px 14px',
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 500,
            color: 'var(--atlas-fg)',
            background:
              t.kind === 'success'
                ? 'var(--atlas-success, #1a6b3c)'
                : t.kind === 'error'
                  ? 'var(--atlas-danger, #6b1a1a)'
                  : 'var(--atlas-surface-raised, var(--atlas-surface))',
            border: `1px solid ${
              t.kind === 'success'
                ? 'var(--atlas-success-border, #2a9d5c)'
                : t.kind === 'error'
                  ? 'var(--atlas-danger-border, #c93030)'
                  : 'var(--atlas-border)'
            }`,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap',
            maxWidth: 340,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
