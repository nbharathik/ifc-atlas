/**
 * Minimal ambient typings for the slice of `three` the sidecar uses.
 *
 * `three` ships no bundled `.d.ts` and `@types/three` is not a dependency, so a
 * direct `import * as THREE from 'three'` in a typechecked source file would
 * fail with TS7016. The fragments `.d.ts` also references `three`, but those
 * references are ignored under `skipLibCheck`. `decimate.ts` needs the real
 * constructors, so this declares just `BufferGeometry` + `BufferAttribute`
 * (matching the `representationFromGeometry` signature's generic shape).
 *
 * Mirrors the existing `src/earcut.d.ts` precedent for untyped modules. The
 * esbuild bundle (`build.mjs`) resolves the real runtime implementation from
 * `node_modules/three`; this file only satisfies the typechecker.
 */
declare module 'three' {
  export type NormalBufferAttributes = Record<string, unknown>;

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
  }

  export class BufferGeometry<Attributes = NormalBufferAttributes> {
    setAttribute(name: string, attribute: BufferAttribute): this;
    setIndex(index: BufferAttribute | null): this;
  }
}
