/**
 * Indexed BIM property filters.
 *
 * Filter definitions use the model-agnostic named-filter schema so they can be
 * persisted independently of one IFC revision. The backend evaluates the same
 * predicates against its revision-aware property index. Result paint belongs
 * to a dedicated colour layer; it never reuses the AI/search highlight channel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  filterElementsIndexed,
  type IndexedPropertyFilterResult,
  type PropertyFilterOperator,
} from '../../services/api';
import {
  NAMED_FILTER_SCHEMA_VERSION,
  NamedElementFilterEngine,
  type ElementFilterCondition,
  type ElementFilterExpression,
  type NamedElementFilterDefinition,
} from '../../services/ifc/namedFilterEngine';
import { useStore } from '../../store/useStore';

export const NAMED_FILTER_STORAGE_KEY = 'ifc-atlas.named-property-filters.v1';
export const FILTER_RESULT_COLOUR = '#38bdf8';
const FILTER_LAYER_PREFIX = 'filter:';
const MAX_CONDITIONS = 20;

let conditionSerial = 0;

export interface FilterConditionDraft {
  id: string;
  propertyName: string;
  operator: PropertyFilterOperator;
  value: string;
  psetName: string;
}

export interface NamedFilterDraft {
  name: string;
  logic: 'and' | 'or';
  conditions: FilterConditionDraft[];
  ifcTypes: string;
  storeys: string;
}

export const OPERATORS: { value: PropertyFilterOperator; label: string }[] = [
  { value: 'eq', label: '= equals' },
  { value: 'neq', label: '!= not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'startswith', label: 'starts with' },
  { value: 'gt', label: '> greater than' },
  { value: 'lt', label: '< less than' },
  { value: 'gte', label: '>= greater or equal' },
  { value: 'lte', label: '<= less or equal' },
  { value: 'exists', label: 'property exists' },
  { value: 'not_exists', label: 'property is missing' },
];

export function isNumericOperator(
  op: PropertyFilterOperator,
): op is Extract<PropertyFilterOperator, 'gt' | 'lt' | 'gte' | 'lte'> {
  return op === 'gt' || op === 'lt' || op === 'gte' || op === 'lte';
}

export function isUnaryOperator(
  op: PropertyFilterOperator,
): op is Extract<PropertyFilterOperator, 'exists' | 'not_exists'> {
  return op === 'exists' || op === 'not_exists';
}

export function createFilterCondition(
  seed: Partial<Omit<FilterConditionDraft, 'id'>> = {},
): FilterConditionDraft {
  conditionSerial += 1;
  return {
    id: `condition-${conditionSerial}`,
    propertyName: seed.propertyName ?? '',
    operator: seed.operator ?? 'eq',
    value: seed.value ?? '',
    psetName: seed.psetName ?? '',
  };
}

export function splitScopeValues(input: string): string[] {
  return [...new Set(
    input
      .split(/[,;\n]/)
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

export function validateFilterForm(
  propertyName: string,
  operator: PropertyFilterOperator,
  value: string,
): string | null {
  if (!propertyName.trim()) return 'Property name is required.';
  if (!isUnaryOperator(operator) && !value.trim()) return 'Value is required.';
  if (isNumericOperator(operator) && !Number.isFinite(Number(value))) {
    return `Operator "${operator}" requires a numeric value.`;
  }
  return null;
}

export function validateFilterConditions(conditions: readonly FilterConditionDraft[]): string | null {
  if (conditions.length < 1) return 'Add at least one condition.';
  if (conditions.length > MAX_CONDITIONS) return `Filters are limited to ${MAX_CONDITIONS} conditions.`;
  for (let index = 0; index < conditions.length; index += 1) {
    const condition = conditions[index];
    const error = validateFilterForm(condition.propertyName, condition.operator, condition.value);
    if (error) return `Condition ${index + 1}: ${error}`;
  }
  return null;
}

export function formatOperatorLabel(op: PropertyFilterOperator): string {
  return OPERATORS.find((option) => option.value === op)?.label ?? op;
}

function definitionConditionFromDraft(draft: FilterConditionDraft): ElementFilterCondition {
  const field = {
    kind: 'property' as const,
    name: draft.propertyName.trim(),
    ...(draft.psetName.trim() ? { pset: draft.psetName.trim() } : {}),
  };
  if (draft.operator === 'exists') return { kind: 'condition', field, operator: 'exists' };
  if (draft.operator === 'not_exists') return { kind: 'condition', field, operator: 'missing' };
  if (isNumericOperator(draft.operator)) {
    return { kind: 'condition', field, operator: draft.operator, value: Number(draft.value) };
  }
  if (draft.operator === 'startswith') {
    return { kind: 'condition', field, operator: 'startsWith', value: draft.value.trim() };
  }
  return {
    kind: 'condition',
    field,
    operator: draft.operator,
    value: draft.value.trim(),
  };
}

function makeDefinitionId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `property-${randomUuid}`;
  return `property-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Convert the server-oriented draft into an immutable, portable definition. */
