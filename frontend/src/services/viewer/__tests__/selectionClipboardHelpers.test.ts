import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  formatExpressIdOnly,
  formatGlobalId,
  formatElementDetails,
  formatElementDetailsJson,
  formatClipboardPayload,
  describeClipboardCopy,
  writeClipboardText,
  copyNodeToClipboard,
  spatialNodeToClipboardNode,
  type ClipboardNodeLike,
} from '../selectionClipboardHelpers';
import type { SpatialNode } from '../../../types/ifc';

const sampleNode: ClipboardNodeLike = {
  id: 42,
  global_id: '3$bgzMtnX9XADIBXBLwpDpO',
  name: 'Wall_North_01',
  ifc_type: 'IfcWall',
  storey: 'Ground Floor',
};

describe('selectionClipboardHelpers - formatExpressIdOnly', () => {
  it('returns the integer express id as a string', () => {
    expect(formatExpressIdOnly(sampleNode)).toBe('42');
  });

  it('handles id=0 (root project) without coercing to empty', () => {
    expect(formatExpressIdOnly({ id: 0 })).toBe('0');
  });
});

describe('selectionClipboardHelpers - formatGlobalId', () => {
  it('returns the GUID verbatim', () => {
    expect(formatGlobalId(sampleNode)).toBe('3$bgzMtnX9XADIBXBLwpDpO');
  });

  it('returns empty string when GlobalId missing', () => {
    expect(formatGlobalId({ id: 1 })).toBe('');
    expect(formatGlobalId({ id: 1, global_id: null })).toBe('');
    expect(formatGlobalId({ id: 1, global_id: undefined })).toBe('');
  });

  it('returns empty string when GlobalId is non-string falsy', () => {
    // Defensive - real callers should never pass numbers, but the helper
    // shouldn't blow up if someone does.
    expect(formatGlobalId({ id: 1, global_id: '' })).toBe('');
  });
});

describe('selectionClipboardHelpers - formatElementDetails', () => {
  it('includes type, name, express id, GlobalId, storey in order', () => {
    const out = formatElementDetails(sampleNode);
    expect(out).toBe(
      [
        'IFC Type: IfcWall',
        'Name: Wall_North_01',
        'Express ID: 42',
        'GlobalId: 3$bgzMtnX9XADIBXBLwpDpO',
        'Storey: Ground Floor',
      ].join('\n'),
    );
  });

  it('omits absent fields without leaving stub lines', () => {
    const out = formatElementDetails({ id: 7, ifc_type: 'IfcDoor' });
    // Should only contain IFC Type + Express ID lines - no Name, no
    // GlobalId stub.
    expect(out).toBe('IFC Type: IfcDoor\nExpress ID: 7');
    expect(out).not.toContain('Name:');
    expect(out).not.toContain('GlobalId:');
    expect(out).not.toContain('Storey:');
  });

  it('always includes Express ID even when everything else is missing', () => {
    expect(formatElementDetails({ id: 99 })).toBe('Express ID: 99');
  });
});

describe('selectionClipboardHelpers - formatElementDetailsJson', () => {
  it('emits pretty-printed JSON with all known fields', () => {
    const out = formatElementDetailsJson(sampleNode);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      express_id: 42,
      global_id: '3$bgzMtnX9XADIBXBLwpDpO',
      name: 'Wall_North_01',
      ifc_type: 'IfcWall',
      storey: 'Ground Floor',
    });
    // Pretty-printed, not minified.
    expect(out).toContain('\n');
  });

  it('omits absent fields from the JSON payload', () => {
    const out = formatElementDetailsJson({ id: 5 });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ express_id: 5 });
    expect('name' in parsed).toBe(false);
    expect('global_id' in parsed).toBe(false);
  });
});

describe('selectionClipboardHelpers - formatClipboardPayload', () => {
  it('dispatches to the right formatter per format', () => {
    expect(formatClipboardPayload('express-id', sampleNode)).toBe('42');
    expect(formatClipboardPayload('global-id', sampleNode)).toBe(
      '3$bgzMtnX9XADIBXBLwpDpO',
    );
    expect(formatClipboardPayload('details', sampleNode)).toContain(
      'IFC Type: IfcWall',
    );
    const json = JSON.parse(formatClipboardPayload('json', sampleNode));
    expect(json.express_id).toBe(42);
  });

  it('defaults unknown formats to details', () => {
    // @ts-expect-error - exercising the fallback branch.
    const out = formatClipboardPayload('bogus', sampleNode);
    expect(out).toContain('Express ID: 42');
  });
});

