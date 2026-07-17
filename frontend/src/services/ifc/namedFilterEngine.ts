/**
 * Indexed, model-agnostic element filters.
 *
 * This service deliberately owns no viewer or Zustand state. Callers feed it
 * typed element metadata, save immutable named definitions, and receive stable
 * `{ modelId, elementId }` references that remain unambiguous in federated
 * models where numeric IFC ids can overlap.
 *
 * Missing, null, and empty string are distinct:
 *   - missing: the field/property was not supplied at all;
 *   - null: it was supplied with an explicit null value;
 *   - "": a present string value that happens to be empty.
 * Ordinary comparisons require at least one non-null value. In particular,
 * `neq` never includes missing/null fields and is true only when none of the
 * present non-null values equals the requested value.
 */

import type { ElementDetail } from '../../types/ifc';

export const NAMED_FILTER_SCHEMA_VERSION = 1 as const;

export type FilterScalar = string | number | boolean | null;
export type FilterComparable = Exclude<FilterScalar, null>;
export type FilterFieldValue = FilterScalar | readonly FilterScalar[];

export interface FilterElementRef {
  readonly modelId: string;
  readonly elementId: number;
}

export interface FilterPropertyValue {
  /** Null means the source did not expose a property-set name. */
  readonly pset: string | null;
  readonly name: string;
  readonly value: FilterScalar;
}

export interface FilterElementRecord {
  readonly ref: FilterElementRef;
  /** Attribute names are case-insensitive; values retain their original type. */
  readonly attributes?: Readonly<Record<string, FilterFieldValue | undefined>>;
  readonly properties?: readonly FilterPropertyValue[];
  readonly quantities?: Readonly<Record<string, number | null | undefined>>;
}

export type ElementFilterField =
  | { readonly kind: 'identity'; readonly name: 'modelId' | 'elementId' }
  | { readonly kind: 'attribute'; readonly name: string }
  | { readonly kind: 'property'; readonly name: string; readonly pset?: string | null }
  | { readonly kind: 'quantity'; readonly name: string };

export type UnaryFilterOperator = 'exists' | 'missing' | 'isNull' | 'isNotNull';
export type EqualityFilterOperator = 'eq' | 'neq';
export type StringFilterOperator = 'contains' | 'startsWith';
export type NumericFilterOperator = 'gt' | 'gte' | 'lt' | 'lte';

export type ElementFilterCondition =
  | {
      readonly kind: 'condition';
      readonly field: ElementFilterField;
      readonly operator: UnaryFilterOperator;
    }
  | {
      readonly kind: 'condition';
      readonly field: ElementFilterField;
      readonly operator: EqualityFilterOperator;
      readonly value: FilterComparable;
      readonly caseSensitive?: boolean;
    }
  | {
      readonly kind: 'condition';
      readonly field: ElementFilterField;
      readonly operator: StringFilterOperator;
      readonly value: string;
      readonly caseSensitive?: boolean;
    }
  | {
      readonly kind: 'condition';
      readonly field: ElementFilterField;
      readonly operator: NumericFilterOperator;
      readonly value: number;
    }
  | {
      readonly kind: 'condition';
      readonly field: ElementFilterField;
      readonly operator: 'in';
      readonly values: readonly FilterComparable[];
      readonly caseSensitive?: boolean;
    };

export interface ElementFilterGroup {
  readonly kind: 'group';
  readonly operator: 'and' | 'or';
  readonly children: readonly ElementFilterExpression[];
}

export type ElementFilterExpression = ElementFilterCondition | ElementFilterGroup;

export type ElementFilterScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'models'; readonly modelIds: readonly string[] }
  | { readonly kind: 'elements'; readonly elements: readonly FilterElementRef[] };

export interface NamedElementFilterDefinition {
  readonly schemaVersion: typeof NAMED_FILTER_SCHEMA_VERSION;
  /** Stable caller-owned id; changing semantics requires a higher revision. */
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly description?: string;
  readonly scope: ElementFilterScope;
  readonly expression: ElementFilterExpression;
}

export interface ElementFilterEvaluation {
  readonly definitionId: string;
  readonly definitionRevision: number;
  readonly scopeCount: number;
  readonly matchedCount: number;
  readonly matches: readonly FilterElementRef[];
}

