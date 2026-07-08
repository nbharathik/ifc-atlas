/**
 * IFC geometry extractor (pure math, no three.js dependency).
 *
 * Walks the V1 entity table and extracts mesh geometry for elements whose
 * geometry is an IfcExtrudedAreaSolid with a rectangle or polyline profile.
 * This covers ~60-80 % of architectural elements (walls, slabs, columns,
 * beams, doors, windows) without CSG booleans, the step that causes the
 * 9-minute browser hang.
 *
 * Output: per-element Float32 vertex buffer (world-space positions, XYZ
 * interleaved) + Uint32 triangle-index buffer. The frontend can hand these
 * directly to a THREE.BufferGeometry for an instant preview mesh.
 *
 * Triangulation uses `earcut` (already in node_modules via @thatopen/fragments).
 *
 * Deferred to V2.2+:
 *   - CSG booleans for door/window openings
 *   - IfcRevolvedAreaSolid (curved columns)
 *   - IfcBooleanResult / IfcBooleanClippingResult
 *   - IfcFacetedBrep
 * Those continue loading via the @thatopen/fragments path in parallel.
 */

import earcut from 'earcut';

import { parseArgs, asRef, asRefList, asString } from './args.js';
import type { EntityRecord } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────────────────

export interface ElementMesh {
  expressId: number;
  ifcType: string;
  name: string | null;
  /** Flat XYZ world-space positions (length = vertexCount × 3). */
  positions: Float32Array;
  /** Triangle index list (length = triangleCount × 3). */
  indices: Uint32Array;
  /** AABB [minX,minY,minZ,maxX,maxY,maxZ] in world space. */
  bbox: Float32Array;
}

export interface GeometryResult {
  meshes: ElementMesh[];
  attempted: number;
  skipped: number;
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mat4: column-major 4×4 transform (flat array[16])
// Using [m00,m10,m20,m30, m01,m11,m21,m31, m02,m12,m22,m32, m03,m13,m23,m33]
// (OpenGL column-major convention)
// ─────────────────────────────────────────────────────────────────────────────

type Mat4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

function identityMat4(): Mat4 {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

/** Multiply two 4×4 column-major matrices: result = a × b */
function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const r = identityMat4();
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[row + k * 4]! * b[k + col * 4]!;
      }
      r[row + col * 4] = sum;
    }
  }
  return r;
}

/** Transform a 3D point [x,y,z] by a 4×4 column-major matrix. */
function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const wInv = w !== 0 ? 1 / w : 1;
  return [
    (m[0]! * x + m[4]! * y + m[8]!  * z + m[12]!) * wInv,
    (m[1]! * x + m[5]! * y + m[9]!  * z + m[13]!) * wInv,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) * wInv,
  ];
}

/**
 * Build a column-major Mat4 from IFC axis2placement data.
 * Origin = [ox,oy,oz], Z-axis = [zx,zy,zz], X-axis = [xx,xy,xz].
 * Y = Z × X.
 */
