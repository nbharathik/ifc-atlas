/**
 * Native IFC parser: V1 type surface.
 *
 * This is a TypeScript reference implementation of the custom STEP parser
 * planned for the incremental backend parser initiative. V1 ships in TS; the
 * algorithm and protocol stay portable so a Rust port can remain a mechanical
 * translation of `lexer.ts`.
 *
 * V1 scope: tokenize STEP, build an entity table keyed by Express ID, and
 * record a per-type histogram. No argument typing, no reference resolution,
 * no geometry.
 */

/**
 * One DATA-section entity, raw form. The `argsRaw` field holds the source
 * text between the outer `(` and `)` (exclusive). V2 will replace this with
 * a typed `Args` array.
 */
export interface EntityRecord {
  /** Express ID, the integer after `#`. Unique within the model. */
  expressId: number;
  /** UPPERCASE entity type, e.g. `IFCWALL`, `IFCCARTESIANPOINT`. */
  type: string;
  /** Source text between the outer `(` and `)` of the entity arg list. */
  argsRaw: string;
  /** Byte offset where the `#` starts. Useful for round-trip + diagnostics. */
  startOffset: number;
  /** Byte offset just past the closing `;`. */
  endOffset: number;
}

/**
 * Header section, lightly parsed. Only the three standard SPF entities are
 * surfaced; anything else in HEADER is preserved as a raw string under
 * `extras` for diagnostics.
 */
export interface HeaderRecord {
  /** Schema declared in FILE_SCHEMA, e.g. `IFC2X3`, `IFC4`, `IFC4X3`. */
  schema: string | null;
  /** FILE_DESCRIPTION first arg-list (description strings). */
  description: string[];
  /** FILE_DESCRIPTION second arg (implementation level), e.g. `2;1`. */
  implementationLevel: string | null;
  /** FILE_NAME args, in order. Indices: 0=name, 1=time_stamp, 2=author[],
   *  3=organization[], 4=preprocessor_version, 5=originating_system,
   *  6=authorization. We keep them as raw strings for V1. */
  fileName: {
    name: string | null;
    timeStamp: string | null;
    author: string[];
    organization: string[];
    preprocessorVersion: string | null;
    originatingSystem: string | null;
    authorization: string | null;
  };
  /** Any non-FILE_DESCRIPTION/NAME/SCHEMA HEADER entries kept verbatim. */
  extras: string[];
}

/** Statistics gathered while parsing. */
export interface ParseStats {
  /** Total bytes scanned. */
  inputBytes: number;
  /** Entities successfully recorded in the DATA section. */
  entityCount: number;
  /** Map of `IFCTYPE` → count. */
  byType: Record<string, number>;
  /** Wall-clock parse duration. */
  parseMs: number;
  /** Entries that failed a sanity check (skipped, not aborted). */
  warningCount: number;
  /** First N warnings, for debugging. */
  warnings: string[];
}

/** Top-level parse result returned by the HTTP `/parse` endpoint. */
export interface ParseResult {
  header: HeaderRecord;
  /**
   * The full entity table is large (50 MB IFC → ~1M+ entities once V2
   * lands; even V1 produces ~145k for BasicHouse.ifc). The HTTP route
   * default is to omit `entities` and only return summary stats. Callers
   * that want the full table pass `?withEntities=1`.
   */
  entities?: EntityRecord[];
  stats: ParseStats;
}

/**
 * Minimum-warnings cap before we stop accumulating to avoid an unbounded
 * memory spike on a corrupt file. The total warningCount is still tracked.
 */
export const MAX_RECORDED_WARNINGS = 32;
