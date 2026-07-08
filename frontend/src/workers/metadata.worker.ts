/// <reference lib="webworker" />
//
// Metadata worker - a parallel web-ifc pass over the raw IFC bytes so we
// can read psets / materials / quantities without bloating the geometry
// import. The @thatopen/fragments import strips IsDefinedBy and
// HasAssociations for speed; this worker fills that gap on demand.
//
// RPC protocol (postMessage):
//   req { id, type: 'init', bytes: Uint8Array }
//   req { id, type: 'getElement', expressId: number }
//   req { id, type: 'getElementsByIds', expressIds: number[] }
//   req { id, type: 'dispose' }
//   res { id, ok: true, result: any } | { id, ok: false, error: string }
//
// The worker runs a full web-ifc parse once on init(), then answers every
// getElement call by walking the in-memory entity graph - so there's no
// per-click round-trip to the Python backend.

// IMPORTANT: side-effect import - patches WEBIFC.IfcAPI.prototype.Init to
// force single-thread. Must come BEFORE `import * as WEBIFC` so the
// prototype is patched before any IfcAPI is constructed.
import '../services/ifc/webIfcPatch';
import * as WEBIFC from 'web-ifc';
import { buildClassificationGroups } from './classificationBuilder';
import type { RawClassification, RawReference, RawRelation } from './classificationBuilder';

type Request =
  | { id: number; type: 'init'; bytes: Uint8Array }
  | { id: number; type: 'getElement'; expressId: number }
  | { id: number; type: 'getElementsByIds'; expressIds: number[] }
  | { id: number; type: 'getClassifications' }
  | { id: number; type: 'getOwnerMap' }
  | { id: number; type: 'getGlobalIdMap' }
  | { id: number; type: 'dispose' };

interface PropertySet {
  name: string;
  properties: Record<string, string | number | boolean | null>;
}

interface ElementDetailPayload {
  id: number;
  global_id: string;
  name: string | null;
  ifc_type: string;
  storey: string | null;
  material: string | null;
  property_sets: PropertySet[];
  quantities: Record<string, number>;
  relating_type: string | null;
  description: string | null;
  object_type: string | null;
  tag: string | null;
  predefined_type: string | null;
}

let api: WEBIFC.IfcAPI | null = null;
let modelID = -1;

// Cached mapping from expressID to containing storey name. Built on init
// so every subsequent getElement is O(1) instead of walking
// IfcRelContainedInSpatialStructure each time.
const storeyNameByContained = new Map<number, string>();

// Forward-walk owner index: maps any sub-entity express id (an
// IfcProductDefinitionShape, IfcShapeRepresentation, IfcRepresentationItem,
// IfcMappedItem, IfcStyledItem, etc.) to the express id of the IfcProduct
// it belongs to. Built once in initModel() because IFC defines no
// standard inverse from a representation item back to its containing
// representation - only the forward chain Product → ProductDefinitionShape
// → Representations → Items reaches them. Fragments raycast can return
// any of these as `itemId`, so without this index a click on raw geometry
// (IfcExtrudedAreaSolid, IfcMappedItem, IfcPolyline, IfcFacetedBrep,
// IfcBooleanClippingResult) cannot be resolved to a product and the
// properties panel falls back to "unavailable".
const SHARED_OWNER_SENTINEL = -1;
const owningProductByGeomId = new Map<number, number>();

// Maps every IFC GlobalId (string GUID) to the entity's IFC Express ID.
// Populated for spatial containers (IfcProject / IfcSite / IfcBuilding /
// IfcBuildingStorey / IfcSpace) plus every product reachable via the
// owning-product index above. Sent to ModelService so the spatial-tree
// builder can attach `expressId` to each SpatialNode - without that,
// tree clicks dispatch the FragmentsModel localId into a slot the rest
// of the codebase treats as an Express ID, and viewer ↔ tree highlight
// sync silently mis-matches whenever the two id spaces diverge.
const productGlobalIdByExpressId = new Map<number, string>();
const SPATIAL_CONTAINER_TYPES = [
  WEBIFC.IFCPROJECT,
  WEBIFC.IFCSITE,
  WEBIFC.IFCBUILDING,
  WEBIFC.IFCBUILDINGSTOREY,
  WEBIFC.IFCSPACE,
];

