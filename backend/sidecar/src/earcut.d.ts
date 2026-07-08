declare module 'earcut' {
  /**
   * Triangulate a polygon given as a flat array of [x,y,...] coordinates.
   * @param data   Flat array of vertex coordinates (x,y pairs by default)
   * @param holeIndices  Starting indices of holes in `data` (optional)
   * @param dim    Number of coords per vertex (default 2)
   * @returns Flat array of triangle indices (3 per triangle)
   */
  function earcut(data: number[] | Float32Array | Float64Array, holeIndices?: number[], dim?: number): number[];
  export default earcut;
}