export interface NamedFilterEngineStats {
  readonly elementCount: number;
  readonly modelCount: number;
  readonly definitionCount: number;
  readonly indexedFieldCount: number;
}

export interface ElementDetailFilterOptions {
  /** Extra typed fields such as discipline, system, or classifications. */
  readonly attributes?: Readonly<Record<string, FilterFieldValue | undefined>>;
}

interface NormalizedRecord {
  readonly ref: FilterElementRef;
  readonly fields: ReadonlyMap<string, readonly FilterScalar[]>;
}

const UNARY_OPERATORS = new Set<string>(['exists', 'missing', 'isNull', 'isNotNull']);
const EQUALITY_OPERATORS = new Set<string>(['eq', 'neq']);
const STRING_OPERATORS = new Set<string>(['contains', 'startsWith']);
const NUMERIC_OPERATORS = new Set<string>(['gt', 'gte', 'lt', 'lte']);
const MAX_EXPRESSION_DEPTH = 32;

/** Collision-safe stable key for a federated element reference. */
export function stableElementRefKey(ref: FilterElementRef): string {
  const modelId = normalizeModelId(ref.modelId);
  const elementId = normalizeElementId(ref.elementId);
  return `${modelId.length}:${modelId}:${elementId}`;
}

/**
 * Preserve the typed values already available in `ElementDetail`. This is the
 * preferred adapter for the metadata-enrichment path; unlike SearchIndex's
 * display-oriented string layer it keeps null, booleans, and numbers intact.
 */
export function filterRecordFromElementDetail(
  modelId: string,
  element: ElementDetail,
  options: ElementDetailFilterOptions = {},
): FilterElementRecord {
  const properties: FilterPropertyValue[] = [];
  for (const set of element.property_sets) {
    for (const [name, value] of Object.entries(set.properties)) {
      properties.push({ pset: set.name, name, value });
    }
  }

  return {
    ref: { modelId, elementId: element.id },
    attributes: {
      globalId: element.global_id,
      name: element.name,
      ifcType: element.ifc_type,
      storey: element.storey,
      material: element.material,
      relatingType: element.relating_type,
      description: element.description,
      objectType: element.object_type,
      tag: element.tag,
      predefinedType: element.predefined_type,
      ...options.attributes,
    },
    properties,
    quantities: element.quantities,
  };
}

export class NamedElementFilterEngine {
  private readonly records = new Map<string, NormalizedRecord>();
  private readonly allKeys = new Set<string>();
  private readonly keysByModel = new Map<string, Set<string>>();

  private readonly presenceByField = new Map<string, Set<string>>();
  private readonly nullByField = new Map<string, Set<string>>();
  private readonly nonNullByField = new Map<string, Set<string>>();
  private readonly exactByField = new Map<string, Map<string, Set<string>>>();

  private readonly definitions = new Map<string, NamedElementFilterDefinition>();

  get stats(): NamedFilterEngineStats {
    return Object.freeze({
      elementCount: this.records.size,
      modelCount: this.keysByModel.size,
      definitionCount: this.definitions.size,
      indexedFieldCount: this.presenceByField.size,
    });
  }

  /** Add or replace one element without disturbing named definitions. */
  upsertElement(record: FilterElementRecord): void {
    const normalized = normalizeRecord(record);
    const key = stableElementRefKey(normalized.ref);
    this.deleteKey(key);
    this.indexRecord(key, normalized);
  }

  /**
   * Atomically replace all metadata for one model. Every input is validated
   * before the old model index is removed, so malformed refreshes cannot leave
   * a half-empty filter index.
   */
  replaceModel(modelId: string, records: readonly FilterElementRecord[]): number {
    const normalizedModelId = normalizeModelId(modelId);
    const prepared = new Map<string, NormalizedRecord>();
    for (const record of records) {
      const normalized = normalizeRecord(record);
      if (normalized.ref.modelId !== normalizedModelId) {
        throw new Error(
          `Filter record modelId "${normalized.ref.modelId}" does not match replacement model "${normalizedModelId}".`,
        );
      }
      const key = stableElementRefKey(normalized.ref);
      if (prepared.has(key)) {
        throw new Error(`Duplicate filter element ${normalized.ref.elementId} in model "${normalizedModelId}".`);
      }
      prepared.set(key, normalized);
    }

    this.removeModel(normalizedModelId);
    for (const [key, record] of prepared) this.indexRecord(key, record);
    return prepared.size;
  }

