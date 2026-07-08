const THREE_MULTI_INSTANCE_WARNING = 'Multiple instances of Three.js being imported';

/**
 * ThatOpen 3.4 imports both `three` and optional `three/webgpu`/TSL entrypoints.
 * Vite dev executes Three's global devtools registration in both entrypoints,
 * which triggers a noisy warning even when `npm ls three` is fully deduped.
 */
export function installThreeWarningFilter(): void {
  if (!import.meta.env.DEV) return;
  const key = '__ifcThreeWarningFilterInstalled';
  const globalState = globalThis as typeof globalThis & Record<string, unknown>;
  if (globalState[key]) return;
  globalState[key] = true;

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const message = args.map((arg) => String(arg)).join(' ');
    if (message.includes(THREE_MULTI_INSTANCE_WARNING)) {
      return;
    }
    originalWarn(...args);
  };
}

installThreeWarningFilter();
