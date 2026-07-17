import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  attachJson,
  installBrowserProbe,
  loadIfcFixture,
  readRenderStats,
  waitForRenderStateIdle,
} from './rendererHarness';

const BASIC_HOUSE = fileURLToPath(
  new URL('../../../data/fixtures/BasicHouse.ifc', import.meta.url),
);
const NAMED_FILTER_STORAGE_KEY = 'ifc-atlas.named-property-filters.v1';
const CONFIGURED_LOAD_TIMEOUT_MS = Number.parseInt(
  process.env.IFC_E2E_LOAD_TIMEOUT_MS ?? '240000',
  10,
);
const LOAD_TIMEOUT_MS = Number.isFinite(CONFIGURED_LOAD_TIMEOUT_MS)
  && CONFIGURED_LOAD_TIMEOUT_MS > 0
  ? CONFIGURED_LOAD_TIMEOUT_MS
  : 240_000;

interface Phase3ViewerState {
  measurementMode: string | null;
  sectionBoxEnabled: boolean;
  filterPanelOpen: boolean;
  sectionWorkspace: {
    id: string;
    name: string;
    bounds: number[] | null;
  } | null;
}

async function readPhase3ViewerState(page: Page): Promise<Phase3ViewerState> {
  return page.evaluate(() => {
    const win = window as Window & {
      __ifcStore?: {
        getState: () => {
          measurement?: { mode?: string };
          sectionBoxEnabled?: boolean;
          filterPanelOpen?: boolean;
          sectionWorkspace?: {
            id: string;
            name: string;
            box?: { bounds?: readonly number[] };
          } | null;
        };
      };
    };
    const state = win.__ifcStore?.getState();
    if (!state) throw new Error('__ifcStore is unavailable; run the Vite development build');
    const workspace = state.sectionWorkspace;
    return {
      measurementMode: state.measurement?.mode ?? null,
      sectionBoxEnabled: state.sectionBoxEnabled === true,
      filterPanelOpen: state.filterPanelOpen === true,
      sectionWorkspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            bounds: workspace.box?.bounds ? [...workspace.box.bounds] : null,
          }
        : null,
    };
  });
}

