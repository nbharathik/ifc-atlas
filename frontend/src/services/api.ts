import type {
  ProjectInfo, SpatialNode, ElementSummary, ElementDetail,
  ModelStats, ModelMeta, SearchResult, EditApplyRequest, EditApplyResponse,
  AgentPreset, AgentCreatePayload, McpServerConfig,
  PendingEditEnvelope, AggregateResult, OperationResult,
} from '../types/ifc';
import type { HealthCheckResult } from '../store/useStore';
import { exportFilename } from './exportFilename';
import { apiUrl } from '../lib/platform';

const BASE = '/api';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(`${BASE}${url}`), init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Upload an IFC file and get project + tree + stats in one response.
 * Saves two round-trips compared to calling /project + /tree + /stats
 * after upload separately.
 */
export async function uploadIfc(file: File): Promise<ModelMeta> {
  const form = new FormData();
  form.append('file', file);
  return fetchJson<ModelMeta>('/ifc/upload', { method: 'POST', body: form });
}

/** Re-hydrate from the currently-loaded backend model (no re-upload). */
export async function getMeta(): Promise<ModelMeta> {
  return fetchJson<ModelMeta>('/ifc/meta');
}

export async function uploadIfcWithMode(
  file: File,
  mode: 'minimal' | 'full',
  init?: Omit<RequestInit, 'method' | 'body'> & {
    /** When false, ask the backend to skip the eager fragment prebuild -
     *  set when the client has disabled the server fragment cache
     *  (`useServerCache=false`), since the prebuild output would never be
     *  reused. Defaults to true on the backend. */
    prebuildFragments?: boolean;
    /** Conversion profile the viewer will request from POST /convert. The
     *  backend prebuilds THIS profile's cache entry; a mismatch warms an
     *  entry nobody reads and runs the sidecar twice. Backend default is
     *  balanced. */
    prebuildProfile?: string;
  },
): Promise<ModelMeta> {
  const form = new FormData();
  form.append('file', file);
  const params = new URLSearchParams({ response: mode });
  if (init?.prebuildFragments === false) {
    params.set('prebuild_fragments', 'false');
  }
  if (init?.prebuildProfile && init.prebuildProfile !== 'balanced') {
    params.set('prebuild_profile', init.prebuildProfile);
  }
  const { prebuildFragments: _unused, prebuildProfile: _unusedProfile, ...fetchInit } = init ?? {};
  return fetchJson<ModelMeta>(`/ifc/upload?${params.toString()}`, {
    ...fetchInit,
    method: 'POST',
    body: form,
  });
}

export async function getMetaWithMode(mode: 'minimal' | 'full'): Promise<ModelMeta> {
  return fetchJson<ModelMeta>(`/ifc/meta?response=${mode}`);
}

export async function applyIfcEdits(request: EditApplyRequest): Promise<EditApplyResponse> {
  return fetchJson<EditApplyResponse>('/ifc/edits/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

// ---------------------------------------------------------------------------
// Operation layer - editor UI direct edits (ADR 003). Every call goes through
// /api/ifc/operations/* with actor=USER; the backend logs it and emits the
// sync event so the viewer updates. A 403 means edit mode is disabled.
// ---------------------------------------------------------------------------

export interface OperationCatalogueEntry {
  name: string;
  summary: string;
  writes: boolean;
  required: Record<string, string>;
  optional: Record<string, string>;
  default_tier: string;
}

export async function executeOperation(
  operation: string,
  params: Record<string, unknown>,
): Promise<OperationResult> {
  return fetchJson<OperationResult>('/ifc/operations/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, params }),
  });
}

export async function undoOperation(): Promise<OperationResult> {
  return fetchJson<OperationResult>('/ifc/operations/undo', { method: 'POST' });
}

export async function redoOperation(): Promise<OperationResult> {
  return fetchJson<OperationResult>('/ifc/operations/redo', { method: 'POST' });
}

export async function getOperationsCatalogue(): Promise<OperationCatalogueEntry[]> {
  const r = await fetchJson<{ operations: OperationCatalogueEntry[] }>(
    '/ifc/operations/catalogue',
  );
  return r.operations;
}

export async function getOperationsHistory(limit = 100): Promise<Record<string, unknown>[]> {
  const r = await fetchJson<{ operations: Record<string, unknown>[] }>(
    `/ifc/operations/history?limit=${limit}`,
  );
  return r.operations;
}

// ---------------------------------------------------------------------------
// History timeline - semantic compare between checkpoints (ifcdiff, plan C3)
// ---------------------------------------------------------------------------

export interface HistoryDiffEntry {
  global_id: string;
  express_id: number | null;
  ifc_type: string | null;
  name: string | null;
  change: 'added' | 'deleted' | 'changed';
  detail?: Record<string, unknown>;
}

export interface HistoryDiffResult {
  from_sha: string;
  to_sha: string | null;
  added: number;
  deleted: number;
  changed: number;
  total: number;
  truncated: boolean;
  entries: HistoryDiffEntry[];
}

/** Semantic diff between two checkpoints; omit `toSha` to compare against the
 *  current working model. Element-level, including property/pset changes. */
export async function getHistoryDiff(fromSha: string, toSha?: string | null): Promise<HistoryDiffResult> {
  const params = new URLSearchParams({ from_sha: fromSha });
  if (toSha) params.set('to_sha', toSha);
  return fetchJson<HistoryDiffResult>(`/ifc/history/diff?${params}`);
}

// ---------------------------------------------------------------------------
// Reference-docs knowledge index (Chat Manager → Knowledge tab, plan E4)
// ---------------------------------------------------------------------------

/** Semantic-search state embedded in the reference-docs status payload
 *  (backend `DocumentIndexService.semantic_status()`). */
export interface ReferenceDocsSemanticStatus {
  /** fastembed + hnswlib importable in the backend environment. */
  available: boolean;
  /** Hybrid (semantic) index actually built for the current chunks. */
  built: boolean;
  /** Embedding model id, informational. */
  model: string;
  /** Total indexed text chunks across all reference documents. */
  chunk_count: number;
  /** BM25/semantic mixing weight, informational. */
  alpha: number;
}

/** Payload of GET /chat/reference-docs/status - mirrors the backend
 *  `ReferenceDocsService.status()` exactly. One document per IfcOpenShell
 *  API domain (wall, pset, geometry, ...), so `doc_count` == domain count. */
export interface ReferenceDocsStatus {
  indexed: boolean;
  doc_count: number;
  /** Document names, e.g. "ifcopenshell.api.wall". */
  documents: Array<string | null>;
  semantic: ReferenceDocsSemanticStatus;
}

export async function getReferenceDocsStatus(): Promise<ReferenceDocsStatus> {
  return fetchJson<ReferenceDocsStatus>('/chat/reference-docs/status');
}

export async function fetchReferenceDocs(source: 'ifcopenshell' | 'all' = 'ifcopenshell'): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(`/chat/reference-docs/fetch?source=${source}`, {
    method: 'POST',
  });
}

