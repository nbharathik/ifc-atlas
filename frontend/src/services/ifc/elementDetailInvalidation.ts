/**
 * Tiny dependency-free bridge between the Zustand store and ModelService.
 *
 * Importing ModelService from the store pulls the IFC/viewer engine into the
 * application entry chunk.  The old dynamic import avoided that cost, but it
 * also made property refresh wait several seconds on a cold bundle.  The
 * viewer registers its already-loaded singleton here; store invalidation then
 * stays synchronous without changing the bundle boundary.
 */

export type ElementDetailInvalidator = (expressIds: readonly number[]) => void;

let invalidator: ElementDetailInvalidator | null = null;

export function registerElementDetailInvalidator(next: ElementDetailInvalidator): () => void {
  invalidator = next;
  return () => {
    if (invalidator === next) invalidator = null;
  };
}

export function invalidateModelElementDetails(expressIds: readonly number[]): void {
  invalidator?.(expressIds);
}
