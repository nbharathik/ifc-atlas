import { describe, it, expect, vi } from 'vitest';
import { clientPointToNdc, queryFastPicker, shouldRaycast } from '../fastPickerGuard';

function makePicker(result: string | null | 'throw') {
  return {
    getModelAt: vi.fn().mockImplementation(() =>
      result === 'throw'
        ? Promise.reject(new Error('WebGL context lost'))
        : Promise.resolve(result),
    ),
  };
}

describe('queryFastPicker', () => {
  it('returns model ID on hit', async () => {
    const picker = makePicker('model-abc');
    expect(await queryFastPicker(picker, { x: 0, y: 0 })).toBe('model-abc');
  });

  it('returns null on clear miss', async () => {
    const picker = makePicker(null);
    expect(await queryFastPicker(picker, { x: 0, y: 0 })).toBeNull();
  });

  it('returns non-null sentinel when picker throws', async () => {
    const picker = makePicker('throw');
    const result = await queryFastPicker(picker, { x: 50, y: 50 });
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('passes position through to getModelAt', async () => {
    const picker = makePicker('some-model');
    const pos = { x: 0.25, y: -0.5 };
    await queryFastPicker(picker, pos);
    const [actual] = picker.getModelAt.mock.calls[0];
    expect(actual.x).toBe(pos.x);
    expect(actual.y).toBe(pos.y);
  });

  it('calls getModelAt exactly once', async () => {
    const picker = makePicker('model-id');
    await queryFastPicker(picker, { x: 10, y: 20 });
    expect(picker.getModelAt).toHaveBeenCalledTimes(1);
  });
});

describe('clientPointToNdc', () => {
  const canvas = {
    getBoundingClientRect: () => ({
      left: 100,
      top: 50,
      width: 400,
      height: 200,
    }),
  };

  it('maps canvas center to NDC origin', () => {
    const point = clientPointToNdc({ x: 300, y: 150 }, canvas);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(0);
  });

  it('maps canvas corners to NDC corners', () => {
    expect(clientPointToNdc({ x: 100, y: 50 }, canvas)).toEqual({ x: -1, y: 1 });
    expect(clientPointToNdc({ x: 500, y: 250 }, canvas)).toEqual({ x: 1, y: -1 });
  });

  it('returns origin for zero-size canvas bounds', () => {
    const zero = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    expect(clientPointToNdc({ x: 10, y: 20 }, zero)).toEqual({ x: 0, y: 0 });
  });
});

describe('shouldRaycast', () => {
  it('returns true for a model UUID (hit)', () => {
    expect(shouldRaycast('model-abc')).toBe(true);
  });

  it('returns false for null (miss)', () => {
    expect(shouldRaycast(null)).toBe(false);
  });

  it('returns true for error sentinel (fall through to raycast)', () => {
    expect(shouldRaycast('__picker_error__')).toBe(true);
  });
});

describe('queryFastPicker + shouldRaycast integration', () => {
  it('miss: shouldRaycast returns false → skip raycast', async () => {
    const picker = makePicker(null);
    const result = await queryFastPicker(picker, { x: 0, y: 0 });
    expect(shouldRaycast(result)).toBe(false);
  });

  it('hit: shouldRaycast returns true → proceed to raycast', async () => {
    const picker = makePicker('model-uuid');
    const result = await queryFastPicker(picker, { x: 0, y: 0 });
    expect(shouldRaycast(result)).toBe(true);
  });

  it('error: shouldRaycast returns true → preserve raycast behavior', async () => {
    const picker = makePicker('throw');
    const result = await queryFastPicker(picker, { x: 0, y: 0 });
    expect(shouldRaycast(result)).toBe(true);
  });
});
