import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendDir = resolve(repoRoot, 'frontend');
const fixture = resolve(repoRoot, 'data', 'fixtures', 'BasicHouse.ifc');

if (!existsSync(fixture)) {
  console.log('[renderer-e2e] SKIP: data/fixtures/BasicHouse.ifc is missing.');
  console.log('[renderer-e2e] Fetch it with scripts/fetch-sample.ps1 or scripts/fetch-sample.sh.');
  process.exit(0);
}

const requireFromFrontend = createRequire(resolve(frontendDir, 'package.json'));
let packageJsonPath;
try {
  packageJsonPath = requireFromFrontend.resolve('@playwright/test/package.json');
} catch {
  console.error('[renderer-e2e] @playwright/test is not installed in frontend.');
  console.error('[renderer-e2e] Run: npm --prefix frontend install --save-dev @playwright/test');
  console.error('[renderer-e2e] Then run once: npm --prefix frontend exec -- playwright install chromium');
  process.exit(2);
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const playwrightBin = typeof packageJson.bin === 'string'
  ? packageJson.bin
  : packageJson.bin?.playwright;
if (!playwrightBin) {
  console.error('[renderer-e2e] Installed @playwright/test has no Playwright CLI entry.');
  process.exit(2);
}

const cliPath = resolve(dirname(packageJsonPath), playwrightBin);
const result = spawnSync(
  process.execPath,
  [cliPath, 'test', '--config', 'playwright.renderer.config.ts', ...process.argv.slice(2)],
  {
    cwd: frontendDir,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`[renderer-e2e] Could not start Playwright: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
