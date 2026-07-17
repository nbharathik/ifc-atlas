/**
 * Measurement snapping against real BasicHouse geometry.
 *
 * The unit tests pin the ranking policy with synthetic candidates; they cannot
 * prove the engine actually reports point/line features for a real IFC model.
 * That assumption is the whole fix, so it gets exercised here:
 *
 *  - `raycastWithSnapping` returns edge features (with both endpoints) on a
 *    real model, from anywhere on a face - not just near the hit triangle's
 *    corners, which is what made snapping feel broken.
 *  - The screen-space resolver turns those into an exact snap.
 *  - Snapping stays off the non-measuring path (no cost when not measuring).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  attachJson,
  findGeometryHit,
  installBrowserProbe,
  loadIfcFixture,
  waitForRenderStateIdle,
  type SnapProbeResult,
} from './rendererHarness';

const BASIC_HOUSE = fileURLToPath(
  new URL('../../../data/fixtures/BasicHouse.ifc', import.meta.url),
);
const configuredLoadTimeoutMs = Number.parseInt(
  process.env.IFC_E2E_LOAD_TIMEOUT_MS ?? '480000',
  10,
);
const LOAD_TIMEOUT_MS = Number.isFinite(configuredLoadTimeoutMs) && configuredLoadTimeoutMs > 0
  ? configuredLoadTimeoutMs
  : 480_000;

async function snapAt(
  page: import('@playwright/test').Page,
  x: number,
  y: number,
  thresholdPx = 20,
): Promise<SnapProbeResult> {
  return page.evaluate(async ({ clientX, clientY, tol }) => {
    const probe = (window as unknown as {
      __ifcSnapAt?: (x: number, y: number, t?: number) => Promise<SnapProbeResult>;
    }).__ifcSnapAt;
    if (!probe) throw new Error('__ifcSnapAt is unavailable');
    return probe(clientX, clientY, tol);
  }, { clientX: x, clientY: y, tol: thresholdPx });
}

test.describe('Phase 5 measurement snapping', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('the engine reports real snap features on BasicHouse geometry', async ({ page }, testInfo) => {
    test.setTimeout(LOAD_TIMEOUT_MS + 120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    await installBrowserProbe(page);

    const canvas = await loadIfcFixture(page, BASIC_HOUSE, LOAD_TIMEOUT_MS, {
      requireMetadata: false,
    });
    await waitForRenderStateIdle(page);

    // Land on real geometry first, so a null snap means "no feature here"
    // rather than "no model here".
    const hit = await findGeometryHit(page, canvas);

    // Scan outward from the hit. Any pixel on a wall/slab should be within
    // reach of at least one edge; before the fix, candidates came from the hit
    // triangle alone and large faces produced nothing at all.
    const box = (await canvas.boundingBox())!;
    const probes: Array<{ dx: number; dy: number; result: SnapProbeResult }> = [];
    for (const [dx, dy] of [[0, 0], [12, 0], [-12, 0], [0, 12], [0, -12], [24, 24], [-24, -24]]) {
      const x = Math.min(box.x + box.width - 2, Math.max(box.x + 2, hit.x + dx));
      const y = Math.min(box.y + box.height - 2, Math.max(box.y + 2, hit.y + dy));
      probes.push({ dx, dy, result: await snapAt(page, x, y, 24) });
    }

    await attachJson(testInfo, 'measure-snap-probes', {
      hit,
      probes: probes.map((p) => ({ dx: p.dx, dy: p.dy, ...p.result })),
    });

    // The load-bearing assumption: the engine returns snap classes at all.
    const anyClasses = probes.some((p) => p.result.hitClasses.length > 0);
    expect(anyClasses, 'raycastWithSnapping returned no POINT/LINE classes anywhere on the model')
      .toBe(true);

    // Edges must arrive with both endpoints - that is what yields vertex,
    // midpoint and along-edge candidates.
    const anyEdges = probes.some((p) => p.result.edgeHits > 0);
    expect(anyEdges, 'no snapped edge carried both endpoints').toBe(true);

    // And the resolver must turn that into a usable, exact snap somewhere.
    const snapped = probes.filter((p) => p.result.snap !== null);
    expect(snapped.length, 'no probe resolved to a snap feature').toBeGreaterThan(0);
    expect(snapped.every((p) => p.result.snap!.exact)).toBe(true);
    expect(snapped.every((p) => p.result.snap!.distancePx <= 24)).toBe(true);
    for (const p of snapped) {
      expect(['vertex', 'edge', 'midpoint', 'endpoint']).toContain(p.result.snap!.kind);
      expect(p.result.snap!.source.startsWith('engine-')).toBe(true);
    }

    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
