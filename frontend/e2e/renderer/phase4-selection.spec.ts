import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  attachJson,
  captureDiagnostics,
  findGeometryHit,
  installBrowserProbe,
  loadIfcFixture,
  readRenderState,
  readViewerState,
  waitForRenderStateIdle,
  type ViewerDiagnostics,
} from './rendererHarness';

const BASIC_HOUSE = fileURLToPath(
  new URL('../../../data/fixtures/BasicHouse.ifc', import.meta.url),
);
const configuredLoadTimeoutMs = Number.parseInt(
  process.env.IFC_E2E_LOAD_TIMEOUT_MS ?? '480000',
  10,
);
const LOAD_TIMEOUT_MS = Number.isFinite(configuredLoadTimeoutMs)
  && configuredLoadTimeoutMs > 0
  ? configuredLoadTimeoutMs
  : 480_000;

test.describe('Phase 4 click-selection regression', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('paints a real BasicHouse mouse click without an orbit prerequisite', async ({ page }, testInfo) => {
    test.setTimeout(LOAD_TIMEOUT_MS + 90_000);
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
        // Selection is a renderer contract. Do not gate it behind the separate
        // metadata/tree worker, which can still be hydrating on SwiftShader.
        requireMetadata: false,
      });
      phases.loaded = await captureDiagnostics(page);

      const hit = await findGeometryHit(page, canvas);
      phases.geometryHit = hit;

      // A fresh selection always paints a highlight layer, so the coordinator
      // generation captured before the click is a safe idle baseline.
      const clickBaseline = (await readRenderState(page)).generation;
      const clickStartedAt = Date.now();
      await page.mouse.click(hit.x, hit.y);
      await expect.poll(async () => (await readViewerState(page)).selectedElementId)
        .toBe(hit.expressId);
      await waitForRenderStateIdle(page, undefined, { baselineGeneration: clickBaseline });
      await expect.poll(async () => (
        (await readRenderState(page)).highlightLayers['appearance:selection']?.count ?? 0
      )).toBeGreaterThan(0);

      const viewerState = await readViewerState(page);
      const renderState = await readRenderState(page);
      phases.selection = {
        expectedExpressId: hit.expressId,
        selectedElementId: viewerState.selectedElementId,
        observedRoundTripMs: Date.now() - clickStartedAt,
        appClickToHighlightMs: viewerState.perfMetrics.clickToHighlightMs,
        renderState,
      };

      expect(renderState.lastError).toBeNull();
      expect(pageErrors).toEqual([]);

      // The plan's click gate is judged on percentiles, not one cold sample.
      // Click additional distinct elements and record the app-measured
      // latency window; correctness (selection painted) is asserted per
      // click, the percentiles are diagnostics for hardware-qualified runs.
      const box = await canvas.boundingBox();
      if (box) {
        const extraRatios: Array<[number, number]> = [
          [0.42, 0.50], [0.58, 0.50], [0.50, 0.42], [0.50, 0.58],
          [0.35, 0.45], [0.65, 0.45], [0.35, 0.60], [0.65, 0.60],
        ];
        const clickSamples: Array<{ expressId: number; latencyMs: number | null }> = [];
        const clickedIds = new Set<number>([hit.expressId]);
        for (const [rx, ry] of extraRatios) {
          if (clickSamples.length >= 3) break;
          const x = box.x + box.width * rx;
          const y = box.y + box.height * ry;
          const probe = await page.evaluate(async ({ clientX, clientY }) => {
            const pickAt = (window as unknown as {
              __ifcPickAt?: (px: number, py: number) => Promise<{ expressId: number } | null>;
            }).__ifcPickAt;
            if (!pickAt) return null;
            return pickAt(clientX, clientY);
          }, { clientX: x, clientY: y });
          if (!probe || clickedIds.has(probe.expressId)) continue;
          clickedIds.add(probe.expressId);
          // Each loop click selects a distinct, not-yet-selected element, so
          // the selection repaint is guaranteed to advance the generation.
          const sampleBaseline = (await readRenderState(page)).generation;
          await page.mouse.click(x, y);
          await expect.poll(async () => (await readViewerState(page)).selectedElementId)
            .toBe(probe.expressId);
          await waitForRenderStateIdle(page, undefined, { baselineGeneration: sampleBaseline });
          const sampleState = await readViewerState(page);
          clickSamples.push({
            expressId: probe.expressId,
            latencyMs: sampleState.perfMetrics.clickToHighlightMs,
          });
        }
        const finalPerf = (await readViewerState(page)).perfMetrics;
        phases.clickLatencyWindow = {
          samples: clickSamples,
          medianMs: finalPerf.clickToHighlightMedianMs,
          p95Ms: finalPerf.clickToHighlightP95Ms,
          maxMs: finalPerf.clickToHighlightMaxMs,
        };
      }
      finalDiagnostics = await captureDiagnostics(page);
    } catch (error) {
      phases.failure = {
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
        viewerState: await readViewerState(page).catch(() => null),
        renderState: await readRenderState(page).catch(() => null),
        diagnostics: await captureDiagnostics(page).catch(() => null),
      };
      await testInfo.attach('phase4-selection-failure.png', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      }).catch(() => {});
      throw error;
    } finally {
      if (!finalDiagnostics) {
        finalDiagnostics = await captureDiagnostics(page).catch(() => null);
      }
      await attachJson(testInfo, 'renderer-phase4-selection-diagnostics', {
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