describe('selectionClipboardHelpers - describeClipboardCopy', () => {
  it('summarises express-id copies', () => {
    expect(describeClipboardCopy('express-id', sampleNode)).toBe(
      'Copied Express ID 42',
    );
  });

  it('summarises GlobalId copies with the GUID inline', () => {
    expect(describeClipboardCopy('global-id', sampleNode)).toBe(
      'Copied GlobalId 3$bgzMtnX9XADIBXBLwpDpO',
    );
  });

  it('signals "no GlobalId" when the node lacks one', () => {
    expect(describeClipboardCopy('global-id', { id: 12 })).toBe(
      'No GlobalId for #12',
    );
  });

  it('summarises details and JSON copies', () => {
    expect(describeClipboardCopy('details', sampleNode)).toBe(
      'Copied element details (#42)',
    );
    expect(describeClipboardCopy('json', sampleNode)).toBe(
      'Copied element JSON (#42)',
    );
  });
});

describe('selectionClipboardHelpers - writeClipboardText', () => {
  const originalNav = (globalThis as { navigator?: Navigator }).navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNav,
      configurable: true,
    });
  });

  it('returns false when the clipboard API is unavailable', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: undefined } as unknown as Navigator,
      configurable: true,
    });
    expect(await writeClipboardText('x')).toBe(false);
  });

  it('returns true on successful write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } } as unknown as Navigator,
      configurable: true,
    });
    expect(await writeClipboardText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('swallows writeText errors and returns false', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('SecurityError'));
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } } as unknown as Navigator,
      configurable: true,
    });
    expect(await writeClipboardText('x')).toBe(false);
  });
});

describe('selectionClipboardHelpers - copyNodeToClipboard', () => {
  const originalNav = (globalThis as { navigator?: Navigator }).navigator;
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } } as unknown as Navigator,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNav,
      configurable: true,
    });
  });

  it('returns null when the node is null (no selection)', async () => {
    expect(await copyNodeToClipboard('details', null)).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('writes the formatted payload and returns ok=true', async () => {
    const result = await copyNodeToClipboard('global-id', sampleNode);
    expect(result).toEqual({
      ok: true,
      summary: 'Copied GlobalId 3$bgzMtnX9XADIBXBLwpDpO',
    });
    expect(writeText).toHaveBeenCalledWith('3$bgzMtnX9XADIBXBLwpDpO');
  });

  it('skips the clipboard write when payload is empty (e.g. no GlobalId)', async () => {
    const result = await copyNodeToClipboard('global-id', { id: 1 });
    expect(result).toEqual({ ok: false, summary: 'No GlobalId for #1' });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('selectionClipboardHelpers - spatialNodeToClipboardNode', () => {
  it('returns null for null / undefined inputs', () => {
    expect(spatialNodeToClipboardNode(null)).toBeNull();
    expect(spatialNodeToClipboardNode(undefined)).toBeNull();
  });

  it('projects all five clipboard-relevant fields from a SpatialNode', () => {
    const node: SpatialNode = {
      id: 17,
      global_id: '2a7Pq...x',
      name: 'Slab_Roof',
      ifc_type: 'IfcSlab',
      storey: 'Roof',
      children: [],
    };
    const out = spatialNodeToClipboardNode(node);
    expect(out).toEqual({
      id: 17,
      global_id: '2a7Pq...x',
      name: 'Slab_Roof',
      ifc_type: 'IfcSlab',
      storey: 'Roof',
    });
  });

  it('coerces a missing storey to null (so the projection is shape-stable)', () => {
    const node: SpatialNode = {
      id: 8,
      global_id: 'g',
      name: 'X',
      ifc_type: 'IfcWall',
      children: [],
    };
    const out = spatialNodeToClipboardNode(node);
    expect(out?.storey).toBeNull();
  });

  it('produces a node that round-trips through formatElementDetails', () => {
    const node: SpatialNode = {
      id: 1,
      global_id: 'gid-1',
      name: 'Door_A',
      ifc_type: 'IfcDoor',
      storey: 'L1',
      children: [],
    };
    const cb = spatialNodeToClipboardNode(node)!;
    expect(formatElementDetails(cb)).toContain('IFC Type: IfcDoor');
    expect(formatElementDetails(cb)).toContain('GlobalId: gid-1');
    expect(formatElementDetails(cb)).toContain('Storey: L1');
  });
});
