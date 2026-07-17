import { describe, expect, it } from 'vitest';
import {
  BROWSER_WEB_IFC_RUNTIME,
  webIfcRuntimeActivitySummary,
} from '../webIfcRuntime';

describe('browser web-ifc runtime contract', () => {
  it('keeps preload telemetry aligned with forced single-thread initialization', () => {
    expect(BROWSER_WEB_IFC_RUNTIME).toEqual({
      forceSingleThread: true,
      wasmVariant: 'st',
      wasmFile: 'web-ifc.wasm',
    });
  });

  it('does not advertise MT when cross-origin isolation is available', () => {
    const summary = webIfcRuntimeActivitySummary(true);
    expect(summary).toContain('Single-threaded web-ifc');
    expect(summary).toContain('nested web-ifc workers are disabled');
    expect(summary).not.toContain('multi-threaded');
    expect(summary).not.toContain('web-ifc-mt.wasm');
  });
});