function mat4FromAxes(
  ox: number, oy: number, oz: number,
  zx: number, zy: number, zz: number,
  xx: number, xy: number, xz: number,
): Mat4 {
  // Normalise Z and X
  const zLen = Math.sqrt(zx*zx + zy*zy + zz*zz) || 1;
  zx /= zLen; zy /= zLen; zz /= zLen;
  const xLen = Math.sqrt(xx*xx + xy*xy + xz*xz) || 1;
  xx /= xLen; xy /= xLen; xz /= xLen;
  // Y = Z × X
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  // Column-major: column 0 = X-axis, col 1 = Y-axis, col 2 = Z-axis, col 3 = origin
  return [
    xx, xy, xz, 0,
    yx, yy, yz, 0,
    zx, zy, zz, 0,
    ox, oy, oz, 1,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference resolver
// ─────────────────────────────────────────────────────────────────────────────

function resolveArgs(id: number, entities: Map<number, EntityRecord>) {
  const e = entities.get(id);
  if (!e) return null;
  return { entity: e, args: parseArgs(e.argsRaw) };
}

function readPointCoords(id: number, entities: Map<number, EntityRecord>): number[] | null {
  const r = resolveArgs(id, entities);
  if (!r) return null;
  const listArg = r.args[0];
  if (!listArg || listArg.kind !== 'list') return null;
  const coords: number[] = [];
  for (const v of listArg.value) {
    if (v.kind === 'real' || v.kind === 'integer') coords.push(v.value);
  }
  return coords.length >= 2 ? coords : null;
}

function readDirectionRatios(id: number, entities: Map<number, EntityRecord>): number[] | null {
  const r = resolveArgs(id, entities);
  if (!r || r.entity.type !== 'IFCDIRECTION') return null;
  const listArg = r.args[0];
  if (!listArg || listArg.kind !== 'list') return null;
  const ratios: number[] = [];
  for (const v of listArg.value) {
    if (v.kind === 'real' || v.kind === 'integer') ratios.push(v.value);
  }
  return ratios.length >= 2 ? ratios : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement chain → Mat4
// ─────────────────────────────────────────────────────────────────────────────

function axis2Placement3DToMat4(id: number, entities: Map<number, EntityRecord>): Mat4 | null {
  const r = resolveArgs(id, entities);
  if (!r || r.entity.type !== 'IFCAXIS2PLACEMENT3D') return null;
  const { args } = r;
  const locId = asRef(args[0]);
  if (!locId) return null;
  const origin = readPointCoords(locId, entities);
  if (!origin) return null;
  const ox = origin[0] ?? 0, oy = origin[1] ?? 0, oz = origin[2] ?? 0;

  let zx = 0, zy = 0, zz = 1;
  let xx = 1, xy = 0, xz = 0;
  const axisId = asRef(args[1]);
  if (axisId) { const d = readDirectionRatios(axisId, entities); if (d && d.length >= 3) [zx, zy, zz] = d; }
  const refId = asRef(args[2]);
  if (refId) { const d = readDirectionRatios(refId, entities); if (d && d.length >= 3) [xx, xy, xz] = d; }
  return mat4FromAxes(ox, oy, oz, zx, zy, zz, xx, xy, xz);
}

const MAX_PLACEMENT_DEPTH = 20; // guard against circular refs

function resolvePlacementMat(
  id: number,
  entities: Map<number, EntityRecord>,
  depth = 0,
): Mat4 {
  if (depth > MAX_PLACEMENT_DEPTH) return identityMat4();
  const r = resolveArgs(id, entities);
  if (!r || r.entity.type !== 'IFCLOCALPLACEMENT') return identityMat4();
  const { args } = r;
  const parentId = asRef(args[0]);
  const relId = asRef(args[1]);
  const relMat = relId ? (axis2Placement3DToMat4(relId, entities) ?? identityMat4()) : identityMat4();
  if (!parentId) return relMat;
  const parentMat = resolvePlacementMat(parentId, entities, depth + 1);
  return mulMat4(parentMat, relMat);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile → 2D outline points [x0,y0, x1,y1, ...]
// ─────────────────────────────────────────────────────────────────────────────

function extractProfileFlat(id: number, entities: Map<number, EntityRecord>): number[] | null {
  const r = resolveArgs(id, entities);
  if (!r) return null;
  const { entity, args } = r;

  if (entity.type === 'IFCRECTANGLEPROFILEDEF') {
    const xd = args[3]; const yd = args[4];
    if (!xd || !yd) return null;
    const xDim = (xd.kind === 'real' || xd.kind === 'integer') ? xd.value : null;
    const yDim = (yd.kind === 'real' || yd.kind === 'integer') ? yd.value : null;
    if (xDim === null || yDim === null || xDim <= 0 || yDim <= 0) return null;
    const hx = xDim / 2, hy = yDim / 2;
    return [-hx,-hy, hx,-hy, hx,hy, -hx,hy];
  }

  if (entity.type === 'IFCCIRCLEPROFILEDEF') {
    const ra = args[3];
    if (!ra || (ra.kind !== 'real' && ra.kind !== 'integer')) return null;
    const r2 = ra.value;
    const pts: number[] = [];
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pts.push(r2 * Math.cos(a), r2 * Math.sin(a));
    }
    return pts;
  }

  if (
    entity.type === 'IFCARBITRARYCLOSEDPROFILEDEF' ||
    entity.type === 'IFCARBITRARYPROFILEDEFWITHVOIDS'
  ) {
    const curveId = asRef(args[2]);
    return curveId ? extractCurveFlat(curveId, entities) : null;
  }

  return null;
}

function extractCurveFlat(id: number, entities: Map<number, EntityRecord>): number[] | null {
  const r = resolveArgs(id, entities);
  if (!r) return null;
  const { entity, args } = r;

  if (entity.type === 'IFCPOLYLINE') {
    const ptIds = asRefList(args[0]);
    const pts: number[] = [];
    for (const pid of ptIds) {
      const c = readPointCoords(pid, entities);
      if (c && c.length >= 2) pts.push(c[0]!, c[1]!);
    }
    return pts.length >= 6 ? pts : null; // ≥3 points
  }

  if (entity.type === 'IFCINDEXEDPOLYCURVE') {
    const listId = asRef(args[0]);
    if (!listId) return null;
    const lr = resolveArgs(listId, entities);
    if (!lr) return null;
    const coordsArg = lr.args[0];
    if (!coordsArg || coordsArg.kind !== 'list') return null;
    const pts: number[] = [];
    for (const item of coordsArg.value) {
      if (item.kind === 'list' && item.value.length >= 2) {
        const xv = item.value[0]!; const yv = item.value[1]!;
        const x = (xv.kind === 'real' || xv.kind === 'integer') ? xv.value : null;
        const y = (yv.kind === 'real' || yv.kind === 'integer') ? yv.value : null;
        if (x !== null && y !== null) pts.push(x, y);
      }
    }
    return pts.length >= 6 ? pts : null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extrusion mesh builder: earcut triangulation + caps + walls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a closed extruded-solid mesh from a 2D profile (flat XY pairs)
 * extruded along a direction vector by `depth`.
 *
 * Returns interleaved position buffer (XYZ) and triangle index buffer.
 * The geometry is in the solid's LOCAL coordinate space (before the
 * placement transform is applied by the caller).
 */
function buildExtrusionLocal(
  profileFlat: number[],
  depth: number,
  extrudeDir: [number, number, number],
): { positions: Float32Array; indices: Uint32Array } | null {
  if (profileFlat.length < 6) return null; // need ≥3 points
  const nPts = profileFlat.length / 2;

  // earcut works on a flat array of [x,y] pairs.
  const triIndices = earcut(profileFlat);
  if (triIndices.length === 0) return null;

  const [dx, dy, dz] = extrudeDir;
  const ex = dx * depth, ey = dy * depth, ez = dz * depth;

  // Vertex layout:
  //   0..nPts-1          = bottom cap (z=0 plane)
  //   nPts..2*nPts-1     = top cap (offset by extrude vector)
  //   2*nPts..end        = wall quads (2 triangles per profile edge)
  const totalVerts = nPts * 2 + nPts * 4; // side walls: each edge = 4 verts
  const positions = new Float32Array(totalVerts * 3);

  // Bottom cap vertices
  for (let i = 0; i < nPts; i++) {
    const x = profileFlat[i * 2]!, y = profileFlat[i * 2 + 1]!;
    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = 0;
  }
  // Top cap vertices
  for (let i = 0; i < nPts; i++) {
    const x = profileFlat[i * 2]!, y = profileFlat[i * 2 + 1]!;
    positions[(nPts + i) * 3]     = x + ex;
    positions[(nPts + i) * 3 + 1] = y + ey;
    positions[(nPts + i) * 3 + 2] = ez;
  }

  const sideBase = nPts * 2;
  // Side wall vertices (4 per edge for distinct normals)
  for (let i = 0; i < nPts; i++) {
    const j = (i + 1) % nPts;
    const x0 = profileFlat[i * 2]!, y0 = profileFlat[i * 2 + 1]!;
    const x1 = profileFlat[j * 2]!, y1 = profileFlat[j * 2 + 1]!;
    const base = sideBase + i * 4;
    // v0 = bottom-left, v1 = bottom-right, v2 = top-right, v3 = top-left
    positions[base * 3]     = x0; positions[base * 3 + 1]     = y0; positions[base * 3 + 2]     = 0;
    positions[(base+1)*3]   = x1; positions[(base+1)*3 + 1]   = y1; positions[(base+1)*3 + 2]   = 0;
    positions[(base+2)*3]   = x1+ex; positions[(base+2)*3 + 1] = y1+ey; positions[(base+2)*3 + 2] = ez;
    positions[(base+3)*3]   = x0+ex; positions[(base+3)*3 + 1] = y0+ey; positions[(base+3)*3 + 2] = ez;
  }

  // Index buffer:
  const nCapTris = triIndices.length / 3;
  const nSideTris = nPts * 2;
  const indices = new Uint32Array((nCapTris * 2 + nSideTris) * 3);
  let idx = 0;

  // Bottom cap (CCW as seen from below → flip winding)
  for (let i = 0; i < triIndices.length; i += 3) {
    indices[idx++] = triIndices[i + 2]!;
    indices[idx++] = triIndices[i + 1]!;
    indices[idx++] = triIndices[i]!;
  }
  // Top cap (CCW as seen from above)
  for (let i = 0; i < triIndices.length; i += 3) {
    indices[idx++] = nPts + triIndices[i]!;
    indices[idx++] = nPts + triIndices[i + 1]!;
    indices[idx++] = nPts + triIndices[i + 2]!;
  }
  // Side walls (quads → two triangles each)
  for (let i = 0; i < nPts; i++) {
    const b = sideBase + i * 4;
    indices[idx++] = b;     indices[idx++] = b + 1; indices[idx++] = b + 2;
    indices[idx++] = b;     indices[idx++] = b + 2; indices[idx++] = b + 3;
  }

  return { positions, indices };
}

// ─────────────────────────────────────────────────────────────────────────────
// IfcExtrudedAreaSolid finder
// ─────────────────────────────────────────────────────────────────────────────

function findExtrudedSolidInRep(
  repId: number,
  entities: Map<number, EntityRecord>,
): number | null {
  const r = resolveArgs(repId, entities);
  if (!r) return null;
  const { entity, args } = r;

  if (entity.type === 'IFCPRODUCTDEFINITIONSHAPE') {
    const repsArg = args[2];
    if (!repsArg || repsArg.kind !== 'list') return null;
    for (const item of repsArg.value) {
      if (item.kind === 'ref') {
        const found = findExtrudedSolidInShapeRep(item.value, entities);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

function findExtrudedSolidInShapeRep(
  id: number,
  entities: Map<number, EntityRecord>,
): number | null {
  const r = resolveArgs(id, entities);
  if (!r || r.entity.type !== 'IFCSHAPEREPRESENTATION') return null;
  const itemsArg = r.args[3];
  if (!itemsArg || itemsArg.kind !== 'list') return null;
  for (const item of itemsArg.value) {
    if (item.kind !== 'ref') continue;
    const ie = entities.get(item.value);
    if (!ie) continue;
    if (ie.type === 'IFCEXTRUDEDAREASOLID') return item.value;
    // Mapped item: follow to representation map
    if (ie.type === 'IFCMAPPEDITEM') {
      const mArgs = parseArgs(ie.argsRaw);
      const srcId = asRef(mArgs[0]);
      if (srcId) {
        const sr = resolveArgs(srcId, entities);
        if (sr && sr.entity.type === 'IFCREPRESENTATIONMAP') {
          const mapRepId = asRef(sr.args[1]);
          if (mapRepId) {
            const found = findExtrudedSolidInShapeRep(mapRepId, entities);
            if (found !== null) return found;
          }
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply Mat4 transform to flat position buffer in-place
// ─────────────────────────────────────────────────────────────────────────────

function applyMat4ToPositions(positions: Float32Array, m: Mat4): void {
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i+1]!, z = positions[i+2]!;
    const [tx, ty, tz] = transformPoint(m, x, y, z);
    positions[i] = tx; positions[i+1] = ty; positions[i+2] = tz;
  }
}

function computeBbox(positions: Float32Array): Float32Array {
  const bbox = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i+1]!, z = positions[i+2]!;
    if (x < bbox[0]!) bbox[0] = x; if (x > bbox[3]!) bbox[3] = x;
    if (y < bbox[1]!) bbox[1] = y; if (y > bbox[4]!) bbox[4] = y;
    if (z < bbox[2]!) bbox[2] = z; if (z > bbox[5]!) bbox[5] = z;
  }
  return bbox;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-compute the placement ID and representation ID for every element
 * from the V1 entity table. IfcProduct layout: args[5]=ObjectPlacement,
 * args[6]=Representation.
 */
export function buildProductMaps(
  entities: Map<number, EntityRecord>,
  elementIds: number[],
): {
  placementIds: Map<number, number>;
  repIds: Map<number, number>;
  elementTypes: Map<number, string>;
  elementNames: Map<number, string | null>;
} {
  const placementIds = new Map<number, number>();
  const repIds = new Map<number, number>();
  const elementTypes = new Map<number, string>();
  const elementNames = new Map<number, string | null>();

  for (const eid of elementIds) {
    const entity = entities.get(eid);
    if (!entity) continue;
    const args = parseArgs(entity.argsRaw);
    const pId = asRef(args[5]);
    const rId = asRef(args[6]);
    if (pId) placementIds.set(eid, pId);
    if (rId) repIds.set(eid, rId);
    elementTypes.set(eid, entity.type);
    elementNames.set(eid, asString(args[2]));
  }
  return { placementIds, repIds, elementTypes, elementNames };
}

/**
 * Process a single element id → ElementMesh, or null if it has no
 * extractable IfcExtrudedAreaSolid geometry. Shared by both the
 * collecting `extractGeometry` and the streaming variant so the two
 * paths produce byte-identical mesh output.
 */
function processElement(
  eid: number,
  entities: Map<number, EntityRecord>,
  elementTypes: Map<number, string>,
  elementNames: Map<number, string | null>,
  placementIds: Map<number, number>,
  repIds: Map<number, number>,
): ElementMesh | null {
  const repId = repIds.get(eid);
  const placementId = placementIds.get(eid);
  if (!repId) return null;

  const solidId = findExtrudedSolidInRep(repId, entities);
  if (solidId === null) return null;

  // Parse IfcExtrudedAreaSolid: [SweptArea, Position, ExtrudedDirection, Depth]
  const sr = resolveArgs(solidId, entities);
  if (!sr) return null;
  const { args: sArgs } = sr;

  const profileId = asRef(sArgs[0]);
  const solidPosId = asRef(sArgs[1]);
  const extDirId = asRef(sArgs[2]);
  const depthArg = sArgs[3];
  if (!profileId || !depthArg) return null;
  const depth = (depthArg.kind === 'real' || depthArg.kind === 'integer') ? depthArg.value : null;
  if (!depth || depth <= 0) return null;

  const profileFlat = extractProfileFlat(profileId, entities);
  if (!profileFlat || profileFlat.length < 6) return null;

  let extDir: [number, number, number] = [0, 0, 1];
  if (extDirId) {
    const d = readDirectionRatios(extDirId, entities);
    if (d && d.length >= 3) extDir = [d[0]!, d[1]!, d[2]!];
  }

  const localMesh = buildExtrusionLocal(profileFlat, depth, extDir);
  if (!localMesh) return null;

  // Compose transform: world placement × solid's own coordinate system.
  const worldMat = placementId ? resolvePlacementMat(placementId, entities) : identityMat4();
  const solidMat = solidPosId ? (axis2Placement3DToMat4(solidPosId, entities) ?? identityMat4()) : identityMat4();
  const fullMat = mulMat4(worldMat, solidMat);

  applyMat4ToPositions(localMesh.positions, fullMat);

  return {
    expressId: eid,
    ifcType: elementTypes.get(eid) ?? 'UNKNOWN',
    name: elementNames.get(eid) ?? null,
    positions: localMesh.positions,
    indices: localMesh.indices,
    bbox: computeBbox(localMesh.positions),
  };
}

/**
 * Extract world-space meshes for all product elements that have an
 * IfcExtrudedAreaSolid geometry item reachable from their Representation.
 */
export function extractGeometry(
  entities: Map<number, EntityRecord>,
  elementIds: number[],
  elementTypes: Map<number, string>,
  elementNames: Map<number, string | null>,
  placementIds: Map<number, number>,
  repIds: Map<number, number>,
): GeometryResult {
  const start = Date.now();
  const meshes: ElementMesh[] = [];
  let attempted = 0;
  let skipped = 0;

  for (const eid of elementIds) {
    attempted++;
    const mesh = processElement(eid, entities, elementTypes, elementNames, placementIds, repIds);
    if (mesh === null) { skipped++; continue; }
    meshes.push(mesh);
  }

  return { meshes, attempted, skipped, elapsedMs: Date.now() - start };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming variant
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractGeometryStreamingOptions {
  /**
   * Number of meshes per batch flush. Default 100. Clamped to the
   * inclusive range `[1, 1000]`, the same contract as the HTTP route
   * `?batchSize=` query param so direct callers can't accidentally
   * produce a payload shape the route would reject.
   */
  batchSize?: number;
  /** Invoked once per filled batch. Buffer is reused; caller must copy if needed. */
  onBatch: (meshes: ElementMesh[], batchIndex: number) => void | Promise<void>;
}

export interface GeometryStreamingSummary {
  attempted: number;
  skipped: number;
  meshCount: number;
  batchCount: number;
  elapsedMs: number;
}

/**
 * Streaming variant of {@link extractGeometry}. Iterates the same element
 * loop as the collecting path but flushes meshes via `onBatch` as soon as
 * `batchSize` meshes have accumulated, rather than holding them all in
 * memory and serialising at the end. This lets the HTTP layer flush
 * NDJSON chunks to the client mid-conversion so first-triangle latency
 * scales with `batchSize × per-element-cost` instead of total model size.
 *
 * Mesh output is byte-identical to {@link extractGeometry} when the same
 * inputs are passed; they share `processElement` internally.
 *
 * Skipped/attempted counters in the returned summary include all
 * elements, even those that produced no mesh.
 */
export async function extractGeometryStreaming(
  entities: Map<number, EntityRecord>,
  elementIds: number[],
  elementTypes: Map<number, string>,
  elementNames: Map<number, string | null>,
  placementIds: Map<number, number>,
  repIds: Map<number, number>,
  options: ExtractGeometryStreamingOptions,
): Promise<GeometryStreamingSummary> {
  const rawBatchSize = options.batchSize ?? 100;
  const batchSize = Math.min(1000, Math.max(1, rawBatchSize));
  const start = Date.now();
  let attempted = 0;
  let skipped = 0;
  let meshCount = 0;
  let batchIndex = 0;
  let buffer: ElementMesh[] = [];

  for (const eid of elementIds) {
    attempted++;
    const mesh = processElement(eid, entities, elementTypes, elementNames, placementIds, repIds);
    if (mesh === null) { skipped++; continue; }
    buffer.push(mesh);
    meshCount++;
    if (buffer.length >= batchSize) {
      const flushing = buffer;
      buffer = [];
      await options.onBatch(flushing, batchIndex++);
    }
  }

  if (buffer.length > 0) {
    await options.onBatch(buffer, batchIndex++);
  }

  return {
    attempted,
    skipped,
    meshCount,
    batchCount: batchIndex,
    elapsedMs: Date.now() - start,
  };
}
