/**
 * Global web-ifc patch - forces single-threaded WASM init.
 *
 * Why this exists:
 * --------------
 * web-ifc's default `IfcAPI.Init()` spawns child workers from the parent
 * worker's script URL. In Vite's dev server those worker files are served
 * with ES `import` statements, but the child spawn uses CLASSIC worker
 * mode - so every spawn fails with:
 *
 *   "Uncaught SyntaxError: Cannot use import statement outside a module"
 *
 * The same code also occasionally tries to load workers from
 * `http://localhost:PORT/undefined` (HTML 404 page → "Unexpected token '<'")
 * when the script URL isn't set on a transient script.
 *
 * We can't pass options to the IfcAPI instances that live inside
 * `@thatopen/fragments` (IfcImporter) and `@thatopen/components-front`
 * (IfcLoader). The most surgical fix is to monkey-patch the prototype
 * once, before any of those libraries instantiate an IfcAPI. Every
 * call to `Init(handler?, forceSingleThread?)` now forces
 * `forceSingleThread = true`.
 *
 * Single-threaded mode runs the WASM directly in the calling thread
 * (a Web Worker for our pipeline), so we lose nothing - the parent IS
 * already a worker. The only thing we lose is web-ifc's internal
 * cross-thread parallelism, which the dev-server workflow can't
 * support anyway.
 *
 * How to use:
 * ---------
 * Imported for side effect from `src/main.tsx` (and any other entry
 * point that spawns a Worker). The patch is idempotent - repeated
 * imports are no-ops.
 */

import * as WEBIFC from 'web-ifc';
import { BROWSER_WEB_IFC_RUNTIME } from './webIfcRuntime';

const FLAG = Symbol.for('aiv.webIfcSingleThreadPatched');

interface IfcAPIPrototype {
  Init: (
    handler?: unknown,
    forceSingleThread?: boolean,
  ) => Promise<void>;
}

const proto = (WEBIFC.IfcAPI as unknown as { prototype: IfcAPIPrototype }).prototype;
const globalAny = globalThis as unknown as Record<symbol, boolean>;

if (!globalAny[FLAG]) {
  const original = proto.Init;
  proto.Init = function patchedInit(
    this: unknown,
    handler?: unknown,
    _forceSingleThread?: boolean,
  ): Promise<void> {
    return original.call(
      this,
      handler as never,
      BROWSER_WEB_IFC_RUNTIME.forceSingleThread,
    );
  };
  globalAny[FLAG] = true;
}