test.describe('Phase 3 BIM workflow regression', () => {
  test.skip(
    !existsSync(BASIC_HOUSE),
    'data/fixtures/BasicHouse.ifc is missing; run scripts/fetch-sample.ps1 or scripts/fetch-sample.sh',
  );

  test('keeps construction tools, section workspace, and saved filters accessible in one model session', async ({ page }, testInfo) => {
    // BasicHouse can consume nearly the full 240 s cold-load budget under
    // software WebGL. Keep a separate bounded window for the lazy UI chunks.
    test.setTimeout(LOAD_TIMEOUT_MS + 180_000);
    const workflowDiagnostics: Record<string, unknown> = {};
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.addInitScript((storageKey) => {
      window.localStorage.removeItem(storageKey);
    }, NAMED_FILTER_STORAGE_KEY);
    await installBrowserProbe(page);

    try {
      await loadIfcFixture(page, BASIC_HOUSE, LOAD_TIMEOUT_MS);

      // This renderer suite runs against Vite development modules. Preload the
      // backend-gated editor before opening its Suspense boundary so software
      // WebGL load cannot starve the first lazy-module request.
      await page.evaluate(async (moduleUrl) => {
        await import(moduleUrl);
      }, '/src/components/panels/ElementFilterPanel.tsx');

      await page.getByRole('button', { name: 'Expand viewer tools' }).click();
      const viewerTools = page.getByRole('complementary', { name: 'Viewer tools' });
      await expect(viewerTools).toBeVisible();

      // Construction measurement modes remain reachable without canvas-coordinate
      // assumptions. The compact readout is the authoritative accessible state.
      await viewerTools.getByRole('button', { name: 'Measure', exact: true }).click();
      const measureSection = viewerTools.locator('#vtp-measure');
      for (const name of ['Distance', 'Height', 'Clearance', 'Position']) {
        await expect(measureSection.getByRole('button', { name, exact: true })).toBeVisible();
      }

      await measureSection.getByRole('button', { name: 'Height', exact: true }).click();
      // The toolbar exposes every tool as its own pressed-state button (it used
      // to be a <select> that hid six of the seven behind a dropdown).
      const measurementToolbar = page.getByRole('toolbar', { name: 'Measurement tools' });
      const measurementTool = (name: string) =>
        measurementToolbar.getByRole('button', { name, exact: true });
      await expect(measurementToolbar).toBeVisible();
      await expect(measurementTool('Height')).toHaveAttribute('aria-pressed', 'true');
      await expect(measureSection.getByRole('button', { name: 'Height', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await readPhase3ViewerState(page)).measurementMode)
        .toBe('height');

      // Switching tool is now a single click on the rail.
      await measurementTool('Clearance').click();
      await expect(measurementTool('Clearance')).toHaveAttribute('aria-pressed', 'true');
      await expect(measurementTool('Height')).toHaveAttribute('aria-pressed', 'false');
      await expect(measureSection.getByRole('button', { name: 'Clearance', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');

      await measurementTool('Position').click();
      await expect(measurementTool('Position')).toHaveAttribute('aria-pressed', 'true');
      await expect(measureSection.getByText(/One click places a persistent coordinate marker/))
        .toBeVisible();
      workflowDiagnostics.measurement = await readPhase3ViewerState(page);

      await measureSection.getByRole('button', { name: 'Position', exact: true }).click();
      await expect(measurementToolbar).toHaveCount(0);
      await expect.poll(async () => (await readPhase3ViewerState(page)).measurementMode)
        .toBe('off');

      // A section workspace is retained while clipping is disabled, then reused
      // verbatim when re-enabled. This catches the former destroy/recreate path.
      await viewerTools.getByRole('button', { name: 'Section box', exact: true }).click();
      const sectionBox = viewerTools.locator('#vtp-sectionbox');
      const enableSection = sectionBox.getByRole('button', { name: 'Turn on', exact: true });
      await enableSection.click();
      const disableSection = sectionBox.getByRole('button', { name: 'Turn off', exact: true });
      await expect(disableSection).toHaveAttribute('aria-pressed', 'true');
      await expect(sectionBox.getByText(/Full model section box active/)).toBeVisible();
      await expect.poll(async () => (await readPhase3ViewerState(page)).sectionWorkspace?.bounds)
        .not.toBeNull();
      await waitForRenderStateIdle(page);
      expect((await readRenderStats(page)).triangles).toBeGreaterThan(0);

      const enabledWorkspace = (await readPhase3ViewerState(page)).sectionWorkspace;
      expect(enabledWorkspace?.bounds).not.toBeNull();
      await disableSection.click();
      await expect(enableSection).toHaveAttribute('aria-pressed', 'false');
      const disabledState = await readPhase3ViewerState(page);
      expect(disabledState.sectionBoxEnabled).toBe(false);
      expect(disabledState.sectionWorkspace).toEqual(enabledWorkspace);

      await enableSection.click();
      await expect(disableSection).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await readPhase3ViewerState(page)).sectionWorkspace)
        .toEqual(enabledWorkspace);
      await waitForRenderStateIdle(page);
      expect((await readRenderStats(page)).triangles).toBeGreaterThan(0);
      workflowDiagnostics.sectionWorkspace = {
        enabled: enabledWorkspace,
        disabled: disabledState.sectionWorkspace,
        restored: (await readPhase3ViewerState(page)).sectionWorkspace,
      };

      // The default renderer harness runs the intentionally backend-free
      // webdemo, where Shift+F is release-gated behind BROWSER_ONLY (a silent
      // no-op). The development store hook mounts the same editor
      // deterministically without calling the unavailable filter endpoint.
      // Which path actually opened the panel is recorded in the diagnostics so
      // keyboard-coverage degradation is visible instead of silent. The build
      // flag itself is readable in-page because this suite runs against Vite
      // development modules (same mechanism as the editor preload above).
      const browserOnly = await page.evaluate(async (moduleUrl) => {
        try {
          const flags = await import(moduleUrl) as { BROWSER_ONLY?: unknown };
          return typeof flags.BROWSER_ONLY === 'boolean' ? flags.BROWSER_ONLY : null;
        } catch {
          return null;
        }
      }, '/src/config/featureFlags.ts');
      await page.keyboard.press('Shift+F');
      const openedByKeyboard = (await readPhase3ViewerState(page)).filterPanelOpen;
      if (!openedByKeyboard) {
        await page.evaluate(() => {
          const win = window as Window & {
            __ifcStore?: {
              getState: () => {
                focusRightTab?: (tab: 'tools') => void;
                setFilterPanelOpen?: (open: boolean) => void;
              };
            };
          };
          const state = win.__ifcStore?.getState();
          if (!state?.setFilterPanelOpen || !state.focusRightTab) {
            throw new Error('Phase 3 filter test requires the Vite development store hook');
          }
          state.focusRightTab('tools');
          state.setFilterPanelOpen(true);
        });
      }
      const filterDiagnostics: Record<string, unknown> = {
        openedVia: openedByKeyboard ? 'keyboard' : 'store-hook',
        browserOnly,
      };
      workflowDiagnostics.filter = filterDiagnostics;
      await expect.poll(async () => (await readPhase3ViewerState(page)).filterPanelOpen)
        .toBe(true);

      const filterPanel = page.getByRole('region', { name: 'Element property filter' });
      await expect(filterPanel).toBeVisible();
      await filterPanel.getByLabel('Filter name').fill('Phase 3 wall review');
      await filterPanel.getByLabel('Property').fill('FireRating');
      await filterPanel.getByLabel('Pset').fill('Pset_WallCommon');
      await filterPanel.getByLabel('Operator for condition 1').selectOption('exists');
      await expect(filterPanel.getByLabel('Value for condition 1')).toHaveCount(0);

      await filterPanel.getByRole('button', { name: 'Add condition' }).click();
      await filterPanel.getByLabel('Property').nth(1).fill('Name');
      await filterPanel.getByLabel('Operator for condition 2').selectOption('contains');
      await filterPanel.getByLabel('Value for condition 2').fill('Wall');
      await filterPanel.getByRole('button', { name: 'OR', exact: true }).click();
      await expect(filterPanel.getByRole('button', { name: 'OR', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');

      await filterPanel.getByRole('button', { name: 'Limit by IFC type or storey' }).click();
      await filterPanel.getByLabel('IFC types').fill('IfcWall, IfcCurtainWall');
      await filterPanel.getByLabel('Storeys').fill('Ground Floor');
      await filterPanel.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(filterPanel.getByRole('status')).toContainText('Filter saved for this browser.');
      const savedFilter = filterPanel.getByLabel('Saved', { exact: true });
      await expect(savedFilter).toContainText('Phase 3 wall review');

      await filterPanel.getByRole('button', { name: 'Reset', exact: true }).click();
      await savedFilter.selectOption({ label: 'Phase 3 wall review' });
      await expect(filterPanel.getByRole('status')).toContainText('Saved filter loaded.');
      await expect(filterPanel.getByRole('button', { name: 'OR', exact: true }))
        .toHaveAttribute('aria-pressed', 'true');
      await expect(filterPanel.getByLabel('Property')).toHaveCount(2);
      await expect(filterPanel.getByLabel('IFC types')).toHaveValue('IfcWall, IfcCurtainWall');
      const savedDefinition = await page.evaluate(
        (storageKey) => window.localStorage.getItem(storageKey),
        NAMED_FILTER_STORAGE_KEY,
      );

      await filterPanel.getByRole('button', { name: 'Delete saved filter' }).click();
      await expect(filterPanel.getByRole('status')).toContainText('Saved filter deleted.');
      await expect(savedFilter).toHaveCount(0);
      await expect.poll(async () => page.evaluate((storageKey) => {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return -1;
        const parsed = JSON.parse(raw) as { definitions?: unknown[] };
        return parsed.definitions?.length ?? -1;
      }, NAMED_FILTER_STORAGE_KEY)).toBe(0);
      filterDiagnostics.savedDefinition = savedDefinition;
      filterDiagnostics.deleted = true;
      filterDiagnostics.endpointCalled = false;
    } finally {
      await attachJson(testInfo, 'renderer-phase3-workflow-diagnostics', {
        fixture: BASIC_HOUSE,
        loadTimeoutMs: LOAD_TIMEOUT_MS,
        workflows: workflowDiagnostics,
        errors: {
          page: pageErrors,
          console: consoleErrors,
        },
      });
    }
  });
});
