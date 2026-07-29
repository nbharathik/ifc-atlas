import type { ElementSummary, SearchResult } from '../../types/ifc';

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

// Client-side inverted index over IFC element names, types, and GUIDs,
// plus a lazily-fed enrichment layer (ObjectType, property sets,
// classifications) that powers the multi-field query syntax.
// The base layer is built once per model load; queries are O(1) lookup +
// Set intersection so the SearchPanel feels instant on every keystroke.
// Enrichment is strictly on demand (see searchEnrichment.ts) - nothing here
// adds work to the model-load critical path.


export interface IndexedItem {
  id: number;           // itemId (expressID-equivalent) - what ModelService.select uses
  globalId: string;
  name: string | null;
  ifcType: string;
  storey: string | null;
}

export interface PsetEnrichment {
  pset: string;
  prop: string;
  /** Stringified property value ("" for null values - presence still matches). */
  value: string;
}

export interface ClassificationEnrichment {
  system: string;
  code: string;
}

export interface ElementEnrichment {
  objectType: string | null;
  psets: PsetEnrichment[];
  classifications: ClassificationEnrichment[];
}

const TOKEN_SPLIT = /[^\p{L}\p{N}_-]+/u;
const MIN_TOKEN_LEN = 2;
// Budget for the linear fallback when the inverted index yields no
// candidates - bounds worst-case keystroke cost on very large models.
const FUZZY_SCAN_CAP = 2000;

// fuzzyScore tiers. Gaps exceed the maximum length bonus so a weaker match
// tier can never out-score a stronger one.
const TIER_SUBSTRING = 3000;
const TIER_WORD_PREFIX = 2000;
const TIER_SUBSEQUENCE = 1000;
const LENGTH_BONUS_MAX = 500;

/**
 * Match strength of `query` against `text`. 0 = no match. Exact substring
 * outranks in-order word-prefix matches, which outrank an in-order character
 * subsequence. Within a tier, shorter targets score higher.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query || !text) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let tier: number;
  if (t.includes(q)) tier = TIER_SUBSTRING;
  else if (matchesWordPrefixes(q, t)) tier = TIER_WORD_PREFIX;
  else if (isSubsequence(q, t)) tier = TIER_SUBSEQUENCE;
  else return 0;
  return tier + Math.max(0, LENGTH_BONUS_MAX - t.length);
}

/** Every query word is a prefix of a distinct target word, in order. */
function matchesWordPrefixes(q: string, t: string): boolean {
  const qWords = q.split(TOKEN_SPLIT).filter(Boolean);
  const tWords = t.split(TOKEN_SPLIT).filter(Boolean);
  if (qWords.length === 0 || tWords.length === 0) return false;
  let ti = 0;
  for (const qw of qWords) {
    while (ti < tWords.length && !tWords[ti].startsWith(qw)) ti++;
    if (ti >= tWords.length) return false;
    ti++;
  }
  return true;
}

