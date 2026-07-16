import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  attachJson,
  captureDiagnostics,
  findGeometryHit,
  finishFrameProbe,
  installBrowserProbe,
  loadIfcFixture,
  readRenderState,
  readRenderStats,
  readViewerState,
  runOrbitBench,
  startFrameProbe,
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

test.describe('Phase 1 IFC renderer regression', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('keeps painted geometry and selection stable through navigation and visibility modes', async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const phaseDiagnostics: Record<string, unknown> = {};
    let finalDiagnostics: ViewerDiagnostics | null = null;

    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await installBrowserProbe(page);

    try {
      const canvas = await loadIfcFixture(page, BASIC_HOUSE, LOAD_TIMEOUT_MS);
      const loaded = await captureDiagnostics(page);
      phaseDiagnostics.loaded = loaded;

      expect(loaded.ready.events.length).toBeGreaterThan(0);
      expect(loaded.ready.uploadToReadyMs).not.toBeNull();
      expect(loaded.model.elementCount).toBeGreaterThan(0);
      expect(loaded.renderStats?.drawCalls).toBeGreaterThan(0);
      expect(loaded.renderStats?.triangles).toBeGreaterThan(0);
      expect(loaded.hardware.webgl.contextLost).toBe(false);
      expect(loaded.renderState?.lastError).toBeNull();
      testInfo.annotations.push({
        type: 'renderer',
        description: loaded.hardware.webgl.unmaskedRenderer
          ?? loaded.hardware.webgl.renderer
          ?? 'unknown WebGL renderer',
      });
      testInfo.annotations.push({
        type: 'model',
        description: `${loaded.model.name ?? 'BasicHouse'}: ${loaded.model.elementCount ?? 0} elements`,
      });

      const orbit = await runOrbitBench(page, 2, 180);
      phaseDiagnostics.orbit = orbit;
      expect(orbit.frames).toBeGreaterThan(5);
      expect(orbit.durationMs).toBeGreaterThan(1_000);
      expect(orbit.p95Ms).toBeGreaterThanOrEqual(orbit.p50Ms);
      expect(orbit.worstMs).toBeGreaterThanOrEqual(orbit.p95Ms);
      expect(orbit.drawCalls).toBeGreaterThan(0);
      expect(orbit.triangles).toBeGreaterThan(0);
      await waitForRenderStateIdle(page);

      const hit = await findGeometryHit(page, canvas);
      phaseDiagnostics.geometryHit = hit;
      // A fresh selection always paints a highlight layer, so the coordinator
      // generation captured before the click is a safe idle baseline.
      const clickBaseline = (await readRenderState(page)).generation;
      const clickStartedAt = Date.now();
      await page.mouse.click(hit.x, hit.y);
      await expect.poll(async () => (await readViewerState(page)).selectedElementId)
        .toBe(hit.expressId);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: clickBaseline });
      await expect.poll(async () => (await readViewerState(page)).perfMetrics.clickToHighlightMs)
        .not.toBeNull();
      const afterClick = await readViewerState(page);
      const selectedRenderState = await readRenderState(page);
      phaseDiagnostics.selection = {
        expressId: hit.expressId,
        observedRoundTripMs: Date.now() - clickStartedAt,
        appClickToHighlightMs: afterClick.perfMetrics.clickToHighlightMs,
        appClickToHighlightP95Ms: afterClick.perfMetrics.clickToHighlightP95Ms,
        renderState: selectedRenderState,
      };
      expect(afterClick.perfMetrics.clickToHighlightMs).toBeGreaterThanOrEqual(0);
      expect(selectedRenderState.highlightLayers['appearance:selection']?.count).toBeGreaterThan(0);
      expect(selectedRenderState.lastError).toBeNull();

      const selectedId = afterClick.selectedElementId;
      if (selectedId == null) throw new Error('Canvas click completed without a selected Express ID');
      const selectionOrbit = await runOrbitBench(page, 1, 70);
      phaseDiagnostics.selectionOrbit = selectionOrbit;
      expect((await readViewerState(page)).selectedElementId).toBe(selectedId);
      expect((await readRenderState(page)).highlightLayers['appearance:selection']?.count)
        .toBeGreaterThan(0);

      // The probe runs across the WHOLE hide/show-all/isolate/ghost/restore
      // sequence and is stopped explicitly by finishFrameProbe() after the
      // final restore settles; 60 s is only a leak-prevention safety cap.
      await startFrameProbe(page, 60_000);

      const hideBaseline = (await readRenderState(page)).generation;
      await page.keyboard.press('h');
      await expect.poll(async () => (await readViewerState(page)).hiddenIds)
        .toContain(selectedId);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: hideBaseline });
      const hiddenState = await readRenderState(page);
      expect(hiddenState.visibilityLayers['visibility:user']).toBeGreaterThan(0);
      expect(hiddenState.effectiveHiddenCount).toBeGreaterThan(0);
      expect((await readViewerState(page)).selectedElementId).toBe(selectedId);
      phaseDiagnostics.hidden = hiddenState;

      const showAllBaseline = (await readRenderState(page)).generation;
      await page.keyboard.press('a');
      await expect.poll(async () => {
        const state = await readViewerState(page);
        return state.hiddenIds.length + state.isolatedIds.length;
      }).toBe(0);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: showAllBaseline });
      expect((await readRenderState(page)).effectiveHiddenCount).toBe(0);

      const isolateBaseline = (await readRenderState(page)).generation;
      await page.keyboard.press('i');
      await expect.poll(async () => (await readViewerState(page)).isolatedIds)
        .toContain(selectedId);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: isolateBaseline });
      const isolatedState = await readRenderState(page);
      expect(isolatedState.visibilityLayers['visibility:user']).toBeGreaterThan(0);
      expect(isolatedState.effectiveHiddenCount).toBeGreaterThan(0);
      expect((await readRenderStats(page)).triangles).toBeGreaterThan(0);
      phaseDiagnostics.isolated = isolatedState;

      const ghostBaseline = (await readRenderState(page)).generation;
      await page.keyboard.press('Shift+g');
      await expect.poll(async () => (await readViewerState(page)).ghostModeOn).toBe(true);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: ghostBaseline });
      const ghostState = await readRenderState(page);
      expect(ghostState.opacityLayers['opacity:isolation-ghost']?.count).toBeGreaterThan(0);
      expect(ghostState.highlightLayers['appearance:selection']?.count).toBeGreaterThan(0);
      expect((await readViewerState(page)).selectedElementId).toBe(selectedId);
      expect((await readRenderStats(page)).triangles).toBeGreaterThan(0);
      phaseDiagnostics.ghost = ghostState;

      const ghostOrbit = await runOrbitBench(page, 1, 70);
      phaseDiagnostics.ghostOrbit = ghostOrbit;
      expect(ghostOrbit.triangles).toBeGreaterThan(0);
      expect((await readViewerState(page)).selectedElementId).toBe(selectedId);

      const restoreBaseline = (await readRenderState(page)).generation;
      await page.keyboard.press('a');
      await expect.poll(async () => {
        const state = await readViewerState(page);
        return {
          hidden: state.hiddenIds.length,
          isolated: state.isolatedIds.length,
          ghost: state.ghostModeOn,
        };
      }).toEqual({ hidden: 0, isolated: 0, ghost: false });
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: restoreBaseline });
      const restoredState = await readRenderState(page);
      expect(restoredState.effectiveHiddenCount).toBe(0);
      expect(restoredState.opacityLayers['opacity:isolation-ghost']).toBeUndefined();
      expect(restoredState.highlightLayers['appearance:selection']?.count).toBeGreaterThan(0);
      expect((await readViewerState(page)).selectedElementId).toBe(selectedId);
      expect((await readRenderStats(page)).triangles).toBeGreaterThan(0);
      phaseDiagnostics.restored = restoredState;

      const transitionFrames = await finishFrameProbe(page);
      phaseDiagnostics.transitionFrames = transitionFrames;
      expect(transitionFrames.frames).toBeGreaterThan(5);
      expect(transitionFrames.contextLostFrames).toBe(0);
      expect(transitionFrames.zeroGeometryFrames).toBe(0);
      expect(transitionFrames.minDrawCalls).toBeGreaterThan(0);
      expect(transitionFrames.minTriangles).toBeGreaterThan(0);

      finalDiagnostics = await captureDiagnostics(page);
      expect(finalDiagnostics.browserErrors.webglContextLosses).toBe(0);
      expect(finalDiagnostics.browserErrors.unhandledRejections).toEqual([]);
      expect(finalDiagnostics.renderState?.lastError).toBeNull();
      expect(pageErrors).toEqual([]);
    } finally {
      if (!finalDiagnostics) {
        finalDiagnostics = await captureDiagnostics(page).catch(() => null);
      }
      await attachJson(testInfo, 'renderer-phase1-diagnostics', {
        fixture: BASIC_HOUSE,
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        phases: phaseDiagnostics,
        final: finalDiagnostics,
        errors: {
          page: pageErrors,
          console: consoleErrors,
        },
      });
    }
  });
});