  removeElement(ref: FilterElementRef): boolean {
    return this.deleteKey(stableElementRefKey(ref));
  }

  removeModel(modelId: string): number {
    const normalizedModelId = normalizeModelId(modelId);
    const keys = this.keysByModel.get(normalizedModelId);
    if (!keys) return 0;
    const snapshot = [...keys];
    for (const key of snapshot) this.deleteKey(key);
    return snapshot.length;
  }

  clearElements(): void {
    this.records.clear();
    this.allKeys.clear();
    this.keysByModel.clear();
    this.presenceByField.clear();
    this.nullByField.clear();
    this.nonNullByField.clear();
    this.exactByField.clear();
  }

  /**
   * Save an immutable named definition. Re-saving identical data at the same
   * revision is idempotent; changing the same id requires a larger revision.
   */
  saveDefinition(input: NamedElementFilterDefinition): NamedElementFilterDefinition {
    const next = normalizeDefinition(input);
    const previous = this.definitions.get(next.id);
    if (previous) {
      if (next.revision < previous.revision) {
        throw new Error(
          `Filter "${next.id}" revision ${next.revision} is older than saved revision ${previous.revision}.`,
        );
      }
      if (next.revision === previous.revision) {
        if (JSON.stringify(next) === JSON.stringify(previous)) return previous;
        throw new Error(`Filter "${next.id}" changed without increasing its revision.`);
      }
    }
    this.definitions.set(next.id, next);
    return next;
  }

  getDefinition(id: string): NamedElementFilterDefinition | undefined {
    return this.definitions.get(id);
  }

