/**
 * Metadata-index extractor.
 *
 * Walks an entity table built by `lexer.scanSections` and produces the
 * read-only `MetadataIndex` consumed by the Python Ask-mode tool router.
 *
 * V1 captures (per-element): id, GlobalId, type, name, description,
 * containing storey. Plus the spatial tree, type histogram, GlobalId
 * lookup, materials list, and project info.
 *
 * V1.5 / V2 will add property sets, classifications, materials per
 * element, quantities. The shape is forward-compatible: those land as
 * additive fields on `MetadataIndex` without changing existing keys.
 */

import {
  parseArgs,
  asString,
  asRef,
  asRefList,
} from './args.js';
import { buildHeader } from './header.js';
import type { EntityRecord } from './types.js';
import {
  INDEX_VERSION,
  type ElementSummary,
  type MetadataIndex,
  type ProjectInfo,
  type PropertySet,
  type PropertyValue,
  type SpatialNode,
  type IndexStats,
  type PsetIndex,
} from './index_types.js';
import type { ArgValue } from './args.js';

/** Convert a typed STEP value (e.g. `IFCLABEL('wall')`, `IFCREAL(2.4)`) to a string. */
function argToString(v: ArgValue | undefined): string | null {
  if (!v) return null;
  if (v.kind === 'null' || v.kind === 'omitted') return null;
  if (v.kind === 'string') return v.value;
  if (v.kind === 'integer' || v.kind === 'real') return String(v.value);
  if (v.kind === 'enum') return v.value; // .T. → 'T'  .UNDEFINED. → 'UNDEFINED'
  if (v.kind === 'typed') {
    // e.g. IFCLABEL('concrete') → inner is the string
    const inner = argToString(v.value);
    return inner;
  }
  if (v.kind === 'unknown') return v.raw || null;
  return null;
}

function argToType(v: ArgValue | undefined): string | null {
  if (!v) return null;
  if (v.kind === 'typed') return v.type; // 'IFCLABEL', 'IFCREAL', …
  if (v.kind === 'integer') return 'integer';
  if (v.kind === 'real') return 'real';
  if (v.kind === 'enum') return 'enum';
  if (v.kind === 'string') return 'string';
  return null;
}

/** Spatial-structure types: the tree, not the element catalog. */
const SPATIAL_TYPES: ReadonlySet<string> = new Set([
  'IFCPROJECT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCSPACE',
]);

/**
 * Type-name prefixes that are NOT building elements even though many of
 * their entities have GlobalIds (e.g. IfcRel* are IfcRoot subclasses).
 *
 * The heuristic: if a type starts with one of these AND it's not in
 * SPATIAL_TYPES, exclude it from the element catalog.
 */
const NON_ELEMENT_PREFIXES: readonly string[] = [
  'IFCREL', // relationships (IfcRelAggregates, IfcRelContainedInSpatialStructure, ...)
  'IFCPROPERTY', // property defs (IfcPropertySet, IfcPropertySingleValue, ...)
  'IFCQUANTITY', // quantity defs (IfcQuantityArea, IfcQuantityVolume, ...)
  'IFCPHYSICAL', // physical quantity bases
  'IFCELEMENTQUANTITY', // IfcElementQuantity is a quantity set, not an element
];

/**
 * Type-name suffixes that mark non-element entities. Catches:
 *   - IfcWallType, IfcWindowType, IfcDoorType, ... (type templates)
 *   - IfcWindowStyle, IfcDoorStyle, ... (legacy IFC2X3 type templates)
 *   - IfcWindowLiningProperties, IfcDoorPanelProperties, ... (param sets)
 *   - IfcSurfaceStyle, IfcTextStyle (presentation)
 *   - IfcDistributionPort (MEP connection point, not an element)
 */
const NON_ELEMENT_SUFFIXES: readonly string[] = [
  'TYPE',
  'STYLE',
  'PROPERTIES',
  'PORT',
];

/** Specific entity types to exclude even if they pass other filters. */
const EXPLICIT_EXCLUDES: ReadonlySet<string> = new Set([
  'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE',
  'IFCVIRTUALELEMENT',
  'IFCANNOTATION',
  'IFCGRID',
  'IFCSURFACEFEATURE',
  'IFCRELATIONSHIP',
  'IFCROOT',
  'IFCOWNERHISTORY',
  'IFCAPPLICATION',
  'IFCORGANIZATION',
  'IFCPERSON',
  'IFCPERSONANDORGANIZATION',
]);