/**
 * Create a fresh IFC project from a template (plan A3) and return the raw .ifc
 * bytes. The caller loads them through the normal upload pipeline, which makes
 * the new project the active model. Templates: 'empty' | 'single_storey' |
 * 'two_storey'.
 */
export async function newProject(template = 'single_storey'): Promise<ArrayBuffer> {
  const res = await fetch(apiUrl(`${BASE}/ifc/new?template=${encodeURIComponent(template)}`), {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Invariant-4 pending edits (sandboxed diff preview)
// ---------------------------------------------------------------------------

export async function listPendingEdits(): Promise<PendingEditEnvelope[]> {
  return fetchJson<PendingEditEnvelope[]>('/ifc/edits/pending');
}

export async function getPendingEdit(editId: string): Promise<PendingEditEnvelope> {
  return fetchJson<PendingEditEnvelope>(`/ifc/edits/pending/${editId}`);
}

/**
 * Apply a staged edit. If the backend returns 409 + `edit_in_progress`
 * (serialisation gate), the response body's `retry_after_ms` is
 * extracted so callers can implement a single retry without re-encoding
 * the protocol.
 *
 * Throws `EditInProgressError` (subclass of Error) when the lock is held.
 * Throws plain Error for any other failure.
 */
export class EditInProgressError extends Error {
  retryAfterMs: number;
  editId: string;
  constructor(editId: string, retryAfterMs: number, message: string) {
    super(message);
    this.name = 'EditInProgressError';
    this.editId = editId;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a 409 response body to detect the `edit_in_progress` shape. */
export function parseEditInProgressError(
  status: number,
  body: string,
  editId: string,
): EditInProgressError | null {
  if (status !== 409) return null;
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.detail;
    if (detail && typeof detail === 'object' && detail.status === 'edit_in_progress') {
      const retryMs = typeof detail.retry_after_ms === 'number' ? detail.retry_after_ms : 1500;
      const msg = typeof detail.message === 'string' ? detail.message : 'Edit in progress';
      return new EditInProgressError(editId, retryMs, msg);
    }
  } catch {
    // Not JSON - fall through.
  }
  return null;
}

export async function applyPendingEdit(editId: string): Promise<PendingEditEnvelope> {
  const res = await fetch(apiUrl(`${BASE}/ifc/edits/pending/${editId}/apply`), {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.text();
    const inProgress = parseEditInProgressError(res.status, body, editId);
    if (inProgress) throw inProgress;
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Apply with one auto-retry on the serialisation gate. The retry
 * waits `retry_after_ms` (default 1500) before trying again; the second
 * 409 (if it happens) surfaces to the caller.
 */
export async function applyPendingEditWithRetry(editId: string): Promise<PendingEditEnvelope> {
  try {
    return await applyPendingEdit(editId);
  } catch (err) {
    if (err instanceof EditInProgressError) {
      await new Promise((resolve) => setTimeout(resolve, err.retryAfterMs));
      return applyPendingEdit(editId);
    }
    throw err;
  }
}

export async function discardPendingEdit(editId: string): Promise<PendingEditEnvelope> {
  return fetchJson<PendingEditEnvelope>(`/ifc/edits/pending/${editId}/discard`, {
    method: 'POST',
  });
}

export async function getProject(): Promise<ProjectInfo> {
  return fetchJson<ProjectInfo>('/ifc/project');
}

export async function getSpatialTree(): Promise<SpatialNode> {
  return fetchJson<SpatialNode>('/ifc/tree');
}

export async function getElements(params?: {
  ifc_type?: string;
  storey_id?: number;
}): Promise<ElementSummary[]> {
  const searchParams = new URLSearchParams();
  if (params?.ifc_type) searchParams.set('ifc_type', params.ifc_type);
  if (params?.storey_id) searchParams.set('storey_id', String(params.storey_id));
  const qs = searchParams.toString();
  return fetchJson<ElementSummary[]>(`/ifc/elements${qs ? '?' + qs : ''}`);
}

export async function getElement(id: number): Promise<ElementDetail> {
  return fetchJson<ElementDetail>(`/ifc/elements/${id}`);
}

export interface ElementRelation {
  id: number;
  name: string;
  ifc_type: string;
  connection_type?: string | null;
}

export interface ElementMaterialLayer {
  name: string;
  thickness_mm: number;
}

export interface ElementMaterial {
  material_type: string;
  name?: string;
  layer_set_name?: string | null;
  layers: ElementMaterialLayer[];
  total_thickness_mm?: number;
  materials?: string[];
}

export interface ElementRelations {
  element_id: number;
  material: ElementMaterial;
  connections: { element_id: number; count: number; connected_elements: ElementRelation[] };
  openings: { element_id: number; count: number; openings: ElementRelation[] };
}

export async function getElementRelations(id: number): Promise<ElementRelations> {
  return fetchJson<ElementRelations>(`/ifc/elements/${id}/relations`);
}

export async function getStats(): Promise<ModelStats> {
  return fetchJson<ModelStats>('/ifc/stats');
}

export async function getStoreys(): Promise<ElementSummary[]> {
  return fetchJson<ElementSummary[]>('/ifc/storeys');
}

export async function search(
  q: string,
  opts?: { ifc_type?: string; storey?: string; limit?: number }
): Promise<SearchResult> {
  const params = new URLSearchParams({ q });
  if (opts?.ifc_type) params.set('ifc_type', opts.ifc_type);
  if (opts?.storey) params.set('storey', opts.storey);
  if (opts?.limit) params.set('limit', String(opts.limit));
  return fetchJson<SearchResult>(`/ifc/search?${params}`);
}

export function getIfcFileUrl(): string {
  return apiUrl(`${BASE}/ifc/file`);
}

// ---------------------------------------------------------------------------
// Save As - export edited IFC to a user-chosen location
// ---------------------------------------------------------------------------

export interface EditStateDto {
  loaded: boolean;
  dirty: boolean;
  /** Backend EDIT_MODE_ENABLED flag - the runtime gate for the whole edit
   *  surface (Edit toggle, editable properties, New Project, write tools). */
  edit_mode_enabled?: boolean;
  original_filename?: string;
  working_filename?: string;
  original_protected?: boolean;
  model_version?: number;
  model_fingerprint?: string;
}

export async function getEditState(): Promise<EditStateDto> {
  return fetchJson<EditStateDto>('/ifc/edit-state');
}

/** Persist working-copy edits back to the original upload path (plan A7).
 *  The server-side counterpart to Save As; resets the dirty flag. */
export async function saveModel(): Promise<{
  saved: boolean;
  filename: string;
  dirty: boolean;
  model_fingerprint: string;
}> {
  return fetchJson('/ifc/save', { method: 'POST' });
}

export function getIfcSaveAsUrl(filename: string): string {
  return apiUrl(`${BASE}/ifc/save-as?filename=${encodeURIComponent(filename)}`);
}

/**
 * Fetch the current edited IFC bytes so the caller can either stream them
 * into a user-picked file (showSaveFilePicker) or drive a classic
 * `<a download>` browser download. The server never overwrites the
 * original upload - these bytes come from the hidden working copy.
 */
export async function fetchIfcSaveAsBlob(filename: string): Promise<Blob> {
  const resp = await fetch(getIfcSaveAsUrl(filename));
  if (!resp.ok) {
    let detail = `Save As failed (${resp.status})`;
    try {
      const body = await resp.json();
      if (body && typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* non-JSON body */
    }
    throw new Error(detail);
  }
  return resp.blob();
}

export async function acknowledgeSaveAs(): Promise<{ dirty: boolean }> {
  return fetchJson<{ dirty: boolean }>('/ifc/save-as/ack', { method: 'POST' });
}

/** Warm-up state of the two AI backends (chat-panel readiness chip). */
export type NativeIndexReadinessState = 'absent' | 'building' | 'ready' | 'error';
export type IfcOpenShellReadinessState = 'cold' | 'warming' | 'ready' | 'error';

export interface ReadinessStatusDto {
  model_id: string | null;
  native_index: NativeIndexReadinessState;
  ifcopenshell: IfcOpenShellReadinessState;
  timings_ms: {
    native_index_built_ms: number | null;
    ifcopenshell_loaded_ms: number | null;
  };
  native_index_error: string | null;
  ifcopenshell_error: string | null;
}

export async function getReadiness(): Promise<ReadinessStatusDto> {
  return fetchJson<ReadinessStatusDto>('/ifc/readiness');
}

/**
 * Ask the backend to re-warm its IfcOpenShell handle from a previously
 * uploaded `.ifc` file on disk (matched by SHA-256). Used by the cached
 * load path when the viewer renders pre-built fragments but the backend
 * has no semantic model loaded (e.g. backend was restarted, or the page
 * was reloaded without a fresh upload).
 *
 * Returns the model meta on success. Throws (404) when no matching IFC
 * is on disk - caller should ask the user to re-upload the file.
 */
export async function warmFromCache(fingerprint: string): Promise<ModelMeta> {
  return fetchJson<ModelMeta>(
    `/ifc/warm-from-cache?fingerprint=${encodeURIComponent(fingerprint)}`,
    { method: 'POST' },
  );
}

export async function getAggregate(expressIds: number[]): Promise<AggregateResult> {
  return fetchJson<AggregateResult>('/ifc/aggregate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ express_ids: expressIds }),
  });
}

// ---------------------------------------------------------------------------
// Spatial / property filter queries
// ---------------------------------------------------------------------------

export interface NearbyElement {
  id: number;
  name: string;
  ifc_type: string;
  storey: string | null;
  distance_m: number;
}

export interface NearbyResult {
  element_id: number;
  radius_m: number;
  count: number;
  elements: NearbyElement[];
  note?: string;
}

export async function findNearbyElements(
  elementId: number,
  radiusM: number = 5.0,
  ifcTypes?: string[],
  limit: number = 20,
): Promise<NearbyResult> {
  const params = new URLSearchParams({ radius_m: String(radiusM), limit: String(limit) });
  if (ifcTypes?.length) params.set('ifc_types', ifcTypes.join(','));
  return fetchJson<NearbyResult>(`/ifc/elements/${elementId}/nearby?${params}`);
}

export type PropertyFilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'startswith'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'exists'
  | 'not_exists';

export interface PropertyFilterRequest {
  property_name: string;
  operator: PropertyFilterOperator;
  value: string;
  ifc_type?: string;
  storey?: string;
  pset_name?: string;
  limit?: number;
}

export interface PropertyFilterElement {
  id: number;
  name: string;
  ifc_type: string;
  storey: string | null;
  pset: string;
  property: string;
  value: string;
}

export interface PropertyFilterResult {
  property_name: string;
  operator: string;
  value: string;
  count: number;
  truncated: boolean;
  elements: PropertyFilterElement[];
  element_ids: number[];
}

export async function filterByPropertyValue(req: PropertyFilterRequest): Promise<PropertyFilterResult> {
  return fetchJson<PropertyFilterResult>('/ifc/elements/filter-by-property', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
}

/** One predicate evaluated against IFC identity attributes, psets or quantities. */
export interface IndexedPropertyFilterCondition {
  property_name: string;
  operator: PropertyFilterOperator;
  /** Omit for `exists` and `not_exists`; every comparison operator requires it. */
  value?: string;
  /** Restrict the property to one pset. Use `IFC` for direct IFC attributes. */
  pset_name?: string;
}

export interface IndexedPropertyFilterRequest {
  name?: string;
  logic: 'and' | 'or';
  conditions: IndexedPropertyFilterCondition[];
  /** Empty arrays mean all IFC types/storeys. Values are matched case-insensitively. */
  ifc_types?: string[];
  storeys?: string[];
  max_result_ids?: number;
  detail_limit?: number;
}

export interface IndexedPropertyFilterMatch {
  pset: string;
  property: string;
  value: string | null;
}

export interface IndexedPropertyFilterElement extends PropertyFilterElement {
  matches: IndexedPropertyFilterMatch[];
}

export interface IndexedPropertyFilterResult {
  name: string | null;
  logic: 'and' | 'or';
  /** Exact number of matches, even when the returned action set is capped. */
  count: number;
  truncated: boolean;
  element_ids: number[];
  elements: IndexedPropertyFilterElement[];
  index_version: number;
  indexed_elements: number;
  elapsed_ms: number;
  model_fingerprint: string | null;
}

/**
 * Evaluate a reusable multi-condition filter against the revision-aware BIM
 * property index. The endpoint returns an exact count and a bounded set of ids
 * suitable for viewer actions without rescanning IFC property sets per click.
 */
export async function filterElementsIndexed(
  req: IndexedPropertyFilterRequest,
  init?: Pick<RequestInit, 'signal'>,
): Promise<IndexedPropertyFilterResult> {
  return fetchJson<IndexedPropertyFilterResult>('/ifc/elements/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    ...init,
  });
}

// ---------------------------------------------------------------------------
// Undo / edit history
// ---------------------------------------------------------------------------

export interface UndoResult {
  undone: boolean;
  reason?: string;
  reverted_edit_id?: string;
  description?: string;
  issues?: string[];
  changed_ids?: number[];
}

export interface EditHistoryEntry {
  edit_id: string;
  description: string;
  timestamp: string;
}

export async function undoLastEdit(): Promise<UndoResult> {
  return fetchJson<UndoResult>('/ifc/undo', { method: 'POST' });
}

export async function getEditHistory(): Promise<EditHistoryEntry[]> {
  return fetchJson<EditHistoryEntry[]>('/ifc/edit-history');
}

// ---------------------------------------------------------------------------
// Agent Manager
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<{ agents: AgentPreset[] }> {
  return fetchJson<{ agents: AgentPreset[] }>('/chat/agents');
}

export async function createAgent(payload: AgentCreatePayload): Promise<{ agent: AgentPreset }> {
  return fetchJson<{ agent: AgentPreset }>('/chat/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function updateAgent(
  agentId: string,
  payload: AgentCreatePayload,
): Promise<{ agent: AgentPreset }> {
  return fetchJson<{ agent: AgentPreset }>(`/chat/agents/${agentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function deleteAgent(agentId: string): Promise<{ deleted: string }> {
  return fetchJson<{ deleted: string }>(`/chat/agents/${agentId}`, { method: 'DELETE' });
}

export async function listTools(): Promise<{ tools: import('../types/ifc').ToolCatalogEntry[] }> {
  return fetchJson('/chat/tools');
}

/**
 * Global tool enable/disable (Tools registry).
 * GET returns the current disabled set; PUT overwrites it.
 */
export async function getToolSettings(): Promise<{ disabled_tools: string[] }> {
  return fetchJson('/chat/tools/settings');
}

export async function setToolSettings(
  disabledTools: string[],
): Promise<{ disabled_tools: string[] }> {
  return fetchJson('/chat/tools/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disabled_tools: disabledTools }),
  });
}

// ---------------------------------------------------------------------------
// Tool Sets - named bundles of tools
// ---------------------------------------------------------------------------

export interface ToolSetPayload {
  label: string;
  description?: string;
  tools: string[];
  icon?: string;
}

export async function listToolSets(): Promise<{ tool_sets: import('../types/ifc').ToolSet[] }> {
  return fetchJson('/chat/tool-sets');
}

export async function createToolSet(payload: ToolSetPayload): Promise<{ tool_set: import('../types/ifc').ToolSet }> {
  const r = await fetchJson<{ tool_set: import('../types/ifc').ToolSet }>('/chat/tool-sets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function updateToolSet(setId: string, payload: ToolSetPayload): Promise<{ tool_set: import('../types/ifc').ToolSet }> {
  const r = await fetchJson<{ tool_set: import('../types/ifc').ToolSet }>(`/chat/tool-sets/${setId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function deleteToolSet(setId: string): Promise<{ deleted: string }> {
  const r = await fetchJson<{ deleted: string }>(`/chat/tool-sets/${setId}`, { method: 'DELETE' });
  invalidateChatManagerBootstrap();
  return r;
}

// ---------------------------------------------------------------------------
// System Prompt library
// ---------------------------------------------------------------------------

export interface PromptPayload {
  label: string;
  description?: string;
  content: string;
  category?: 'ask' | 'plan' | 'edit' | 'general';
}

export interface ProviderStatusEntry {
  name: string;
  configured: boolean;
  /** Where the active key resolves from. `null` = no key configured. */
  source?: 'env' | 'file' | null;
  /** Short mask like `sk-1…wxyz` for display. Never the raw key. */
  masked?: string;
  env_var: string;
  base_url: string | null;
  default_model: string;
}

export interface ChatManagerBootstrapResponse {
  tool_sets: import('../types/ifc').ToolSet[];
  prompts: import('../types/ifc').SystemPromptEntry[];
  tools: import('../types/ifc').ToolCatalogEntry[];
  snippets: PromptSnippet[];
  agents: AgentPreset[];
  models: import('../types/ifc').ModelEntry[];
  mcp: {
    source: string;
    enabled: string[];
    servers: McpServerConfig[];
  };
  providers: Record<string, ProviderStatusEntry>;
}

// Module-level cache for /chat/manager/bootstrap. The Chat Manager modal
// unmounts on close, so without a cache every reopen re-fetches the entire
// payload (hundreds of ms). With this cache, reopens render synchronously
// from the last response and revalidate in the background.
let _bootstrapCache: ChatManagerBootstrapResponse | null = null;
let _bootstrapInflight: Promise<ChatManagerBootstrapResponse> | null = null;

export function getCachedChatManagerBootstrap(): ChatManagerBootstrapResponse | null {
  return _bootstrapCache;
}

export function invalidateChatManagerBootstrap(): void {
  _bootstrapCache = null;
  _bootstrapInflight = null;
}

export async function getChatManagerBootstrap(): Promise<ChatManagerBootstrapResponse> {
  if (_bootstrapInflight) return _bootstrapInflight;
  _bootstrapInflight = fetchJson<ChatManagerBootstrapResponse>('/chat/manager/bootstrap')
    .then((r) => {
      _bootstrapCache = r;
      _bootstrapInflight = null;
      return r;
    })
    .catch((e) => {
      _bootstrapInflight = null;
      throw e;
    });
  return _bootstrapInflight;
}

export function prewarmChatManagerBootstrap(): void {
  if (_bootstrapCache || _bootstrapInflight) return;
  void getChatManagerBootstrap().catch(() => {
    // Pre-warm is best-effort. Errors surface on the first real open.
  });
}

export async function listPrompts(): Promise<{ prompts: import('../types/ifc').SystemPromptEntry[] }> {
  return fetchJson('/chat/prompts');
}

export async function createPrompt(payload: PromptPayload): Promise<{ prompt: import('../types/ifc').SystemPromptEntry }> {
  const r = await fetchJson<{ prompt: import('../types/ifc').SystemPromptEntry }>('/chat/prompts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function updatePrompt(promptId: string, payload: PromptPayload): Promise<{ prompt: import('../types/ifc').SystemPromptEntry }> {
  const r = await fetchJson<{ prompt: import('../types/ifc').SystemPromptEntry }>(`/chat/prompts/${promptId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function deletePrompt(promptId: string): Promise<{ deleted: string }> {
  const r = await fetchJson<{ deleted: string }>(`/chat/prompts/${promptId}`, { method: 'DELETE' });
  invalidateChatManagerBootstrap();
  return r;
}

// ---------------------------------------------------------------------------
// Model Registry - UI-configurable LLM catalogue (Chat Manager → Models tab)
// ---------------------------------------------------------------------------

type ModelT = import('../types/ifc').ModelEntry;

/** Create/update payload. Omits the server-managed fields (id, sort_order,
 *  is_custom, created_at). */
export interface ModelPayload {
  provider: ModelT['provider'];
  model_id: string;
  display_name: string;
  use_case: ModelT['use_case'];
  temperature: number;
  top_p?: number | null;
  max_output_tokens?: number | null;
  reasoning?: ModelT['reasoning'];
  supports_tools?: boolean;
  supports_vision?: boolean;
  supports_structured_output?: boolean;
  cost_tier?: ModelT['cost_tier'];
  speed_tier?: ModelT['speed_tier'];
  input_cost_per_1m?: number | null;
  output_cost_per_1m?: number | null;
  notes?: string;
  enabled?: boolean;
}

export async function listModels(): Promise<{ models: ModelT[] }> {
  return fetchJson('/chat/models');
}

export async function createModel(payload: ModelPayload): Promise<{ model: ModelT }> {
  const r = await fetchJson<{ model: ModelT }>('/chat/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function updateModel(modelId: string, payload: ModelPayload): Promise<{ model: ModelT }> {
  const r = await fetchJson<{ model: ModelT }>(`/chat/models/${modelId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function deleteModel(modelId: string): Promise<{ deleted: string }> {
  const r = await fetchJson<{ deleted: string }>(`/chat/models/${modelId}`, { method: 'DELETE' });
  invalidateChatManagerBootstrap();
  return r;
}

export async function reorderModels(order: string[]): Promise<{ models: ModelT[] }> {
  const r = await fetchJson<{ models: ModelT[] }>('/chat/models/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  invalidateChatManagerBootstrap();
  return r;
}

export async function getModelContext(): Promise<{ context_block: string; has_model: boolean }> {
  return fetchJson('/chat/context');
}


// ---------------------------------------------------------------------------
// MCP server registry
// ---------------------------------------------------------------------------

export interface McpListResponse {
  source: 'live' | 'example' | 'none' | 'error' | string;
  enabled: string[];
  servers: McpServerConfig[];
}

export async function listMcpServers(): Promise<McpListResponse> {
  return fetchJson<McpListResponse>('/mcp/servers');
}

export async function reloadMcpServers(): Promise<{ source: string; count: number }> {
  return fetchJson<{ source: string; count: number }>('/mcp/reload', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Document Index
// ---------------------------------------------------------------------------

export interface DocFile {
  doc_id: string;
  name: string;
  chunk_count: number;
  char_count: number;
  uploaded_at: string;
  sha256: string;
}

export async function listDocFiles(): Promise<{ docs: DocFile[] }> {
  return fetchJson('/chat/docs');
}

export async function uploadDocFile(file: File): Promise<{ doc: DocFile }> {
  const form = new FormData();
  form.append('file', file);
  return fetchJson('/chat/docs/upload', { method: 'POST', body: form });
}

export async function deleteDocFile(docId: string): Promise<{ deleted: string }> {
  return fetchJson(`/chat/docs/${docId}`, { method: 'DELETE' });
}

export async function getDocSemanticStatus(): Promise<import('../types/ifc').DocSemanticStatus> {
  return fetchJson('/chat/docs/semantic-status');
}

// ---------------------------------------------------------------------------
// LangGraph thread checkpoints
// ---------------------------------------------------------------------------

export interface ThreadState {
  thread_id: string;
  messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; name?: string }>;
  pending_edit: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  session_summary: string;
  graph_available: boolean;
}

/** Fetch the latest LangGraph checkpoint for a thread. Returns null on 404. */
export async function getThreadState(threadId: string): Promise<ThreadState | null> {
  try {
    return await fetchJson<ThreadState>(`/chat/thread/${threadId}/state`);
  } catch {
    return null;
  }
}

/** Clear the LangGraph checkpoint for a thread (user starts fresh). */
export async function deleteThreadState(threadId: string): Promise<void> {
  await fetchJson<{ deleted: string }>(`/chat/thread/${threadId}/state`, { method: 'DELETE' });
}

/** Run the model health check on the backend and return the structured report. */
export async function runModelHealthCheck(limitPerRule = 50): Promise<HealthCheckResult> {
  return fetchJson<HealthCheckResult>('/ifc/health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit_per_rule: limitPerRule }),
  });
}

/** List git-backed IFC edit checkpoints newest-first. */
export async function listCheckpoints(limit = 50): Promise<import('../types/ifc').CheckpointStatus> {
  return fetchJson<import('../types/ifc').CheckpointStatus>(`/ifc/checkpoints?limit=${limit}`);
}

/** Restore the IFC model to a specific checkpoint SHA. */
export async function rollbackToCheckpoint(sha: string): Promise<{ sha: string; model_version: number; model_fingerprint: string }> {
  return fetchJson(`/ifc/checkpoints/rollback/${encodeURIComponent(sha)}`, { method: 'POST' });
}

/** Diff a checkpoint snapshot against the current model. */
export async function getCheckpointDiff(sha: string): Promise<import('../types/ifc').CheckpointDiffResult> {
  return fetchJson(`/ifc/checkpoints/${encodeURIComponent(sha)}/diff`);
}

// ── Budget dashboard ──────────────────────────────────────────────────────────

export interface BudgetAgentRow {
  agent_id: string;
  label: string;
  spent_usd: number;
  budget_usd: number | null;
  status: 'ok' | 'near_cap' | 'over_cap';
}

export interface BudgetSummary {
  month: string;
  agents: BudgetAgentRow[];
}

/** Fetch current-month spend per agent. */
export async function getBudgetSummary(): Promise<BudgetSummary> {
  return fetchJson<BudgetSummary>('/chat/budget/summary');
}

/** Reset a single agent's monthly spend counter. */
export async function resetAgentBudget(agentId: string): Promise<{ reset: string; previous_spent_usd: number }> {
  return fetchJson(`/chat/budget/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

// ── Model properties export ───────────────────────────────────────────────────

export interface ExportPropertiesOptions {
  format?: 'csv' | 'json';
  ifcType?: string;
  includeQuantities?: boolean;
  maxElements?: number;
}

/**
 * Download a CSV/JSON export of all elements + their pset properties.
 * In CSV mode this triggers a browser file download; in JSON mode it returns
 * the parsed array of row objects.
 */
export async function exportModelProperties(
  opts: ExportPropertiesOptions = {},
): Promise<void | Record<string, string>[]> {
  const params = new URLSearchParams();
  if (opts.format) params.set('format', opts.format);
  if (opts.ifcType) params.set('ifc_type', opts.ifcType);
  if (opts.includeQuantities) params.set('include_quantities', 'true');
  if (opts.maxElements !== undefined) params.set('max_elements', String(opts.maxElements));

  const res = await fetch(apiUrl(`${BASE}/ifc/export/properties?${params.toString()}`));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Export error ${res.status}: ${body}`);
  }

  if (opts.format === 'json') {
    return res.json() as Promise<Record<string, string>[]>;
  }

  // Trigger browser download for CSV
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  a.download = match?.[1] ?? exportFilename(`ifc-export-${opts.ifcType ?? 'all'}`, 'csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Prompt Snippets ───────────────────────────────────────────────────────────

export interface PromptSnippet {
  id: string;
  title: string;
  body: string;
  tags: string[];
  is_builtin: boolean;
  created_at: string | null;
}

export async function getSnippets(): Promise<PromptSnippet[]> {
  const data = await fetchJson<{ snippets: PromptSnippet[] }>('/chat/snippets');
  return data.snippets;
}

export async function createSnippet(title: string, body: string, tags?: string[]): Promise<PromptSnippet> {
  const data = await fetchJson<{ snippet: PromptSnippet }>('/chat/snippets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, tags: tags ?? [] }),
  });
  return data.snippet;
}

export async function updateSnippet(id: string, title: string, body: string, tags?: string[]): Promise<PromptSnippet> {
  const data = await fetchJson<{ snippet: PromptSnippet }>(`/chat/snippets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, tags: tags ?? [] }),
  });
  return data.snippet;
}

export async function deleteSnippet(id: string): Promise<void> {
  await fetchJson(`/chat/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Real per-element AABB cache
// ---------------------------------------------------------------------------

export type AabbCacheState = 'idle' | 'computing' | 'ready' | 'failed';

/** Provenance reported by `/api/ifc/tile-manifest`: did we read real AABBs
 *  from the cache, fall back to placement-origin points, or a mix? */
export type AabbSource = 'real' | 'placement' | 'mixed';

/** One stable spatial partition produced from the backend's geometry AABBs. */
export interface SpatialTileDto {
  tile_id: string;
  storey_idx: number;
  cell_x: number;
  cell_y: number;
  aabb_min: AabbVec3;
  aabb_max: AabbVec3;
  /** IFC Express IDs. Convert these to Fragments local IDs before rendering. */
  element_ids: number[];
  element_count: number;
}

/** Backend spatial index contract. Geometry remains mounted on the client. */
export interface SpatialTileManifestDto {
  source_sha256: string;
  grid_resolution: number;
  world_aabb_min: AabbVec3;
  world_aabb_max: AabbVec3;
  total_elements: number;
  total_tiles: number;
  aabb_source: AabbSource;
  tiles: SpatialTileDto[];
}

export interface AabbCacheStatusDto {
  sha: string;
  state: AabbCacheState;
  count: number;
  total_expected: number;
  total_ms: number;
  error: string | null;
}

export type AabbVec3 = [number, number, number];

export interface AabbResponseDto {
  express_id: number;
  aabb_min: AabbVec3;
  aabb_max: AabbVec3;
}

export interface AabbBulkResponseDto {
  sha: string;
  aabbs: AabbResponseDto[];
  missing: number[];
}

export async function getAabbStatus(): Promise<AabbCacheStatusDto> {
  return fetchJson<AabbCacheStatusDto>('/ifc/aabb/status');
}

/** Return the cached AABB for one element, or `null` on 404 (not yet warm). */
export async function getAabbOne(expressId: number): Promise<AabbResponseDto | null> {
  const res = await fetch(apiUrl(`${BASE}/ifc/aabb/${expressId}`));
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }
  return res.json();
}

export async function getAabbBulk(expressIds: number[]): Promise<AabbBulkResponseDto> {
  return fetchJson<AabbBulkResponseDto>('/ifc/aabb/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ express_ids: expressIds }),
  });
}

/**
 * Fetch the current model's preprocessed spatial partition.
 *
 * Consumers must verify `source_sha256` against their mounted model and should
 * only drive render visibility from `aabb_source === 'real'`. Placement-origin
 * manifests are useful as a progress/fallback signal, but are not conservative
 * geometry bounds and could otherwise hide visible elements.
 */
export async function getSpatialTileManifest(
  gridResolution = 4,
  init?: Pick<RequestInit, 'signal'>,
): Promise<SpatialTileManifestDto> {
  const grid = Math.max(1, Math.min(16, Math.floor(gridResolution)));
  return fetchJson<SpatialTileManifestDto>(`/ifc/tile-manifest?grid=${grid}`, init);
}

export type SpatialTileFragmentProfile = 'quality' | 'balanced' | 'performance' | 'ultra_fast';

export interface SpatialTileFragmentResult {
  readonly bytes: Uint8Array;
  readonly source: 'tile-cache' | 'tile-sidecar';
  readonly profile: SpatialTileFragmentProfile;
  readonly tileId: string;
  readonly gridResolution: number;
  readonly aabbSource: AabbSource;
  readonly cacheKey: string | null;
  readonly artifactSchema: string | null;
  readonly fragmentsFormatVersion: string | null;
}

/** Fetch one independently loadable exact tile artifact. */
export async function fetchSpatialTileFragment(
  request: {
    readonly fingerprint: string;
    readonly gridResolution: number;
    readonly tileId: string;
    readonly profile: SpatialTileFragmentProfile;
  },
  init?: Pick<RequestInit, 'signal'>,
): Promise<SpatialTileFragmentResult> {
  const grid = Math.max(1, Math.min(16, Math.floor(request.gridResolution)));
  const params = new URLSearchParams({
    sha: request.fingerprint,
    grid: String(grid),
    tile_id: request.tileId,
    profile: request.profile,
  });
  const response = await fetch(apiUrl(`${BASE}/ifc/fragments/tile?${params.toString()}`), init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tile artifact error ${response.status}: ${body}`);
  }
  const tileId = response.headers.get('X-Fragment-Tile-Id');
  const responseGrid = Number(response.headers.get('X-Fragment-Grid'));
  const profile = response.headers.get('X-Fragment-Profile');
  const source = response.headers.get('X-Fragment-Source');
  const aabbSource = response.headers.get('X-Fragment-AABB-Source');
  // Backends that send source provenance must agree with the requested
  // model; older backends omit the header and skip this check.
  const sourceSha = response.headers.get('X-Fragment-Source-Sha');
  if (
    tileId !== request.tileId
    || responseGrid !== grid
    || profile !== request.profile
    || (source !== 'tile-cache' && source !== 'tile-sidecar')
    || (aabbSource !== 'real' && aabbSource !== 'mixed' && aabbSource !== 'placement')
    || (sourceSha !== null && sourceSha !== request.fingerprint)
  ) {
    throw new Error('Tile artifact response identity does not match the request');
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    source,
    profile: profile as SpatialTileFragmentProfile,
    tileId,
    gridResolution: responseGrid,
    aabbSource,
    cacheKey: response.headers.get('X-Fragment-Cache-Key'),
    artifactSchema: response.headers.get('X-Fragment-Artifact-Schema'),
    fragmentsFormatVersion: response.headers.get('X-Fragments-Format-Version'),
  };
}

export async function clearAabbCache(opts?: { sha?: string; disk?: boolean }):
  Promise<{ cleared: string; disk_files_removed: number }> {
  const params = new URLSearchParams();
  if (opts?.sha) params.set('sha', opts.sha);
  if (opts?.disk) params.set('disk', 'true');
  const qs = params.toString();
  return fetchJson<{ cleared: string; disk_files_removed: number }>(
    `/ifc/aabb/cache${qs ? '?' + qs : ''}`,
    { method: 'DELETE' },
  );
}

// ---------------------------------------------------------------------------
// System / data-storage endpoints (Settings → Storage panel)
// ---------------------------------------------------------------------------

export interface DataPathEntry {
  path: string;
  exists: boolean;
  entries: number;
  size_bytes: number;
}

export interface DataPathsResponse {
  base: string;
  uploads: DataPathEntry;
  snapshots: DataPathEntry;
  data: DataPathEntry;
  checkpoints: DataPathEntry;
  fragments: DataPathEntry;
  total_size_bytes: number;
  cache_max_bytes: number;
}

export type CacheScope = 'uploads' | 'snapshots' | 'data' | 'checkpoints' | 'fragments' | 'all';

export interface CacheFlushResponse {
  scope: string;
  bytes_freed: number;
  files_removed: number;
}

export async function getDataPaths(): Promise<DataPathsResponse> {
  return fetchJson<DataPathsResponse>('/system/data-paths');
}

export async function flushServerCache(scope: CacheScope): Promise<CacheFlushResponse> {
  return fetchJson<CacheFlushResponse>(`/system/cache?scope=${scope}`, { method: 'DELETE' });
}

export async function updateCacheConfig(cacheMaxBytes: number): Promise<{
  cache_max_bytes: number;
  bytes_freed: number;
  files_removed: number;
  note: string;
}> {
  return fetchJson('/system/cache/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cache_max_bytes: cacheMaxBytes }),
  });
}

export async function enforceCacheCap(): Promise<{
  scope: string;
  cap_bytes: number;
  bytes_freed: number;
  files_removed: number;
}> {
  return fetchJson('/system/cache/enforce-cap', { method: 'POST' });
}

// ---------------------------------------------------------------------------
// Per-user AI keys (~/.ifc-atlas/secrets.json) - UI never sees raw values.
// ---------------------------------------------------------------------------

export interface SecretStatusEntry {
  configured: boolean;
  source: 'env' | 'file' | null;
  env_var: string;
  masked: string;
}

export interface SecretsStatusResponse {
  providers: Record<string, SecretStatusEntry>;
}

export interface SecretsUpdatePayload {
  openai?: string;
  anthropic?: string;
  openrouter?: string;
}

interface SecretsStatusOptions {
  timeoutMs?: number;
}

export async function getSecretsStatus(
  options: SecretsStatusOptions = {},
): Promise<SecretsStatusResponse> {
  const timeoutMs = options.timeoutMs ?? 5000;
  if (timeoutMs <= 0) return fetchJson<SecretsStatusResponse>('/settings/secrets');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchJson<SecretsStatusResponse>('/settings/secrets', {
      signal: controller.signal,
    });
  } catch (err) {
    if (timedOut) {
      throw new Error(
        `Provider key status timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          'The backend may be busy; retry when the current model operation finishes.',
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function updateSecrets(payload: SecretsUpdatePayload): Promise<SecretsStatusResponse> {
  const res = await fetchJson<SecretsStatusResponse>('/settings/secrets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // ChatManager bootstrap caches the same provider status; invalidate so the
  // next open re-fetches and reflects the new key.
  invalidateChatManagerBootstrap();
  return res;
}

export async function deleteSecret(
  provider: 'openai' | 'anthropic' | 'openrouter' | 'all',
): Promise<SecretsStatusResponse & { removed: string[] }> {
  const res = await fetchJson<SecretsStatusResponse & { removed: string[] }>(
    `/settings/secrets/${provider}`,
    { method: 'DELETE' },
  );
  invalidateChatManagerBootstrap();
  return res;
}
