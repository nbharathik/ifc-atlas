import { describe, expect, it } from 'vitest';
import type { ElementDetail } from '../../types/ifc';
import {
  NAMED_FILTER_SCHEMA_VERSION,
  NamedElementFilterEngine,
  filterRecordFromElementDetail,
  stableElementRefKey,
  type ElementFilterExpression,
  type ElementFilterScope,
  type FilterElementRecord,
  type NamedElementFilterDefinition,
} from './namedFilterEngine';

const property = (name: string, value: string | number | boolean | null, pset = 'Pset_Common') => ({
  pset,
  name,
  value,
});

function record(
  modelId: string,
  elementId: number,
  input: Omit<FilterElementRecord, 'ref'> = {},
): FilterElementRecord {
  return { ref: { modelId, elementId }, ...input };
}

function definition(
  expression: ElementFilterExpression,
  scope: ElementFilterScope = { kind: 'all' },
  overrides: Partial<NamedElementFilterDefinition> = {},
): NamedElementFilterDefinition {
  return {
    schemaVersion: NAMED_FILTER_SCHEMA_VERSION,
    id: 'filter.test',
    revision: 1,
    name: 'Test filter',
    scope,
    expression,
    ...overrides,
  };
}

function setupEngine(): NamedElementFilterEngine {
  const engine = new NamedElementFilterEngine();
  engine.replaceModel('model-a', [
    record('model-a', 1, {
      attributes: {
        name: 'External Wall A',
        ifcType: 'IfcWall',
        storey: 'Ground Floor',
        material: null,
        isExternal: true,
      },
      properties: [
        property('FireRating', '2H', 'Pset_WallCommon'),
        property('LoadBearing', null, 'Pset_WallCommon'),
        property('Code', '3'),
      ],
      quantities: { Height: 3.2 },
    }),
    record('model-a', 2, {
      attributes: {
        name: 'Internal Wall B',
        ifcType: 'IfcWall',
        storey: 'Level 1',
        isExternal: false,
      },
      properties: [property('FireRating', '1h', 'Pset_WallCommon')],
      quantities: { Height: 4.5 },
    }),
    record('model-a', 3, {
      attributes: {
        name: 'Door C',
        ifcType: 'IfcDoor',
        storey: 'Ground Floor',
      },
      properties: [
        property('FireRating', null, 'Pset_DoorCommon'),
        property('LoadBearing', true, 'Pset_Common'),
        property('Note', '', 'Pset_Common'),
      ],
      quantities: { Height: 2.1 },
    }),
  ]);
  engine.replaceModel('model-b', [
    record('model-b', 1, {
      attributes: { name: 'Linked Wall', ifcType: 'IfcWall', storey: 'Ground Floor' },
      properties: [
        property('FireRating', '2h', 'Pset_Other'),
        property('LoadBearing', false, 'Pset_Common'),
      ],
      quantities: { Height: 5 },
    }),
  ]);
  return engine;
}

function matchedKeys(
  engine: NamedElementFilterEngine,
  filter: NamedElementFilterDefinition,
): string[] {
  return engine.evaluate(filter).matches.map(stableElementRefKey);
}

describe('NamedElementFilterEngine expressions', () => {
  it('combines typed AND/OR groups and returns stable federated references', () => {
    const engine = setupEngine();
    const expression: ElementFilterExpression = {
      kind: 'group',
      operator: 'and',
      children: [
        {
          kind: 'condition',
          field: { kind: 'attribute', name: 'ifcType' },
          operator: 'eq',
          value: 'IFCWALL',
        },
        {
          kind: 'group',
          operator: 'or',
          children: [
            {
              kind: 'condition',
              field: { kind: 'property', pset: 'Pset_WallCommon', name: 'FireRating' },
              operator: 'eq',
              value: '2h',
            },
            {
              kind: 'condition',
              field: { kind: 'quantity', name: 'Height' },
              operator: 'gt',
              value: 4,
            },
          ],
        },
      ],
    };

    expect(matchedKeys(engine, definition(expression))).toEqual([
      stableElementRefKey({ modelId: 'model-a', elementId: 1 }),
      stableElementRefKey({ modelId: 'model-a', elementId: 2 }),
      stableElementRefKey({ modelId: 'model-b', elementId: 1 }),
    ]);
  });

  it('treats empty AND as the scope identity and empty OR as no matches', () => {
    const engine = setupEngine();
    expect(engine.evaluate(definition({ kind: 'group', operator: 'and', children: [] })).matchedCount).toBe(4);
    expect(engine.evaluate(definition({ kind: 'group', operator: 'or', children: [] })).matchedCount).toBe(0);
  });

  it('matches I against i case-insensitively regardless of the host locale', () => {
    // Uses toLowerCase (not toLocaleLowerCase) so 'I' always folds to 'i',
    // matching the backend index built with Python str.lower() even when the
    // browser runs under a Turkish-style locale with a dotless ı.
    const engine = setupEngine();
    const field = { kind: 'attribute', name: 'name' } as const;
    expect(engine.evaluate(definition({
      kind: 'condition', field, operator: 'eq', value: 'INTERNAL WALL B',
    })).matches).toEqual([{ modelId: 'model-a', elementId: 2 }]);
    expect(engine.evaluate(definition({
      kind: 'condition', field, operator: 'contains', value: 'INTERNAL',
    })).matches).toEqual([{ modelId: 'model-a', elementId: 2 }]);
  });

  it('supports case-sensitive string comparisons without changing the default', () => {
    const engine = setupEngine();
    const field = { kind: 'property', name: 'FireRating' } as const;
    expect(engine.evaluate(definition({ kind: 'condition', field, operator: 'eq', value: '2h' })).matchedCount).toBe(2);
    expect(engine.evaluate(definition({
      kind: 'condition', field, operator: 'eq', value: '2h', caseSensitive: true,
    })).matches).toEqual([{ modelId: 'model-b', elementId: 1 }]);
  });
});

