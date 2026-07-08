/**
 * Shared frozen hover-highlight material.
 *
 * Both hover surfaces - the canvas pointer-move preview and the sidebar
 * tree-row preview - paint the same soft-amber "this is what you'd pick"
 * highlight. They used to each build their own material-options object (and
 * the tree path allocated a fresh `new THREE.Color(0xfbbf24)` on EVERY row
 * hover), undoing the colour singleton the hover-churn tests pin.
 *
 * This module is the single source of truth: one frozen options object whose
 * `color` is the `getHoverHighlightColor()` page-singleton, combined with the
 * @thatopen/fragments `RenderedFaces` enum here (the colour/opacity contract
 * itself stays framework-free in `hoverHighlightHelpers.ts` so vitest can pin
 * it without pulling in fragments). Referential equality across hovers means
 * zero per-paint allocation on either surface.
 */
import * as FRAGS from '@thatopen/fragments';
import {
  HOVER_HIGHLIGHT_OPACITY,
  getHoverHighlightColor,
} from './hoverHighlightHelpers';

/**
 * The exact material handed to `model.highlight()` for a hover preview.
 * Frozen so neither call site can mutate the shared instance, and built once
 * at module load - the colour is the lazy page-singleton, so this triggers a
 * single `THREE.Color` allocation for the life of the page.
 */
export const HOVER_HIGHLIGHT_MATERIAL = Object.freeze({
  color: getHoverHighlightColor(),
  opacity: HOVER_HIGHLIGHT_OPACITY,
  transparent: true,
  renderedFaces: FRAGS.RenderedFaces.ONE,
});
