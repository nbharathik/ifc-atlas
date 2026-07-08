/**
 * Public surface of the native IFC parser module.
 *
 * Callers should import from here, not from individual files, so we can
 * shuffle internals later without breaking the sidecar HTTP handler.
 */

export { parseIfc, parseIfcStatsOnly, type ParseOptions } from './parser.js';
export { scanSections, type ScanCallbacks } from './lexer.js';
export { buildIndex } from './extract.js';
export { buildHeader } from './header.js';
export {
  parseArgs,
  splitTopLevelArgs,
  parseValue,
  asString,
  asRef,
  asRefList,
  asEnum,
  type ArgValue,
} from './args.js';

export type {
  EntityRecord,
  HeaderRecord,
  ParseStats,
  ParseResult,
} from './types.js';

export type {
  MetadataIndex,
  ElementSummary,
  SpatialNode,
  ProjectInfo,
  PropertySet,
  PropertyValue,
  IndexStats,
} from './index_types.js';

export { INDEX_VERSION } from './index_types.js';