describe('missing, null, and typed value semantics', () => {
  const loadBearing = { kind: 'property', name: 'LoadBearing' } as const;

  it('distinguishes presence, missing, explicit null, and non-null', () => {
    const engine = setupEngine();
    expect(engine.evaluate(definition({ kind: 'condition', field: loadBearing, operator: 'exists' })).matchedCount).toBe(3);
    expect(engine.evaluate(definition({ kind: 'condition', field: loadBearing, operator: 'missing' })).matches).toEqual([
      { modelId: 'model-a', elementId: 2 },
    ]);
    expect(engine.evaluate(definition({ kind: 'condition', field: loadBearing, operator: 'isNull' })).matches).toEqual([
      { modelId: 'model-a', elementId: 1 },
    ]);
    expect(engine.evaluate(definition({ kind: 'condition', field: loadBearing, operator: 'isNotNull' })).matchedCount).toBe(2);
  });

  it('does not let neq accidentally include missing or null values', () => {
    const engine = setupEngine();
    expect(engine.evaluate(definition({
      kind: 'condition', field: loadBearing, operator: 'neq', value: true,
    })).matches).toEqual([{ modelId: 'model-b', elementId: 1 }]);

    expect(engine.evaluate(definition({
      kind: 'condition',
      field: { kind: 'property', name: 'FireRating' },
      operator: 'neq',
      value: '2h',
    })).matches).toEqual([{ modelId: 'model-a', elementId: 2 }]);
  });

  it('keeps empty string separate from null and missing', () => {
    const engine = setupEngine();
    const note = { kind: 'property', name: 'Note' } as const;
    expect(engine.evaluate(definition({ kind: 'condition', field: note, operator: 'eq', value: '' })).matches).toEqual([
      { modelId: 'model-a', elementId: 3 },
    ]);
    expect(engine.evaluate(definition({ kind: 'condition', field: note, operator: 'isNull' })).matchedCount).toBe(0);
    expect(engine.evaluate(definition({ kind: 'condition', field: note, operator: 'missing' })).matchedCount).toBe(3);
  });

  it('uses strict scalar types and numeric ranges', () => {
    const engine = setupEngine();
    const code = { kind: 'property', name: 'Code' } as const;
    expect(engine.evaluate(definition({ kind: 'condition', field: code, operator: 'eq', value: 3 })).matchedCount).toBe(0);
    expect(engine.evaluate(definition({ kind: 'condition', field: code, operator: 'eq', value: '3' })).matchedCount).toBe(1);
    expect(engine.evaluate(definition({
      kind: 'condition', field: { kind: 'quantity', name: 'Height' }, operator: 'gte', value: 4.5,
    })).matchedCount).toBe(2);
  });

  it('qualifies property sets when requested and supports any-pset lookup', () => {
    const engine = setupEngine();
    expect(engine.evaluate(definition({
      kind: 'condition',
      field: { kind: 'property', pset: 'Pset_WallCommon', name: 'FireRating' },
      operator: 'eq',
      value: '2h',
    })).matches).toEqual([{ modelId: 'model-a', elementId: 1 }]);
    expect(engine.evaluate(definition({
      kind: 'condition',
      field: { kind: 'property', name: 'FireRating' },
      operator: 'eq',
      value: '2h',
    })).matchedCount).toBe(2);
  });
});

