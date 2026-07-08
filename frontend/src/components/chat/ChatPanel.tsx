import { useState, useRef, useEffect, useCallback, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import { useStore } from '../../store/useStore';
import type { ChatMessage, ChatUsage, ToolCall, ChatAttachment } from '../../types/ifc';
import {
  listAgents,
  getThreadState,
  deleteThreadState,
  getSecretsStatus,
  getChatManagerBootstrap,
  getCachedChatManagerBootstrap,
} from '../../services/api';
import type { ModelEntry } from '../../types/ifc';
import { exportChatHistory } from '../../services/chat/chatExport';
import { exportFilename } from '../../services/exportFilename';
import { apiUrl, wsUrl as backendWsUrl } from '../../lib/platform';
import type { ThreadState } from '../../services/api';
import Icon, { type IconName } from '../ui/Icon';
import { EDIT_MODE_ENABLED } from '../../config/featureFlags';
import AiKeysModal from './AiKeysModal';
import AIReadinessChip from './AIReadinessChip';
import { formatToolCallClipboard, writeToClipboard } from './chatClipboardHelpers';
import {
  getTopBarOverflowActions,
  nextIndexForKey,
  firstEnabledIndex,
  isOverflowNavKey,
  type ChatTopBarAction,
} from './chatTopBarOverflowHelpers';
import {
  getIdsCsvButtonLabel,
  getIdsCsvButtonTitle,
  extractIdsFailedCount,
} from './idsCsvHelpers';
import { applyEntityDelta, type EntityDeltaEvent } from '../../services/viewer/entityDeltaHandler';

/**
 * Full catalogue of concrete models, grouped by provider. Shown inline in the
 * embedded chat toolbar so the user can pick exactly which model runs -
 * no more "OpenAI vs Anthropic" provider picker with the model hidden in
 * Settings. New models are added here in one place.
 */
const MODEL_CATALOGUE: Array<{ provider: string; providerLabel: string; models: Array<{ id: string; label: string; hint?: string }> }> = [
  {
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [
      { id: 'gpt-4o',       label: 'GPT-4o',        hint: 'recommended' },
      { id: 'gpt-4o-mini',  label: 'GPT-4o mini',   hint: 'fast'        },
      { id: 'gpt-4-turbo',  label: 'GPT-4 Turbo',   hint: ''            },
    ],
  },
  {
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514',   label: 'Claude Sonnet 4',   hint: 'recommended' },
      { id: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5',  hint: 'fast'        },
    ],
  },
  {
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    models: [
      { id: 'anthropic/claude-sonnet-4-20250514',  label: 'Claude Sonnet 4',     hint: 'recommended' },
      { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',    hint: 'fast'        },
      { id: 'openai/gpt-4o',                       label: 'GPT-4o',              hint: ''            },
      { id: 'deepseek/deepseek-chat',              label: 'DeepSeek V3',         hint: 'value'       },
      { id: 'qwen/qwen-2.5-72b-instruct',          label: 'Qwen 2.5 72B',        hint: 'value'       },
      { id: 'meta-llama/llama-3.3-70b-instruct',   label: 'Llama 3.3 70B',       hint: 'open'        },
    ],
  },
];

const DEFAULT_QUICK_ACTIONS = [
  { label: 'Model Summary', prompt: 'Give me a summary of this IFC model including element counts and storeys.' },
  { label: 'Quantity Totals', prompt: 'Use get_quantities_summary to give me total area, volume, and length grouped by IFC type.' },
  { label: 'Per-Storey Totals', prompt: 'Use get_quantities_summary grouped by storey and report total area and volume per storey.' },
  { label: 'Isolate Top Storey', prompt: 'Find the topmost building storey and isolate just its elements in the viewer.' },
  { label: 'Find All Walls', prompt: 'How many walls are in this model? List them by storey.' },
  { label: 'Find All Doors', prompt: 'Show me all doors in this model and highlight them.' },
  { label: 'Find All Windows', prompt: 'Find all windows and highlight them in the viewer.' },
  { label: 'Material Breakdown', prompt: 'What materials are used in this model? Give me a breakdown.' },
];

const EDIT_QUICK_ACTIONS = [
  { label: 'Rename Walls', prompt: "Rename all IfcWall elements on the ground floor to 'Exterior Wall - GF'." },
  { label: 'Add IsExternal', prompt: "Add IsExternal = true to Pset_WallCommon on all IfcWall elements." },
  { label: 'Fix Empty Names', prompt: "Find all elements with empty or null names and rename them to '<Type> - <ExpressId>'." },
  { label: 'Bulk Rename Doors', prompt: "Rename all IfcDoor elements to 'Door - <storey> - <index>' using execute_ifc_code." },
  { label: 'Set Fire Rating', prompt: "Add FireRating = '60' to Pset_WallCommon on all exterior walls." },
  { label: 'Edit History', prompt: 'Show the edit history for this session using get_edit_history.' },
  { label: 'Undo Last Edit', prompt: 'Undo the last edit I made to this model.' },
  { label: 'What Can Be Edited', prompt: 'What elements can I rename or update properties on? Give me a summary of editable fields.' },
];

// -----------------------------------------------------------------------------
// Slash commands - intercepted before the WS send. Many are pure UI actions
// that never hit the LLM; the rest rewrite the input into a tool-leaning
// prompt so even small models find the right tool on the first try.
// -----------------------------------------------------------------------------
interface SlashSpec {
  name: string;
  hint: string;
  /** If present, the function produces a rewritten prompt string or a
   * special marker (`__local__` means fully handled locally). */
  run?: (arg: string) => string | '__local__';
}

/** Format of a single attachment for the wire. */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(binary);
}

async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const buf = await file.arrayBuffer();
  const data_base64 = arrayBufferToBase64(buf);
  const lower = file.name.toLowerCase();
  let kind: ChatAttachment['kind'] = 'other';
  if (file.type.startsWith('image/')) kind = 'image';
  else if (lower.endsWith('.ids') || lower.endsWith('.xml')) kind = 'ids';
  else if (file.type.startsWith('text/') || lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.json')) {
    kind = 'text';
  }
  return {
    kind,
    name: file.name,
    mime: file.type || null,
    data_base64,
    size: file.size,
  };
}

/** Compact badge row shown after a batch edit tool completes. */
function BatchEditSummary({ result }: { result: Record<string, unknown> }) {
  const changed = typeof result.changed_count === 'number' ? result.changed_count : null;
  const skipped = typeof result.skipped_count === 'number' ? result.skipped_count : null;
  const failed  = typeof result.failed_count  === 'number' ? result.failed_count  : null;

  if (changed === null) return null;

  const parts: string[] = [];
  if (changed > 0)  parts.push(`${changed} changed`);
  if (skipped !== null && skipped > 0) parts.push(`${skipped} skipped`);
  if (failed  !== null && failed  > 0) parts.push(`${failed} failed`);
  if (parts.length === 0) parts.push('no changes');

  return (
    <div className="tool-call-batch-summary">
      {parts.map((p, i) => (
        <span key={i} className={`batch-badge batch-badge--${p.includes('failed') ? 'fail' : p.includes('skipped') ? 'skip' : 'ok'}`}>
          {p}
        </span>
      ))}
    </div>
  );
}

