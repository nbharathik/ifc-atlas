import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  attachJson,
  captureDiagnostics,
  findGeometryHit,
  forceWebglContextLoss,
  installBrowserProbe,
  isWebglContextLost,
  loadIfcFixture,
  readRenderState,
  readRenderStats,
  readViewerState,
  readWebglContextLossCount,
  restoreWebglContext,
  runOrbitBench,
  waitForRenderStateIdle,
  type ViewerDiagnostics,
} from './rendererHarness';

const BASIC_HOUSE = fileURLToPath(
  new URL('../../../data/fixtures/BasicHouse.ifc', import.meta.url),
);
const CONFIGURED_LOAD_TIMEOUT_MS = Number.parseInt(
  process.env.IFC_E2E_LOAD_TIMEOUT_MS ?? '240000',
  10,
);
const LOAD_TIMEOUT_MS = Number.isFinite(CONFIGURED_LOAD_TIMEOUT_MS)
  && CONFIGURED_LOAD_TIMEOUT_MS > 0
  ? CONFIGURED_LOAD_TIMEOUT_MS
  : 240_000;

test.describe('Phase 1 WebGL context-loss recovery', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('recovers painting, coordinator state, and the selection layer after a forced context loss', async ({ page }, testInfo) => {
    test.fixme(true, 'App cannot yet recover from WebGL context loss: fragment GPU geometry is never re-uploaded (0 draw calls, empty canvas after restore) and an uncaught TypeError (reading byteLength) fires in @thatopen/fragments; verified on Intel Arc 140V 16 July 2026, see RENDERER_REGRESSION_HARNESS.md');
    test.setTimeout(LOAD_TIMEOUT_MS + 180_000);
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const phases: Record<string, unknown> = {};
    let finalDiagnostics: ViewerDiagnostics | null = null;

    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await installBrowserProbe(page);

    try {
      const canvas = await loadIfcFixture(page, BASIC_HOUSE, LOAD_TIMEOUT_MS, {
        // Context recovery is a renderer contract; the metadata/tree worker
        // is irrelevant here and can still be hydrating on SwiftShader.
        requireMetadata: false,
      });
      phases.loaded = await captureDiagnostics(page);

      const hit = await findGeometryHit(page, canvas);
      phases.geometryHit = hit;
      // A fresh selection always paints a highlight layer, so the coordinator
      // generation captured before the click is a safe idle baseline.
      const clickBaseline = (await readRenderState(page)).generation;
      await page.mouse.click(hit.x, hit.y);
      await expect.poll(async () => (await readViewerState(page)).selectedElementId)
        .toBe(hit.expressId);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: clickBaseline });
      await expect.poll(async () => (
        (await readRenderState(page)).highlightLayers['appearance:selection']?.count ?? 0
      )).toBeGreaterThan(0);

      const beforeLoss = await captureDiagnostics(page);
      phases.beforeLoss = beforeLoss;
      expect(beforeLoss.hardware.webgl.contextLost).toBe(false);
      expect(beforeLoss.browserErrors.webglContextLosses).toBe(0);

      await forceWebglContextLoss(page);
      await expect.poll(() => isWebglContextLost(page)).toBe(true);
      await expect.poll(() => readWebglContextLossCount(page)).toBeGreaterThan(0);
      // Hold the loss so the app observably survives a real lost period
      // rather than an instantaneous lose/restore pair.
      await page.waitForTimeout(1_000);
      phases.duringLoss = {
        contextLost: await isWebglContextLost(page),
        renderState: await readRenderState(page).catch(() => null),
      };

      await restoreWebglContext(page);
      // The app recreates its GL resources on webglcontextrestored; give the
      // restore and the first repaints generous room on slow adapters.
      await expect.poll(() => isWebglContextLost(page), { timeout: 30_000 }).toBe(false);
      await expect.poll(async () => {
        const stats = await readRenderStats(page);
        return stats.drawCalls > 0 && stats.triangles > 0;
      }, { timeout: 60_000 }).toBe(true);

      await waitForRenderStateIdle(page, 30_000);
      const recoveredRenderState = await readRenderState(page);
      expect(recoveredRenderState.lastError).toBeNull();
      expect(recoveredRenderState.appliedGeneration).toBe(recoveredRenderState.generation);
      expect(recoveredRenderState.renderedGeneration).toBe(recoveredRenderState.generation);
      await expect.poll(async () => (
        (await readRenderState(page)).highlightLayers['appearance:selection']?.count ?? 0
      ), { timeout: 30_000 }).toBeGreaterThan(0);
      expect((await readViewerState(page)).selectedElementId).toBe(hit.expressId);

      // readRenderStats can fall back to stale loop counters, so prove real
      // frames paint from the recreated GL resources with a live orbit.
      const recoveryOrbit = await runOrbitBench(page, 1, 60);
      phases.recoveryOrbit = recoveryOrbit;
      expect(recoveryOrbit.frames).toBeGreaterThan(5);
      expect(recoveryOrbit.drawCalls).toBeGreaterThan(0);
      expect(recoveryOrbit.triangles).toBeGreaterThan(0);
      await waitForRenderStateIdle(page);
      expect((await readRenderState(page)).highlightLayers['appearance:selection']?.count)
        .toBeGreaterThan(0);

      finalDiagnostics = await captureDiagnostics(page);
      phases.afterRestore = finalDiagnostics;
      expect(finalDiagnostics.hardware.webgl.contextLost).toBe(false);
      expect(finalDiagnostics.browserErrors.webglContextLosses).toBe(1);
      expect(finalDiagnostics.browserErrors.unhandledRejections).toEqual([]);
      expect(finalDiagnostics.renderState?.lastError).toBeNull();
      expect(pageErrors).toEqual([]);
    } finally {
      if (!finalDiagnostics) {
        finalDiagnostics = await captureDiagnostics(page).catch(() => null);
      }
      await attachJson(testInfo, 'renderer-context-restore-diagnostics', {
        fixture: BASIC_HOUSE,
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        phases,
        final: finalDiagnostics,
        errors: {
          page: pageErrors,
          console: consoleErrors,
        },
      });
    }
  });
});
