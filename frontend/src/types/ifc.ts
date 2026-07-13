export interface ProjectInfo {
  name: string;
  description: string | null;
  schema_version: string;
  author: string | null;
  organization: string | null;
}

export interface SpatialNode {
  // FragmentsModel localId. The sidebar dispatches this via selectElement().
  id: number;
  // IFC Express ID for the same product. Lets selection comparators match
  // viewer-click (express id from raycast.itemId, normalized to owning
  // product) against tree-click (localId) without an async lookup.
  expressId?: number;
  global_id: string;
  name: string;
  ifc_type: string;
  storey?: string | null;
  children: SpatialNode[];
}

export interface ElementSummary {
  id: number;
  global_id: string;
  name: string | null;
  ifc_type: string;
  storey: string | null;
}

export interface PropertySet {
  name: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface ElementDetail {
  id: number;
  global_id: string;
  name: string | null;
  ifc_type: string;
  storey: string | null;
  material: string | null;
  property_sets: PropertySet[];
  quantities: Record<string, number>;
  relating_type: string | null;
  description: string | null;
  object_type: string | null;
  tag: string | null;
  predefined_type: string | null;
}

export interface ModelStats {
  total_elements: number;
  by_type: Record<string, number>;
  storeys: string[];
  materials: string[];
}

export interface ModelMeta {
  project: ProjectInfo;
  tree: SpatialNode | null;
  stats: ModelStats | null;
  model_version: number;
  model_fingerprint: string;
  edit_id: string | null;
}

export type EditOpType =
  | 'set_name'
  | 'set_description'
  | 'set_property'
  | 'set_visibility'
  | 'set_transform'
  | 'create'
  | 'delete';

export interface EditOperation {
  op: EditOpType;
  express_id?: number;
  ifc_type?: string;
  property_set?: string;
  property_name?: string;
  value?: string | number | boolean | null;
  visible?: boolean;
  payload?: Record<string, unknown>;
}

export interface EditApplyRequest {
  operations: EditOperation[];
  base_model_version?: number;
  consistency_mode?: 'hybrid' | 'strong' | 'frontend_first';
}

export interface MetadataPatch {
  updated_elements: ElementSummary[];
  removed_element_ids: number[];
  touched_storeys: string[];
  stats_delta: Record<string, number>;
}

export interface EditApplyResponse {
  edit_id: string;
  model_version: number;
  model_fingerprint: string;
  changed_express_ids: number[];
  metadata_patch: MetadataPatch;
  status: 'accepted' | 'rejected';
  requires_rebuild: boolean;
  message: string | null;
}

export interface ModelSyncEvent {
  type:
    | 'edit_accepted'
    | 'edit_rejected'
    | 'geometry_patch'
    | 'metadata_patch'
    | 'rebuild_started'
    | 'rebuild_ready'
    | 'pending_edit'
    | 'pending_applied'
    | 'pending_discarded'
    | 'ifc_patch'
    | 'native_index_ready'
    | 'readiness_changed'
    | 'metadata_changed'
    | 'model_refresh'
    | 'viewer_command';
  model_version: number;
  model_fingerprint: string;
  edit_id: string | null;
  payload: Record<string, unknown>;
}

export type PendingEditChangeKind =
  | 'renamed'
  | 'retyped'
  | 'property_changed'
  | 'deleted'
  | 'created';

export interface PendingEditPropertyChange {
  property_set: string;
  property_name: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

export interface PendingEditElement {
  express_id: number;
  ifc_type: string;
  change: PendingEditChangeKind;
  name_before: string | null;
  name_after: string | null;
  ifc_type_before: string | null;
  ifc_type_after: string | null;
  property_changes: PendingEditPropertyChange[];
}

export interface PendingEditEnvelope {
  edit_id: string;
  created_at: number;
  base_model_version: number;
  base_model_fingerprint: string;
  sandbox_fingerprint: string;
  summary: string;
  operations: Record<string, unknown>[];
  changes: PendingEditElement[];
  counts: Record<string, number>;
  /** D4 verifier: health delta vs the live baseline + geometry sanity,
   *  computed on the sandbox before this edit was presented. Null/absent =
   *  verifier skipped (older backend or verification error). */
  verifier_verdict?: {
    status: 'pass' | 'warn' | 'fail';
    new_errors: number;
    new_warnings: number;
    geometry?: { checked: number; failures: Array<{ express_id: number; reason: string }> };
    note?: string;
  } | null;
}

/** Result of one operation-layer call (backend OperationResult.to_public_dict).
 *  Human direct edits from the editor UI go through /api/ifc/operations/*. */
export interface OperationResult {
  op_id: string;
  operation: string;
  actor: 'user' | 'agent' | 'mcp' | 'system';
  ok: boolean;
  changed: boolean;
  changed_ids: number[];
  patch_tier: 'none' | 'metadata' | 'transform' | 'geometry' | 'bulk';
  description: string;
  edit_id?: string;
  error?: string;
  /** Fresh model contract after an applied op (present when changed=true).
   *  Applied ops re-fingerprint the working file; adopting this immediately
   *  keeps the sync-event stale filter from dropping this edit's events. */
  model_version?: number;
  model_fingerprint?: string;
  /** Whether a redo is armed after this operation (drives the Redo buttons). */
  can_redo?: boolean;
}

export interface AggregateResult {
  count: number;
  total_area: number | null;
  total_volume: number | null;
  area_quantity_name: string | null;
  volume_quantity_name: string | null;
  material_histogram: Record<string, number>;
  type_histogram: Record<string, number>;
  missing_quantity_ids: number[];
}

export interface SearchResult {
  elements: ElementSummary[];
  total: number;
  query: string;
}

export interface ClassificationItem {
  refExpressId: number;
  code: string | null;
  name: string;
  memberIds: number[];
}

export interface ClassificationGroup {
  classificationExpressId: number;
  name: string;
  source: string | null;
  edition: string | null;
  items: ClassificationItem[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  tier?: string;
  tierLabel?: string;
  activityKind?:
    | 'read_only'
    | 'viewer_action'
    | 'validation'
    | 'semantic_edit'
    | 'geometry_edit'
    | 'model_edit'
    | 'code_read'
    | 'code_edit';
  result?: string;
  executedOn?: 'client' | 'server';
  /** Number of assistant-text characters emitted BEFORE this tool call, so the
   *  UI can render text and tool calls in true transcript order. Absent on
   *  messages restored from history (they fall back to tools-first layout). */
  contentOffset?: number;
}

export type ChatAttachmentKind = 'image' | 'text' | 'ids' | 'other';

/** File attached to a single chat turn. data_base64 is raw file bytes
 * base64-encoded - the backend decodes + forwards to the LLM (vision for
 * images, inlined text block for text/ids). */
export interface ChatAttachment {
  kind: ChatAttachmentKind;
  name: string;
  mime: string | null;
  data_base64: string;
  size: number | null;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Approximate cost in USD (-1 when rate unknown). */
  costUsd?: number;
  model: string;
  provider: string;
  /** Anthropic prompt caching */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** 0-1 ratio of input_tokens that were served from cache. */
  cacheHitRatio?: number;
  /** Cost net of cached tokens (Anthropic charges less for cache-read tokens). */
  cachedCostUsd?: number;
}

export interface ChatMessage {
  /** Stable per-message id minted at creation by the store
   *  (`addChatMessage` / `restoreThreadHistory`, via `crypto.randomUUID()`),
   *  used as the React list key instead of the array index so the list
   *  reconciles by identity (prereq for memoization/virtualization and a
   *  fix for remount flicker on history restore). Optional on the type so
   *  read-only consumers can describe messages without minting an id; every
   *  message that flows through the store has one at runtime. */
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  attachments?: ChatAttachment[];
  /** Populated after the turn completes (cost telemetry). */
  usage?: ChatUsage;
}

/** Budget guardrail events. */
export interface BudgetWarning {
  /** Current month accumulated spend in USD. */
  usedUsd: number;
  /** Monthly budget cap. */
  budgetUsd: number;
  /** Ratio 0-1 (0.8 = 80%). */
  ratio: number;
  agentId: string;
  /** True when budget is fully exhausted (model fallback active). */
  atCap: boolean;
}

export interface ModelFallback {
  originalModel: string;
  fallbackModel: string;
  reason: 'budget_cap';
  usedUsd: number;
  budgetUsd: number;
}

/** Agent preset exposed by GET /api/chat/agents. Used by the Agent
 * Manager picker in the chat header. */
export type AgentCategory = 'ask' | 'plan' | 'edit';

export interface AgentPreset {
  id: string;
  label: string;
  description: string;
  system_prompt?: string;
  provider: string;
  model: string;
  temperature: number;
  icon: string;
  allowed_tools: string[] | null;
  quick_prompts: string[];
  is_custom?: boolean;
  created_at?: string | null;
  role?: string | null;
  goal?: string | null;
  backstory?: string | null;
  category?: AgentCategory;
  /** Monthly USD budget cap for this agent (null = unlimited). */
  monthly_budget_usd?: number | null;
  /** Model ID to use when monthly_budget_usd is exhausted (null = hard stop). */
  fallback_model?: string | null;
}

/** A named, reusable bundle of tool names. Built-in or user-created. */
export interface ToolSet {
  id: string;
  label: string;
  description: string;
  tools: string[];
  is_custom: boolean;
  created_at?: string | null;
  icon?: string;
}

/** A named, reusable system prompt. Built-in or user-created. */
export interface SystemPromptEntry {
  id: string;
  label: string;
  description: string;
  content: string;
  category: AgentCategory | 'general';
  is_custom: boolean;
  created_at?: string | null;
}

/** Provider-agnostic reasoning / extended-thinking setting for a model.
 *  `null` = off. `{effort}` is OpenAI-native; `{budget_tokens}` is Anthropic-native;
 *  the backend mapper translates between them per target provider. */
export type ModelReasoning =
  | { effort?: 'minimal' | 'low' | 'medium' | 'high'; budget_tokens?: number }
  | null;

export type ModelProvider = 'openai' | 'anthropic' | 'openrouter';
export type ModelUseCase =
  | 'reasoning' | 'fast_chat' | 'cheap_fallback' | 'coding' | 'vision' | 'structured_extraction';
export type ModelCostTier = 'free' | 'low' | 'medium' | 'high';
export type ModelSpeedTier = 'slow' | 'medium' | 'fast';

/** One configurable model in the Model Registry (Chat Manager → Models tab).
 *  `id` is a registry-unique slug, NOT the provider's `model_id`. */
export interface ModelEntry {
  id: string;
  provider: ModelProvider;
  model_id: string;
  display_name: string;
  use_case: ModelUseCase;
  temperature: number;
  top_p: number | null;
  max_output_tokens: number | null;
  reasoning: ModelReasoning;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_structured_output: boolean;
  cost_tier: ModelCostTier;
  speed_tier: ModelSpeedTier;
  /** Approximate USD per 1M tokens (editable estimates; null = unknown).
   *  Feeds the usage chip's cost figure and monthly budget enforcement. */
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  notes: string;
  enabled: boolean;
  sort_order: number;
  is_custom: boolean;
  created_at?: string | null;
}

/** Tool definition from the Agent Manager catalog API. */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  where: 'client' | 'server';
  tier: 'read_model' | 'read_viewer' | 'validate' | 'write_edit';
  tier_label: string;
}

export interface AgentCreatePayload {
  label: string;
  description: string;
  system_prompt: string;
  provider: string;
  model: string;
  temperature: number;
  icon: string;
  allowed_tools: string[] | null;
  quick_prompts: string[];
  role?: string;
  goal?: string;
  backstory?: string;
  category?: AgentCategory;
  monthly_budget_usd?: number | null;
  fallback_model?: string | null;
}

/** Single element that failed an IDS requirement. */
export interface IdsFailingElement {
  id: number | null;
  global_id: string | null;
  ifc_type: string;
  name?: string | null;
  facet_type: string;
  reason: string;
}

/** Per-specification result from ids_validate. */
export interface IdsSpecReport {
  name: string;
  description?: string;
  ifc_type: string | null;
  predefined_type: string | null;
  status: 'passed' | 'failed' | 'no_applicable';
  applied_to: number;
  passed: number;
  failed: number;
  applicability?: Record<string, unknown>[];
  requirements: Record<string, unknown>[];
  failing_elements: IdsFailingElement[];
  failing_truncated: boolean;
  ifc_versions?: string[];
  min_occurs?: number | null;
  max_occurs?: number | null;
}

export interface IdsReport {
  total_specifications: number;
  passed: number;
  failed: number;
  no_applicable?: number;
  specifications: IdsSpecReport[];
  ids_title?: string;
  ids_version?: string;
  ids_description?: string;
  engine?: string;
  /** Flattened list of all failing Express IDs across all specs - for viewer highlight. */
  all_failing_ids?: number[];
  message?: string;
}

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | string;
  command: string | null;
  args: string[];
  url: string | null;
  description: string;
}

export interface Viewpoint {
  id: string;
  projectKey: string;
  name: string;
  createdAt: number;
  camera: {
    pos: [number, number, number];
    target: [number, number, number];
  };
  isolatedIds: number[];
  hiddenIds: number[];
  selectedId: number | null;
  highlightedIds: number[];
  thumbnail: string | null;
}

// ── Document Index ────────────────────────────────────────────────────────────

export interface DocFile {
  doc_id: string;
  name: string;
  chunk_count: number;
  char_count: number;
  uploaded_at: string;
  sha256: string;
  /** True when the document has local ONNX embeddings (fastembed + hnswlib). */
  semantic?: boolean;
}

export interface DocSemanticStatus {
  available: boolean;
  built: boolean;
  model: string;
  chunk_count: number;
  alpha: number;
}

// ── IFC Edit Checkpoints (git-backed) ────────────────────────────────────────

export interface IFCCheckpoint {
  sha: string;
  message: string;
  timestamp: string; // ISO-8601
  edit_count: number;
  is_initial: boolean;
}

export interface CheckpointStatus {
  available: boolean;
  count: number;
  checkpoints: IFCCheckpoint[];
}

export interface DiffAttributeChange {
  attribute: string;
  before: string | null;
  after: string | null;
}

export interface CheckpointDiffEntry {
  global_id: string;
  ifc_type: string;
  name: string | null;
  change: 'added' | 'removed' | 'changed';
  attribute_changes: DiffAttributeChange[];
  express_id: number | null;
}

export interface CheckpointDiffResult {
  sha: string;
  added: number;
  removed: number;
  changed: number;
  total: number;
  truncated: boolean;
  entries: CheckpointDiffEntry[];
}
