/**
 * Read-only metadata index: the JSON shape persisted to
 * `backend/data/ifc-index/{sha256}.json` and consumed by the Python
 * Ask-mode tool router.
 *
 * Keep field names in `snake_case` so the Python side can deserialize
 * straight into Pydantic models without remapping. (TS likes camelCase;
 * we accept the awkwardness on this seam because the stable contract is
 * with Python, not with intra-sidecar code.)
 *
 * V1 captures: schema, header, project info, spatial tree (project →
 * site → building → storey → space), element catalog (id, GlobalId,
 * type, name, description, storey), per-type and per-storey indices.
 *
 * V1 deliberately omits: property sets, materials, classifications,
 * geometry, type objects, quantities. They land in V1.5 / V2 as
 * additive fields on this same shape: old clients see fewer keys, new
 * clients see more.
 */

import type { HeaderRecord, ParseStats } from './types.js';

/** A single entry in the spatial structure tree. */
export interface SpatialNode {
  id: number;
  global_id: string | null;
  type: string;
  name: string | null;
  parent_id: number | null;
  /** Express IDs of children in the spatial tree (sub-storeys, spaces, etc.). */
  child_ids: number[];
}

/** A single building element, denormalised for fast lookups. */
export interface ElementSummary {
  id: number;
  global_id: string | null;
  type: string;
  name: string | null;
  description: string | null;
  /** Express ID of the containing storey (null if uncontained). */
  storey_id: number | null;
  /** Storey *name*, denormalised so callers don't need a join. */
  storey_name: string | null;
}

/** A property in an IfcPropertySet. V1 string-coerces values. */
export interface PropertyValue {
  name: string;
  /** Best-effort string repr of the value. Null for $/missing. */
  value: string | null;
  /** STEP type tag if known (e.g. `IFCLABEL`, `IFCREAL`). */
  value_type: string | null;
}

/** One IfcPropertySet, flattened. */
export interface PropertySet {
  id: number;
  name: string | null;
  description: string | null;
  properties: PropertyValue[];
}

/** Project-level summary (from IfcProject). */
export interface ProjectInfo {
  id: number;
  global_id: string | null;
  name: string | null;
  description: string | null;
  long_name: string | null;
  phase: string | null;
}

/** Statistics about the index build (counts, timing). */
export interface IndexStats extends ParseStats {
  /** Time spent in the lexer pass. */
  lex_ms: number;
  /** Time spent assembling the metadata index after lexing. */
  index_ms: number;
  /** Total wall-clock from request to response. */
  total_ms: number;
  /** Number of distinct storeys. */
  storey_count: number;
  /** Total IfcProduct elements (excluding IfcOpeningElement). */
  element_count: number;
}

/**
 * Property name → value list for a single IfcPropertySet.
 * Used by `all_pset_names` for fast "what properties exist in this model?" queries.
 */
export interface PsetIndex {
  /** Map of pset_name → sorted list of property names inside it. */
  [psetName: string]: string[];
}

/** The full V1.5 metadata index JSON. */
export interface MetadataIndex {
  /** Schema version of THIS index format (bumped on incompatible changes). */
  index_version: number;
  /** Sidecar version that produced this index (for cache invalidation). */
  producer_version: string;
  /** SHA-256 of the IFC bytes the index was built from. */
  source_sha256: string;
  /** Source IFC byte count. */
  source_bytes: number;
  /** Schema declared in FILE_SCHEMA. */
  schema: string | null;
  /** Header parsed from HEADER section. */
  header: HeaderRecord;
  /** IfcProject summary (one per file). */
  project: ProjectInfo | null;
  /** Spatial tree, keyed by Express ID. */
  spatial: Record<number, SpatialNode>;
  /** Express IDs of root-level spatial nodes (typically the project). */
  spatial_roots: number[];
  /** Storeys in display order (Elevation if available, else Express ID). */
  storey_ids: number[];
  /** Element catalog, keyed by Express ID. */
  elements: Record<number, ElementSummary>;
  /** Type histogram: `IFCWALL` → 84 etc. (Counts excluding IfcOpeningElement.) */
  by_type: Record<string, number>;
  /** Express IDs grouped by type: `IFCWALL` → [12, 34, 56]. */
  ids_by_type: Record<string, number[]>;
  /** Element IDs grouped by storey: storey_id → [element_ids]. */
  ids_by_storey: Record<number, number[]>;
  /** GlobalId → Express ID map for fast lookups. */
  id_by_global_id: Record<string, number>;
  /** Materials referenced in the file (names, deduplicated, sorted). */
  materials: string[];
  /**
   * V1.5: property sets per element.
   * Key = Express ID (as string, JSON limitation).
   * Value = list of IfcPropertySet records with all their properties.
   * Empty object on old V1 caches without property data.
   */
  element_psets: Record<number, PropertySet[]>;
  /**
   * V1.5: all distinct pset names + their property names in this model.
   * Used by `get_all_property_names` and `search_by_property` fast-path.
   * Empty on old V1 caches.
   */
  all_pset_names: PsetIndex;
  /** Build statistics. */
  stats: IndexStats;
}

/** Current index format version. Bump on incompatible changes. */
export const INDEX_VERSION = 1;