describe('stable scopes and named definitions', () => {
  const allWalls: ElementFilterExpression = {
    kind: 'condition',
    field: { kind: 'attribute', name: 'ifcType' },
    operator: 'eq',
    value: 'IfcWall',
  };

  it('separates duplicate numeric ids by model scope', () => {
    const engine = setupEngine();
    expect(engine.evaluate(definition(allWalls, { kind: 'models', modelIds: ['model-a'] })).matchedCount).toBe(2);
    expect(engine.evaluate(definition(allWalls, {
      kind: 'elements',
      elements: [
        { modelId: 'model-b', elementId: 1 },
        { modelId: 'model-a', elementId: 2 },
      ],
    })).matches).toEqual([
      { modelId: 'model-a', elementId: 2 },
      { modelId: 'model-b', elementId: 1 },
    ]);
  });

  it('stores immutable definitions and requires revision bumps for changes', () => {
    const engine = setupEngine();
    const initial = definition(allWalls, { kind: 'models', modelIds: ['model-b', 'model-a', 'model-a'] });
    const saved = engine.saveDefinition(initial);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.scope)).toBe(true);
    expect(saved.scope).toEqual({ kind: 'models', modelIds: ['model-a', 'model-b'] });
    expect(engine.saveDefinition(initial)).toBe(saved);
    expect(() => engine.saveDefinition({ ...initial, name: 'Changed without revision' })).toThrow(/revision/i);

    const revised = engine.saveDefinition({ ...initial, revision: 2, name: 'Revised walls' });
    expect(revised.revision).toBe(2);
    expect(engine.evaluate(initial.id).definitionRevision).toBe(2);
    expect(engine.stats.definitionCount).toBe(1);
  });

  it('replaces one model without retaining stale index entries', () => {
    const engine = setupEngine();
    engine.replaceModel('model-a', [
      record('model-a', 9, { attributes: { ifcType: 'IfcDoor', name: 'Replacement' } }),
    ]);
    expect(engine.evaluate(definition(allWalls)).matches).toEqual([{ modelId: 'model-b', elementId: 1 }]);
    expect(engine.stats).toMatchObject({ elementCount: 2, modelCount: 2 });
  });

  it('validates a replacement before removing the existing model', () => {
    const engine = setupEngine();
    expect(() => engine.replaceModel('model-a', [record('wrong-model', 8)])).toThrow(/does not match/i);
    expect(engine.stats.elementCount).toBe(4);
  });
});

describe('ElementDetail adapter and validation', () => {
  it('preserves typed property, quantity, and explicit-null values', () => {
    const detail: ElementDetail = {
      id: 42,
      global_id: 'guid-42',
      name: null,
      ifc_type: 'IfcSlab',
      storey: 'Level 2',
      material: 'Concrete',
      property_sets: [{ name: 'Pset_SlabCommon', properties: { IsExternal: true, Reference: null } }],
      quantities: { GrossArea: 125.5 },
      relating_type: null,
      description: null,
      object_type: 'Floor slab',
      tag: null,
      predefined_type: 'FLOOR',
    };
    const engine = new NamedElementFilterEngine();
    engine.upsertElement(filterRecordFromElementDetail('fingerprint-1', detail, {
      attributes: { discipline: 'Architecture' },
    }));

    const expression: ElementFilterExpression = {
      kind: 'group',
      operator: 'and',
      children: [
        { kind: 'condition', field: { kind: 'attribute', name: 'name' }, operator: 'isNull' },
        { kind: 'condition', field: { kind: 'property', name: 'IsExternal' }, operator: 'eq', value: true },
        { kind: 'condition', field: { kind: 'quantity', name: 'GrossArea' }, operator: 'gt', value: 100 },
        { kind: 'condition', field: { kind: 'attribute', name: 'discipline' }, operator: 'eq', value: 'architecture' },
      ],
    };
    expect(engine.evaluate(definition(expression)).matches).toEqual([
      { modelId: 'fingerprint-1', elementId: 42 },
    ]);
  });

  it('rejects null equality targets and invalid numeric predicates at runtime', () => {
    const engine = setupEngine();
    const invalidNull = definition({
      kind: 'condition',
      field: { kind: 'property', name: 'Reference' },
      operator: 'eq',
      value: null,
    } as unknown as ElementFilterExpression);
    expect(() => engine.evaluate(invalidNull)).toThrow(/isNull/i);

    const invalidRange = definition({
      kind: 'condition',
      field: { kind: 'quantity', name: 'Height' },
      operator: 'gt',
      value: Number.NaN,
    });
    expect(() => engine.evaluate(invalidRange)).toThrow(/finite numeric/i);
  });
});