export function namedDefinitionFromDraft(
  draft: NamedFilterDraft,
  identity?: { id: string; revision: number },
): NamedElementFilterDefinition {
  const error = validateFilterConditions(draft.conditions);
  if (error) throw new Error(error);
  const name = draft.name.trim();
  if (!name) throw new Error('Filter name is required.');

  const propertyExpression: ElementFilterExpression = {
    kind: 'group',
    operator: draft.logic,
    children: draft.conditions.map(definitionConditionFromDraft),
  };
  const scopedChildren: ElementFilterExpression[] = [propertyExpression];
  const ifcTypes = splitScopeValues(draft.ifcTypes);
  const storeys = splitScopeValues(draft.storeys);
  if (ifcTypes.length > 0) {
    scopedChildren.push({
      kind: 'condition',
      field: { kind: 'attribute', name: 'ifcType' },
      operator: 'in',
      values: ifcTypes,
    });
  }
  if (storeys.length > 0) {
    scopedChildren.push({
      kind: 'condition',
      field: { kind: 'attribute', name: 'storey' },
      operator: 'in',
      values: storeys,
    });
  }

  const validator = new NamedElementFilterEngine();
  return validator.saveDefinition({
    schemaVersion: NAMED_FILTER_SCHEMA_VERSION,
    id: identity?.id ?? makeDefinitionId(),
    revision: identity?.revision ?? 1,
    name,
    description: 'Saved BIM property filter',
    scope: { kind: 'all' },
    expression: { kind: 'group', operator: 'and', children: scopedChildren },
  });
}

function draftConditionFromDefinition(condition: ElementFilterCondition): FilterConditionDraft {
  if (condition.field.kind !== 'property') {
    throw new Error('Saved filter contains an unsupported non-property predicate.');
  }
  let operator: PropertyFilterOperator;
  if (condition.operator === 'missing') operator = 'not_exists';
  else if (condition.operator === 'startsWith') operator = 'startswith';
  else if (
    condition.operator === 'exists'
    || condition.operator === 'eq'
    || condition.operator === 'neq'
    || condition.operator === 'contains'
    || condition.operator === 'gt'
    || condition.operator === 'lt'
    || condition.operator === 'gte'
    || condition.operator === 'lte'
  ) operator = condition.operator;
  else throw new Error(`Saved filter operator "${condition.operator}" is not supported by the viewer.`);

  return createFilterCondition({
    propertyName: condition.field.name,
    psetName: condition.field.pset ?? '',
    operator,
    value: 'value' in condition ? String(condition.value) : '',
  });
}

/** Read definitions produced by `namedDefinitionFromDraft` back into the editor. */
export function draftFromNamedDefinition(definition: NamedElementFilterDefinition): NamedFilterDraft {
  const root = definition.expression;
  if (root.kind !== 'group' || root.operator !== 'and') {
    throw new Error('Saved filter has an unsupported expression layout.');
  }
  const propertyGroup = root.children.find((child) => child.kind === 'group');
  if (!propertyGroup || propertyGroup.kind !== 'group') {
    throw new Error('Saved filter has no property conditions.');
  }
  const conditions = propertyGroup.children.map((child) => {
    if (child.kind !== 'condition') throw new Error('Nested property groups are not editable here.');
    return draftConditionFromDefinition(child);
  });

  let ifcTypes: string[] = [];
  let storeys: string[] = [];
  for (const child of root.children) {
    if (child.kind !== 'condition' || child.field.kind !== 'attribute' || child.operator !== 'in') continue;
    const values = child.values.map(String);
    if (child.field.name.toLocaleLowerCase() === 'ifctype') ifcTypes = values;
    if (child.field.name.toLocaleLowerCase() === 'storey') storeys = values;
  }

  return {
    name: definition.name,
    logic: propertyGroup.operator,
    conditions,
    ifcTypes: ifcTypes.join(', '),
    storeys: storeys.join(', '),
  };
}