// Memoise GetLine() results inside the worker. Each call to getElement(id)
// triggers ~30 GetLine calls (psets, properties, materials, relating type).
// Property-set definitions like Pset_WallCommon are SHARED across many
// elements (e.g. 100 walls all reference the same Pset_WallCommon Eid),
// so caching the resolved line means walls 2-100 don't re-parse the
// shared psets. In practice this turns a 50-100 ms property fetch into
// ~5-15 ms for elements similar to ones already inspected.
//
// Two caches: one for the (flatten=true, inverse=false) variant used by
// resolveLine, one for (flatten=true, inverse=true) used by the main
// getElement entry. They contain different shaped objects.
const lineCacheNoInverse = new Map<number, any>();
const lineCacheWithInverse = new Map<number, any>();
// Soft cap to prevent unbounded growth on huge models.
const MAX_LINE_CACHE = 50_000;
function setLineCache(map: Map<number, any>, key: number, value: any): void {
  if (map.size < MAX_LINE_CACHE) map.set(key, value);
}

async function ensureApi(): Promise<WEBIFC.IfcAPI> {
  if (api) return api;
  const instance = new WEBIFC.IfcAPI();
  // Point at the local wasm (served from frontend/public/). BASE_URL keeps
  // this working on sub-path hosting (GH Pages project sites).
  instance.SetWasmPath(import.meta.env.BASE_URL || '/', true);
  // forceSingleThread=true - web-ifc's default Init() tries to spawn child
  // workers from the CURRENT script URL as classic workers, but our worker
  // file uses ES `import` syntax so the spawn fails with
  // "Cannot use import statement outside a module". Single-thread mode
  // skips that spawn and runs the WASM directly in this worker.
  await instance.Init(undefined, true);
  api = instance;
  return instance;
}

