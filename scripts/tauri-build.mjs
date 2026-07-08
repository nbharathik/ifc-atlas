// Wrapper around `tauri build` that resolves the updater signing key the same
// way for local builds and CI, so a bare `npm run tauri:build` never fails on a
// missing signing key.
//
// `bundle.createUpdaterArtifacts` is `true` in tauri.conf.json (signed
// auto-updates are a shipping feature). Tauri then refuses to build unless a
// signing key is reachable. This wrapper resolves the key in priority order:
//
//   1. TAURI_SIGNING_PRIVATE_KEY already set (CI secret, or the maintainer's
//      own export) -> use it verbatim, produce SIGNED artifacts.
//   2. TAURI_SIGNING_PRIVATE_KEY_PATH, else the conventional key at
//      ~/.tauri/ifc-atlas.key (see docs/architecture/TAURI.md) -> load its
//      contents, produce SIGNED artifacts.
//   3. No key anywhere (fresh clone, fork, contributor) -> build KEYLESS by
//      merging `src-tauri/updater-off.conf.json` (which sets
//      createUpdaterArtifacts=false) via `--config`, so the committed config is
//      never mutated. Installers still build; only the .sig / latest.json
//      updater artifacts are skipped.
//
// Extra CLI args are forwarded: `npm run tauri:build -- --debug`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env };
let signing = Boolean(env.TAURI_SIGNING_PRIVATE_KEY);

if (signing) {
  console.log('[tauri-build] Signing with TAURI_SIGNING_PRIVATE_KEY from the environment.');
} else {
  const keyPath =
    env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), '.tauri', 'ifc-atlas.key');
  if (existsSync(keyPath)) {
    // Pass the key file's full contents (matching the CI secret), not the path,
    // for consistent behaviour across Tauri CLI versions.
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8');
    if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    }
    signing = true;
    console.log(`[tauri-build] Signing with key at ${keyPath} -> signed updater artifacts.`);
  }
}

const args = ['tauri', 'build', ...process.argv.slice(2)];
if (!signing) {
  // Merge (not replace) an override that turns off updater artifacts. A file
  // path avoids the cmd.exe quoting hazards of an inline JSON --config string.
  args.push('--config', 'src-tauri/updater-off.conf.json');
  console.log(
    '[tauri-build] No signing key found (TAURI_SIGNING_PRIVATE_KEY / ' +
      '~/.tauri/ifc-atlas.key) - building installers WITHOUT updater artifacts.',
  );
}

const res = spawnSync('npx', args, {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});
process.exit(res.status ?? 1);
