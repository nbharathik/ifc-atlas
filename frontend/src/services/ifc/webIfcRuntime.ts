/**
 * Browser web-ifc runtime contract.
 *
 * The conversion and metadata pipelines already run inside application-owned
 * Web Workers. web-ifc's nested worker mode is intentionally disabled because
 * its classic child-worker bootstrap is not compatible with the module-worker
 * URLs emitted by the browser build. Keep preload and telemetry tied to this
 * lightweight contract so they cannot claim or warm the MT binary while the
 * runtime patch forces single-threaded initialization.
 */
export const BROWSER_WEB_IFC_RUNTIME = {
  forceSingleThread: true,
  wasmVariant: 'st',
  wasmFile: 'web-ifc.wasm',
} as const;

export function webIfcRuntimeActivitySummary(crossOriginIsolated: boolean): string {
  const base = `Single-threaded web-ifc enabled (${BROWSER_WEB_IFC_RUNTIME.wasmFile}).`;
  if (!crossOriginIsolated) return base;
  return `${base} Cross-origin isolation is available, but nested web-ifc workers are disabled for browser compatibility.`;
}