function ToolCallDisplay({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const [idsDownloading, setIdsDownloading] = useState(false);
  const [idsError, setIdsError] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const setActivePendingEditId = useStore((s) => s.setActivePendingEditId);
  const modelLoaded = useStore((s) => s.modelLoaded);

  // Detect pending-edit result so we can surface a "Review Diff" chip
  const parsedResult = (() => {
    if (!tc.result) return null;
    try { return JSON.parse(tc.result); } catch { return null; }
  })();
  const isPendingEdit = parsedResult?.action === 'pending_edit';
  const isBatchEdit = parsedResult?.action === 'metadata_changed' &&
    typeof parsedResult?.changed_count === 'number';
  const editId: string | undefined = parsedResult?.edit_id;
  const isBlockedByMode = parsedResult?.blocked_by_mode === true;
  const isMemoCached = parsedResult?._memo === true;

  // IDS validate - show "Download failures CSV" when the tool produced results
  const isIdsValidate = tc.name === 'ids_validate' && !!tc.result;
  const idsBase64: string | undefined = typeof tc.arguments.ids_base64 === 'string'
    ? tc.arguments.ids_base64
    : undefined;
  const idsFailedCount = extractIdsFailedCount(parsedResult as Record<string, unknown> | null);

  const handleIdsDownloadCsv = async () => {
    if (!idsBase64) return;
    setIdsDownloading(true);
    setIdsError(false);
    try {
      const res = await fetch(apiUrl('/api/ifc/ids-validate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids_base64: idsBase64, format: 'csv' }),
      });
      if (!res.ok) { setIdsError(true); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFilename('ids-failures', 'csv');
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setIdsError(true);
    } finally {
      setIdsDownloading(false);
    }
  };

  const idsBtnState = {
    downloading: idsDownloading,
    error: idsError,
    noModel: !modelLoaded,
    failedCount: idsFailedCount,
  };

  const handleCopyToolCall = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await writeToClipboard(formatToolCallClipboard(tc));
    setCopyState(ok ? 'ok' : 'err');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <div className={`tool-call-block${isBlockedByMode ? ' tool-call-block--blocked' : ''}`}>
      <button
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="tool-call-icon">
          {isBlockedByMode ? '🔒' : isPendingEdit ? '📝' : tc.result ? '✅' : '⏳'}
        </span>
        <span className="tool-call-name">{tc.name}</span>
        {isMemoCached && (
          <span className="tool-call-memo-badge" title="Result served from memo cache (same args within this turn)">
            ⚡
          </span>
        )}
        {tc.executedOn && (
          <span className="tool-call-name" title={`Executed on ${tc.executedOn}`}>
            [{tc.executedOn}]
          </span>
        )}
        {!isBlockedByMode && (
          <span className="tool-call-args">
            ({Object.entries(tc.arguments).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ')})
          </span>
        )}
        <span
          role="button"
          tabIndex={0}
          aria-label={copyState === 'ok' ? 'Tool call copied' : 'Copy tool call as JSON'}
          className={`tool-call-copy tool-call-copy--${copyState}`}
          onClick={(e) => { void handleCopyToolCall(e); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              void handleCopyToolCall(e as unknown as React.MouseEvent);
            }
          }}
          title={
            copyState === 'ok' ? 'Copied!' :
            copyState === 'err' ? 'Copy failed' :
            'Copy tool call (name + arguments + result) as JSON'
          }
        >
          {copyState === 'ok' ? '✓' : copyState === 'err' ? '⚠' : '📋'}
        </span>
        <span className="tool-call-expand">{expanded ? '▲' : '▼'}</span>
      </button>
      {isBlockedByMode && (
        <div className="tool-call-blocked-bar">
          <Icon name="lock" size={11} />
          <span>Write tool blocked. Switch to <strong>Edit</strong> mode to make changes.</span>
        </div>
      )}
      {isPendingEdit && editId && (
        <button
          className="tool-call-pending-edit-btn"
          onClick={() => setActivePendingEditId(editId)}
          title="Open diff preview panel"
        >
          📋 Edit staged · review diff →
        </button>
      )}
      {isBatchEdit && parsedResult && (
        <BatchEditSummary result={parsedResult as Record<string, unknown>} />
      )}
      {isIdsValidate && idsBase64 && (
        <button
          className={`tool-call-ids-csv-btn${idsError ? ' ids-csv-error' : ''}${!modelLoaded ? ' ids-csv-no-model' : ''}`}
          onClick={() => { void handleIdsDownloadCsv(); }}
          disabled={idsDownloading || !modelLoaded}
          title={getIdsCsvButtonTitle(idsBtnState)}
        >
          {getIdsCsvButtonLabel(idsBtnState)}
        </button>
      )}
      {expanded && tc.result && (
        <pre className="tool-call-result">{tc.result}</pre>
      )}
    </div>
  );
}

function usageDetailLines(usage: ChatUsage): string[] {
  return [
    `${usage.provider} · ${usage.model}`,
    `Input: ${usage.inputTokens.toLocaleString()} tokens`,
    `Output: ${usage.outputTokens.toLocaleString()} tokens`,
    usage.cacheReadTokens
      ? `Cache read: ${usage.cacheReadTokens.toLocaleString()} tok (${((usage.cacheHitRatio ?? 0) * 100).toFixed(0)}% hit)`
      : '',
    usage.cacheCreationTokens
      ? `Cache write: ${usage.cacheCreationTokens.toLocaleString()} tok`
      : '',
  ].filter(Boolean);
}

function ChatUsageChip({ usage, messageContent }: { usage: ChatUsage; messageContent: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  const lines = usageDetailLines(usage);

  // The clipboard button copies the assistant message text itself - not the
  // token figures. The token counts stay readable via the chip's tooltip.
  const handleCopyMessage = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!messageContent) return;
    const ok = await writeToClipboard(messageContent);
    setCopyState(ok ? 'ok' : 'err');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <span
      className="chat-usage-chip"
      title={lines.join('\n')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        marginTop: 4,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--surface-2, rgba(255,255,255,0.06))',
        color: 'var(--text-muted, rgba(255,255,255,0.35))',
        fontSize: 10,
        letterSpacing: '0.02em',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {(usage.inputTokens + usage.outputTokens).toLocaleString()} tok
      {usage.cacheHitRatio !== undefined && usage.cacheHitRatio > 0 && (
        <span
          style={{ color: 'var(--accent-green, #4caf50)', fontWeight: 600 }}
          title={`${((usage.cacheHitRatio) * 100).toFixed(0)}% of input served from Anthropic prompt cache`}
        >
          {' '}⚡{((usage.cacheHitRatio) * 100).toFixed(0)}%
        </span>
      )}
      <button
        type="button"
        className={`chat-usage-copy-btn chat-usage-copy-btn--${copyState}`}
        onClick={(e) => { void handleCopyMessage(e); }}
        disabled={!messageContent}
        title={copyState === 'ok' ? 'Message copied' : copyState === 'err' ? 'Copy failed' : 'Copy message text'}
        aria-label={copyState === 'ok' ? 'Message copied' : 'Copy message text'}
      >
        {copyState === 'ok' ? <Icon name="check" size={10} strokeWidth={2} /> : <Icon name="clipboard-list" size={10} strokeWidth={1.9} />}
      </button>
    </span>
  );
}

// Memoized so the react-markdown parse only re-runs when the message text
// actually changes. Each streamed token re-renders ChatPanel, but only the
// streaming bubble's content string changes - every settled message keeps the
// same `content` and skips the parse via this memo boundary.
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      components={{
        code({ className, children, ...props }) {
          const isInline = !className;
          if (isInline) {
            return <code {...props}>{children}</code>;
          }
          return (
            <pre>
              <code className={className} {...props}>
                {children}
              </code>
            </pre>
          );
        },
        a({ children, ...props }) {
          return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

// One chat bubble, memoized and keyed (by the caller) on the stable message id.
// Because it lives at module scope and reads nothing from ChatPanel's closure,
// React.memo's default shallow compare holds it stable: a settled message keeps
// the same `msg` reference (the store appends tokens to the LAST message only)
// and `isStreaming` is a primitive, so only the streaming bubble re-renders per
// token instead of the whole list. `isStreaming` replaces the old
// `chatLoading && i === last` check so loading toggles don't re-render history.
const ChatMessageRow = memo(function ChatMessageRow({
  msg,
  isStreaming,
}: {
  msg: ChatMessage;
  isStreaming: boolean;
}) {
  return (
    <div className={`chat-bubble ${msg.role}`}>
      {msg.attachments && msg.attachments.length > 0 && (
        <div className="chat-attachments" style={{ marginBottom: 4 }}>
          {msg.attachments.map((a, k) => (
            <span
              key={k}
              className="chat-attachment-chip"
              title={`${a.kind} · ${a.size ?? '?'} bytes`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 4,
                background: 'var(--surface-2, rgba(0,0,0,0.15))',
                fontSize: 11,
                marginRight: 4,
              }}
            >
              <Icon name="clip" size={11} strokeWidth={1.7} /> {a.name}
            </span>
          ))}
        </div>
      )}
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="tool-calls-container">
          {msg.toolCalls.map((tc, j) => (
            <ToolCallDisplay key={j} tc={tc} />
          ))}
        </div>
      )}
      {msg.content ? (
        msg.role === 'assistant' ? (
          <MarkdownContent content={msg.content} />
        ) : (
          msg.content
        )
      ) : (
        isStreaming ? (
          <span className="loading-spinner" style={{ width: 14, height: 14 }} />
        ) : ''
      )}
      {msg.role === 'assistant' && msg.usage && <ChatUsageChip usage={msg.usage} messageContent={msg.content} />}
    </div>
  );
});

interface ChatPanelProps {
  embedded?: boolean;
}

// How close (px) to the bottom counts as "pinned" for the streaming
// autoscroll guard. Within this band, new tokens keep the view at the bottom;
// scroll further up than this and the autoscroll leaves the user alone.
const BOTTOM_PIN_PX = 80;

export default function ChatPanel({ embedded = false }: ChatPanelProps = {}) {
  const chatMessages = useStore((s) => s.chatMessages);
  const chatLoading = useStore((s) => s.chatLoading);
  const chatProvider = useStore((s) => s.chatProvider);
  const chatModel = useStore((s) => s.chatModel);
  const chatTemperature = useStore((s) => s.chatTemperature);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const addChatMessage = useStore((s) => s.addChatMessage);
  const setChatLoading = useStore((s) => s.setChatLoading);
  const setChatProvider = useStore((s) => s.setChatProvider);
  const setChatModel = useStore((s) => s.setChatModel);
  const chatModelRegistryId = useStore((s) => s.chatModelRegistryId);
  const setChatModelRegistryId = useStore((s) => s.setChatModelRegistryId);
  const clearChat = useStore((s) => s.clearChat);
  const setRightActiveTab = useStore((s) => s.setRightActiveTab);
  const lastNonChatTab = useStore((s) => s.lastNonChatTab);
  const setFloatingChatMinimized = useStore((s) => s.setFloatingChatMinimized);
  const agents = useStore((s) => s.agents);
  const agentsLoaded = useStore((s) => s.agentsLoaded);
  const activeAgentId = useStore((s) => s.activeAgentId);
  const setAgents = useStore((s) => s.setAgents);
  const setActiveAgentId = useStore((s) => s.setActiveAgentId);
  const chatAttachments = useStore((s) => s.chatAttachments);
  const addChatAttachment = useStore((s) => s.addChatAttachment);
  const removeChatAttachment = useStore((s) => s.removeChatAttachment);
  const clearChatAttachments = useStore((s) => s.clearChatAttachments);
  const agentManagerOpen = useStore((s) => s.agentManagerOpen);
  const setAgentManagerOpen = useStore((s) => s.setAgentManagerOpen);
  const sessionMemoryFacts = useStore((s) => s.sessionMemoryFacts);
  const chatThreadId = useStore((s) => s.chatThreadId);
  const chatHistoryRestored = useStore((s) => s.chatHistoryRestored);
  const setChatThreadId = useStore((s) => s.setChatThreadId);
  const restoreThreadHistory = useStore((s) => s.restoreThreadHistory);
  const budgetWarning = useStore((s) => s.budgetWarning);
  const activeFallbackModel = useStore((s) => s.activeFallbackModel);
  const setBudgetWarning = useStore((s) => s.setBudgetWarning);

  const selectedElement = useStore((s) => s.selectedElement);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const activeToolSetId = useStore((s) => s.activeToolSetId);
  const activePromptId = useStore((s) => s.activePromptId);
  // setActivePromptId reserved for future prompt-picker UI; not used yet.
  const snippetInsertText = useStore((s) => s.snippetInsertText);
  const setSnippetInsertText = useStore((s) => s.setSnippetInsertText);
  const setSnippetPanelOpen = useStore((s) => s.setSnippetPanelOpen);

  const [input, setInput] = useState('');
  const [dragOver, setDragOver] = useState(false);

  // First-run AI-keys gate. We only open the modal when the user actually
  // tries to chat with a non-local provider that has no key - opening on
  // mount would nag users who never use chat.
  const [aiKeysModalOpen, setAiKeysModalOpen] = useState(false);
  const [providerConfigured, setProviderConfigured] = useState<Record<string, boolean>>({});
  const refreshProviderConfigured = useCallback(async () => {
    try {
      const r = await getSecretsStatus();
      const m: Record<string, boolean> = {};
      for (const [id, entry] of Object.entries(r.providers)) m[id] = entry.configured;
      setProviderConfigured(m);
      return m;
    } catch {
      return providerConfigured;
    }
  }, [providerConfigured]);
  useEffect(() => {
    void refreshProviderConfigured();
    // mount-only fetch - the modal's onChanged hook keeps state in sync after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Model Registry - the chat model dropdown is populated from the *enabled*
  // entries here (Chat Manager → Models tab) instead of a hard-coded list.
  // Seeded synchronously from the cached bootstrap so the dropdown renders with
  // the right options on first paint; the fetch below revalidates. Falls back to
  // MODEL_CATALOGUE when the registry is empty / unreachable.
  const [registryModels, setRegistryModels] = useState<ModelEntry[]>(
    () => getCachedChatManagerBootstrap()?.models ?? [],
  );
  useEffect(() => {
    let cancelled = false;
    getChatManagerBootstrap()
      .then((boot) => { if (!cancelled) setRegistryModels(boot.models ?? []); })
      .catch(() => { /* fall back to MODEL_CATALOGUE */ });
    return () => { cancelled = true; };
  }, []);
  const enabledRegistryModels = registryModels.filter((m) => m.enabled);
  const useRegistry = enabledRegistryModels.length > 0;
  // Only send model_registry_id when the stored id still matches the active
  // provider+model. Guards against a stale id desyncing from a model typed into
  // the Settings tab's free-text field; a mismatch → legacy provider/model path.
  const selectedRegistryModel = enabledRegistryModels.find((m) => m.id === chatModelRegistryId);
  const effectiveRegistryId =
    selectedRegistryModel
    && selectedRegistryModel.provider === chatProvider
    && selectedRegistryModel.model_id === chatModel
      ? selectedRegistryModel.id
      : null;

  // Selection reconciliation. Once the registry is the source of truth, snap the
  // active selection onto a real enabled entry whenever it has drifted off one
  // (fresh load with a legacy persisted model that no seed matches, or the
  // active model was just disabled/deleted). Without this the dropdown shows the
  // first option while the turn silently sends the stale provider/model and
  // ignores all registry sampling. Prefer an entry on the current provider to
  // preserve intent. Self-terminating: once synced, effectiveRegistryId is
  // truthy and the guard returns.
  useEffect(() => {
    if (!useRegistry || effectiveRegistryId) return;
    const pick = enabledRegistryModels.find((m) => m.provider === chatProvider)
      ?? enabledRegistryModels[0];
    if (!pick) return;
    if (pick.provider !== chatProvider) setChatProvider(pick.provider);
    setChatModel(pick.model_id);
    setChatModelRegistryId(pick.id);
  }, [useRegistry, effectiveRegistryId, enabledRegistryModels, chatProvider,
      setChatProvider, setChatModel, setChatModelRegistryId]);

  // Chat mode: ask (default) | edit
  const [chatMode, setChatMode] = useState<'ask' | 'edit'>('ask');
  // Slash command autocomplete
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  // Quick-actions "+" menu
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  // Top-bar overflow menu - folds export/clear/new-chat/
  // chat-manager/settings into a single `⋯` button + dropdown.  Includes
  // roving-tabindex keyboard nav (Arrow/Home/End/Enter).
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [overflowActiveIndex, setOverflowActiveIndex] = useState<number | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Scrollable message viewport - used by the autoscroll guard to read scroll
  // position so streaming tokens don't yank the user back to the bottom while
  // they read earlier history.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // rAF handle coalescing the per-token autoscroll into at most one scroll
  // write per animation frame (instead of one smooth-scroll per token).
  const autoscrollRafRef = useRef<number | null>(null);
  // Token coalescer: streamed `chunk` deltas accumulate into this buffer and
  // are committed to the store via `updateLastAssistantMessage` at most once
  // per animation frame (instead of one store write - and one whole-list
  // re-render - per token). `null` means no stream is buffering; it is seeded
  // lazily from the current last-message content on the first chunk of a turn
  // and reset to `null` once flushed on `done` / `error` / abort.
  const streamBufRef = useRef<string | null>(null);
  const streamFlushRafRef = useRef<number | null>(null);
  // Whether the user is currently pinned to the bottom of the message list.
  // Updated on every (user or programmatic) scroll; the autoscroll guard only
  // follows new tokens when this is true, so scrolling up to read history
  // mid-stream is no longer fought by the auto-scroll. Starts true so the
  // first messages pin to the bottom.
  const isPinnedToBottomRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Snippet insert - signal from PromptSnippetPanel via store.
  useEffect(() => {
    if (!snippetInsertText) return;
    setInput((prev) => (prev ? `${prev} ${snippetInsertText}` : snippetInsertText));
    setSnippetInsertText(null);
    textareaRef.current?.focus();
  }, [snippetInsertText, setSnippetInsertText]);

  // Load agent catalogue once per session. Failure is non-fatal.
  useEffect(() => {
    if (agentsLoaded || agents.length > 0) return;
    let cancelled = false;
    listAgents()
      .then((resp) => {
        if (!cancelled) setAgents(resp.agents || []);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => { cancelled = true; };
  }, [agentsLoaded, agents.length, setAgents]);

  // Reconcile chatMode ↔ activeAgentId on first load.
  // Edit mode always uses edit-assistant. Ask mode allows any ask-category
  // agent; only snaps to 'default' if the current agent is the edit-assistant
  // (which would be wrong in ask mode).
  useEffect(() => {
    if (!agents.length) return;
    const currentAgent = agents.find((a) => a.id === activeAgentId);
    if (chatMode === 'edit') {
      if (activeAgentId !== 'edit-assistant' && agents.some(a => a.id === 'edit-assistant')) {
        setActiveAgentId('edit-assistant');
      }
    } else {
      // In ask mode: snap to 'default' only if current agent is edit-assistant or missing
      const isAskOk = currentAgent && currentAgent.id !== 'edit-assistant';
      if (!isAskOk && agents.some(a => a.id === 'default')) {
        setActiveAgentId('default');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]);

  // Restore chat history from LangGraph checkpoint on first mount (if no messages yet).
  useEffect(() => {
    if (chatHistoryRestored || chatMessages.length > 0) return;
    let cancelled = false;
    getThreadState(chatThreadId).then((state: ThreadState | null) => {
      if (cancelled || !state) return;
      const restored = state.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m): Omit<ChatMessage, 'id'> => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      if (restored.length > 0) restoreThreadHistory(restored);
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatThreadId]);

  // Track whether the user is pinned to the bottom of the message list.
  // Sampled on every scroll (user or programmatic) so the autoscroll guard
  // below has a stable answer that doesn't depend on measuring DOM geometry
  // after a streamed-token re-render (which a single large chunk could skew).
  const handleMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isPinnedToBottomRef.current = distanceFromBottom <= BOTTOM_PIN_PX;
  }, []);

  // Auto-scroll to bottom.
  // chatMessages changes on every streamed token, so a per-token
  // `scrollIntoView({behavior:'smooth'})` both janks (dozens of restarted
  // smooth animations per second) and traps the user - they can't scroll up
  // to re-read history because every token yanks them back down. Instead:
  //   1. only autoscroll while the user is pinned to the bottom (tracked via
  //      handleMessagesScroll) - otherwise leave their scroll position alone;
  //   2. coalesce the scroll into one rAF and use an instant (non-smooth)
  //      jump so streaming stays cheap and predictable.
  useEffect(() => {
    if (!isPinnedToBottomRef.current) return;        // user scrolled up - don't yank
    if (autoscrollRafRef.current !== null) return;   // a scroll is already queued this frame
    autoscrollRafRef.current = requestAnimationFrame(() => {
      autoscrollRafRef.current = null;
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, [chatMessages]);

  // Cancel any pending autoscroll / stream-flush rAF on unmount.
  useEffect(() => () => {
    if (autoscrollRafRef.current !== null) cancelAnimationFrame(autoscrollRafRef.current);
    if (streamFlushRafRef.current !== null) cancelAnimationFrame(streamFlushRafRef.current);
  }, []);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Close plus-menu on outside click
  useEffect(() => {
    if (!plusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [plusMenuOpen]);

  // Close overflow menu on outside click + Escape.
  useEffect(() => {
    if (!overflowMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowMenuOpen]);

  // Seed `overflowActiveIndex` to the first enabled row when the menu opens,
  // and clear it on close - keeps keyboard + mouse opens consistent.
  useEffect(() => {
    if (!overflowMenuOpen) {
      setOverflowActiveIndex(null);
      return;
    }
    const seed = firstEnabledIndex(getTopBarOverflowActions(chatMessages.length > 0));
    setOverflowActiveIndex(seed);
  }, [overflowMenuOpen, chatMessages.length]);

  // Move DOM focus to the keyboard-active row so the user can press Enter
  // to activate it.  Runs after every activeIndex change while the menu is
  // open.  Disabled rows are skipped by `nextIndexForKey`, so the ref here
  // always points at a focusable button.
  useEffect(() => {
    if (!overflowMenuOpen || overflowActiveIndex == null) return;
    const btn = overflowItemRefs.current[overflowActiveIndex];
    if (btn) btn.focus();
  }, [overflowMenuOpen, overflowActiveIndex]);

  const mentionElement = () => {
    if (!selectedElementId) return;
    const name = selectedElement?.name || selectedElement?.ifc_type || 'element';
    const mention = `#${selectedElementId} (${name})`;
    setInput((prev) => prev + (prev ? ' ' : '') + mention);
    setPlusMenuOpen(false);
    textareaRef.current?.focus();
  };

  const pasteProperties = () => {
    if (!selectedElement) return;
    const lines: string[] = [
      `**${selectedElement.name || selectedElement.ifc_type} (#${selectedElement.id})**`,
      `Type: ${selectedElement.ifc_type}`,
      selectedElement.storey ? `Storey: ${selectedElement.storey}` : '',
      selectedElement.material ? `Material: ${selectedElement.material}` : '',
    ].filter(Boolean);
    for (const pset of selectedElement.property_sets) {
      lines.push(`\n*${pset.name}:*`);
      for (const [k, v] of Object.entries(pset.properties)) {
        lines.push(`  ${k}: ${v ?? ''}`);
      }
    }
    setInput((prev) => (prev ? prev + '\n\n' : '') + lines.join('\n'));
    setPlusMenuOpen(false);
    textareaRef.current?.focus();
  };

  const activeAgent = agents.find((a) => a.id === activeAgentId) || null;
  const quickActions = (() => {
    if (chatMode === 'edit') return EDIT_QUICK_ACTIONS;
    if (activeAgent?.quick_prompts?.length)
      return activeAgent.quick_prompts.map((p) => ({ label: p.length > 34 ? p.slice(0, 31) + '…' : p, prompt: p }));
    return DEFAULT_QUICK_ACTIONS;
  })();

  // Commit the buffered stream text to the store and clear the pending rAF.
  // Safe to call repeatedly: `updateLastAssistantMessage` is a no-op when the
  // content already matches the last message (per the store contract), so a
  // flush with no new tokens does not force a re-render. Leaves the buffer
  // intact so further tokens keep accumulating from where this left off.
  const flushStreamBuffer = useCallback(() => {
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    if (streamBufRef.current !== null) {
      useStore.getState().updateLastAssistantMessage(streamBufRef.current);
    }
  }, []);

  // Shared handler for incoming WebSocket messages.
  const handleWsMessage = useCallback(async (event: MessageEvent) => {
    const data = JSON.parse(event.data);
    const state = useStore.getState();
    const lastMsg = state.chatMessages[state.chatMessages.length - 1];

    if (data.type === 'tool_call_request') {
      const ws = wsRef.current;
      const tool_call_id = data.tool_call_id as string | undefined;
      if (!tool_call_id) return;
      try {
        const { runClientTool } = await import('../../services/ifc/clientTools');
        const result = await runClientTool(data.name, data.arguments || {});
        ws?.send(JSON.stringify({ type: 'tool_result', tool_call_id, result }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ws?.send(JSON.stringify({
          type: 'tool_result',
          tool_call_id,
          result: { error: `Client tool dispatch failed: ${msg}` },
        }));
      }
      return;
    }

    if (data.type === 'chunk') {
      // Accumulate the token into the per-turn buffer (seeded lazily from the
      // current last-message content) and commit at most once per frame. The
      // caller still passes the FULL accumulated string to the store action -
      // only the cadence changes from per-token to per-frame.
      if (streamBufRef.current === null) {
        streamBufRef.current = lastMsg?.content || '';
      }
      streamBufRef.current += data.content;
      if (streamFlushRafRef.current === null) {
        streamFlushRafRef.current = requestAnimationFrame(() => {
          streamFlushRafRef.current = null;
          if (streamBufRef.current !== null) {
            useStore.getState().updateLastAssistantMessage(streamBufRef.current);
          }
        });
      }
    } else if (data.type === 'tool_call') {
      state.addToolCallToLastMessage({
        name: data.name,
        arguments: data.arguments || {},
      });
      state.logActivity({
        kind: 'tool',
        summary: `Tool: ${data.name}`,
        detail: JSON.stringify(data.arguments || {}),
      });
    } else if (data.type === 'tool_result') {
      const executedOn = data.executed_on === 'client' || data.executed_on === 'server'
        ? data.executed_on
        : undefined;
      state.updateLastToolCallResult(data.result, executedOn);
      // Log pending-edit results in the activity panel
      if (typeof data.result === 'string') {
        try {
          const r = JSON.parse(data.result);
          if (r?.action === 'pending_edit') {
            state.logActivity({
              kind: 'edit',
              summary: `Edit staged: ${r.summary || r.edit_id?.slice(0, 8) || 'pending'}`,
            });
          }
        } catch { /* ignore */ }
      }
    } else if (data.type === 'highlight') {
      const ids = data.element_ids || [];
      state.setHighlightedIds(ids);
      state.logActivity({
        kind: 'highlight',
        summary: `AI highlighted ${ids.length} element(s)`,
      });
    } else if (data.type === 'select') {
      const id: number | null = data.element_id ?? null;
      state.selectElement(id);
      if (id != null && state.rightSidebarMode === 'tabs') {
        state.setRightActiveTab('props');
        state.setRightSidebarOpen(true);
      }
      state.logActivity({
        kind: 'select',
        summary: `AI selected element ${id}`,
      });
    } else if (data.type === 'isolate') {
      const ids: number[] = data.element_ids || [];
      if (ids.length === 0) {
        state.clearVisibility();
        state.logActivity({ kind: 'show-all', summary: 'AI cleared isolation' });
      } else {
        state.setIsolatedIds(ids);
        state.logActivity({
          kind: 'isolate',
          summary: `AI isolated ${ids.length} element(s)`,
        });
      }
    } else if (data.type === 'show_all') {
      state.clearVisibility();
      state.logActivity({ kind: 'show-all', summary: 'AI restored full visibility' });
    } else if (data.type === 'clip_section_box') {
      const id: number = data.element_id;
      state.clipToElement(id);
      state.logActivity({ kind: 'view', summary: `AI clipped section box to element #${id}` });
    } else if (data.type === 'metadata_changed') {
      const changedIds: number[] = data.changed_ids || [];
      const renamed: Array<{ id: number; new_name: string }> = data.renamed || [];
      renamed.forEach(({ id, new_name }) => state.patchSpatialTreeNodeName(id, new_name));
      state.invalidateElementDetails(changedIds);
      state.logActivity({
        kind: 'edit',
        summary: data.description || `Model metadata updated (${changedIds.length} element(s))`,
      });
    } else if (data.type === 'entity_delta') {
      // Apply delta: flash highlight + property cache invalidation.
      const deltaEvent = data as unknown as EntityDeltaEvent;
      const changedIds: number[] = deltaEvent.changed_ids ?? [];
      const dirtyIds: number[]   = deltaEvent.dirty_ids   ?? [];
      const extra = dirtyIds.length - changedIds.length;
      // Fire-and-forget; applyEntityDelta never throws.
      applyEntityDelta(deltaEvent, {
        flashHighlight: (ids) => state.flashHighlightIds(ids),
        invalidateElementDetails: (ids) => state.invalidateElementDetails(ids),
      }).catch(() => {/* already handled internally */});
      state.logActivity({
        kind: 'info',
        summary: `Entity delta: ${changedIds.length} changed, ${extra > 0 ? extra : 0} transitively dirty`,
        detail: `dirty_ids: [${dirtyIds.slice(0, 10).join(', ')}${dirtyIds.length > 10 ? '…' : ''}]`,
      });
    } else if (data.type === 'budget_warning') {
      // Near-cap or over-cap budget alert.
      state.setBudgetWarning({
        usedUsd: data.used_usd as number,
        budgetUsd: data.budget_usd as number,
        ratio: data.ratio as number,
        agentId: data.agent_id as string,
        atCap: Boolean(data.at_cap),
      });
    } else if (data.type === 'model_fallback') {
      // Model was swapped to a cheaper fallback due to budget cap.
      state.setActiveFallbackModel({
        originalModel: data.original_model as string,
        fallbackModel: data.fallback_model as string,
        reason: 'budget_cap',
        usedUsd: data.used_usd as number,
        budgetUsd: data.budget_usd as number,
      });
      state.logActivity({
        kind: 'info',
        summary: `Budget cap reached. Model switched to ${data.fallback_model} (spent $${(data.used_usd as number).toFixed(4)} / $${(data.budget_usd as number).toFixed(2)})`,
      });
    } else if (data.type === 'memory_update') {
      const facts: string[] = Array.isArray(data.facts) ? data.facts : [];
      state.setSessionMemoryFacts(facts);
    } else if (data.type === 'usage') {
      state.setLastMessageUsage({
        inputTokens: (data.input_tokens as number) ?? 0,
        outputTokens: (data.output_tokens as number) ?? 0,
        costUsd: data.cost_usd as number | undefined,
        model: (data.model as string) ?? '',
        provider: (data.provider as string) ?? '',
        cacheReadTokens: data.cache_read_tokens as number | undefined,
        cacheCreationTokens: data.cache_creation_tokens as number | undefined,
        cacheHitRatio: data.cache_hit_ratio as number | undefined,
        cachedCostUsd: data.cached_cost_usd as number | undefined,
      });
    } else if (data.type === 'done') {
      // Commit any tokens still buffered for the final frame, then end the
      // stream so the next turn re-seeds the buffer from a clean slate.
      flushStreamBuffer();
      streamBufRef.current = null;
      state.setChatLoading(false);
    } else if (data.type === 'error') {
      // Commit any streamed partial first, then surface the error WITHOUT
      // destroying delivered content: a non-empty bubble (partial stream, or
      // a finished answer when the error arrives post-done) gets the error
      // appended; only an empty bubble is replaced outright.
      flushStreamBuffer();
      streamBufRef.current = null;
      const errText = typeof data.content === 'string' && data.content
        ? data.content
        : 'Chat stream error.';
      const msgs = useStore.getState().chatMessages;
      const lastMsg = msgs[msgs.length - 1];
      const prior = lastMsg && lastMsg.role === 'assistant' ? lastMsg.content : '';
      state.updateLastAssistantMessage(
        prior ? `${prior}\n\n⚠️ ${errText}` : `Error: ${errText}`,
      );
      state.setChatLoading(false);
      state.logActivity({
        kind: 'error',
        summary: 'Chat error',
        detail: errText,
      });
    }
  }, [flushStreamBuffer]);

  const ensureWebSocket = useCallback(async (): Promise<WebSocket> => {
    const current = wsRef.current;
    if (current && current.readyState === WebSocket.OPEN) {
      return current;
    }

    if (current && current.readyState === WebSocket.CONNECTING) {
      return new Promise<WebSocket>((resolve, reject) => {
        const onOpen = () => resolve(current);
        const onError = () => reject(new Error('Chat WebSocket failed to connect'));
        current.addEventListener('open', onOpen, { once: true });
        current.addEventListener('error', onError, { once: true });
      });
    }

    const wsUrl = backendWsUrl('/api/chat/ws');
    const ws = new WebSocket(wsUrl);
    ws.onmessage = handleWsMessage;
    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
    wsRef.current = ws;

    return new Promise<WebSocket>((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('Chat WebSocket failed to connect'));
    });
  }, [handleWsMessage]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  // Static list used for real-time autocomplete overlay
  const SLASH_MENU = [
    { cmd: '/find',    args: '<query>',        hint: 'Search elements by name or type' },
    { cmd: '/isolate', args: '<express ids>',  hint: 'Isolate comma-separated Express IDs' },
    { cmd: '/agent',   args: '<id>',           hint: 'Switch active agent preset' },
    { cmd: '/model',   args: '<provider:id>',  hint: 'Switch LLM model' },
    { cmd: '/ids',     args: '',               hint: 'Validate attached IDS file' },
    { cmd: '/clear',   args: '',               hint: 'Clear chat history' },
    { cmd: '/help',    args: '',               hint: 'Show available commands' },
  ] as const;

  // Slash command specs. `run` returns either the rewritten prompt to send
  // to the LLM, or the literal '__local__' if the command was handled
  // entirely client-side (e.g. /clear, /help, /agent).
  const slashCommands: SlashSpec[] = [
    {
      name: '/help',
      hint: 'show available slash commands',
      run: () => {
        const list = [
          '/find <query>        · search elements by name/type',
          '/isolate <expr ids>  · isolate comma-separated Express IDs',
          '/ids                 · validate the attached IDS file',
          '/agent <id>          · switch active agent preset',
          '/model <provider:id> · switch LLM model',
          '/clear               · clear chat history',
          '/help                · this message',
        ].join('\n');
        addChatMessage({ role: 'assistant', content: '```\n' + list + '\n```' });
        return '__local__';
      },
    },
    {
      name: '/clear',
      hint: 'clear chat history',
      run: () => {
        clearChat();
        clearChatAttachments();
        return '__local__';
      },
    },
    {
      name: '/agent',
      hint: 'switch agent preset',
      run: (arg) => {
        const id = arg.trim();
        if (!id) {
          const names = agents.map((a) => a.id).join(', ');
          addChatMessage({
            role: 'assistant',
            content: `Active agent: **${activeAgentId || 'default'}**. Available: ${names || '(loading…)'}.`,
          });
          return '__local__';
        }
        const match = agents.find((a) => a.id === id || a.label.toLowerCase() === id.toLowerCase());
        if (!match) {
          addChatMessage({ role: 'assistant', content: `Unknown agent: ${id}` });
          return '__local__';
        }
        setActiveAgentId(match.id);
        addChatMessage({ role: 'assistant', content: `Switched to agent **${match.label}**.` });
        return '__local__';
      },
    },
    {
      name: '/model',
      hint: 'switch LLM model',
      run: (arg) => {
        const trimmed = arg.trim();
        if (!trimmed) {
          addChatMessage({
            role: 'assistant',
            content: `Current model: **${chatProvider}:${chatModel}**.`,
          });
          return '__local__';
        }
        const [p, ...rest] = trimmed.split(':');
        const m = rest.join(':');
        if (!p || !m) {
          addChatMessage({ role: 'assistant', content: 'Usage: `/model provider:model_id` (e.g. `openai:gpt-4o`)' });
          return '__local__';
        }
        setChatProvider(p);
        setChatModel(m);
        addChatMessage({ role: 'assistant', content: `Switched to model **${p}:${m}**.` });
        return '__local__';
      },
    },
    {
      name: '/find',
      hint: 'search elements',
      run: (arg) => {
        const q = arg.trim();
        if (!q) return 'Search the loaded model.';
        return `Use search_elements with query "${q}" and list the top results with their Express ID, IFC type, and storey.`;
      },
    },
    {
      name: '/isolate',
      hint: 'isolate Express IDs',
      run: (arg) => {
        const ids = arg.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
        if (!ids.length) return 'Isolate nothing. Show all.';
        return `Call isolate_elements with element_ids=${JSON.stringify(ids)}.`;
      },
    },
    {
      name: '/ids',
      hint: 'validate attached IDS',
      run: () => {
        const ids = chatAttachments.find((a) => a.kind === 'ids');
        if (!ids) {
          addChatMessage({
            role: 'assistant',
            content: 'Attach an IDS (.ids / .xml) file first, then run `/ids` again.',
          });
          return '__local__';
        }
        return 'Validate the attached IDS file against the loaded IFC model and report pass/fail per specification with reasons.';
      },
    },
  ];

  const resolveSlashCommand = (raw: string): { prompt: string | '__local__' } | null => {
    if (!raw.startsWith('/')) return null;
    const space = raw.indexOf(' ');
    const head = (space < 0 ? raw : raw.slice(0, space)).toLowerCase();
    const rest = space < 0 ? '' : raw.slice(space + 1);
    const spec = slashCommands.find((s) => s.name === head);
    if (!spec || !spec.run) return null;
    return { prompt: spec.run(rest) };
  };

  const sendMessage = useCallback(async (messageText?: string) => {
    const msg = (messageText || input).trim();
    if ((!msg && chatAttachments.length === 0) || chatLoading) return;

    // Slash-command shortcut - intercept before the WS send.
    if (!messageText) {
      const slash = resolveSlashCommand(msg);
      if (slash) {
        setInput('');
        if (slash.prompt === '__local__') return;
        return sendMessage(slash.prompt);
      }
    }

    // First-run gate: hosted providers need a key. We re-fetch on miss in
    // case the user just configured a key in another tab / via the manage
    // modal.
    if (!providerConfigured[chatProvider]) {
      const fresh = await refreshProviderConfigured();
      if (!fresh[chatProvider]) {
        setAiKeysModalOpen(true);
        return;
      }
    }

    if (!messageText) setInput('');

    const attachmentsToSend = chatAttachments.slice();
    const userMsg: Omit<ChatMessage, 'id'> = { role: 'user', content: msg, attachments: attachmentsToSend };
    addChatMessage(userMsg);
    clearChatAttachments();
    useStore.getState().logActivity({
      kind: 'chat',
      summary: `User: ${msg.length > 60 ? msg.slice(0, 57) + '...' : msg}${attachmentsToSend.length ? ` (+${attachmentsToSend.length} file)` : ''}`,
    });

    addChatMessage({ role: 'assistant', content: '' });
    setChatLoading(true);

    // Start each turn with a clean stream buffer. done/error/abort already
    // reset it, but a turn can end abnormally (socket closed mid-stream with
    // no `done` frame, or clear/new-chat mid-stream) and leave a stale partial
    // behind. Resetting here - right after the fresh empty assistant bubble is
    // added - guarantees the first chunk re-seeds from this bubble's '' rather
    // than the previous turn's leftover text, and drops any orphaned flush rAF.
    if (streamFlushRafRef.current !== null) {
      cancelAnimationFrame(streamFlushRafRef.current);
      streamFlushRafRef.current = null;
    }
    streamBufRef.current = null;

    const currentMessages = useStore.getState().chatMessages;
    const history = currentMessages.slice(0, -1).map((m) => ({
      role: m.role,
      content: m.content,
      attachments: m.attachments || [],
    }));

    const payload = {
      message: msg,
      history,
      provider: chatProvider,
      model: chatModel,
      temperature: chatTemperature,
      tool_mode: 'hybrid',
      agent_id: activeAgentId,
      attachments: attachmentsToSend,
      tool_set_id: activeToolSetId,
      prompt_id: activePromptId,
      model_registry_id: effectiveRegistryId,
      thread_id: useStore.getState().chatThreadId,
      use_graph: true,
    };

    try {
      const ws = await ensureWebSocket();
      ws.send(JSON.stringify(payload));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Chat connection failed';
      useStore.getState().updateLastAssistantMessage(`Error: ${errMsg}`);
      useStore.getState().setChatLoading(false);
      useStore.getState().logActivity({
        kind: 'error',
        summary: 'Chat connection failed',
        detail: errMsg,
      });
    }
  }, [input, chatLoading, chatProvider, chatModel, chatTemperature, effectiveRegistryId, activeAgentId, chatAttachments, addChatMessage, setChatLoading, ensureWebSocket, clearChatAttachments]);

  const handleAbort = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    // Commit any tokens buffered for the current frame BEFORE the empty-content
    // check below, then end the stream. Without this flush the buffered partial
    // would be lost and `_(stopped)_` could clobber a non-empty response.
    flushStreamBuffer();
    streamBufRef.current = null;
    const state = useStore.getState();
    const msgs = state.chatMessages;
    if (msgs.length > 0 && msgs[msgs.length - 1].role === 'assistant') {
      if (!msgs[msgs.length - 1].content) {
        state.updateLastAssistantMessage('_(stopped)_');
      }
    }
    state.setChatLoading(false);
    state.logActivity({ kind: 'chat', summary: 'Generation stopped by user' });
  }, [flushStreamBuffer]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape' && chatLoading) {
      e.preventDefault();
      handleAbort();
    }
  };

  const handleQuickAction = (prompt: string) => {
    sendMessage(prompt);
  };

  const handleNewChat = useCallback(() => {
    const oldId = useStore.getState().chatThreadId;
    deleteThreadState(oldId).catch(() => {});
    setChatThreadId(crypto.randomUUID());
    clearChatAttachments();
  }, [setChatThreadId, clearChatAttachments]);

  // Overflow-menu dispatcher - keeps the menu rendering loop
  // thin by mapping action id → existing handler.  Centralising the
  // switch here makes future renames cheap (one place to touch).
  const runOverflowAction = useCallback((id: ChatTopBarAction['id']) => {
    switch (id) {
      case 'export-md':
        exportChatHistory(chatMessages, 'markdown', chatModel ?? undefined);
        break;
      case 'export-json':
        exportChatHistory(chatMessages, 'json', chatModel ?? undefined);
        break;
      case 'clear':
        clearChat();
        break;
      case 'new-chat':
        handleNewChat();
        break;
      case 'chat-manager':
        setAgentManagerOpen(true);
        break;
    }
  }, [chatMessages, chatModel, clearChat, handleNewChat, setAgentManagerOpen]);

  // -- Attachment helpers ---------------------------------------------------

  const ingestFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    // Cap per-turn attachments so users don't accidentally upload huge
    // sets of images (the history roundtrip is already the hot path).
    const ATTACHMENT_LIMIT = 6;
    const room = Math.max(0, ATTACHMENT_LIMIT - chatAttachments.length);
    const slice = arr.slice(0, room);
    for (const f of slice) {
      try {
        const att = await fileToAttachment(f);
        addChatAttachment(att);
      } catch (e) {
        useStore.getState().logActivity({
          kind: 'error',
          summary: `Attachment failed: ${f.name}`,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }, [chatAttachments.length, addChatAttachment]);

  const onFilePicked: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const files = e.target.files;
    if (files && files.length) ingestFiles(files);
    // Reset so selecting the same file twice still triggers onChange.
    e.target.value = '';
  };

  const onDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) ingestFiles(files);
  };

  const onDragOver: React.DragEventHandler<HTMLDivElement> = (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  };

  const onDragLeave: React.DragEventHandler<HTMLDivElement> = () => {
    setDragOver(false);
  };

  const showQuickActions = modelLoaded && chatMessages.length === 0;

  const containerStyle: React.CSSProperties = embedded
    ? { flex: 1, minHeight: 0 }
    : { flex: 1, minHeight: 200 };

  return (
    <div
      className="panel chat-panel"
      style={containerStyle}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {(() => {
        // Two fixed harnesses: Ask (read-only) and Edit (the only writer).
        // No sub-agent picker; the personas live in Chat Manager.
        const switchToAsk = () => {
          if (chatMode !== 'ask') {
            setChatMode('ask');
            setActiveAgentId('default');
          }
        };
        const switchToEdit = () => {
          setChatMode('edit');
          setActiveAgentId('edit-assistant');
        };

        return (
        <div className="chat-toolbar-row">
          <div className="chat-mode-pills">
            {/* Ask pill - just one agent ("Default · Ask") behind it.
                The sub-agent picker (BIM Analyst, Quantity Surveyor, …)
                was removed: those personas now live on the Skills tab
                in the Chat Manager and you can flip the active prompt
                from there instead. The Chat Manager keeps the
                full agent roster for power users. */}
            <button
              className={`chat-mode-pill${chatMode === 'ask' ? ' chat-mode-pill--active chat-mode-pill--agent' : ''}`}
              onClick={switchToAsk}
              title="Ask mode: read-only Q&A using the Default Ask agent."
            >
              <Icon name="message-square" size={12} />
              Ask
            </button>
            {/* Edit pill - hidden for v1 (EDIT_MODE_ENABLED). The Edit harness,
                switchToEdit, EDIT_QUICK_ACTIONS and the chatMode==='edit'
                branches stay in place so flipping the flag re-enables them. */}
            {EDIT_MODE_ENABLED && (
              <button
                className={`chat-mode-pill${chatMode === 'edit' ? ' chat-mode-pill--active' : ''}`}
                onClick={switchToEdit}
                title="Edit mode: stage IFC edits with diff preview. Always confirms before applying."
              >
                <Icon name="pencil" size={12} />
                Edit
              </button>
            )}
          </div>

          {/* Model select - compact. Populated from the Model Registry (Chat
              Manager → Models tab) when it has enabled entries; otherwise falls
              back to the built-in MODEL_CATALOGUE. */}
          {useRegistry ? (
            <select
              className="chat-model-select"
              value={
                selectedRegistryModel?.id
                ?? enabledRegistryModels.find((m) => m.provider === chatProvider && m.model_id === chatModel)?.id
                ?? ''
              }
              onChange={(e) => {
                const m = enabledRegistryModels.find((x) => x.id === e.target.value);
                if (m) {
                  if (m.provider !== chatProvider) setChatProvider(m.provider);
                  setChatModel(m.model_id);
                  setChatModelRegistryId(m.id);
                }
              }}
              title="LLM model - manage the list in Chat Manager → Models"
            >
              {(['openai', 'anthropic', 'openrouter'] as const).map((prov) => {
                const inGroup = enabledRegistryModels.filter((m) => m.provider === prov);
                if (inGroup.length === 0) return null;
                const label = prov === 'openai' ? 'OpenAI' : prov === 'anthropic' ? 'Anthropic' : 'OpenRouter';
                return (
                  <optgroup key={prov} label={label}>
                    {inGroup.map((m) => (
                      <option key={m.id} value={m.id}>{m.display_name}</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          ) : (
            <select
              className="chat-model-select"
              value={`${chatProvider}:${chatModel}`}
              onChange={(e) => {
                const [p, ...rest] = e.target.value.split(':');
                const m = rest.join(':');
                if (p && m) { if (p !== chatProvider) setChatProvider(p); setChatModel(m); }
              }}
              title="LLM model"
            >
              {MODEL_CATALOGUE.map((group) => (
                <optgroup key={group.provider} label={group.providerLabel}>
                  {group.models.map((m) => (
                    <option key={m.id} value={`${group.provider}:${m.id}`}>
                      {m.label}{m.hint ? ` (${m.hint})` : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}

          <span className="embedded-toolbar-spacer" />

          {/* Right icon-only buttons */}
          {chatLoading && (
            <button className="chat-icon-btn chat-icon-btn--stop" onClick={handleAbort}
              title="Stop generation (Esc)">
              <Icon name="square" size={13} />
            </button>
          )}
          {sessionMemoryFacts.length > 0 && (
            <span
              className="chat-memory-badge"
              title={`Agent session memory (${sessionMemoryFacts.length} fact${sessionMemoryFacts.length !== 1 ? 's' : ''}):\n${sessionMemoryFacts.join('\n')}`}
            >
              <Icon name="brain" size={11} />
              {sessionMemoryFacts.length}
            </span>
          )}
            {/* Compact chat actions
              (export MD/JSON · clear · new-chat · chat-manager)
              folded into a single `⋯` overflow menu so the toolbar reads
              as: mode pills · model · stop? · memory? · ⋯ · detach.
              Stop / memory badge / detach stay visible (status / layout). */}
          <div className="chat-overflow-wrap" ref={overflowMenuRef}>
            <button
              className={`chat-icon-btn${overflowMenuOpen ? ' chat-icon-btn--active' : ''}`}
              onClick={() => setOverflowMenuOpen((v) => !v)}
              title="More actions"
              aria-label="More chat actions"
              aria-haspopup="menu"
              aria-expanded={overflowMenuOpen}
            >
              <Icon name="more-horizontal" size={13} />
            </button>
            {overflowMenuOpen && (() => {
              const rows = getTopBarOverflowActions(chatMessages.length > 0);
              // Resize the ref array so removed rows don't leak DOM refs.
              if (overflowItemRefs.current.length !== rows.length) {
                overflowItemRefs.current.length = rows.length;
              }
              const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
                if (!isOverflowNavKey(e.key)) return;
                const next = nextIndexForKey(rows, overflowActiveIndex, e.key);
                if (next == null) return;
                e.preventDefault();
                e.stopPropagation();
                setOverflowActiveIndex(next);
              };
              return (
                <div
                  className="chat-overflow-menu"
                  role="menu"
                  aria-orientation="vertical"
                  onKeyDown={onMenuKeyDown}
                >
                  {rows.map((row, idx) => {
                    const onPick = () => {
                      if (row.disabled) return;
                      setOverflowMenuOpen(false);
                      runOverflowAction(row.id);
                    };
                    const isActive = idx === overflowActiveIndex;
                    return (
                      <div key={row.id}>
                        <button
                          ref={(el) => { overflowItemRefs.current[idx] = el; }}
                          className={`chat-overflow-item${row.disabled ? ' chat-overflow-item--disabled' : ''}${isActive ? ' chat-overflow-item--active' : ''}`}
                          onClick={onPick}
                          onMouseEnter={() => { if (!row.disabled) setOverflowActiveIndex(idx); }}
                          disabled={row.disabled}
                          aria-disabled={row.disabled || undefined}
                          tabIndex={isActive ? 0 : -1}
                          title={row.hint}
                          role="menuitem"
                        >
                          <Icon name={row.icon} size={12} />
                          <span className="chat-overflow-item-label">{row.label}</span>
                        </button>
                        {row.separatorAfter && <div className="chat-overflow-divider" role="separator" />}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          <button
            className="chat-icon-btn"
            onClick={() => { setFloatingChatMinimized(false); setRightActiveTab(lastNonChatTab ?? 'props'); }}
            title="Detach into floating panel">
            <Icon name="panel-right-open" size={13} />
          </button>
        </div>
        );
      })()}
      <AIReadinessChip />
      {<div ref={messagesContainerRef} onScroll={handleMessagesScroll} className={`chat-messages${dragOver ? ' chat-drop-hover' : ''}`}>
        {!modelLoaded && chatMessages.length === 0 && (
          <div className="chat-empty-state">
            <div className="chat-empty-icon">{chatMode === 'edit' ? '✏️' : '🏗️'}</div>
            <p>{chatMode === 'edit'
              ? 'Upload an IFC model to start editing'
              : 'Upload an IFC model to start asking questions'}
            </p>
          </div>
        )}
        {showQuickActions && (
          <div className="quick-actions">
            <p className="quick-actions-title">
              {chatMode === 'edit'
                ? 'Try editing:'
                : activeAgent && activeAgent.id !== 'default'
                  ? `Try asking (${activeAgent.label}):`
                  : 'Try asking:'}
            </p>
            <div className="quick-actions-grid">
              {quickActions.map((action, i) => (
                <button
                  key={i}
                  className="quick-action-btn"
                  onClick={() => handleQuickAction(action.prompt)}
                  disabled={chatLoading}
                  title={action.prompt}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatHistoryRestored && chatMessages.length > 0 && (
          <div className="chat-history-divider">
            <span>Previous conversation restored</span>
          </div>
        )}
        {chatMessages.map((msg, i) => (
          // Keyed by the stable per-message id (not the array index) so the
          // list reconciles by identity - no remount flicker on history
          // restore and a prerequisite for the per-bubble memoization in
          // ChatMessageRow. `isStreaming` is true only for the last bubble
          // while a turn is loading, so settled rows keep a stable `false`
          // and don't re-render on loading toggles or per-token commits.
          <ChatMessageRow
            key={msg.id}
            msg={msg}
            isStreaming={chatLoading && i === chatMessages.length - 1}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>}
      {chatAttachments.length > 0 && (
        <div className="chat-attachment-tray" style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          padding: '4px 8px',
          borderTop: '1px solid var(--border, rgba(255,255,255,0.08))',
        }}>
          {chatAttachments.map((a, i) => (
            <span
              key={i}
              className="chat-attachment-chip"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '2px 8px',
                borderRadius: 4,
                background: 'var(--surface-2, rgba(0,0,0,0.15))',
                fontSize: 11,
              }}
              title={`${a.kind} · ${a.mime || 'unknown mime'} · ${a.size ?? '?'} bytes`}
            >
              <Icon name="clip" size={11} strokeWidth={1.7} /> {a.name}
              <button
                className="btn-icon"
                style={{ padding: 0, fontSize: 12, lineHeight: 1 }}
                onClick={() => removeChatAttachment(i)}
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {/* Budget warning banner */}
      {budgetWarning && (
        <div className={`chat-budget-banner${budgetWarning.atCap ? ' chat-budget-banner--cap' : ''}`}>
          <span className="chat-budget-banner__icon">{budgetWarning.atCap ? '🚫' : '⚠️'}</span>
          <span className="chat-budget-banner__text">
            {budgetWarning.atCap
              ? `Budget exhausted. Fallback model active ($${budgetWarning.usedUsd.toFixed(4)} / $${budgetWarning.budgetUsd.toFixed(2)})`
              : `Near budget limit: ${Math.round(budgetWarning.ratio * 100)}% used ($${budgetWarning.usedUsd.toFixed(4)} / $${budgetWarning.budgetUsd.toFixed(2)})`
            }
          </span>
          <button className="chat-budget-banner__dismiss" onClick={() => setBudgetWarning(null)} title="Dismiss">×</button>
        </div>
      )}
      {activeFallbackModel && (
        <div className="chat-budget-banner chat-budget-banner--fallback">
          <span className="chat-budget-banner__icon">🔄</span>
          <span className="chat-budget-banner__text">
            Using <strong>{activeFallbackModel.fallbackModel}</strong> (budget cap; was {activeFallbackModel.originalModel})
          </span>
        </div>
      )}
      {<div className="chat-input-area">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFilePicked}
          accept="image/*,.ids,.xml,.txt,.md,.csv,.json"
        />
        <input
          ref={pdfInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFilePicked}
          accept="application/pdf,.pdf"
        />
        {/* Quick-actions "+" menu */}
        <div className="chat-plus-wrap" ref={plusMenuRef}>
          <button
            className="btn-icon chat-plus-btn"
            onClick={() => setPlusMenuOpen((v) => !v)}
            title="Quick actions: upload, mention, paste properties"
            aria-label="Quick actions"
            aria-expanded={plusMenuOpen}
          >
            +
          </button>
          {plusMenuOpen && (
            <div className="chat-plus-menu">
              <button
                className="chat-plus-item"
                onClick={() => { pdfInputRef.current?.click(); setPlusMenuOpen(false); }}
              >
                <span className="chat-plus-item-icon"><Icon name="file-text" size={14} strokeWidth={1.7} /></span>
                <div>
                  <div className="chat-plus-item-label">Upload PDF</div>
                  <div className="chat-plus-item-hint">Attach a PDF document to this message</div>
                </div>
              </button>
              <button
                className="chat-plus-item"
                onClick={() => { fileInputRef.current?.click(); setPlusMenuOpen(false); }}
              >
                <span className="chat-plus-item-icon"><Icon name="clip" size={14} strokeWidth={1.7} /></span>
                <div>
                  <div className="chat-plus-item-label">Attach file</div>
                  <div className="chat-plus-item-hint">Images, IDS, XML, text, CSV, JSON</div>
                </div>
              </button>
              <button
                className={`chat-plus-item${!selectedElementId ? ' chat-plus-item--disabled' : ''}`}
                onClick={mentionElement}
                disabled={!selectedElementId}
              >
                <span className="chat-plus-item-icon"><Icon name="tag" size={14} strokeWidth={1.7} /></span>
                <div>
                  <div className="chat-plus-item-label">Mention selection</div>
                  <div className="chat-plus-item-hint">
                    {selectedElementId
                      ? `#${selectedElementId} ${selectedElement?.name || ''}`
                      : 'Select an element first'}
                  </div>
                </div>
              </button>
              <button
                className={`chat-plus-item${!selectedElement ? ' chat-plus-item--disabled' : ''}`}
                onClick={pasteProperties}
                disabled={!selectedElement}
              >
                <span className="chat-plus-item-icon"><Icon name="clipboard-list" size={14} strokeWidth={1.7} /></span>
                <div>
                  <div className="chat-plus-item-label">Paste properties</div>
                  <div className="chat-plus-item-hint">
                    {selectedElement
                      ? `${selectedElement.property_sets.length} property sets`
                      : 'Select an element first'}
                  </div>
                </div>
              </button>
            </div>
          )}
        </div>
        {/* Slash command autocomplete overlay */}
        {slashMenuOpen && (() => {
          const q = input.slice(1).toLowerCase();
          const matches = SLASH_MENU.filter(s => s.cmd.slice(1).startsWith(q));
          return matches.length > 0 ? (
            <div className="slash-menu">
              {matches.map(s => (
                <button
                  key={s.cmd}
                  className="slash-menu-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setInput(s.cmd + (s.args ? ' ' : ''));
                    setSlashMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <code className="slash-menu-cmd">{s.cmd}</code>
                  {s.args && <span className="slash-menu-args">{s.args}</span>}
                  <span className="slash-menu-hint">{s.hint}</span>
                </button>
              ))}
            </div>
          ) : null;
        })()}
        <textarea
          ref={textareaRef}
          placeholder={
            !modelLoaded
              ? 'Load a model first…'
              : chatMode === 'edit'
                ? 'Describe what to edit… (e.g. "Rename all walls to Exterior Wall")'
                : 'Ask about the model… (Shift+Enter for newline, / for commands)'
          }
          value={input}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            setSlashMenuOpen(v.startsWith('/') && !v.includes(' '));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && slashMenuOpen) {
              setSlashMenuOpen(false);
              return;
            }
            handleKeyDown(e);
          }}
          onBlur={() => setTimeout(() => setSlashMenuOpen(false), 150)}
          // Stay editable while the answer streams so the user can pre-type the
          // next prompt. Send is still gated on !chatLoading (button below +
          // the guard in sendMessage), so Enter mid-stream is a no-op until the
          // current turn finishes - the typed text is preserved.
          disabled={!modelLoaded}
          rows={1}
        />
        <button
          className="btn btn-primary"
          onClick={() => sendMessage()}
          disabled={chatLoading || (!input.trim() && chatAttachments.length === 0)}
        >
          Send
        </button>
      </div>}
      {aiKeysModalOpen && (
        <AiKeysModal
          mode="onboarding"
          onClose={() => setAiKeysModalOpen(false)}
          onChanged={(res) => {
            const m: Record<string, boolean> = {};
            for (const [id, entry] of Object.entries(res.providers)) m[id] = entry.configured;
            setProviderConfigured(m);
          }}
        />
      )}
    </div>
  );
}
