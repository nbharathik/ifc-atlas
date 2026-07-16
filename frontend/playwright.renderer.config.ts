import { defineConfig, devices } from '@playwright/test';

const externallyManagedBaseUrl = process.env.IFC_E2E_BASE_URL?.trim();
const baseURL = externallyManagedBaseUrl || 'http://127.0.0.1:4174';
const forceSwiftShader = process.env.IFC_E2E_FORCE_SWIFTSHADER === '1';
// Headless-shell Chromium falls back to SwiftShader even on GPU machines. The
// hardware mode launches the full Chromium build in new-headless mode with the
// native ANGLE backend so diagnostics record the real adapter.
const forceHardware = !forceSwiftShader && process.env.IFC_E2E_FORCE_HW === '1';
const configuredLoadTimeout = Number.parseInt(process.env.IFC_E2E_LOAD_TIMEOUT_MS ?? '', 10);
const loadTimeoutMs = Number.isFinite(configuredLoadTimeout) && configuredLoadTimeout > 0
  ? configuredLoadTimeout
  : 240_000;
const configuredRetries = Number.parseInt(process.env.IFC_E2E_RETRIES ?? '', 10);
const retries = Number.isFinite(configuredRetries) && configuredRetries >= 0
  ? configuredRetries
  : 0;
const video = process.env.IFC_E2E_VIDEO === 'off' ? 'off' : 'retain-on-failure';

export default defineConfig({
  testDir: './e2e/renderer',
  outputDir: 'test-results/renderer-phase1',
  fullyParallel: false,
  workers: 1,
  // A 50 MB browser parse is expensive. Do not silently double it after an
  // infrastructure timeout; opt into retries explicitly when investigating.
  retries,
  timeout: Math.max(5 * 60_000, loadTimeoutMs + 90_000),
  expect: {
    timeout: 15_000,
  },
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report/renderer-phase1', open: 'never' }]]
    : [['list'], ['html', { outputFolder: 'playwright-report/renderer-phase1', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    headless: process.env.IFC_E2E_HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    video,
    launchOptions: {
      ...(forceHardware ? { channel: 'chromium' as const } : {}),
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        ...(forceSwiftShader
          ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
          : []),
        ...(forceHardware ? ['--use-angle=d3d11', '--enable-gpu'] : []),
      ],
    },
  },
  webServer: externallyManagedBaseUrl
    ? undefined
    : {
        command: 'npm run dev:web -- --host 127.0.0.1 --port 4174 --strictPort',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
