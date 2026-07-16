import { describe, expect, it } from 'vitest';
import { formatErrorDiagnostics } from './ErrorBoundary';

describe('formatErrorDiagnostics', () => {
  it('includes actionable component and environment context', () => {
    const error = new TypeError('GPU buffer upload failed');
    const output = formatErrorDiagnostics('ViewerPanel', error, 'at ViewerPanel', {
      timestamp: '2026-07-15T12:00:00.000Z',
      url: 'http://localhost:5173/model',
      userAgent: 'test-browser',
    });

    expect(output).toContain('IFC Atlas component: ViewerPanel');
    expect(output).toContain('2026-07-15T12:00:00.000Z');
    expect(output).toContain('TypeError: GPU buffer upload failed');
    expect(output).toContain('React component stack:\nat ViewerPanel');
    expect(output).toContain('test-browser');
  });
});