/**
 * Quick GlobalId-shape check. IFC GlobalIds are 22-char base64-style
 * strings (`A-Za-z0-9_$`). Used to distinguish IfcRoot subclasses (which
 * have GlobalIds) from geometry primitives (which don't).
 */
function looksLikeGlobalId(s: string | null): boolean {
  if (s === null) return false;
  if (s.length !== 22) return false;
  for (let i = 0; i < 22; i++) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      c === 0x5f || // _
      c === 0x24; // $
    if (!ok) return false;
  }
  return true;
}

/** True if the type is a building element (not spatial, not a relationship, etc.). */
function isElementType(type: string): boolean {
  if (SPATIAL_TYPES.has(type)) return false;
  if (EXPLICIT_EXCLUDES.has(type)) return false;
  for (const prefix of NON_ELEMENT_PREFIXES) {
    if (type.startsWith(prefix)) return false;
  }
  for (const suffix of NON_ELEMENT_SUFFIXES) {
    if (type.endsWith(suffix)) return false;
  }
  return true;
}

/**
 * Read the IfcRoot four-tuple from the entity args:
 *   (GlobalId, OwnerHistory, Name, Description, ...)
 *
 * Returns nulls for missing/typed-wrapped/unrecognised positions.
 */
function readIfcRootHeader(rawArgs: string): {
  globalId: string | null;
  name: string | null;
  description: string | null;
} {
  const args = parseArgs(rawArgs);
  return {
    globalId: asString(args[0]),
    // arg[1] is OwnerHistory ref, skip
    name: asString(args[2]),
    description: asString(args[3]),
  };
}

/**
 * Build the metadata index from the raw entity table + header strings.
 *
 * @param entities      Express ID → entity record (output of lexer)
 * @param rawHeaders    Raw `TYPE(args)` strings from the HEADER section
 * @param sourceSha256  SHA-256 hex of the IFC bytes (for cache keying)
 * @param sourceBytes   Length of the IFC bytes
 * @param producerVersion `version` string from the sidecar `/health`
 * @param lexMs         How long the lexer pass took (ms)
 */
