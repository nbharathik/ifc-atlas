import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../../store/useStore';

// ── Pure helpers for ghost opacity ─────────────────────────────────────────────

/** Round opacity to nearest percentage point for display. */
function opacityToPercent(opacity: number): number {
  return Math.round(opacity * 100);
}

/** Clamp opacity to [0.05, 0.60] slider range. */
function clampSliderOpacity(v: number): number {
  return Math.max(0.05, Math.min(0.60, v));
}

// ── Store slice tests ──────────────────────────────────────────────────────────

function resetAppearanceSlice() {
  useStore.setState({ selectionFocusMode: 'off', selectionGhostOpacity: 0.22 });
}

describe('opacityToPercent', () => {
  it('converts 0.22 to 22', () => {
    expect(opacityToPercent(0.22)).toBe(22);
  });
  it('converts 0.05 to 5', () => {
    expect(opacityToPercent(0.05)).toBe(5);
  });
  it('converts 0.60 to 60', () => {
    expect(opacityToPercent(0.60)).toBe(60);
  });
  it('rounds fractional results', () => {
    expect(opacityToPercent(0.333)).toBe(33);
  });
});

describe('clampSliderOpacity', () => {
  it('clamps below min to 0.05', () => {
    expect(clampSliderOpacity(0.01)).toBe(0.05);
  });
  it('clamps above max to 0.60', () => {
    expect(clampSliderOpacity(0.99)).toBe(0.60);
  });
  it('leaves values in range unchanged', () => {
    expect(clampSliderOpacity(0.22)).toBe(0.22);
    expect(clampSliderOpacity(0.05)).toBe(0.05);
    expect(clampSliderOpacity(0.60)).toBe(0.60);
  });
});

describe('selection focus mode store slice', () => {
  beforeEach(resetAppearanceSlice);

  it('initial selectionFocusMode is off', () => {
    expect(useStore.getState().selectionFocusMode).toBe('off');
  });

  it('setSelectionFocusMode switches to ghost', () => {
    useStore.getState().setSelectionFocusMode('ghost');
    expect(useStore.getState().selectionFocusMode).toBe('ghost');
  });

  it('setSelectionFocusMode can toggle back to off', () => {
    useStore.getState().setSelectionFocusMode('ghost');
    useStore.getState().setSelectionFocusMode('off');
    expect(useStore.getState().selectionFocusMode).toBe('off');
  });
});

describe('selectionGhostOpacity store slice', () => {
  beforeEach(resetAppearanceSlice);

  it('initial value is 0.22', () => {
    expect(useStore.getState().selectionGhostOpacity).toBeCloseTo(0.22);
  });

  it('setSelectionGhostOpacity updates the value', () => {
    useStore.getState().setSelectionGhostOpacity(0.35);
    expect(useStore.getState().selectionGhostOpacity).toBeCloseTo(0.35);
  });

  it('clamps to minimum 0.05', () => {
    useStore.getState().setSelectionGhostOpacity(0.01);
    expect(useStore.getState().selectionGhostOpacity).toBeCloseTo(0.05);
  });

  it('clamps to maximum 1.0 (store max)', () => {
    useStore.getState().setSelectionGhostOpacity(1.5);
    expect(useStore.getState().selectionGhostOpacity).toBeCloseTo(1.0);
  });

  it('reset to default 0.22', () => {
    useStore.getState().setSelectionGhostOpacity(0.50);
    useStore.getState().setSelectionGhostOpacity(0.22);
    expect(useStore.getState().selectionGhostOpacity).toBeCloseTo(0.22);
  });
});

// ── IDS CSV button logic (pure detection helpers) ─────────────────────────────

/** Mirror of the label logic in ToolCallDisplay. */
function idsButtonLabel(downloading: boolean, error: boolean): string {
  if (downloading) return '⏳ Downloading…';
  if (error) return '⚠ Download failed';
  return '📥 Download failures CSV';
}

/** Mirror of the CSS class logic in ToolCallDisplay. */
function idsButtonClass(error: boolean): string {
  return `tool-call-ids-csv-btn${error ? ' ids-csv-error' : ''}`;
}

describe('IDS CSV button detection', () => {
  /** Mirror of the detection logic in ToolCallDisplay: validate_model with
   *  check='ids' is the current catalog shape; the bare ids_validate name
   *  keeps restored legacy transcripts working. */
  const isIdsValidate = (
    name: string,
    args: Record<string, unknown>,
    result: string | undefined,
  ) => !!result && ((name === 'validate_model' && args.check === 'ids') || name === 'ids_validate');

  it('shows button for validate_model with check=ids and a result', () => {
    expect(isIdsValidate('validate_model', { check: 'ids' }, '{"total":5}')).toBe(true);
  });

  it('shows button for the legacy ids_validate name (restored transcripts)', () => {
    expect(isIdsValidate('ids_validate', {}, '{"total":5}')).toBe(true);
  });

  it('does not show button for other tool names or checks', () => {
    expect(isIdsValidate('describe_model', {}, '{"total":5}')).toBe(false);
    expect(isIdsValidate('validate_model', { check: 'health' }, '{"total":5}')).toBe(false);
  });

  it('does not show button when result is missing', () => {
    expect(isIdsValidate('validate_model', { check: 'ids' }, undefined)).toBe(false);
  });

  it('extracts ids_base64 from arguments', () => {
    const args = { ids_base64: 'abc123==', format: 'json' };
    const idsBase64 = typeof args.ids_base64 === 'string' ? args.ids_base64 : undefined;
    expect(idsBase64).toBe('abc123==');
  });

  it('returns undefined when ids_base64 is missing', () => {
    const args = { format: 'json' } as Record<string, unknown>;
    const idsBase64 = typeof args.ids_base64 === 'string' ? args.ids_base64 : undefined;
    expect(idsBase64).toBeUndefined();
  });
});

describe('IDS CSV button label states', () => {
  it('shows download label when idle', () => {
    expect(idsButtonLabel(false, false)).toBe('📥 Download failures CSV');
  });

  it('shows downloading label while in flight', () => {
    expect(idsButtonLabel(true, false)).toBe('⏳ Downloading…');
  });

  it('shows error label on failure', () => {
    expect(idsButtonLabel(false, true)).toBe('⚠ Download failed');
  });

  it('downloading takes precedence over error', () => {
    expect(idsButtonLabel(true, true)).toBe('⏳ Downloading…');
  });
});

describe('IDS CSV button CSS class', () => {
  it('has base class only when no error', () => {
    expect(idsButtonClass(false)).toBe('tool-call-ids-csv-btn');
  });

  it('appends ids-csv-error modifier on failure', () => {
    expect(idsButtonClass(true)).toBe('tool-call-ids-csv-btn ids-csv-error');
  });
});

describe('ghost slider visibility', () => {
  it('slider visible predicate true when ghost mode active', () => {
    const visible = (mode: string) => mode === 'ghost';
    expect(visible('ghost')).toBe(true);
  });

  it('slider visible predicate false when focus off', () => {
    const visible = (mode: string) => mode === 'ghost';
    expect(visible('off')).toBe(false);
  });

  it('appearance section auto-opens when ghost mode active', () => {
    const autoOpen = (colourBy: string, focusMode: string) =>
      colourBy !== 'off' || focusMode !== 'off';
    expect(autoOpen('off', 'ghost')).toBe(true);
    expect(autoOpen('type', 'off')).toBe(true);
    expect(autoOpen('off', 'off')).toBe(false);
  });
});
