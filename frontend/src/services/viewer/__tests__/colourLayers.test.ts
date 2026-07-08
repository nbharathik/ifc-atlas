/**
 * Vitest coverage for the generic colour-layer helpers:
 * heatRamp (pure ramp math), buildHeatmapLayer (bucketing + legend),
 * and flattenColourLayers (the paint/snapshot merge rule).
 */

import { describe, expect, it } from 'vitest';
import {
  heatRamp,
  buildHeatmapLayer,
  flattenColourLayers,
} from '../colourLayers';
import type { ColourLayer } from '../../../store/useStore';

const HEX_RE = /^#[0-9a-f]{6}$/;

describe('heatRamp', () => {
  it('returns lowercase #rrggbb strings across the ramp', () => {
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(heatRamp(t)).toMatch(HEX_RE);
    }
  });

  it('anchors: blue at 0, red at 1', () => {
    expect(heatRamp(0)).toBe('#2563eb');
    expect(heatRamp(1)).toBe('#ef4444');
  });

  it('hits the interior anchors at the piecewise joints', () => {
    expect(heatRamp(1 / 3)).toBe('#22d3ee'); // cyan
    expect(heatRamp(2 / 3)).toBe('#facc15'); // yellow
  });

  it('clamps out-of-range input to the ends', () => {
    expect(heatRamp(-3)).toBe(heatRamp(0));
    expect(heatRamp(42)).toBe(heatRamp(1));
  });

  it('maps non-finite input to the cold end', () => {
    expect(heatRamp(Number.NaN)).toBe(heatRamp(0));
    expect(heatRamp(Number.POSITIVE_INFINITY)).toBe(heatRamp(1));
    expect(heatRamp(Number.NEGATIVE_INFINITY)).toBe(heatRamp(0));
  });

  it('interpolates between anchors (midpoint of blue->cyan)', () => {
    // t=1/6 is halfway between anchor 0 (#2563eb) and anchor 1 (#22d3ee).
    expect(heatRamp(1 / 6)).toBe('#249bed');
  });
});

describe('buildHeatmapLayer', () => {
  it('buckets values over the min..max range with a full-scale legend', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 4 },
        { id: 3, value: 10 },
      ],
      { buckets: 5 },
    );
    // Full scale: legend row per bucket even for empty buckets.
    expect(layer.legend).toHaveLength(5);
    // Entries only for non-empty buckets: 0 -> bucket 0, 4 -> bucket 2, 10 -> bucket 4.
    expect(layer.entries).toHaveLength(3);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0), ids: [1] });
    expect(layer.entries[1]).toEqual({ color: heatRamp(0.5), ids: [2] });
    expect(layer.entries[2]).toEqual({ color: heatRamp(1), ids: [3] });
  });

  it('puts the max value in the LAST bucket, not an overflow bucket', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 10 },
      ],
      { buckets: 2 },
    );
    expect(layer.entries).toHaveLength(2);
    expect(layer.entries[1].ids).toEqual([2]);
  });

  it('clamps values outside an explicit min/max into the edge buckets', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: -100 },
        { id: 2, value: 900 },
      ],
      { min: 0, max: 10, buckets: 4 },
    );
    expect(layer.entries).toHaveLength(2);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0), ids: [1] });
    expect(layer.entries[1]).toEqual({ color: heatRamp(1), ids: [2] });
  });

  it('min === max degenerates to one mid-ramp bucket', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 7 },
        { id: 2, value: 7 },
      ],
      { buckets: 5 },
    );
    expect(layer.entries).toHaveLength(1);
    expect(layer.entries[0]).toEqual({ color: heatRamp(0.5), ids: [1, 2] });
    expect(layer.legend).toEqual([{ color: heatRamp(0.5), label: '7' }]);
  });

  it('default legend labels are "lo - hi" with 3 significant digits', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 1 },
      ],
      { buckets: 3 },
    );
    expect(layer.legend?.map((r) => r.label)).toEqual([
      '0 - 0.333',
      '0.333 - 0.667',
      '0.667 - 1',
    ]);
  });

  it('uses a custom label function when provided', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 0 },
        { id: 2, value: 2 },
      ],
      { buckets: 2, label: (lo, hi) => `${lo.toFixed(0)} to ${hi.toFixed(0)} kg` },
    );
    expect(layer.legend?.map((r) => r.label)).toEqual(['0 to 1 kg', '1 to 2 kg']);
  });

  it('passes the name through and ignores non-finite values', () => {
    const layer = buildHeatmapLayer(
      [
        { id: 1, value: 1 },
        { id: 2, value: Number.NaN },
        { id: 3, value: Number.POSITIVE_INFINITY },
        { id: 4, value: 3 },
      ],
      { buckets: 2, name: 'Elements per storey' },
    );
    expect(layer.name).toBe('Elements per storey');
    expect(layer.entries.flatMap((e) => e.ids).sort()).toEqual([1, 4]);
  });

  it('returns an empty layer for empty (or all-non-finite) input', () => {
    expect(buildHeatmapLayer([])).toEqual({ entries: [], legend: [], name: undefined });
    expect(buildHeatmapLayer([{ id: 1, value: Number.NaN }]).entries).toEqual([]);
  });

  it('swaps an inverted explicit min/max instead of producing NaN buckets', () => {
    const layer = buildHeatmapLayer(
      [{ id: 1, value: 5 }],
      { min: 10, max: 0, buckets: 2 },
    );
    expect(layer.entries).toHaveLength(1);
    expect(layer.entries[0].ids).toEqual([1]);
  });
});

describe('flattenColourLayers', () => {
  const layer = (entries: ColourLayer['entries']): ColourLayer => ({ entries });

  it('passes a single layer through as colour groups', () => {
    const out = flattenColourLayers({
      a: layer([{ color: '#ff0000', ids: [1, 2] }, { color: '#00ff00', ids: [3] }]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1, 2] },
      { color: '#00ff00', ids: [3] },
    ]);
  });

  it('later layers win for overlapping ids', () => {
    const out = flattenColourLayers({
      first: layer([{ color: '#ff0000', ids: [1, 2, 3] }]),
      second: layer([{ color: '#0000ff', ids: [2] }]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1, 3] },
      { color: '#0000ff', ids: [2] },
    ]);
  });

  it('later entries win inside one layer', () => {
    const out = flattenColourLayers({
      a: layer([
        { color: '#ff0000', ids: [1, 2] },
        { color: '#0000ff', ids: [2] },
      ]),
    });
    expect(out).toEqual([
      { color: '#ff0000', ids: [1] },
      { color: '#0000ff', ids: [2] },
    ]);
  });

  it('merges same-colour entries into one paint group', () => {
    const out = flattenColourLayers({
      a: layer([{ color: '#ff0000', ids: [1] }]),
      b: layer([{ color: '#ff0000', ids: [2] }]),
    });
    expect(out).toEqual([{ color: '#ff0000', ids: [1, 2] }]);
  });

  it('returns [] for no layers', () => {
    expect(flattenColourLayers({})).toEqual([]);
  });
});