export function buildIndex(
  entities: Map<number, EntityRecord>,
  rawHeaders: string[],
  sourceSha256: string,
  sourceBytes: number,
  producerVersion: string,
  lexMs: number,
  warnings: string[],
): MetadataIndex {
  const indexStart = Date.now();

  // 1. Header: already parsed by `header.ts`.
  const header = buildHeader(rawHeaders);

  // 2. Walk the entity table once, bucketing by category. We do this in
  //    one pass to keep cache locality good; each entity's args string
  //    is only parsed when we know we care about it.
  const spatial: Record<number, SpatialNode> = Object.create(null);
  const elements: Record<number, ElementSummary> = Object.create(null);
  const byType: Record<string, number> = Object.create(null);
  const idsByType: Record<string, number[]> = Object.create(null);
  const idByGlobalId: Record<string, number> = Object.create(null);
  const materials = new Set<string>();

  // Relationships: collected during the first pass, applied in pass 2.
  const aggregates: Array<{ parent: number; children: number[] }> = [];
  const containments: Array<{ storey: number; children: number[] }> = [];
  // V1.5: IfcRelDefinesByProperties → (elements[], psetId)
  const psetRels: Array<{ elements: number[]; psetId: number }> = [];

  let projectId: number | null = null;
  let projectInfo: ProjectInfo | null = null;

  for (const [id, entity] of entities) {
    const t = entity.type;

    // Spatial-tree node: parse minimally and collect for the second pass.
    if (SPATIAL_TYPES.has(t)) {
      const head = readIfcRootHeader(entity.argsRaw);
      spatial[id] = {
        id,
        global_id: head.globalId,
        type: t,
        name: head.name,
        parent_id: null, // filled in pass 2
        child_ids: [],
      };
      if (head.globalId !== null) idByGlobalId[head.globalId] = id;

      if (t === 'IFCPROJECT') {
        // IfcProject has more fields: long_name (idx 5), phase (idx 6).
        const args = parseArgs(entity.argsRaw);
        projectId = id;
        projectInfo = {
          id,
          global_id: head.globalId,
          name: head.name,
          description: head.description,
          long_name: asString(args[5]),
          phase: asString(args[6]),
        };
      }
      continue;
    }

    // Aggregation relationship, used to connect spatial parent → child.
    if (t === 'IFCRELAGGREGATES') {
      // (GlobalId, OwnerHistory, Name, Description,
      //  RelatingObject:#ref, RelatedObjects: list of #refs)
      const args = parseArgs(entity.argsRaw);
      const parent = asRef(args[4]);
      const children = asRefList(args[5]);
      if (parent !== null && children.length > 0) {
        aggregates.push({ parent, children });
      }
      continue;
    }

    // Containment relationship, connects storey → elements.
    if (t === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
      // (GlobalId, OwnerHistory, Name, Description,
      //  RelatedElements: list, RelatingStructure: ref)
      const args = parseArgs(entity.argsRaw);
      const children = asRefList(args[4]);
      const storey = asRef(args[5]);
      if (storey !== null && children.length > 0) {
        containments.push({ storey, children });
      }
      continue;
    }

    // V1.5: IfcRelDefinesByProperties links elements to property sets.
    // args: [GlobalId, OwnerHistory, Name, Description,
    //        RelatedObjects(list), RelatingPropertyDefinition(ref)]
    if (t === 'IFCRELDEFINESBYPROPERTIES') {
      const args = parseArgs(entity.argsRaw);
      const elemIds = asRefList(args[4]);
      const psetId = asRef(args[5]);
      if (psetId !== null && elemIds.length > 0) {
        psetRels.push({ elements: elemIds, psetId });
      }
      continue;
    }

    // Materials: IFC has IfcMaterial, IfcMaterialLayer (which references
    // an IfcMaterial), etc. V1 only collects the top-level Material name.
    if (t === 'IFCMATERIAL') {
      const args = parseArgs(entity.argsRaw);
      const name = asString(args[0]);
      if (name !== null && name.length > 0) materials.add(name);
      continue;
    }

    // Element catalogue (IfcRoot subclass that is not spatial / not Rel /
    // not Property / not opening / not type-template).
    if (isElementType(t)) {
      const head = readIfcRootHeader(entity.argsRaw);
      // Drop entities that don't actually look like building elements
      // (e.g. IfcOwnerHistory has a GUID-shaped first arg in the wild
      // and would slip through the prefix filter; this guard catches
      // the common false positives).
      if (!looksLikeGlobalId(head.globalId)) continue;
      elements[id] = {
        id,
        global_id: head.globalId,
        type: t,
        name: head.name,
        description: head.description,
        storey_id: null,
        storey_name: null,
      };
      if (head.globalId !== null) idByGlobalId[head.globalId] = id;
      byType[t] = (byType[t] ?? 0) + 1;
      (idsByType[t] ??= []).push(id);
    }
  }

  // 3. Apply aggregates → spatial tree parent/child links.
  for (const { parent, children } of aggregates) {
    const parentNode = spatial[parent];
    if (!parentNode) continue;
    for (const childId of children) {
      const childNode = spatial[childId];
      if (childNode) {
        childNode.parent_id = parent;
        parentNode.child_ids.push(childId);
      }
    }
  }

  // 4. Apply containments → element.storey_id + element.storey_name.
  const idsByStorey: Record<number, number[]> = Object.create(null);
  for (const { storey, children } of containments) {
    const storeyNode = spatial[storey];
    const storeyName = storeyNode?.name ?? null;
    const bucket = (idsByStorey[storey] ??= []);
    for (const elemId of children) {
      const elem = elements[elemId];
      if (elem) {
        elem.storey_id = storey;
        elem.storey_name = storeyName;
        bucket.push(elemId);
      }
    }
  }

  // 5. V1.5: extract property sets and build element_psets + all_pset_names.
  const elementPsets: Record<number, PropertySet[]> = Object.create(null);
  const allPsetNames: PsetIndex = Object.create(null);

  for (const { elements: elemIds, psetId } of psetRels) {
    const psetEntity = entities.get(psetId);
    if (!psetEntity) continue;
    // IfcPropertySet: [GlobalId, OwnerHistory, Name, Description, HasProperties(list)]
    // IfcElementQuantity has the same layout; include it for completeness.
    const isSet =
      psetEntity.type === 'IFCPROPERTYSET' ||
      psetEntity.type === 'IFCELEMENTQUANTITY';
    if (!isSet) continue;

    const psetArgs = parseArgs(psetEntity.argsRaw);
    const psetName = asString(psetArgs[2]) ?? psetEntity.type;
    const propIds = asRefList(psetArgs[4]);

    const properties: PropertyValue[] = [];
    for (const propId of propIds) {
      const propEntity = entities.get(propId);
      if (!propEntity) continue;
      const propArgs = parseArgs(propEntity.argsRaw);

      if (
        propEntity.type === 'IFCPROPERTYSINGLEVALUE' ||
        propEntity.type === 'IFCPROPERTYBOUNDEDVALUE'
      ) {
        // args: [Name, Description, NominalValue(typed), Unit(ref|$)]
        const name = asString(propArgs[0]);
        if (!name) continue;
        const nomVal = propArgs[2];
        properties.push({
          name,
          value: argToString(nomVal),
          value_type: argToType(nomVal),
        });
      } else if (propEntity.type === 'IFCPROPERTYENUMERATEDVALUE') {
        // args: [Name, Description, EnumerationValues(list), EnumRef(ref|$)]
        const name = asString(propArgs[0]);
        if (!name) continue;
        const listArg = propArgs[2];
        let enumStr: string | null = null;
        if (listArg?.kind === 'list' && listArg.value.length > 0) {
          enumStr = listArg.value.map(argToString).filter((s) => s !== null).join(', ');
        }
        properties.push({ name, value: enumStr, value_type: 'enum' });
      } else if (
        propEntity.type === 'IFCQUANTITYLENGTH' ||
        propEntity.type === 'IFCQUANTITYAREA' ||
        propEntity.type === 'IFCQUANTITYVOLUME' ||
        propEntity.type === 'IFCQUANTITYCOUNT' ||
        propEntity.type === 'IFCQUANTITYWEIGHT' ||
        propEntity.type === 'IFCQUANTITYTIME'
      ) {
        // args: [Name, Description, Unit(ref|$), Value(real)]
        const name = asString(propArgs[0]);
        if (!name) continue;
        const valArg = propArgs[3];
        properties.push({
          name,
          value: argToString(valArg),
          value_type: propEntity.type.replace('IFCQUANTITY', '').toLowerCase(),
        });
      }
    }

    if (properties.length === 0) continue;

    const pset: PropertySet = {
      id: psetId,
      name: psetName,
      description: asString(psetArgs[3]),
      properties,
    };

    // Update all_pset_names index.
    if (!(psetName in allPsetNames)) allPsetNames[psetName] = [];
    for (const p of properties) {
      if (!allPsetNames[psetName]!.includes(p.name)) {
        allPsetNames[psetName]!.push(p.name);
      }
    }

    // Attach to every element referenced by this relationship.
    for (const elemId of elemIds) {
      if (!(elemId in elements)) continue; // skip non-product refs
      if (!(elemId in elementPsets)) elementPsets[elemId] = [];
      elementPsets[elemId]!.push(pset);
    }
  }

  // Sort property names inside each pset for deterministic output.
  for (const names of Object.values(allPsetNames)) names.sort();

  // 6a. Spatial roots = nodes whose parent_id is null (typically just project).
  const spatialRoots: number[] = [];
  for (const id in spatial) {
    if (spatial[id].parent_id === null) spatialRoots.push(Number(id));
  }
  spatialRoots.sort((a, b) => a - b);

  // 6b. Storey order: Express ID for V1; V2 reads IfcBuildingStorey.Elevation.
  const storeyIds: number[] = [];
  for (const id in spatial) {
    if (spatial[id].type === 'IFCBUILDINGSTOREY') storeyIds.push(Number(id));
  }
  storeyIds.sort((a, b) => a - b);

  const indexEnd = Date.now();
  const indexMs = indexEnd - indexStart;
  const totalMs = lexMs + indexMs;

  const elementCount = Object.keys(elements).length;
  const stats: IndexStats = {
    inputBytes: sourceBytes,
    entityCount: entities.size,
    byType,
    parseMs: lexMs, // legacy field: total lex time
    warningCount: warnings.length,
    warnings: warnings.slice(0, 32),
    lex_ms: lexMs,
    index_ms: indexMs,
    total_ms: totalMs,
    storey_count: storeyIds.length,
    element_count: elementCount,
  };

  return {
    index_version: INDEX_VERSION,
    producer_version: producerVersion,
    source_sha256: sourceSha256,
    source_bytes: sourceBytes,
    schema: header.schema,
    header,
    project: projectInfo,
    spatial,
    spatial_roots: spatialRoots,
    storey_ids: storeyIds,
    elements,
    by_type: byType,
    ids_by_type: idsByType,
    ids_by_storey: idsByStorey,
    id_by_global_id: idByGlobalId,
    materials: [...materials].sort(),
    element_psets: elementPsets,
    all_pset_names: allPsetNames,
    stats,
  };
}