  listDefinitions(): readonly NamedElementFilterDefinition[] {
    return [...this.definitions.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  deleteDefinition(id: string): boolean {
    return this.definitions.delete(id);
  }

  clearDefinitions(): void {
    this.definitions.clear();
  }

  evaluate(
    definitionOrId: NamedElementFilterDefinition | string,
  ): ElementFilterEvaluation {
    const definition = typeof definitionOrId === 'string'
      ? this.definitions.get(definitionOrId)
      : normalizeDefinition(definitionOrId);
    if (!definition) throw new Error(`Unknown named element filter "${definitionOrId}".`);

    const universe = this.scopeKeys(definition.scope);
    const matched = this.evaluateExpression(definition.expression, universe);
    const matches = [...matched]
      .map((key) => this.records.get(key)?.ref)
      .filter((ref): ref is FilterElementRef => ref !== undefined)
      .sort(compareRefs)
      .map((ref) => Object.freeze({ ...ref }));

    return Object.freeze({
      definitionId: definition.id,
      definitionRevision: definition.revision,
      scopeCount: universe.size,
      matchedCount: matches.length,
      matches: Object.freeze(matches),
    });
  }

  private indexRecord(key: string, record: NormalizedRecord): void {
    this.records.set(key, record);
    this.allKeys.add(key);
    addToSetMap(this.keysByModel, record.ref.modelId, key);

    for (const [field, values] of record.fields) {
      addToSetMap(this.presenceByField, field, key);
      for (const value of values) {
        if (value === null) {
          addToSetMap(this.nullByField, field, key);
          continue;
        }
        addToSetMap(this.nonNullByField, field, key);
        let valuesIndex = this.exactByField.get(field);
        if (!valuesIndex) {
          valuesIndex = new Map();
          this.exactByField.set(field, valuesIndex);
        }
        addToSetMap(valuesIndex, canonicalScalar(value), key);
      }
    }
  }

  private deleteKey(key: string): boolean {
    const record = this.records.get(key);
    if (!record) return false;

    this.records.delete(key);
    this.allKeys.delete(key);
    deleteFromSetMap(this.keysByModel, record.ref.modelId, key);

    for (const [field, values] of record.fields) {
      deleteFromSetMap(this.presenceByField, field, key);
      deleteFromSetMap(this.nullByField, field, key);
      deleteFromSetMap(this.nonNullByField, field, key);
      const exact = this.exactByField.get(field);
      if (!exact) continue;
      for (const value of values) {
        if (value !== null) deleteFromSetMap(exact, canonicalScalar(value), key);
      }
      if (exact.size === 0) this.exactByField.delete(field);
    }
    return true;
  }

  private scopeKeys(scope: ElementFilterScope): Set<string> {
    if (scope.kind === 'all') return new Set(this.allKeys);
    const out = new Set<string>();
    if (scope.kind === 'models') {
      for (const modelId of scope.modelIds) {
        const keys = this.keysByModel.get(modelId);
        if (keys) for (const key of keys) out.add(key);
      }
      return out;
    }
    for (const ref of scope.elements) {
      const key = stableElementRefKey(ref);
      if (this.records.has(key)) out.add(key);
    }
    return out;
  }

  private evaluateExpression(
    expression: ElementFilterExpression,
    universe: ReadonlySet<string>,
  ): Set<string> {
    if (expression.kind === 'condition') {
      return this.evaluateCondition(expression, universe);
    }

    if (expression.operator === 'or') {
      const result = new Set<string>();
      for (const child of expression.children) {
        for (const key of this.evaluateExpression(child, universe)) result.add(key);
      }
      return result;
    }

    // AND's identity is the current scope. Evaluate index-friendly children
    // first so contains/range scans run over the smallest available candidate.
    let result = new Set(universe);
    const children = [...expression.children].sort(
      (a, b) => expressionPriority(a) - expressionPriority(b),
    );
    for (const child of children) {
      result = this.evaluateExpression(child, result);
      if (result.size === 0) break;
    }
    return result;
  }

  private evaluateCondition(
    condition: ElementFilterCondition,
    universe: ReadonlySet<string>,
  ): Set<string> {
    const field = filterFieldKey(condition.field);
    if (condition.operator === 'exists') {
      return intersectWithIndex(universe, this.presenceByField.get(field));
    }
    if (condition.operator === 'missing') {
      return subtractIndex(universe, this.presenceByField.get(field));
    }
    if (condition.operator === 'isNull') {
      return intersectWithIndex(universe, this.nullByField.get(field));
    }
    if (condition.operator === 'isNotNull') {
      return intersectWithIndex(universe, this.nonNullByField.get(field));
    }

    if ((condition.operator === 'eq' || condition.operator === 'neq') && !condition.caseSensitive) {
      const equal = this.exactByField.get(field)?.get(canonicalScalar(condition.value));
      if (condition.operator === 'eq') return intersectWithIndex(universe, equal);
      const present = intersectWithIndex(universe, this.nonNullByField.get(field));
      return subtractIndex(present, equal);
    }

    if (condition.operator === 'in' && !condition.caseSensitive) {
      const indexed = new Set<string>();
      const valuesIndex = this.exactByField.get(field);
      if (valuesIndex) {
        for (const value of condition.values) {
          const bucket = valuesIndex.get(canonicalScalar(value));
          if (bucket) for (const key of bucket) indexed.add(key);
        }
      }
      return intersectWithIndex(universe, indexed);
    }

    const candidates = intersectWithIndex(universe, this.nonNullByField.get(field));
    const matches = new Set<string>();
    for (const key of candidates) {
      const record = this.records.get(key);
      if (record && recordMatchesCondition(record, field, condition)) matches.add(key);
    }
    return matches;
  }
}

function normalizeRecord(input: FilterElementRecord): NormalizedRecord {
  const ref = normalizeRef(input.ref);
  const fields = new Map<string, readonly FilterScalar[]>();

  appendField(fields, identityFieldKey('modelId'), [ref.modelId]);
  appendField(fields, identityFieldKey('elementId'), [ref.elementId]);

  for (const [name, raw] of Object.entries(input.attributes ?? {})) {
    if (raw === undefined) continue;
    const values = Array.isArray(raw) ? raw : [raw as FilterScalar];
    for (const value of values) assertScalar(value, `attribute "${name}"`);
    appendField(fields, attributeFieldKey(name), values);
  }

  for (const property of input.properties ?? []) {
    const name = normalizeFieldName(property.name, 'property name');
    const pset = property.pset === null ? null : normalizeFieldName(property.pset, 'property-set name');
    assertScalar(property.value, `property "${property.name}"`);
    const wildcard = propertyFieldKey(name, null);
    appendField(fields, wildcard, [property.value]);
    if (pset !== null) {
      appendField(fields, propertyFieldKey(name, pset), [property.value]);
    }
  }

  for (const [name, value] of Object.entries(input.quantities ?? {})) {
    if (value === undefined) continue;
    assertScalar(value, `quantity "${name}"`);
    appendField(fields, quantityFieldKey(name), [value]);
  }

  return {
    ref: Object.freeze(ref),
    fields,
  };
}

function normalizeDefinition(input: NamedElementFilterDefinition): NamedElementFilterDefinition {
  if (input.schemaVersion !== NAMED_FILTER_SCHEMA_VERSION) {
    throw new Error(`Unsupported named filter schema version ${String(input.schemaVersion)}.`);
  }
  const id = normalizeRequiredText(input.id, 'filter id');
  const name = normalizeRequiredText(input.name, 'filter name');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error('Filter revision must be a positive safe integer.');
  }

  return deepFreeze({
    schemaVersion: NAMED_FILTER_SCHEMA_VERSION,
    id,
    revision: input.revision,
    name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    scope: normalizeScope(input.scope),
    expression: normalizeExpression(input.expression, 0),
  });
}

function normalizeScope(scope: ElementFilterScope): ElementFilterScope {
  if (scope.kind === 'all') return { kind: 'all' };
  if (scope.kind === 'models') {
    const modelIds = [...new Set(scope.modelIds.map(normalizeModelId))].sort();
    return { kind: 'models', modelIds };
  }
  if (scope.kind === 'elements') {
    const byKey = new Map<string, FilterElementRef>();
    for (const input of scope.elements) {
      const ref = normalizeRef(input);
      byKey.set(stableElementRefKey(ref), ref);
    }
    return {
      kind: 'elements',
      elements: [...byKey.values()].sort(compareRefs),
    };
  }
  throw new Error(`Unknown filter scope kind "${String((scope as { kind?: unknown }).kind)}".`);
}

function normalizeExpression(
  expression: ElementFilterExpression,
  depth: number,
): ElementFilterExpression {
  if (depth > MAX_EXPRESSION_DEPTH) {
    throw new Error(`Filter expression exceeds maximum depth ${MAX_EXPRESSION_DEPTH}.`);
  }
  if (expression.kind === 'group') {
    if (expression.operator !== 'and' && expression.operator !== 'or') {
      throw new Error(`Unknown filter group operator "${String(expression.operator)}".`);
    }
    return {
      kind: 'group',
      operator: expression.operator,
      children: expression.children.map((child) => normalizeExpression(child, depth + 1)),
    };
  }
  if (expression.kind !== 'condition') {
    throw new Error(`Unknown filter expression kind "${String((expression as { kind?: unknown }).kind)}".`);
  }

  const raw = expression as ElementFilterCondition;
  const field = normalizeField(raw.field);
  if (UNARY_OPERATORS.has(raw.operator)) {
    return { kind: 'condition', field, operator: raw.operator } as ElementFilterCondition;
  }
  if (EQUALITY_OPERATORS.has(raw.operator)) {
    assertComparable((raw as { value?: unknown }).value, `${raw.operator} value`);
    return {
      kind: 'condition',
      field,
      operator: raw.operator,
      value: (raw as { value: FilterComparable }).value,
      ...((raw as { caseSensitive?: boolean }).caseSensitive ? { caseSensitive: true } : {}),
    } as ElementFilterCondition;
  }
  if (STRING_OPERATORS.has(raw.operator)) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value !== 'string') throw new Error(`${raw.operator} requires a string value.`);
    return {
      kind: 'condition',
      field,
      operator: raw.operator,
      value,
      ...((raw as { caseSensitive?: boolean }).caseSensitive ? { caseSensitive: true } : {}),
    } as ElementFilterCondition;
  }
  if (NUMERIC_OPERATORS.has(raw.operator)) {
    const value = (raw as { value?: unknown }).value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${raw.operator} requires a finite numeric value.`);
    }
    return { kind: 'condition', field, operator: raw.operator, value } as ElementFilterCondition;
  }
  if (raw.operator === 'in') {
    const values = (raw as { values?: unknown }).values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('in requires at least one comparable value.');
    }
    for (const value of values) assertComparable(value, 'in value');
    return {
      kind: 'condition',
      field,
      operator: 'in',
      values: [...values] as FilterComparable[],
      ...((raw as { caseSensitive?: boolean }).caseSensitive ? { caseSensitive: true } : {}),
    };
  }
  throw new Error(`Unknown filter condition operator "${String(raw.operator)}".`);
}

function normalizeField(field: ElementFilterField): ElementFilterField {
  if (field.kind === 'identity') {
    if (field.name !== 'modelId' && field.name !== 'elementId') {
      throw new Error(`Unknown identity field "${String(field.name)}".`);
    }
    return { kind: 'identity', name: field.name };
  }
  if (field.kind === 'attribute') {
    return { kind: 'attribute', name: normalizeFieldName(field.name, 'attribute name') };
  }
  if (field.kind === 'property') {
    return {
      kind: 'property',
      name: normalizeFieldName(field.name, 'property name'),
      ...(field.pset === undefined || field.pset === null
        ? {}
        : { pset: normalizeFieldName(field.pset, 'property-set name') }),
    };
  }
  if (field.kind === 'quantity') {
    return { kind: 'quantity', name: normalizeFieldName(field.name, 'quantity name') };
  }
  throw new Error(`Unknown filter field kind "${String((field as { kind?: unknown }).kind)}".`);
}

function recordMatchesCondition(
  record: NormalizedRecord,
  field: string,
  condition: ElementFilterCondition,
): boolean {
  const values = record.fields.get(field);
  if (condition.operator === 'exists') return values !== undefined;
  if (condition.operator === 'missing') return values === undefined;
  if (condition.operator === 'isNull') return values?.some((value) => value === null) ?? false;
  if (condition.operator === 'isNotNull') return values?.some((value) => value !== null) ?? false;
  if (!values) return false;
  const nonNull = values.filter((value): value is FilterComparable => value !== null);
  if (nonNull.length === 0) return false;

  if (condition.operator === 'eq') {
    return nonNull.some((value) => scalarEquals(value, condition.value, condition.caseSensitive));
  }
  if (condition.operator === 'neq') {
    return nonNull.every((value) => !scalarEquals(value, condition.value, condition.caseSensitive));
  }
  if (condition.operator === 'in') {
    return nonNull.some((value) =>
      condition.values.some((wanted) => scalarEquals(value, wanted, condition.caseSensitive)));
  }
  if (condition.operator === 'contains' || condition.operator === 'startsWith') {
    const wanted = condition.caseSensitive ? condition.value : condition.value.toLowerCase();
    return nonNull.some((value) => {
      if (typeof value !== 'string') return false;
      const actual = condition.caseSensitive ? value : value.toLowerCase();
      return condition.operator === 'contains'
        ? actual.includes(wanted)
        : actual.startsWith(wanted);
    });
  }
  if (
    condition.operator === 'gt'
    || condition.operator === 'gte'
    || condition.operator === 'lt'
    || condition.operator === 'lte'
  ) {
    const operator = condition.operator;
    const wanted = condition.value;
    return nonNull.some((value) => {
      if (typeof value !== 'number') return false;
      if (operator === 'gt') return value > wanted;
      if (operator === 'gte') return value >= wanted;
      if (operator === 'lt') return value < wanted;
      return value <= wanted;
    });
  }
  return false;
}

function filterFieldKey(field: ElementFilterField): string {
  if (field.kind === 'identity') return identityFieldKey(field.name);
  if (field.kind === 'attribute') return attributeFieldKey(field.name);
  if (field.kind === 'property') return propertyFieldKey(field.name, field.pset ?? null);
  return quantityFieldKey(field.name);
}

function identityFieldKey(name: 'modelId' | 'elementId'): string {
  return `identity:${name.toLowerCase()}`;
}

function attributeFieldKey(name: string): string {
  return `attribute:${normalizeFieldName(name, 'attribute name').toLowerCase()}`;
}

function propertyFieldKey(name: string, pset: string | null): string {
  const normalizedName = normalizeFieldName(name, 'property name').toLowerCase();
  const normalizedPset = pset === null
    ? '*'
    : normalizeFieldName(pset, 'property-set name').toLowerCase();
  return `property:${normalizedPset}:${normalizedName}`;
}

function quantityFieldKey(name: string): string {
  return `quantity:${normalizeFieldName(name, 'quantity name').toLowerCase()}`;
}

function appendField(
  fields: Map<string, readonly FilterScalar[]>,
  key: string,
  values: readonly FilterScalar[],
): void {
  const previous = fields.get(key);
  fields.set(key, previous ? [...previous, ...values] : [...values]);
}

function normalizeRef(ref: FilterElementRef): FilterElementRef {
  return {
    modelId: normalizeModelId(ref.modelId),
    elementId: normalizeElementId(ref.elementId),
  };
}

function normalizeModelId(value: string): string {
  return normalizeRequiredText(value, 'model id');
}

function normalizeElementId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Element id must be a non-negative safe integer.');
  }
  return value;
}

function normalizeFieldName(value: string, label: string): string {
  return normalizeRequiredText(value, label);
}

function normalizeRequiredText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function assertScalar(value: unknown, label: string): asserts value is FilterScalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  throw new Error(`${label} must be a string, finite number, boolean, or null.`);
}

function assertComparable(value: unknown, label: string): asserts value is FilterComparable {
  assertScalar(value, label);
  if (value === null) throw new Error(`${label} cannot be null; use isNull or isNotNull.`);
}

function scalarEquals(
  actual: FilterComparable,
  wanted: FilterComparable,
  caseSensitive = false,
): boolean {
  if (typeof actual !== typeof wanted) return false;
  if (typeof actual === 'string' && typeof wanted === 'string') {
    return caseSensitive
      ? actual === wanted
      : actual.toLowerCase() === wanted.toLowerCase();
  }
  return actual === wanted;
}

function canonicalScalar(value: FilterComparable): string {
  if (typeof value === 'string') return `s:${value.toLowerCase()}`;
  if (typeof value === 'number') return `n:${Object.is(value, -0) ? 0 : value}`;
  return `b:${value ? 1 : 0}`;
}

function expressionPriority(expression: ElementFilterExpression): number {
  if (expression.kind === 'group') return 1;
  const caseSensitive = 'caseSensitive' in expression && expression.caseSensitive === true;
  return expression.operator === 'contains'
    || expression.operator === 'startsWith'
    || NUMERIC_OPERATORS.has(expression.operator)
    || caseSensitive
    ? 2
    : 0;
}

function intersectWithIndex(
  universe: ReadonlySet<string>,
  indexed: ReadonlySet<string> | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!indexed) return out;
  const [small, large] = universe.size <= indexed.size
    ? [universe, indexed]
    : [indexed, universe];
  for (const key of small) if (large.has(key)) out.add(key);
  return out;
}

function subtractIndex(
  universe: ReadonlySet<string>,
  excluded: ReadonlySet<string> | undefined,
): Set<string> {
  if (!excluded || excluded.size === 0) return new Set(universe);
  const out = new Set<string>();
  for (const key of universe) if (!excluded.has(key)) out.add(key);
  return out;
}

function addToSetMap(
  map: Map<string, Set<string>>,
  bucketKey: string,
  value: string,
): void {
  let bucket = map.get(bucketKey);
  if (!bucket) {
    bucket = new Set();
    map.set(bucketKey, bucket);
  }
  bucket.add(value);
}

function deleteFromSetMap(
  map: Map<string, Set<string>>,
  bucketKey: string,
  value: string,
): void {
  const bucket = map.get(bucketKey);
  if (!bucket) return;
  bucket.delete(value);
  if (bucket.size === 0) map.delete(bucketKey);
}

function compareRefs(a: FilterElementRef, b: FilterElementRef): number {
  return a.modelId.localeCompare(b.modelId) || a.elementId - b.elementId;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