async function initModel(bytes: Uint8Array): Promise<void> {
  const ifcApi = await ensureApi();
  if (modelID >= 0) {
    try { ifcApi.CloseModel(modelID); } catch { /* noop */ }
    modelID = -1;
  }
  storeyNameByContained.clear();
  owningProductByGeomId.clear();
  productGlobalIdByExpressId.clear();
  // Wipe the per-model GetLine caches - stale entries from a prior load
  // would point at the old modelID and return wrong data.
  lineCacheNoInverse.clear();
  lineCacheWithInverse.clear();

  modelID = ifcApi.OpenModel(bytes);

  // Precompute storey-containment map so getElement is fast.
  try {
    const rels = ifcApi.GetLineIDsWithType(modelID, WEBIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    const size = rels.size();
    for (let i = 0; i < size; i++) {
      const relId = rels.get(i);
      let rel: any;
      try {
        rel = ifcApi.GetLine(modelID, relId, true);
      } catch {
        continue;
      }
      const storeyRef = rel?.RelatingStructure;
      const storeyExpressId = normalizeRef(storeyRef);
      if (!storeyExpressId) continue;
      let storey: any;
      try {
        storey = ifcApi.GetLine(modelID, storeyExpressId, false);
      } catch {
        continue;
      }
      const storeyName = readValue(storey?.Name) ?? readValue(storey?.LongName) ?? `Storey #${storeyExpressId}`;
      const related = rel?.RelatedElements;
      if (Array.isArray(related)) {
        for (const ref of related) {
          const id = normalizeRef(ref);
          if (id) storeyNameByContained.set(id, String(storeyName));
        }
      }
    }
  } catch {
    /* if this fails, storey resolution falls back to null */
  }

  // Build forward-walk owner index. Walks every IfcShapeRepresentation
  // backwards-and-forwards: backwards via the existing inverse chain to
  // discover the owning IfcProduct, then forwards through its Items[]
  // so each top-level IfcRepresentationItem (and the shape representation
  // itself, and its IfcProductDefinitionShape parent) maps to the product.
  // Also follows IfcMappedItem → MappingSource → MappedRepresentation →
  // Items[] so raycast hits on instanced geometry land on the right product.
  //
  // Conflict policy: shared mapped-geometry items reachable from multiple
  // products are poisoned to SHARED_OWNER_SENTINEL - resolveOwningProductId
  // then returns null so the panel shows "unavailable" rather than mis-
  // attributing to a random product.
  try {
    const repIds = ifcApi.GetLineIDsWithType(modelID, WEBIFC.IFCSHAPEREPRESENTATION);
    const repSize = repIds.size();
    for (let i = 0; i < repSize; i++) {
      const repId = repIds.get(i);
      let rep: any;
      try {
        // inverse=true so OfProductRepresentation is populated for the
        // existing resolveOwningProductId() walk-up below.
        rep = ifcApi.GetLine(modelID, repId, true, true);
      } catch {
        continue;
      }
      if (!rep) continue;
      const ownerId = resolveOwningProductIdFromLine(rep);
      if (ownerId == null) continue;

      assignOwner(repId, ownerId);

      // Record the IfcProductDefinitionShape that nests this shape rep so
      // a direct hit on the PDS also resolves to the product. PDS Express
      // id is reachable via the shape rep's OfProductRepresentation inverse.
      if (Array.isArray(rep.OfProductRepresentation)) {
        for (const ref of rep.OfProductRepresentation) {
          const pdsId = normalizeRef(ref);
          if (pdsId !== null) assignOwner(pdsId, ownerId);
        }
      }

      if (Array.isArray(rep.Items)) {
        for (const itemRef of rep.Items) {
          const itemId = normalizeRef(itemRef);
          if (itemId === null) continue;
          assignOwner(itemId, ownerId);

          // IfcMappedItem → MappingSource (IfcRepresentationMap) →
          // MappedRepresentation → its Items. Bring those one level in
          // so raycast on mapped geometry still resolves.
          let item: any;
          try {
            item = ifcApi.GetLine(modelID, itemId, false, false);
          } catch {
            continue;
          }
          if (!item) continue;
          const mapSrcRef = item.MappingSource;
          if (!mapSrcRef) continue;
          const mapSrcId = normalizeRef(mapSrcRef);
          if (mapSrcId === null) continue;
          let mapSrc: any;
          try {
            mapSrc = ifcApi.GetLine(modelID, mapSrcId, false, false);
          } catch {
            continue;
          }
          if (!mapSrc) continue;
          const mappedRepId = normalizeRef(mapSrc.MappedRepresentation);
          if (mappedRepId === null) continue;
          assignOwner(mappedRepId, ownerId);
          let mappedRep: any;
          try {
            mappedRep = ifcApi.GetLine(modelID, mappedRepId, false, false);
          } catch {
            continue;
          }
          if (!mappedRep || !Array.isArray(mappedRep.Items)) continue;
          for (const subRef of mappedRep.Items) {
            const subId = normalizeRef(subRef);
            if (subId !== null) assignOwner(subId, ownerId);
          }
        }
      }
    }
  } catch {
    /* index stays empty; getElement returns null for non-IfcRoot ids */
  }

  // Build the GlobalId → ExpressId map. Covers (a) spatial containers
  // (IfcProject..IfcSpace - these appear in the spatial tree but have no
  // geometry so they won't be in the owner index), (b) every IfcProduct
  // discovered as an owner above. ModelService composes this with the
  // FragmentsModel's localId → GlobalId table to attach SpatialNode.expressId.
  try {
    for (const t of SPATIAL_CONTAINER_TYPES) {
      const ids = ifcApi.GetLineIDsWithType(modelID, t);
      const size = ids.size();
      for (let i = 0; i < size; i++) {
        const eid = ids.get(i);
        let line: any;
        try { line = ifcApi.GetLine(modelID, eid, false, false); } catch { continue; }
        const guid = line && readValue(line.GlobalId);
        if (typeof guid === 'string' && guid) {
          productGlobalIdByExpressId.set(eid, guid);
        }
      }
    }
  } catch {
    /* spatial container enumeration failed; products below still ride */
  }

  const productEids = new Set<number>();
  for (const owner of owningProductByGeomId.values()) {
    if (owner !== SHARED_OWNER_SENTINEL) productEids.add(owner);
  }
  for (const eid of productEids) {
    if (productGlobalIdByExpressId.has(eid)) continue;
    let line: any;
    try { line = ifcApi.GetLine(modelID, eid, false, false); } catch { continue; }
    const guid = line && readValue(line.GlobalId);
    if (typeof guid === 'string' && guid) {
      productGlobalIdByExpressId.set(eid, guid);
    }
  }
}

function assignOwner(itemId: number, ownerId: number): void {
  const prev = owningProductByGeomId.get(itemId);
  if (prev === undefined) {
    owningProductByGeomId.set(itemId, ownerId);
    return;
  }
  if (prev === ownerId || prev === SHARED_OWNER_SENTINEL) return;
  // Same item reachable from a second product - shared geometry. Poison
  // so the caller can fall back to null instead of mis-attributing.
  owningProductByGeomId.set(itemId, SHARED_OWNER_SENTINEL);
}

// Variant of resolveOwningProductId() that does NOT consult the index -
// used during index construction (avoids self-referential lookups before
// the map is populated). Same body as resolveOwningProductId() minus the
// index check.
function resolveOwningProductIdFromLine(line: any): number | null {
  if (!line) return null;
  const ofProductRepresentation = line.OfProductRepresentation;
  if (Array.isArray(ofProductRepresentation)) {
    for (const ref of ofProductRepresentation) {
      const shapeDef = resolveLine(ref);
      if (!shapeDef) continue;
      const shapeOfProduct = shapeDef.ShapeOfProduct;
      if (!Array.isArray(shapeOfProduct)) continue;
      for (const pref of shapeOfProduct) {
        const pid = normalizeRef(pref);
        if (pid !== null) return pid;
      }
    }
  }
  // Direct IfcProductDefinitionShape → ShapeOfProduct.
  if (Array.isArray(line.ShapeOfProduct)) {
    for (const pref of line.ShapeOfProduct) {
      const pid = normalizeRef(pref);
      if (pid !== null) return pid;
    }
  }
  return null;
}

function getClassifications(): ReturnType<typeof buildClassificationGroups> {
  if (!api || modelID < 0) return [];

  const rawClassifications: RawClassification[] = [];
  try {
    const ids = api.GetLineIDsWithType(modelID, WEBIFC.IFCCLASSIFICATION);
    const size = ids.size();
    for (let i = 0; i < size; i++) {
      const eid = ids.get(i);
      try {
        const line = api.GetLine(modelID, eid, false);
        if (!line) continue;
        rawClassifications.push({
          eid,
          name: String(readValue(line.Name) ?? `Classification #${eid}`),
          source: (readValue(line.Source) as string | null) ?? null,
          edition: (readValue(line.Edition) as string | null) ?? null,
        });
      } catch { continue; }
    }
  } catch { /* no IfcClassification in this model */ }

  const rawReferences: RawReference[] = [];
  try {
    const ids = api.GetLineIDsWithType(modelID, WEBIFC.IFCCLASSIFICATIONREFERENCE);
    const size = ids.size();
    for (let i = 0; i < size; i++) {
      const eid = ids.get(i);
      try {
        const line = api.GetLine(modelID, eid, false);
        if (!line) continue;
        const code = (readValue(line.ItemReference) as string | null) ?? null;
        const name = String(readValue(line.Name) ?? code ?? `Ref #${eid}`);
        const sourceEid = normalizeRef(line.ReferencedSource);
        rawReferences.push({ eid, code, name, sourceEid });
      } catch { continue; }
    }
  } catch { /* no IfcClassificationReference */ }

  const rawRelations: RawRelation[] = [];
  try {
    const ids = api.GetLineIDsWithType(modelID, WEBIFC.IFCRELASSOCIATESCLASSIFICATION);
    const size = ids.size();
    for (let i = 0; i < size; i++) {
      const relEid = ids.get(i);
      try {
        const rel = api.GetLine(modelID, relEid, true);
        if (!rel) continue;
        const relatingClassificationEid = normalizeRef(rel.RelatingClassification);
        if (relatingClassificationEid == null) continue;
        const memberIds: number[] = [];
        if (Array.isArray(rel.RelatedObjects)) {
          for (const obj of rel.RelatedObjects) {
            const id = normalizeRef(obj);
            if (id) memberIds.push(id);
          }
        }
        rawRelations.push({ relatingClassificationEid, memberIds });
      } catch { continue; }
    }
  } catch { /* no relations */ }

  return buildClassificationGroups(rawClassifications, rawReferences, rawRelations);
}

function disposeModel(): void {
  if (api && modelID >= 0) {
    try { api.CloseModel(modelID); } catch { /* noop */ }
  }
  modelID = -1;
  storeyNameByContained.clear();
  owningProductByGeomId.clear();
  productGlobalIdByExpressId.clear();
  lineCacheNoInverse.clear();
  lineCacheWithInverse.clear();
}

function getOwnerMap(): Uint32Array {
  // Flatten Map<number, number> to a transferable Uint32Array of
  // [childExpressId, productExpressId, …] pairs. SHARED_OWNER_SENTINEL
  // entries are dropped - they would resolve to "ambiguous", and the
  // sync resolver on the main thread should fall back to the raw id.
  // Also seed each PRODUCT with a self-reference so that already-product
  // express ids resolve to themselves through resolveOwnerSync, giving
  // callers a single canonical "is this a known product?" check.
  const pairs: number[] = [];
  const seen = new Set<number>();
  for (const [child, owner] of owningProductByGeomId) {
    if (owner === SHARED_OWNER_SENTINEL) continue;
    pairs.push(child, owner);
    if (!seen.has(owner)) {
      seen.add(owner);
      pairs.push(owner, owner);
    }
  }
  // Spatial containers don't appear as owners in the geometry index but
  // ARE products in their own right; mark them as self-owners so a click
  // (or tree-pick) on a storey/space still resolves.
  for (const eid of productGlobalIdByExpressId.keys()) {
    if (!seen.has(eid)) {
      seen.add(eid);
      pairs.push(eid, eid);
    }
  }
  return Uint32Array.from(pairs);
}

interface GlobalIdMapEntry { expressId: number; globalId: string; }
function getGlobalIdMap(): GlobalIdMapEntry[] {
  const out: GlobalIdMapEntry[] = [];
  for (const [eid, guid] of productGlobalIdByExpressId) {
    out.push({ expressId: eid, globalId: guid });
  }
  return out;
}

/**
 * The fragments viewport raycast returns the express ID of whichever entity
 * the mesh maps to - for many models that's the IfcProduct, but for elements
 * with complex shape representations (e.g. IfcBuildingElementPart with a
 * detailed IfcShapeRepresentation) it's the representation's express ID. The
 * properties panel then renders an empty "IfcShapeRepresentation #N - no name,
 * no GlobalId" row.
 *
 * Walk up the IFC schema inverses to find the owning IfcProduct so the panel
 * (and any caller asking for an element's properties) always lands on the
 * IfcRoot subclass the user actually clicked. Returns null when no owner can
 * be reached - caller can then fall back to "no properties" as before.
 */
function resolveOwningProductId(line: any, expressId?: number): number | null {
  if (!line) return null;

  // Pre-built forward-walk index covers every IfcShapeRepresentation,
  // IfcProductDefinitionShape, IfcRepresentationItem subclass, IfcMappedItem,
  // and one level of mapped sub-items. Built in initModel() and consulted
  // here before any expensive line traversal.
  if (typeof expressId === 'number') {
    const indexed = owningProductByGeomId.get(expressId);
    if (indexed !== undefined) {
      return indexed === SHARED_OWNER_SENTINEL ? null : indexed;
    }
  }

  // Inverse fallback for non-indexed cases (e.g. legacy paths or models
  // where the forward walk didn't enumerate this entity):
  //   IfcShapeRepresentation → OfProductRepresentation (inverse) →
  //   IfcProductDefinitionShape → ShapeOfProduct (inverse) → IfcProduct.
  return resolveOwningProductIdFromLine(line);
}

function getElement(expressId: number): ElementDetailPayload | null {
  if (!api || modelID < 0) return null;

  let line: any = lineCacheWithInverse.get(expressId);
  if (line === undefined) {
    try {
      line = api.GetLine(modelID, expressId, true, true);
    } catch {
      return null;
    }
    if (line) setLineCache(lineCacheWithInverse, expressId, line);
  }
  if (!line) return null;

  // Non-IfcRoot entities (representations, geometry items, styled items) have
  // no GlobalId/Name/property sets. Walk up to the owning IfcProduct and
  // re-enter - the cached line lookup below makes the recursion cheap.
  // When walk-up fails (e.g. shared-mapped-geometry conflict, or some
  // exotic non-IfcRoot entity not covered by either the forward index or
  // the inverse chain), return null instead of building a hollow payload.
  // PropertiesPanel renders the "unavailable" state for null, but would
  // silently show empty rows for a hollow payload.
  if (!line.GlobalId) {
    const ownerId = resolveOwningProductId(line, expressId);
    if (ownerId !== null && ownerId !== expressId) {
      return getElement(ownerId);
    }
    return null;
  }

  const ifcType = typeof line.type === 'string'
    ? line.type
    : typeof line.constructor?.name === 'string'
      ? line.constructor.name
      : 'IfcElement';

  // Property sets via IsDefinedBy inverse relation.
  const property_sets: PropertySet[] = [];
  const quantities: Record<string, number> = {};
  const isDefinedBy = line.IsDefinedBy;
  if (Array.isArray(isDefinedBy)) {
    for (const rel of isDefinedBy) {
      const relObj = resolveLine(rel);
      if (!relObj) continue;
      const relatingDef = resolveLine(relObj.RelatingPropertyDefinition);
      if (!relatingDef) continue;
      const defName = readValue(relatingDef.Name) ?? '';
      if (Array.isArray(relatingDef.HasProperties) && defName) {
        const props: Record<string, string | number | boolean | null> = {};
        for (const propRef of relatingDef.HasProperties) {
          const prop = resolveLine(propRef);
          if (!prop) continue;
          const pName = readValue(prop.Name);
          if (!pName) continue;
          const pVal = extractPropertyValue(prop);
          if (pVal !== undefined) {
            props[String(pName)] = pVal;
          }
        }
        if (Object.keys(props).length > 0) {
          property_sets.push({ name: String(defName), properties: props });
        }
      }
      if (Array.isArray(relatingDef.Quantities)) {
        for (const qRef of relatingDef.Quantities) {
          const q = resolveLine(qRef);
          if (!q) continue;
          const qName = readValue(q.Name);
          const qValue = pickQuantityValue(q);
          if (qName && typeof qValue === 'number') {
            quantities[String(qName)] = qValue;
          }
        }
      }
    }
  }

  // Material via HasAssociations inverse.
  let material: string | null = null;
  const hasAssociations = line.HasAssociations;
  if (Array.isArray(hasAssociations)) {
    for (const rel of hasAssociations) {
      const relObj = resolveLine(rel);
      if (!relObj) continue;
      const relatingMaterial = resolveLine(relObj.RelatingMaterial);
      if (!relatingMaterial) continue;
      const candidate = materialName(relatingMaterial);
      if (candidate) {
        material = candidate;
        break;
      }
    }
  }

  // Relating type via IsTypedBy inverse (not stored on line by default
  // unless inverse=true fetched it; fall back to null if absent).
  let relating_type: string | null = null;
  const typed = line.IsTypedBy;
  if (Array.isArray(typed) && typed.length > 0) {
    const relObj = resolveLine(typed[0]);
    if (relObj) {
      const typeObj = resolveLine(relObj.RelatingType);
      if (typeObj) relating_type = readValue(typeObj.Name) as string | null;
    }
  }

  // Direct IFC attributes - same suppression rules as the backend so the
  // Identity panel never shows NOTDEFINED / NOTKNOWN noise. PredefinedType
  // arrives from web-ifc as { value: 'EXTERNAL', ... } or a bare string;
  // readValue() unwraps both.
  let predefined_type: string | null = null;
  const predefRaw = readValue(line.PredefinedType);
  if (typeof predefRaw === 'string') {
    const upper = predefRaw.toUpperCase();
    if (upper !== 'NOTDEFINED' && upper !== 'NOTKNOWN' && upper !== 'USERDEFINED') {
      predefined_type = predefRaw;
    }
  }

  return {
    id: expressId,
    global_id: String(readValue(line.GlobalId) ?? ''),
    name: (readValue(line.Name) as string | null) ?? null,
    ifc_type: String(ifcType),
    storey: storeyNameByContained.get(expressId) ?? null,
    material,
    property_sets,
    quantities,
    relating_type,
    description: (readValue(line.Description) as string | null) ?? null,
    object_type: (readValue(line.ObjectType) as string | null) ?? null,
    tag: (readValue(line.Tag) as string | null) ?? null,
    predefined_type,
  };
}

function resolveLine(ref: unknown): any {
  if (!api || modelID < 0) return null;
  const expressId = normalizeRef(ref);
  if (!expressId) return null;
  const cached = lineCacheNoInverse.get(expressId);
  if (cached !== undefined) return cached;
  try {
    const line = api.GetLine(modelID, expressId, true);
    setLineCache(lineCacheNoInverse, expressId, line);
    return line;
  } catch {
    return null;
  }
}

function normalizeRef(ref: unknown): number | null {
  if (!ref) return null;
  if (typeof ref === 'number') return ref;
  if (typeof ref === 'object') {
    const obj = ref as { value?: unknown; expressID?: unknown };
    if (typeof obj.expressID === 'number') return obj.expressID;
    if (typeof obj.value === 'number') return obj.value;
  }
  return null;
}

function readValue(attr: unknown): unknown {
  if (attr === null || attr === undefined) return null;
  if (typeof attr === 'string' || typeof attr === 'number' || typeof attr === 'boolean') {
    return attr;
  }
  if (typeof attr === 'object' && 'value' in (attr as object)) {
    const inner = (attr as { value: unknown }).value;
    return inner;
  }
  return null;
}

// Extract a render-ready scalar from any IfcProperty subtype. The
// hand-walked IsDefinedBy reader previously only inspected NominalValue,
// silently dropping every property that wasn't a SingleValue - which is
// why the Properties tab looked empty for psets that used Enumerated /
// Bounded / List / Reference / Complex variants.
function extractPropertyValue(prop: any): string | number | boolean | null | undefined {
  // IfcPropertySingleValue
  const nominal = readValue(prop.NominalValue);
  if (nominal !== null && nominal !== undefined) {
    return nominal as string | number | boolean;
  }
  // IfcPropertyEnumeratedValue
  if (Array.isArray(prop.EnumerationValues)) {
    const parts = prop.EnumerationValues
      .map((v: unknown) => readValue(v))
      .filter((v: unknown) => v !== null && v !== undefined)
      .map(String);
    if (parts.length > 0) return parts.join(', ');
  }
  // IfcPropertyListValue
  if (Array.isArray(prop.ListValues)) {
    const parts = prop.ListValues
      .map((v: unknown) => readValue(v))
      .filter((v: unknown) => v !== null && v !== undefined)
      .map(String);
    if (parts.length > 0) return parts.join(', ');
  }
  // IfcPropertyBoundedValue
  const lower = readValue(prop.LowerBoundValue);
  const upper = readValue(prop.UpperBoundValue);
  const set = readValue(prop.SetPointValue);
  if (lower !== null || upper !== null || set !== null) {
    const segs: string[] = [];
    if (lower !== null) segs.push(`≥ ${lower}`);
    if (upper !== null) segs.push(`≤ ${upper}`);
    if (set !== null) segs.push(`set ${set}`);
    if (segs.length > 0) return segs.join(' / ');
  }
  // IfcPropertyReferenceValue
  if (prop.PropertyReference) {
    const ref = resolveLine(prop.PropertyReference);
    if (ref) {
      const refName = readValue(ref.Name);
      if (refName) return String(refName);
    }
  }
  // IfcComplexProperty - flatten one level so the user at least sees the
  // sub-property names rather than nothing.
  if (Array.isArray(prop.HasProperties)) {
    const parts: string[] = [];
    for (const subRef of prop.HasProperties) {
      const sub = resolveLine(subRef);
      if (!sub) continue;
      const subName = readValue(sub.Name);
      const subVal = extractPropertyValue(sub);
      if (subName && subVal !== undefined && subVal !== null) {
        parts.push(`${subName}=${subVal}`);
      }
    }
    if (parts.length > 0) return parts.join(', ');
  }
  return undefined;
}

function pickQuantityValue(q: any): number | undefined {
  // IfcQuantityLength / Area / Volume / Count / Weight / Time each store
  // their scalar on a slightly different attribute. Pick the first numeric.
  const keys = [
    'LengthValue',
    'AreaValue',
    'VolumeValue',
    'CountValue',
    'WeightValue',
    'TimeValue',
  ];
  for (const k of keys) {
    const v = readValue(q[k]);
    if (typeof v === 'number') return v;
  }
  return undefined;
}

function materialName(obj: any): string | null {
  if (!obj) return null;
  const direct = readValue(obj.Name);
  if (direct && typeof direct === 'string') return direct;
  // IfcMaterialLayerSetUsage -> ForLayerSet -> MaterialLayers -> Material.Name
  const layerSetUsage = resolveLine(obj.ForLayerSet);
  if (layerSetUsage && Array.isArray(layerSetUsage.MaterialLayers)) {
    const layer = resolveLine(layerSetUsage.MaterialLayers[0]);
    if (layer) {
      const mat = resolveLine(layer.Material);
      if (mat) return readValue(mat.Name) as string | null;
    }
  }
  // IfcMaterialLayerSet
  if (Array.isArray(obj.MaterialLayers)) {
    const layer = resolveLine(obj.MaterialLayers[0]);
    if (layer) {
      const mat = resolveLine(layer.Material);
      if (mat) return readValue(mat.Name) as string | null;
    }
  }
  // IfcMaterialList
  if (Array.isArray(obj.Materials)) {
    const mat = resolveLine(obj.Materials[0]);
    if (mat) return readValue(mat.Name) as string | null;
  }
  return null;
}

self.onmessage = async (evt: MessageEvent<Request>) => {
  const req = evt.data;
  const id = req?.id;
  try {
    if (req.type === 'init') {
      await initModel(req.bytes);
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result: null });
      return;
    }
    if (req.type === 'getElement') {
      const result = getElement(req.expressId);
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result });
      return;
    }
    if (req.type === 'getElementsByIds') {
      const result = req.expressIds.map((eid) => getElement(eid));
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result });
      return;
    }
    if (req.type === 'getClassifications') {
      const result = getClassifications();
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result });
      return;
    }
    if (req.type === 'getOwnerMap') {
      const result = getOwnerMap();
      // Transferable: zero-copy postMessage of the Uint32Array buffer.
      (self as unknown as { postMessage: (m: unknown, transfer?: Transferable[]) => void })
        .postMessage({ id, ok: true, result }, [result.buffer]);
      return;
    }
    if (req.type === 'getGlobalIdMap') {
      const result = getGlobalIdMap();
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result });
      return;
    }
    if (req.type === 'dispose') {
      disposeModel();
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: true, result: null });
      return;
    }
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({
      id,
      ok: false,
      error: `Unknown request type: ${(req as { type: string }).type}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ id, ok: false, error: msg });
  }
};

export {};