/** Characters of `q` appear in `t` in order (not necessarily contiguous). */
function isSubsequence(q: string, t: string): boolean {
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export class SearchIndex {
  private readonly byToken = new Map<string, Set<number>>();
  private readonly items = new Map<number, IndexedItem>();

  // Enrichment layer (fed lazily by searchEnrichment.ts).
  private readonly objectTypeById = new Map<number, string>();
  // Keyed by lowercase "<pset>.<prop>" AND bare "<prop>" so pset filters
  // resolve with or without a qualifying pset name.
  private readonly psetValuesByKey = new Map<string, Map<number, string>>();
  // Lowercase "system.code" strings per element (substring-matched).
  private readonly classificationsById = new Map<number, string[]>();
  private enrichedCount = 0;

  add(item: IndexedItem): void {
    this.items.set(item.id, item);
    const strs: string[] = [];
    if (item.name) strs.push(item.name);
    if (item.ifcType) strs.push(item.ifcType);
    if (item.globalId) strs.push(item.globalId);
    for (const s of strs) {
      for (const tok of tokenize(s)) {
        this.tokenBucket(tok).add(item.id);
      }
    }
  }

  get size(): number { return this.items.size; }

  /** True once at least one element has enrichment data. */
  get hasEnrichment(): boolean { return this.enrichedCount > 0; }

  clear(): void {
    this.byToken.clear();
    this.items.clear();
    this.clearEnrichment();
  }

  /**
   * Drops the enrichment layer only (model change / rebuild). ObjectType
   * tokens already merged into the inverted index stay behind: they only
   * widen candidate generation and the fuzzy re-rank discards items whose
   * remaining fields don't match; clear() removes them with everything else.
   */
  clearEnrichment(): void {
    this.objectTypeById.clear();
    this.psetValuesByKey.clear();
    this.classificationsById.clear();
    this.enrichedCount = 0;
  }

  setEnrichment(id: number, enrichment: ElementEnrichment): void {
    this.enrichedCount++;
    if (enrichment.objectType) {
      this.objectTypeById.set(id, enrichment.objectType);
      // Merge ObjectType tokens into the inverted index so bare terms can
      // surface elements by their type name once enrichment exists.
      for (const tok of tokenize(enrichment.objectType)) {
        this.tokenBucket(tok).add(id);
      }
    }
    for (const p of enrichment.psets) {
      const prop = p.prop.toLowerCase();
      this.psetValueMap(`${p.pset.toLowerCase()}.${prop}`).set(id, p.value);
      this.psetValueMap(prop).set(id, p.value);
    }
    if (enrichment.classifications.length > 0) {
      this.classificationsById.set(
        id,
        enrichment.classifications.map((c) => `${c.system}.${c.code}`.toLowerCase()),
      );
    }
  }

  search(query: string, options: { ifcType?: string; storey?: string; limit?: number } = {}): SearchResult {
    const limit = options.limit ?? 100;
    const trimmed = query.trim();
    if (!trimmed) return { elements: [], total: 0, query };

    const queryTokens = tokenize(trimmed);
    if (queryTokens.length === 0) {
      // Non-token-y input (e.g. single short chars). Fall back to a
      // substring scan across the smaller item table.
      return this.substringScan(trimmed.toLowerCase(), options, query);
    }

    // Intersect all token-bucket sets - an item must hit every token.
    let candidates: Set<number> | null = null;
    for (const tok of queryTokens) {
      const bucket = bestBucket(this.byToken, tok);
      if (!bucket) return { elements: [], total: 0, query };
      if (candidates === null) {
        candidates = new Set(bucket);
      } else {
        for (const id of candidates) {
          if (!bucket.has(id)) candidates.delete(id);
        }
        if (candidates.size === 0) return { elements: [], total: 0, query };
      }
    }
    if (!candidates) return { elements: [], total: 0, query };

    return this.finalize(candidates, options, query, limit);
  }

  /**
   * Multi-field search over a parsed query: bare terms are fuzzy-ranked
   * (inverted index as candidate generator, capped linear scan as fallback);
   * type/storey filter the base layer; pset/class filter the enrichment
   * layer. With no enrichment built yet, pset/class filters match nothing -
   * the SearchPanel gates those queries on EnrichmentStatus.
   */
  searchParsed(parsed: ParsedQuery, options: { limit?: number } = {}): SearchResult {
    const limit = options.limit ?? 100;
    const empty: SearchResult = { elements: [], total: 0, query: parsed.raw };
    if (parsed.isEmpty) return empty;

    let candidates: Set<number> | null = null; // null = unconstrained (all items)
    let fuzzyById: Map<number, number> | null = null;

    if (parsed.terms.length > 0) {
      const ranked = this.rankBareTerms(parsed.terms);
      if (ranked.size === 0) return empty;
      candidates = new Set(ranked.keys());
      fuzzyById = ranked;
    }

    for (const filter of parsed.psetFilters) {
      candidates = this.applyPsetFilter(filter, candidates);
      if (candidates.size === 0) return empty;
    }
    for (const filter of parsed.classFilters) {
      candidates = this.applyClassFilter(filter, candidates);
      if (candidates.size === 0) return empty;
    }

    const typeFilters = parsed.typeFilters.map((f) => f.toLowerCase());
    const storeyFilters = parsed.storeyFilters.map((f) => f.toLowerCase());
    const elements: ElementSummary[] = [];
    const pool: Iterable<number> = candidates ?? this.items.keys();
    for (const id of pool) {
      const item = this.items.get(id);
      if (!item) continue;
      if (!typeFilters.every((f) => matchesTypeFilter(item.ifcType, f))) continue;
      if (!storeyFilters.every((f) => (item.storey ?? '').toLowerCase().includes(f))) continue;
      elements.push({
        id: item.id,
        global_id: item.globalId,
        name: item.name,
        ifc_type: item.ifcType,
        storey: item.storey,
      });
    }
    const total = elements.length;
    if (fuzzyById) {
      const scores = fuzzyById;
      elements.sort((a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || byRelevance(a, b));
    } else {
      elements.sort(byRelevance);
    }
    return { elements: elements.slice(0, limit), total, query: parsed.raw };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private tokenBucket(tok: string): Set<number> {
    let bucket = this.byToken.get(tok);
    if (!bucket) { bucket = new Set(); this.byToken.set(tok, bucket); }
    return bucket;
  }

  private psetValueMap(key: string): Map<number, string> {
    let map = this.psetValuesByKey.get(key);
    if (!map) { map = new Map(); this.psetValuesByKey.set(key, map); }
    return map;
  }

  /** Fuzzy-ranked ids for bare terms; empty map = nothing matched anywhere. */
  private rankBareTerms(terms: string[]): Map<number, number> {
    const candidates = this.candidatesFromInvertedIndex(terms);
    if (candidates && candidates.size > 0) {
      const ranked = this.rankByFuzzy(candidates, terms);
      if (ranked.size > 0) return ranked;
    }
    // The token index found nothing (e.g. mid-word fragments that defeat the
    // prefix buckets) - run a capped linear fuzzy scan instead.
    return this.fuzzyScan(terms);
  }

  /** Token AND + prefix buckets; null when the index cannot answer. */
  private candidatesFromInvertedIndex(terms: string[]): Set<number> | null {
    const tokens: string[] = [];
    for (const term of terms) tokens.push(...tokenize(term));
    if (tokens.length === 0) return null;
    let candidates: Set<number> | null = null;
    for (const tok of tokens) {
      const bucket = bestBucket(this.byToken, tok);
      if (!bucket) return null;
      if (candidates === null) {
        candidates = new Set(bucket);
      } else {
        for (const id of candidates) {
          if (!bucket.has(id)) candidates.delete(id);
        }
        if (candidates.size === 0) return null;
      }
    }
    return candidates;
  }

  private rankByFuzzy(ids: Iterable<number>, terms: string[]): Map<number, number> {
    const ranked = new Map<number, number>();
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item) continue;
      const score = this.scoreItem(item, terms);
      if (score > 0) ranked.set(id, score);
    }
    return ranked;
  }

  /** Sum of per-term best field scores; 0 when any term matches nothing (AND). */
  private scoreItem(item: IndexedItem, terms: string[]): number {
    const objectType = this.objectTypeById.get(item.id) ?? '';
    let total = 0;
    for (const term of terms) {
      const best = Math.max(
        item.name ? fuzzyScore(term, item.name) : 0,
        fuzzyScore(term, item.ifcType),
        objectType ? fuzzyScore(term, objectType) : 0,
        fuzzyScore(term, item.globalId),
      );
      if (best === 0) return 0;
      total += best;
    }
    return total;
  }

  private fuzzyScan(terms: string[]): Map<number, number> {
    const ranked = new Map<number, number>();
    let examined = 0;
    for (const item of this.items.values()) {
      if (examined >= FUZZY_SCAN_CAP) break;
      examined++;
      const score = this.scoreItem(item, terms);
      if (score > 0) ranked.set(item.id, score);
    }
    return ranked;
  }

  private applyPsetFilter(filter: PsetFilter, pool: Set<number> | null): Set<number> {
    const key = filter.pset
      ? `${filter.pset.toLowerCase()}.${filter.prop.toLowerCase()}`
      : filter.prop.toLowerCase();
    const matched = new Set<number>();
    const valueById = this.psetValuesByKey.get(key);
    if (!valueById) return matched;
    if (pool) {
      for (const id of pool) {
        const value = valueById.get(id);
        if (value !== undefined && psetValueMatches(value, filter.value)) matched.add(id);
      }
    } else {
      for (const [id, value] of valueById) {
        if (psetValueMatches(value, filter.value)) matched.add(id);
      }
    }
    return matched;
  }

  private applyClassFilter(filter: string, pool: Set<number> | null): Set<number> {
    const needle = filter.toLowerCase();
    const matched = new Set<number>();
    if (pool) {
      for (const id of pool) {
        const refs = this.classificationsById.get(id);
        if (refs && refs.some((r) => r.includes(needle))) matched.add(id);
      }
    } else {
      for (const [id, refs] of this.classificationsById) {
        if (refs.some((r) => r.includes(needle))) matched.add(id);
      }
    }
    return matched;
  }

  private substringScan(needle: string, options: { ifcType?: string; storey?: string; limit?: number }, query: string): SearchResult {
    const hits = new Set<number>();
    for (const [id, item] of this.items) {
      if (
        (item.name && item.name.toLowerCase().includes(needle)) ||
        (item.ifcType && item.ifcType.toLowerCase().includes(needle)) ||
        (item.globalId && item.globalId.toLowerCase().includes(needle))
      ) {
        hits.add(id);
      }
    }
    return this.finalize(hits, options, query, options.limit ?? 100);
  }

  private finalize(
    ids: Set<number>,
    options: { ifcType?: string; storey?: string; limit?: number },
    query: string,
    limit: number,
  ): SearchResult {
    const elements: ElementSummary[] = [];
    const ifcType = options.ifcType?.toLowerCase();
    const storey = options.storey?.toLowerCase();
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item) continue;
      if (ifcType && item.ifcType.toLowerCase() !== ifcType) continue;
      if (storey && (item.storey ?? '').toLowerCase() !== storey) continue;
      elements.push({
        id: item.id,
        global_id: item.globalId,
        name: item.name,
        ifc_type: item.ifcType,
        storey: item.storey,
      });
    }
    const total = elements.length;
    elements.sort(byRelevance);
    return { elements: elements.slice(0, limit), total, query };
  }
}

