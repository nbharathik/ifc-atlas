/**
 * Bottom-right applied-filters control.
 *
 * Drives the real viewer: applies several overrides through the UI/store, then
 * checks the control surfaces them and that "Reset all" actually returns the
 * model to its as-loaded state. The unit tests pin the description policy; this
 * proves the control is mounted, reachable, and wired to the real clear actions.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  installBrowserProbe,
  loadIfcFixture,
  waitForRenderStateIdle,
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

interface FilterStoreState {
  isolatedIds: number[];
  hiddenIds: number[];
  highlightedIds: number[];
  colourBy: string;
  clipPlanes: Array<{ enabled: boolean }>;
  sectionBoxEnabled: boolean;
  measurement: { mode: string };
}

type FilterStoreWindow = Window & {
  __ifcStore?: {
    getState: () => FilterStoreState & {
      setIsolatedIds: (ids: number[]) => void;
      setHighlightedIds: (ids: number[]) => void;
      setColourBy: (p: string) => void;
      addClipPlane: () => void;
      setMeasurementMode: (m: string) => void;
      setSectionBoxEnabled: (v: boolean) => void;
    };
  };
};

async function readFilterState(page: Page): Promise<FilterStoreState> {
  return page.evaluate(() => {
    const s = (window as FilterStoreWindow).__ifcStore?.getState();
    if (!s) throw new Error('__ifcStore is unavailable');
    return {
      isolatedIds: s.isolatedIds,
      hiddenIds: s.hiddenIds,
      highlightedIds: s.highlightedIds,
      colourBy: s.colourBy,
      clipPlanes: s.clipPlanes.map((p) => ({ enabled: p.enabled })),
      sectionBoxEnabled: s.sectionBoxEnabled,
      measurement: { mode: s.measurement.mode },
    };
  });
}

test.describe('Phase 6 applied-filters reset', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('lists every applied override and resets the model to its loaded state', async ({ page }) => {
    test.setTimeout(LOAD_TIMEOUT_MS + 120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    await installBrowserProbe(page);

    await loadIfcFixture(page, BASIC_HOUSE, LOAD_TIMEOUT_MS, { requireMetadata: false });
    await waitForRenderStateIdle(page);

    // Anchored: the popover's own "Close applied filters" button would
    // otherwise match too once it is open.
    const pill = page.getByRole('button', { name: /^\d+ applied filters?$/i });

    // Nothing applied: the control is a status indicator, so it stays hidden.
    await expect(pill).toHaveCount(0);

    // Apply several kinds of override, including the section box - enabling it
    // makes ViewerPanel fit a 'model-bounds' workspace, which is the state that
    // could resurrect itself if Reset all cleared the two halves separately.
    await page.evaluate(() => {
      const s = (window as FilterStoreWindow).__ifcStore!.getState();
      s.setIsolatedIds([84]);
      s.setHighlightedIds([84]);
      s.setColourBy('type');
      s.addClipPlane();
      s.setMeasurementMode('linear');
      s.setSectionBoxEnabled(true);
    });
    await expect.poll(async () => (await readFilterState(page)).sectionBoxEnabled).toBe(true);

    await expect(pill).toBeVisible();
    // visibility + highlights + colour-by + clip planes + section box + measure.
    await expect(pill).toHaveText(/6/);

    await pill.click();
    const popover = page.getByRole('dialog', { name: 'Applied filters' });
    await expect(popover).toBeVisible();
    for (const label of [
      'Isolated elements', 'Highlights', 'Colour by', 'Section planes', 'Section box', 'Measure tool',
    ]) {
      await expect(popover.getByText(label, { exact: true })).toBeVisible();
    }

    // Remove one row individually: the count drops, the rest survive.
    await popover.getByRole('button', { name: 'Remove highlights' }).click();
    await expect.poll(async () => (await readFilterState(page)).highlightedIds.length).toBe(0);
    await expect(pill).toHaveText(/5/);
    expect((await readFilterState(page)).colourBy).toBe('type');

    // Reset all: back to the as-loaded model.
    await page.getByRole('button', { name: /Reset all/i }).click();
    await expect.poll(async () => {
      const s = await readFilterState(page);
      return {
        isolated: s.isolatedIds.length,
        hidden: s.hiddenIds.length,
        highlighted: s.highlightedIds.length,
        colourBy: s.colourBy,
        enabledPlanes: s.clipPlanes.filter((p) => p.enabled).length,
        sectionBox: s.sectionBoxEnabled,
        measureMode: s.measurement.mode,
      };
    }).toEqual({
      isolated: 0,
      hidden: 0,
      highlighted: 0,
      colourBy: 'off',
      enabledPlanes: 0,
      sectionBox: false,
      measureMode: 'off',
    });

    // With nothing applied the control retires itself again.
    await expect(pill).toHaveCount(0);
    expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  });
});
