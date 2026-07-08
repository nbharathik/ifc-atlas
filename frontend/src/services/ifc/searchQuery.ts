// Query-syntax parser for the multi-field model search.
//
// Grammar (whitespace-separated tokens; double quotes group spaces anywhere
// inside a token, e.g. storey:"Ground Floor" or pset:Door.Notes="fire rated"):
//   bare term                      fuzzy match on name / IFC class / ObjectType / GlobalId
//   type:IfcWall  | type:wall      IFC class filter (exact when the value starts with "ifc",
//                                  substring otherwise; always case-insensitive)
//   storey:"Ground Floor"          storey filter (case-insensitive substring)
//   pset:Pset_X.Prop=value         property value in a named pset
//   pset:Prop=value                property value in any pset
//   pset:Prop                      property presence check
//   class:Uniclass.Ss_25_10        classification system/code (case-insensitive substring)
// Unknown prefixes fall through as bare terms. Parsing never throws.

export interface PsetFilter {
  /** Property-set name; null = match the property in any pset. */
  pset: string | null;
  prop: string;
  /** Value to compare (case-insensitive; booleans and numbers normalized); null = presence check. */
  value: string | null;
}

export interface ParsedQuery {
  /** Original query string, echoed back in SearchResult.query. */
  raw: string;
  /** Bare fuzzy terms; all must match (AND). */
  terms: string[];
  /** Values from type: tokens. */
  typeFilters: string[];
  /** Values from storey: tokens. */
  storeyFilters: string[];
  /** Filters from pset: tokens. */
  psetFilters: PsetFilter[];
  /** Values from class: tokens. */
  classFilters: string[];
  /** True when any filter needs the lazily-built pset/classification layer. */
  needsEnrichment: boolean;
  /** True when the query contains no terms and no filters. */
  isEmpty: boolean;
}

const KNOWN_PREFIXES = new Set(['type', 'storey', 'pset', 'class']);

export function parseSearchQuery(raw: string): ParsedQuery {
  const terms: string[] = [];
  const typeFilters: string[] = [];
  const storeyFilters: string[] = [];
  const psetFilters: PsetFilter[] = [];
  const classFilters: string[] = [];

  for (const token of splitTokens(raw)) {
    const colon = token.indexOf(':');
    // A leading colon (or none) means there is no prefix to dispatch on.
    if (colon <= 0 || colon === token.length - 1) {
      terms.push(token);
      continue;
    }
    const prefix = token.slice(0, colon).toLowerCase();
    if (!KNOWN_PREFIXES.has(prefix)) {
      terms.push(token);
      continue;
    }
    const rest = token.slice(colon + 1);
    if (prefix === 'type') {
      typeFilters.push(rest);
    } else if (prefix === 'storey') {
      storeyFilters.push(rest);
    } else if (prefix === 'class') {
      classFilters.push(rest);
    } else {
      const filter = parsePsetRest(rest);
      if (filter) psetFilters.push(filter);
      else terms.push(token);
    }
  }

  const isEmpty =
    terms.length === 0 &&
    typeFilters.length === 0 &&
    storeyFilters.length === 0 &&
    psetFilters.length === 0 &&
    classFilters.length === 0;

  return {
    raw,
    terms,
    typeFilters,
    storeyFilters,
    psetFilters,
    classFilters,
    needsEnrichment: psetFilters.length > 0 || classFilters.length > 0,
    isEmpty,
  };
}

/** Parses the value part of a pset: token; null when there is no property name. */
function parsePsetRest(rest: string): PsetFilter | null {
  const eq = rest.indexOf('=');
  const left = eq >= 0 ? rest.slice(0, eq) : rest;
  const rawValue = eq >= 0 ? rest.slice(eq + 1) : null;
  const dot = left.indexOf('.');
  // A leading dot (".Prop") has an empty pset name - treat it as any-pset.
  const pset = dot > 0 ? left.slice(0, dot) : null;
  const prop = dot >= 0 ? left.slice(dot + 1) : left;
  if (!prop) return null;
  // "pset:Prop=" (empty value) degrades to a presence check.
  return { pset, prop, value: rawValue ? rawValue : null };
}

/**
 * Splits on whitespace; double quotes toggle a mode where whitespace is kept
 * in the current token (the quotes themselves are dropped). An unclosed quote
 * consumes the rest of the input - parsing never fails.
 */
function splitTokens(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}