/** type:IfcWall = exact class match; type:wall = class-name substring. */
function matchesTypeFilter(ifcType: string, lowerFilter: string): boolean {
  const t = ifcType.toLowerCase();
  return lowerFilter.startsWith('ifc') ? t === lowerFilter : t.includes(lowerFilter);
}

function psetValueMatches(stored: string, wanted: string | null): boolean {
  if (wanted === null) return true; // presence check
  const s = stored.trim().toLowerCase();
  const w = wanted.trim().toLowerCase();
  if (s === w) return true;
  // IFC booleans surface as "true"/"false" or ".T."/".F." depending on source.
  const sb = asBoolean(s);
  const wb = asBoolean(w);
  if (sb !== null && wb !== null) return sb === wb;
  // Numeric compare when both sides parse (e.g. "200" matches "200.0").
  const sn = asFiniteNumber(s);
  const wn = asFiniteNumber(w);
  if (sn !== null && wn !== null) return sn === wn;
  return false;
}

function asBoolean(v: string): boolean | null {
  if (v === 'true' || v === '.t.') return true;
  if (v === 'false' || v === '.f.') return false;
  return null;
}

function asFiniteNumber(v: string): number | null {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function tokenize(input: string): string[] {
  if (!input) return [];
  const parts = input.toLowerCase().split(TOKEN_SPLIT);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length >= MIN_TOKEN_LEN) out.push(p);
  }
  return out;
}

function bestBucket(
  byToken: Map<string, Set<number>>,
  tok: string,
): Set<number> | null {
  // Exact-match token preferred; if missing, fall back to any bucket
  // whose key starts with `tok` (prefix match).
  const exact = byToken.get(tok);
  if (exact) return exact;
  const combined = new Set<number>();
  for (const [k, bucket] of byToken) {
    if (k.startsWith(tok)) {
      for (const id of bucket) combined.add(id);
    }
  }
  return combined.size > 0 ? combined : null;
}

function byRelevance(a: ElementSummary, b: ElementSummary): number {
  const an = (a.name ?? '').length || Number.MAX_SAFE_INTEGER;
  const bn = (b.name ?? '').length || Number.MAX_SAFE_INTEGER;
  return an - bn;
}