/** Parse and validate local persistence without allowing one bad entry to hide the rest. */
export function parseNamedFilterStorage(serialized: string | null): NamedElementFilterDefinition[] {
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object') return [];
    const payload = parsed as { schemaVersion?: unknown; definitions?: unknown };
    if (payload.schemaVersion !== NAMED_FILTER_SCHEMA_VERSION || !Array.isArray(payload.definitions)) return [];
    const engine = new NamedElementFilterEngine();
    for (const candidate of payload.definitions) {
      try {
        engine.saveDefinition(candidate as NamedElementFilterDefinition);
      } catch {
        // Preserve the valid definitions and ignore only the corrupt entry.
      }
    }
    return [...engine.listDefinitions()];
  } catch {
    return [];
  }
}

export function serializeNamedFilters(definitions: readonly NamedElementFilterDefinition[]): string {
  return JSON.stringify({ schemaVersion: NAMED_FILTER_SCHEMA_VERSION, definitions });
}

function readSavedFilters(): NamedElementFilterDefinition[] {
  if (typeof window === 'undefined') return [];
  try {
    return parseNamedFilterStorage(window.localStorage.getItem(NAMED_FILTER_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function ElementFilterPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const {
    filterPanelOpen,
    modelLoaded,
    modelFingerprint,
    modelVersion,
    setFilterPanelOpen,
    setFilterResultIds,
    setColourLayer,
    clearColourLayer,
    setIsolatedIds,
    addHiddenIds,
    clearVisibility,
    frameElements,
  } = useStore(useShallow((state) => ({
    filterPanelOpen: state.filterPanelOpen,
    modelLoaded: state.modelLoaded,
    modelFingerprint: state.modelFingerprint,
    modelVersion: state.modelVersion,
    setFilterPanelOpen: state.setFilterPanelOpen,
    setFilterResultIds: state.setFilterResultIds,
    setColourLayer: state.setColourLayer,
    clearColourLayer: state.clearColourLayer,
    setIsolatedIds: state.setIsolatedIds,
    addHiddenIds: state.addHiddenIds,
    clearVisibility: state.clearVisibility,
    frameElements: state.frameElements,
  })));

  const [filterName, setFilterName] = useState('');
  const [logic, setLogic] = useState<'and' | 'or'>('and');
  const [conditions, setConditions] = useState<FilterConditionDraft[]>(() => [createFilterCondition()]);
  const [ifcTypes, setIfcTypes] = useState('');
  const [storeys, setStoreys] = useState('');
  const [showScope, setShowScope] = useState(false);
  const [colour, setColour] = useState(FILTER_RESULT_COLOUR);
  const [savedFilters, setSavedFilters] = useState<NamedElementFilterDefinition[]>(readSavedFilters);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<IndexedPropertyFilterResult | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const activeLayerRef = useRef<string | null>(null);
  const resultContractRef = useRef<{ fingerprint: string | null; version: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(NAMED_FILTER_STORAGE_KEY, serializeNamedFilters(savedFilters));
    } catch {
      // Private browsing/storage quotas must not prevent filtering.
    }
  }, [savedFilters]);

  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    if (!filterPanelOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (useStore.getState().commandPaletteOpen || useStore.getState().settingsOpen) return;
      event.stopPropagation();
      setFilterPanelOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [filterPanelOpen, setFilterPanelOpen]);

  const updateCondition = useCallback((id: string, patch: Partial<FilterConditionDraft>) => {
    setConditions((current) => current.map((condition) => (
      condition.id === id ? { ...condition, ...patch } : condition
    )));
  }, []);

  const paintResult = useCallback((ids: number[], exactCount: number) => {
    const nextLayerId = `${FILTER_LAYER_PREFIX}${activeSavedId ?? 'preview'}`;
    if (activeLayerRef.current && activeLayerRef.current !== nextLayerId) {
      clearColourLayer(activeLayerRef.current);
    }
    activeLayerRef.current = nextLayerId;
    if (ids.length === 0) {
      clearColourLayer(nextLayerId);
      return;
    }
    const label = ids.length === exactCount
      ? `${exactCount.toLocaleString()} matches`
      : `${ids.length.toLocaleString()} of ${exactCount.toLocaleString()} matches`;
    setColourLayer(nextLayerId, {
      name: filterName.trim() || 'Property filter',
      entries: [{ color: colour, ids }],
      legend: [{ color: colour, label }],
    });
  }, [activeSavedId, clearColourLayer, colour, filterName, setColourLayer]);

  const handleApply = useCallback(async () => {
    const validationError = validateFilterConditions(conditions);
    if (validationError) {
      setError(validationError);
      return;
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const response = await filterElementsIndexed({
        name: filterName.trim() || undefined,
        logic,
        conditions: conditions.map((condition) => ({
          property_name: condition.propertyName.trim(),
          operator: condition.operator,
          ...(!isUnaryOperator(condition.operator) ? { value: condition.value.trim() } : {}),
          ...(condition.psetName.trim() ? { pset_name: condition.psetName.trim() } : {}),
        })),
        ifc_types: splitScopeValues(ifcTypes),
        storeys: splitScopeValues(storeys),
        max_result_ids: 200_000,
        detail_limit: 20,
      }, { signal: controller.signal });
      const currentModel = useStore.getState();
      if (
        !currentModel.modelLoaded
        || response.model_fingerprint !== currentModel.modelFingerprint
        || response.index_version !== currentModel.modelVersion
      ) {
        return;
      }
      resultContractRef.current = {
        fingerprint: response.model_fingerprint,
        version: response.index_version,
      };
      setResult(response);
      setFilterResultIds(response.element_ids);
      paintResult(response.element_ids, response.count);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : 'Filter request failed.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [conditions, filterName, ifcTypes, logic, paintResult, setFilterResultIds, storeys]);

  const handleSave = useCallback(() => {
    try {
      const existing = savedFilters.find((definition) => definition.id === activeSavedId)
        ?? savedFilters.find((definition) => definition.name.toLocaleLowerCase() === filterName.trim().toLocaleLowerCase());
      const definition = namedDefinitionFromDraft(
        { name: filterName, logic, conditions, ifcTypes, storeys },
        existing ? { id: existing.id, revision: existing.revision + 1 } : undefined,
      );
      setSavedFilters((current) => [
        ...current.filter((item) => item.id !== definition.id),
        definition,
      ].sort((a, b) => a.name.localeCompare(b.name)));
      setActiveSavedId(definition.id);
      setError(null);
      setNotice(existing ? 'Saved filter updated.' : 'Filter saved for this browser.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Filter could not be saved.');
    }
  }, [activeSavedId, conditions, filterName, ifcTypes, logic, savedFilters, storeys]);

  const handleLoadSaved = useCallback((id: string) => {
    if (!id) {
      setActiveSavedId(null);
      return;
    }
    const definition = savedFilters.find((candidate) => candidate.id === id);
    if (!definition) return;
    try {
      const draft = draftFromNamedDefinition(definition);
      setFilterName(draft.name);
      setLogic(draft.logic);
      setConditions(draft.conditions);
      setIfcTypes(draft.ifcTypes);
      setStoreys(draft.storeys);
      setShowScope(Boolean(draft.ifcTypes || draft.storeys));
      setActiveSavedId(definition.id);
      setError(null);
      setNotice('Saved filter loaded. Apply it to the current model.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Saved filter is not editable.');
    }
  }, [savedFilters]);

  const handleDeleteSaved = useCallback(() => {
    if (!activeSavedId) return;
    clearColourLayer(`${FILTER_LAYER_PREFIX}${activeSavedId}`);
    setSavedFilters((current) => current.filter((definition) => definition.id !== activeSavedId));
    setActiveSavedId(null);
    setNotice('Saved filter deleted.');
  }, [activeSavedId, clearColourLayer]);

  const clearResult = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (activeLayerRef.current) clearColourLayer(activeLayerRef.current);
    activeLayerRef.current = null;
    resultContractRef.current = null;
    setResult(null);
    setFilterResultIds([]);
    setLoading(false);
  }, [clearColourLayer, setFilterResultIds]);

  // Express IDs are model-local. Drop an applied result as soon as the model
  // unloads or its semantic revision changes so stale actions cannot target a
  // different element that happens to reuse the same numeric id.
  useEffect(() => {
    const contract = resultContractRef.current;
    if (!contract) return;
    if (
      !modelLoaded
      || contract.fingerprint !== modelFingerprint
      || contract.version !== modelVersion
    ) {
      clearResult();
    }
  }, [clearResult, modelFingerprint, modelLoaded, modelVersion]);

  const handleReset = useCallback(() => {
    clearResult();
    setFilterName('');
    setLogic('and');
    setConditions([createFilterCondition()]);
    setIfcTypes('');
    setStoreys('');
    setShowScope(false);
    setActiveSavedId(null);
    setError(null);
    setNotice(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [clearResult]);

  if (!filterPanelOpen) return null;

  const resultIds = result?.element_ids ?? [];
  const hasResult = resultIds.length > 0;

  return (
    <div
      className="element-filter-panel"
      role={embedded ? 'region' : 'dialog'}
      aria-label="Element property filter"
    >
      {!embedded && (
        <div className="efp-header">
          <span className="efp-title">BIM filters</span>
          <button
            className="efp-close"
            onClick={() => setFilterPanelOpen(false)}
            aria-label="Close filter panel"
            title="Close (Shift+F)"
          >
            &times;
          </button>
        </div>
      )}

      <div className="efp-body">
        {savedFilters.length > 0 && (
          <div className="efp-saved-row">
            <label className="efp-label" htmlFor="efp-saved">Saved</label>
            <select
              id="efp-saved"
              className="efp-select"
              value={activeSavedId ?? ''}
              onChange={(event) => handleLoadSaved(event.target.value)}
            >
              <option value="">Choose a saved filter</option>
              {savedFilters.map((definition) => (
                <option key={definition.id} value={definition.id}>{definition.name}</option>
              ))}
            </select>
            <button
              className="efp-icon-btn"
              type="button"
              onClick={handleDeleteSaved}
              disabled={!activeSavedId}
              aria-label="Delete saved filter"
              title="Delete saved filter"
            >
              Delete
            </button>
          </div>
        )}

        <div className="efp-name-row">
          <div className="efp-row">
            <label className="efp-label" htmlFor="efp-name">Filter name</label>
            <input
              id="efp-name"
              className="efp-input"
              type="text"
              placeholder="e.g. External fire-rated walls"
              value={filterName}
              onChange={(event) => setFilterName(event.target.value)}
              autoComplete="off"
            />
          </div>
          <button className="efp-btn efp-btn--quiet" type="button" onClick={handleSave} disabled={loading}>
            Save
          </button>
        </div>

        <div className="efp-condition-header">
          <span className="efp-label">Match conditions</span>
          <div className="efp-logic" role="group" aria-label="Condition logic">
            <button
              type="button"
              className={logic === 'and' ? 'active' : ''}
              aria-pressed={logic === 'and'}
              onClick={() => setLogic('and')}
            >
              AND
            </button>
            <button
              type="button"
              className={logic === 'or' ? 'active' : ''}
              aria-pressed={logic === 'or'}
              onClick={() => setLogic('or')}
            >
              OR
            </button>
          </div>
        </div>

        <div className="efp-condition-stack" data-logic={logic.toUpperCase()}>
          {conditions.map((condition, index) => {
            const propertyId = `efp-property-${condition.id}`;
            return (
              <div className="efp-condition" key={condition.id}>
                <div className="efp-condition-index" aria-hidden="true">{index + 1}</div>
                <div className="efp-condition-fields">
                  <div className="efp-condition-property-row">
                    <div className="efp-row">
                      <label className="efp-label" htmlFor={propertyId}>Property</label>
                      <input
                        ref={index === 0 ? inputRef : undefined}
                        id={propertyId}
                        className="efp-input"
                        type="text"
                        placeholder="FireRating, Area, Name"
                        value={condition.propertyName}
                        onChange={(event) => updateCondition(condition.id, { propertyName: event.target.value })}
                        onKeyDown={(event) => event.key === 'Enter' && void handleApply()}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="efp-row efp-row--pset">
                      <label className="efp-label" htmlFor={`efp-pset-${condition.id}`}>Pset</label>
                      <input
                        id={`efp-pset-${condition.id}`}
                        className="efp-input"
                        type="text"
                        placeholder="Any"
                        value={condition.psetName}
                        onChange={(event) => updateCondition(condition.id, { psetName: event.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="efp-condition-value-row">
                    <select
                      className="efp-select"
                      aria-label={`Operator for condition ${index + 1}`}
                      value={condition.operator}
                      onChange={(event) => updateCondition(condition.id, {
                        operator: event.target.value as PropertyFilterOperator,
                      })}
                    >
                      {OPERATORS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    {!isUnaryOperator(condition.operator) && (
                      <input
                        className="efp-input"
                        aria-label={`Value for condition ${index + 1}`}
                        type={isNumericOperator(condition.operator) ? 'number' : 'text'}
                        placeholder={isNumericOperator(condition.operator) ? '20.0' : 'Value'}
                        value={condition.value}
                        onChange={(event) => updateCondition(condition.id, { value: event.target.value })}
                        onKeyDown={(event) => event.key === 'Enter' && void handleApply()}
                        autoComplete="off"
                      />
                    )}
                    {conditions.length > 1 && (
                      <button
                        className="efp-remove-condition"
                        type="button"
                        onClick={() => setConditions((current) => current.filter((item) => item.id !== condition.id))}
                        aria-label={`Remove condition ${index + 1}`}
                        title="Remove condition"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <button
          className="efp-add-condition"
          type="button"
          disabled={conditions.length >= MAX_CONDITIONS}
          onClick={() => setConditions((current) => [...current, createFilterCondition()])}
        >
          + Add condition
        </button>

        <button
          className="efp-advanced-toggle"
          type="button"
          onClick={() => setShowScope((current) => !current)}
          aria-expanded={showScope}
        >
          <span aria-hidden="true">{showScope ? '\u25be' : '\u25b8'}</span>
          Limit by IFC type or storey
        </button>

        {showScope && (
          <div className="efp-advanced">
            <div className="efp-row">
              <label className="efp-label" htmlFor="efp-types">IFC types</label>
              <input
                id="efp-types"
                className="efp-input efp-input--small"
                type="text"
                placeholder="IfcWall, IfcCurtainWall"
                value={ifcTypes}
                onChange={(event) => setIfcTypes(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="efp-row">
              <label className="efp-label" htmlFor="efp-storeys">Storeys</label>
              <input
                id="efp-storeys"
                className="efp-input efp-input--small"
                type="text"
                placeholder="Ground Floor, Level 1"
                value={storeys}
                onChange={(event) => setStoreys(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="efp-hint">Separate multiple values with commas. Scopes always constrain the full filter.</p>
          </div>
        )}

        {error && <p className="efp-error" role="alert">{error}</p>}
        {notice && !error && <p className="efp-notice" role="status">{notice}</p>}

        <div className="efp-actions">
          <button className="efp-btn efp-btn--apply" type="button" onClick={() => void handleApply()} disabled={loading}>
            {loading ? 'Evaluating...' : 'Apply filter'}
          </button>
          <button className="efp-btn efp-btn--clear" type="button" onClick={handleReset} disabled={loading}>
            Reset
          </button>
        </div>

        {result !== null && (
          <div className="efp-result" aria-live="polite">
            {result.count === 0 ? (
              <span className="efp-result-none">No elements match this filter.</span>
            ) : (
              <>
                <div className="efp-result-summary">
                  <span className="efp-result-count">
                    {result.count.toLocaleString()} match{result.count === 1 ? '' : 'es'}
                  </span>
                  <span className="efp-result-time">
                    {result.elapsed_ms.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms
                  </span>
                </div>
                {result.truncated && (
                  <p className="efp-hint">
                    Viewer actions use the first {result.element_ids.length.toLocaleString()} matches.
                  </p>
                )}
                <div className="efp-result-tools" aria-label="Filter result actions">
                  <label className="efp-colour-control" title="Filter result colour">
                    <span>Colour</span>
                    <input
                      type="color"
                      value={colour}
                      onChange={(event) => setColour(event.target.value)}
                      aria-label="Filter result colour"
                    />
                  </label>
                  <button type="button" onClick={() => paintResult(resultIds, result.count)} disabled={!hasResult}>Paint</button>
                  <button type="button" onClick={() => setIsolatedIds(resultIds)} disabled={!hasResult}>Isolate</button>
                  <button type="button" onClick={() => addHiddenIds(resultIds)} disabled={!hasResult}>Hide</button>
                  <button type="button" onClick={() => frameElements(resultIds)} disabled={!hasResult}>Frame</button>
                  <button type="button" onClick={clearVisibility}>Show all</button>
                  <button type="button" onClick={clearResult}>Clear result</button>
                </div>
                <div className="efp-result-list">
                  {result.elements.slice(0, 10).map((element) => (
                    <div key={element.id} className="efp-result-row">
                      <span className="efp-result-name" title={`#${element.id}`}>
                        {element.name || `#${element.id}`}
                      </span>
                      <span className="efp-result-type">{element.ifc_type}</span>
                      <span
                        className="efp-result-value"
                        title={element.matches[0]
                          ? `${element.matches[0].pset}.${element.matches[0].property}`
                          : undefined}
                      >
                        {String(element.matches[0]?.value ?? element.value ?? '')}
                      </span>
                    </div>
                  ))}
                  {result.count > result.elements.length && (
                    <p className="efp-result-more">
                      Previewing {result.elements.length.toLocaleString()} of {result.count.toLocaleString()}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
