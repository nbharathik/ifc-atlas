import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { applyIfcPatchBatch } from './services/viewer/patchApplier';
import type { IfcPatch } from './types/ifcPatch';

import DemoModeBanner from './components/layout/DemoModeBanner';
import EditScopeBanner from './components/layout/EditScopeBanner';
import KeyboardShortcuts from './components/layout/KeyboardShortcuts';
import Menubar from './components/layout/Menubar';
import { applyAccentPreset } from './utils/accentPreset';
import { prewarmChatManagerBootstrap } from './services/api';
import StatusBar from './components/layout/StatusBar';
import Topbar from './components/layout/Topbar';
import UploadOverlay from './components/layout/UploadOverlay';
import DesktopOpenFileBridge from './components/DesktopOpenFileBridge';
import Icon from './components/ui/Icon';
import ToastStack from './components/ui/ToastStack';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { readinessFromSyncEvent } from './components/chat/AIReadinessChip';
import { getServerCapabilities } from './services/ifc/serverConvert';
import { isRecoverableServerConvertFailure } from './services/viewer/loadStrategy';
import { useStore } from './store/useStore';
import { wsUrl as backendWsUrl } from './lib/platform';
import { BROWSER_ONLY } from './config/featureFlags';
import { executeViewerCommand, type ViewerCommandPayload } from './services/viewer/viewerCommandExecutor';
import { viewerStateReporter } from './services/viewer/viewerStateReporter';
import type {
  ElementSummary,
  ModelSyncEvent,
  PendingEditEnvelope,
  SpatialNode,
} from './types/ifc';

const ActivityPanel = lazy(() => import('./components/panels/ActivityPanel'));
const BudgetDashboardPanel = lazy(() => import('./components/panels/BudgetDashboardPanel').then((m) => ({ default: m.BudgetDashboardPanel })));
const ChatManagerPanel = lazy(() => import('./components/chat/ChatManagerPanel'));
const ChatPanel = lazy(() => import('./components/chat/ChatPanel'));
const TimelinePanel = lazy(() => import('./components/panels/TimelinePanel').then((m) => ({ default: m.TimelinePanel })));
const CommandPalette = lazy(() => import('./components/layout/CommandPalette'));
const DiffPreviewPanel = lazy(() => import('./components/edit/DiffPreviewPanel'));
const Outliner = lazy(() => import('./components/layout/Outliner'));
const PromptSnippetPanel = lazy(() => import('./components/chat/PromptSnippetPanel'));
const PropertiesPanel = lazy(() => import('./components/panels/PropertiesPanel'));
const RightSidebar = lazy(() => import('./components/layout/RightSidebar'));
const SettingsModal = lazy(() => import('./components/layout/SettingsModal'));
const ViewerPanel = lazy(() => import('./components/viewer/ViewerPanel'));
const ViewerToolsPanel = lazy(() => import('./components/viewer/ViewerToolsPanel'));
const ColourLayerLegend = lazy(() => import('./components/viewer/ColourLayerLegend'));
const ViewpointsPanel = lazy(() => import('./components/panels/ViewpointsPanel'));

function patchTreeNames(root: SpatialNode, updates: Map<number, string>): SpatialNode {
  const walk = (node: SpatialNode): [SpatialNode, boolean] => {
    let changed = false;
    const children: SpatialNode[] = [];
    for (const child of node.children) {
      const [patchedChild, childChanged] = walk(child);
      children.push(patchedChild);
      if (childChanged) changed = true;
    }

    const nextName = updates.get(node.id);
    const nameChanged = typeof nextName === 'string' && nextName !== node.name;
    if (nameChanged) changed = true;

    if (!changed) {
      return [node, false];
    }
    return [
      {
        ...node,
        name: nameChanged ? (nextName as string) : node.name,
        children,
      },
      true,
    ];
  };

  return walk(root)[0];
}

function AgentManagerPanelWrapper() {
  const agentManagerOpen = useStore(s => s.agentManagerOpen);
  const setAgentManagerOpen = useStore(s => s.setAgentManagerOpen);
  const setChatManagerInitialSection = useStore(s => s.setChatManagerInitialSection);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        setAgentManagerOpen(!agentManagerOpen);
      }
      // Ctrl+Shift+I opens the Chat Manager on the Documents tab.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'I') {
        e.preventDefault();
        setChatManagerInitialSection('docs');
        setAgentManagerOpen(true);
      }
      if (e.key === 'Escape' && agentManagerOpen) {
        setAgentManagerOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [agentManagerOpen, setAgentManagerOpen, setChatManagerInitialSection]);

  if (!agentManagerOpen) return null;
  return (
    <Suspense fallback={null}>
      <ChatManagerPanel onClose={() => setAgentManagerOpen(false)} />
    </Suspense>
  );
}

export default function App() {
  const modelLoaded = useStore((s) => s.modelLoaded);
  const loadStartTs = useStore((s) => s.loadStartTs);
  const setSwReady = useStore((s) => s.setSwReady);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const pendingEditCount = useStore((s) => s.pendingEdits.length);
  const checkpointPanelOpen = useStore((s) => s.checkpointPanelOpen);
  const budgetPanelOpen = useStore((s) => s.budgetPanelOpen);
  const snippetPanelOpen = useStore((s) => s.snippetPanelOpen);
  const theme = useStore((s) => s.theme);
  const accentPreset = useStore((s) => s.accentPreset);
  const spatialTree = useStore((s) => s.spatialTree);
  const streamingRevealEnabled = useStore((s) => s.streamingRevealEnabled);

  const rightSidebarMode = useStore((s) => s.rightSidebarMode);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightSidebarExpanded = useStore((s) => s.rightSidebarExpanded);

  const propsOpen = useStore((s) => s.propsOpen);
  const chatOpen = useStore((s) => s.chatOpen);
  const activityOpen = useStore((s) => s.activityOpen);
  const viewpointsOpen = useStore((s) => s.viewpointsOpen);

  const leftSidebarOpen = useStore((s) => s.leftSidebarOpen);
  const setLeftSidebarOpen = useStore((s) => s.setLeftSidebarOpen);
  const setRightSidebarOpen = useStore((s) => s.setRightSidebarOpen);

  const cameraViewRef = useRef<((view: string) => void) | null>(null);
  const fitModelRef = useRef<(() => void) | null>(null);
  const screenshotRef = useRef<(() => void) | null>(null);
  const saveViewpointRef = useRef<((name: string) => void) | null>(null);
  const restoreViewpointRef = useRef<((id: string) => void) | null>(null);
  const chatBootstrapPrewarmedRef = useRef(false);

  const handleCameraView = useCallback((view: string) => {
    cameraViewRef.current?.(view);
  }, []);

  const handleFitModel = useCallback(() => {
    fitModelRef.current?.();
  }, []);

  const handleScreenshot = useCallback(() => {
    screenshotRef.current?.();
  }, []);

  const handleSaveViewpoint = useCallback((name: string) => {
    saveViewpointRef.current?.(name);
  }, []);

  const handleRestoreViewpoint = useCallback((id: string) => {
    restoreViewpointRef.current?.(id);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Remove legacy welcome tour overlays (if any stale/cached runtime script
  // still injects them) so the viewer opens directly without onboarding UI.
  useEffect(() => {
    const removeTourNodes = () => {
      document.querySelectorAll('.tour-tooltip, .tour-overlay').forEach((el) => el.remove());
    };

    removeTourNodes();
    const observer = new MutationObserver(() => removeTourNodes());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Restore viewer state from a share link in the URL hash.
  // We wait until the model is loaded before applying isolate/highlight so
  // the viewer's element map is ready. Camera is applied via getCameraStateFn
  // which is registered by ViewerPanel after the model is ready.
  useEffect(() => {
    if (!modelLoaded) return;
    void (async () => {
      try {
        const { parseShareHash, clearShareHash } = await import('./services/viewer/shareLink');
        const shared = parseShareHash();
        if (!shared) return;

        const state = useStore.getState();
        if (shared.iso && shared.iso.length > 0) state.setIsolatedIds(shared.iso);
        if (shared.hi && shared.hi.length > 0) state.setHighlightedIds(shared.hi);
        if (shared.tab) {
          const validTabs = ['props', 'views', 'log', 'chat', 'tools'] as const;
          if (validTabs.includes(shared.tab as typeof validTabs[number])) {
            state.setRightActiveTab(shared.tab as typeof validTabs[number]);
          }
        }
        if (shared.cam) {
          const lookAt = state.setLookAtFn;
          if (lookAt) {
            lookAt(shared.cam.p, shared.cam.t, true);
          }
        }
        state.logActivity({ kind: 'info', summary: 'Viewer state restored from share link.' });
        clearShareHash();
      } catch {
        /* share link parsing is best-effort */
      }
    })();
  }, [modelLoaded]);

  useEffect(() => {
    applyAccentPreset(accentPreset);
  }, [accentPreset]);

  // Pre-warm the Chat Manager bootstrap after the shell/model has had time
  // to paint. This keeps the initial route and model load path focused on
  // the viewer instead of pulling chat-manager data into the critical path.
  useEffect(() => {
    if (BROWSER_ONLY) return;
    if (chatBootstrapPrewarmedRef.current) return;
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }).requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
    const kick = () => {
      if (chatBootstrapPrewarmedRef.current) return;
      chatBootstrapPrewarmedRef.current = true;
      prewarmChatManagerBootstrap();
    };
    let timer = 0;
    let idleHandle = 0;
    if (modelLoaded && ric) {
      idleHandle = ric(kick, { timeout: 5000 });
    } else {
      timer = window.setTimeout(kick, modelLoaded ? 3000 : 8000);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
      if (idleHandle && cic) cic(idleHandle);
    };
  }, [modelLoaded]);

  // Progressive storey reveal - after the spatial tree arrives from the
  // backend, animate the model by revealing storeys from ground up.
  // The reveal uses isolatedIds transiently; it clears isolation when done.
  // Cancelled automatically if the model changes (spatialTree -> null -> new).
  useEffect(() => {
    if (!modelLoaded || !spatialTree || !streamingRevealEnabled) return;
    let ctrl: import('./services/viewer/streamingLoader').RevealController | null = null;
    void import('./services/viewer/streamingLoader').then(({ revealStoreyByStorey }) => {
      const state = useStore.getState();
      state.setStreamingRevealActive(true);
      ctrl = revealStoreyByStorey(
        spatialTree,
        {
          setIsolatedIds: (ids) => useStore.getState().setIsolatedIds(ids),
          clearVisibility: () => useStore.getState().clearVisibility(),
          onProgress: (_step, total) => {
            if (_step >= total) useStore.getState().setStreamingRevealActive(false);
          },
        },
        { delayMs: 350 },
      );
    });
    return () => {
      ctrl?.cancel();
      useStore.getState().setStreamingRevealActive(false);
    };
  // Deliberately depend on spatialTree identity (not content): the effect re-runs
  // each time the backend delivers a new tree (model reload).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelLoaded, spatialTree, streamingRevealEnabled]);

  // Register service worker to pre-cache WASM + worker files.
  // Non-blocking - runs at idle, never delays startup.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    import('./services/viewer/swRegistration').then(({ registerWasmServiceWorker, listenForSwActivation }) => {
      registerWasmServiceWorker().then(result => {
        if (result.status === 'registered') {
          if (import.meta.env.DEV) console.debug('[sw] WASM pre-cache SW registered');
        } else if (result.status === 'error') {
          console.warn('[sw] WASM pre-cache SW failed:', result.error);
        }
        if (result.status !== 'error' && result.status !== 'unsupported') {
          cleanup = listenForSwActivation(() => setSwReady(true));
        }
      });
    });
    return () => cleanup?.();
  }, [setSwReady]);

  // Warm wasm early so first load does less blocking work. When the page
  // is cross-origin isolated (COOP + COEP set, see vite.config), pick the
  // multi-threaded variant so web-ifc's parse can engage workers. Reports
  // the selection to the activity log once so users can confirm MT is
  // actually in effect.
  useEffect(() => {
    const isolated =
      typeof self !== 'undefined'
      && self.crossOriginIsolated === true
      && typeof SharedArrayBuffer !== 'undefined';
    const variant = isolated ? 'mt' : 'st';
    const base = import.meta.env.BASE_URL || '/';
    const wasmUrl = `${base}${isolated ? 'web-ifc-mt.wasm' : 'web-ifc.wasm'}`;
    const kick = () => {
      fetch(wasmUrl, { cache: 'default' }).catch(() => {
        // noop
      });
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (ric) ric(kick, { timeout: 2000 });
    else window.setTimeout(kick, 50);

    const logActivity = useStore.getState().logActivity;
    if (isolated) {
      logActivity({
        kind: 'info',
        summary: 'Cross-origin isolated - multi-threaded web-ifc enabled (web-ifc-mt.wasm).',
      });
    } else {
      logActivity({
        kind: 'info',
        summary:
          'Single-threaded web-ifc in use (crossOriginIsolated=false). Enable COOP/COEP on the host to unlock MT parse.',
      });
    }
    // Test harness metadata. Only exposed in development builds.
    if (import.meta.env.DEV) {
      (window as unknown as { __ifcWasmVariant?: string }).__ifcWasmVariant = variant;
      (window as unknown as { __crossOriginIsolated?: boolean }).__crossOriginIsolated = isolated;
    }
  }, []);

  // Probe the backend fragment-convert sidecar. Recoverable failures are not
  // stored as a hard "disabled" state; we retry in the background so a slow
  // sidecar startup can still become the primary load path.
  useEffect(() => {
    if (BROWSER_ONLY) return;
    let cancelled = false;
    let lastStatus: 'ready' | 'recoverable' | 'hard-unavailable' | null = null;
    const wait = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });

    const probe = async () => {
      let attempt = 0;
      while (!cancelled) {
        try {
          const caps = await getServerCapabilities({ force: attempt > 0 });
          if (cancelled) return;
          const state = useStore.getState();
          if (caps.server_convert) {
            state.setServerConvertCaps(caps);
            if (lastStatus !== 'ready') {
              state.logActivity({
                kind: 'info',
                summary: `Server fragment converter ready (sidecar v${caps.version ?? '?'}). Large-file loads will use the fast path.`,
              });
            }
            lastStatus = 'ready';
            return;
          }

          const recoverable = isRecoverableServerConvertFailure(caps);
          if (recoverable) {
            state.setServerConvertCaps(null);
            if (lastStatus !== 'recoverable') {
              state.logActivity({
                kind: 'info',
                summary: `Server fragment converter is starting or recovering (${caps.reason ?? 'pending'}). Uploads will keep trying backend conversion before browser fallback.`,
              });
            }
            lastStatus = 'recoverable';
            attempt += 1;
            await wait(Math.min(10_000, 2_000 + attempt * 1_000));
            continue;
          }

          state.setServerConvertCaps(caps);
          if (lastStatus !== 'hard-unavailable') {
            state.logActivity({
              kind: 'info',
              summary: `Server fragment converter unavailable (${caps.reason ?? 'unknown'}). Browser fallback is enabled for this session.`,
            });
          }
          lastStatus = 'hard-unavailable';
          return;
        } catch {
          if (cancelled) return;
          if (lastStatus !== 'recoverable') {
            useStore.getState().logActivity({
              kind: 'info',
              summary: 'Server fragment converter probe failed transiently. Uploads will still try backend conversion first.',
            });
          }
          lastStatus = 'recoverable';
          attempt += 1;
          await wait(Math.min(10_000, 2_000 + attempt * 1_000));
        }
      }
    };
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }).requestIdleCallback;
    const cic = (window as unknown as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
    let timer = 0;
    let idleHandle = 0;
    if (ric) {
      idleHandle = ric(() => { void probe(); }, { timeout: 3000 });
    } else {
      timer = window.setTimeout(() => { void probe(); }, 1500);
    }
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      if (idleHandle && cic) cic(idleHandle);
    };
  }, []);

  // Runtime probe of the backend's EDIT_MODE_ENABLED flag. The whole edit
  // surface (Edit toggle, editable properties, New Project, undo/redo UI)
  // gates on the store's editModeAvailable instead of a compile-time constant,
  // so a backend with editing on immediately lights the UI up and the two
  // sides can never disagree (ADR 003 phased flip).
  useEffect(() => {
    if (BROWSER_ONLY) return;
    let cancelled = false;
    void import('./services/api').then(({ getEditState }) =>
      getEditState()
        .then((s) => {
          if (!cancelled) {
            useStore.getState().setEditModeAvailable(Boolean(s.edit_mode_enabled));
            useStore.setState({ modelDirty: Boolean(s.dirty) });
          }
        })
        .catch(() => {
          /* backend unreachable - edit surface stays hidden */
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Data-loss guard (B7): warn before the tab closes while the working copy
  // has unsaved edits. The browser shows its own generic message; we only
  // need to flag the event.
  useEffect(() => {
    if (BROWSER_ONLY) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useStore.getState().modelDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Model-sync stream for incremental edits and version contract updates.
  useEffect(() => {
    if (!modelLoaded || BROWSER_ONLY) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    const wsUrl = backendWsUrl('/api/ifc/sync/ws');

    const handleMessage = (event: MessageEvent<string>) => {
      let msg: ModelSyncEvent;
      try {
        msg = JSON.parse(event.data) as ModelSyncEvent;
      } catch {
        return;
      }

      const state = useStore.getState();
      const payload = msg.payload as {
        bootstrap?: boolean;
        message?: string;
        updated_elements?: ElementSummary[];
        stats_delta?: Record<string, number>;
      };

      // viewer_command events are presentation-only relays of CLI / MCP
      // commands (select, isolate, camera, snapshot, ...). Staleness is
      // harmless and commands sent while no model is loaded must still
      // reach the executor, so dispatch BEFORE the stale-fingerprint
      // filter and never run the contract write below for these events.
      if (msg.type === 'viewer_command') {
        void executeViewerCommand(msg.payload as unknown as ViewerCommandPayload);
        return;
      }

      // readiness_changed events fire BEFORE the model contract
      // is set (model_version=0, fingerprint=""). They don't touch the
      // contract; route them straight to setReadiness so the chip flips
      // without polling.
      if (msg.type === 'readiness_changed') {
        const snap = readinessFromSyncEvent(msg.payload);
        if (snap !== null) {
          state.setReadiness(snap);
        }
        return;
      }

      // Pending-edit events describe a sandbox whose fingerprint does NOT
      // match the live model on purpose. Let them through the stale-version
      // filter so the diff panel can render even though `model_fingerprint`
      // on the envelope is the sandbox's hash, not ours.
      const isPendingEvent =
        msg.type === 'pending_edit' ||
        msg.type === 'pending_applied' ||
        msg.type === 'pending_discarded';

      // Operation-layer tier events are serialized under the backend edit
      // lock and carry the authoritative POST-edit contract - they are how
      // this client learns the new fingerprint (the op's HTTP response races
      // this event; whichever lands first updates the contract, the other is
      // a no-op). Filtering them by the pre-edit fingerprint would drop the
      // very event describing the edit. rebuild_started is in this set for
      // the same reason: a structural op's only broadcast is this event, and
      // it must both update the contract and trigger the geometry reload.
      const isOperationEvent =
        msg.type === 'metadata_changed' ||
        msg.type === 'model_refresh' ||
        msg.type === 'rebuild_started';

      if (
        !isPendingEvent &&
        !isOperationEvent &&
        state.modelFingerprint &&
        msg.model_fingerprint &&
        msg.model_fingerprint !== state.modelFingerprint &&
        !(payload.bootstrap && !state.modelLoaded)
      ) {
        return;
      }

      if (!isPendingEvent) {
        state.setModelContract({
          model_version: msg.model_version,
          model_fingerprint: msg.model_fingerprint,
          edit_id: msg.edit_id,
        });
      }

      if (msg.type === 'pending_edit') {
        const envelope = msg.payload as unknown as PendingEditEnvelope;
        if (envelope && envelope.edit_id) {
          state.upsertPendingEdit(envelope);
          state.logActivity({
            kind: 'edit',
            summary: `Pending edit proposed: ${envelope.summary || envelope.edit_id.slice(0, 8)}`,
            detail: Object.entries(envelope.counts || {})
              .map(([k, v]) => `${k}=${v}`)
              .join(' '),
          });
        }
      } else if (msg.type === 'pending_applied') {
        if (msg.edit_id) state.removePendingEdit(msg.edit_id);
        state.setModelContract({
          model_version: msg.model_version,
          model_fingerprint: msg.model_fingerprint,
          edit_id: msg.edit_id,
        });
      } else if (msg.type === 'pending_discarded') {
        if (msg.edit_id) state.removePendingEdit(msg.edit_id);
      } else if (msg.type === 'metadata_patch') {
        if (payload.updated_elements?.length && state.spatialTree) {
          const updates = new Map<number, string>();
          for (const el of payload.updated_elements) {
            updates.set(el.id, el.name || `Unnamed ${el.ifc_type}`);
          }
          const nextTree = patchTreeNames(state.spatialTree, updates);
          if (nextTree !== state.spatialTree) {
            state.setSpatialTree(nextTree);
          }
        }
        if (state.stats && payload.stats_delta && Object.keys(payload.stats_delta).length > 0) {
          const byType = { ...state.stats.by_type };
          for (const [ifcType, delta] of Object.entries(payload.stats_delta)) {
            byType[ifcType] = Math.max(0, (byType[ifcType] ?? 0) + delta);
          }
          const total = Object.values(byType).reduce((sum, v) => sum + v, 0);
          state.setStats({ ...state.stats, by_type: byType, total_elements: total });
        }
      } else if (msg.type === 'metadata_changed') {
        // An applied operation (human direct edit, op-layer undo/redo, or the
        // legacy undo route). The follow-up metadata_patch event carries the
        // tree-name updates; here we invalidate stale detail caches and log.
        const op = msg.payload as unknown as {
          changed_ids?: number[];
          description?: string;
          operation?: string;
          actor?: string;
        };
        if (op.changed_ids?.length) {
          state.invalidateElementDetails(op.changed_ids);
        }
        state.logActivity({
          kind: 'edit',
          summary: op.description || `Applied ${op.operation ?? 'edit'}`,
          detail: op.actor ? `actor: ${op.actor}` : '',
        });
        state.refreshEditState();
      } else if (msg.type === 'edit_rejected') {
        state.logActivity({
          kind: 'error',
          summary: 'Edit rejected',
          detail: payload.message,
        });
      } else if (msg.type === 'rebuild_started' || msg.type === 'model_refresh') {
        // A structural change landed (wall created, element deleted, sandbox
        // geometry apply, rollback). Correct-first display path: soft-reload
        // the edited model - debounced, camera-preserving, and WITHOUT
        // re-uploading (see modelRefresh.ts). Incremental frag deltas replace
        // this for touched-products-only updates when A5 lands.
        const why =
          (msg.payload as { reason?: string; description?: string }).description ||
          (msg.payload as { reason?: string }).reason ||
          'structural edit';
        state.logActivity({ kind: 'edit', summary: `Structural change: ${why}` });
        state.refreshEditState();
        void import('./services/ifc/modelRefresh').then((m) =>
          m.requestModelRefresh(why),
        );
      } else if (msg.type === 'rebuild_ready') {
        state.logActivity({ kind: 'info', summary: 'Background rebuild ready' });
      } else if (msg.type === 'ifc_patch') {
        // Typed patch protocol for the AI-native engine.
        const patches = (msg.payload.patches ?? []) as IfcPatch[];
        applyIfcPatchBatch(patches, {
          spatialTree: state.spatialTree,
          onTreeUpdated: (tree) => state.setSpatialTree(tree),
          onActivityLogged: (entry) => state.logActivity(entry),
          onElementsHidden: (ids) => state.addHiddenIds(ids),
        });
      } else if (msg.type === 'native_index_ready') {
        // Metadata index is ready (background parse done).
        const { element_count, storey_count, pset_count, total_ms } = msg.payload as {
          element_count: number; storey_count: number; pset_count: number; total_ms: number;
        };
        state.logActivity({
          kind: 'info',
          summary: `Metadata index ready: ${element_count} elements, ${storey_count} storeys, ${pset_count} psets in ${total_ms} ms. Ask-mode tools now use fast path.`,
        });
        state.setNativeIndexReady({ elementCount: element_count, storeyCount: storey_count, psetCount: pset_count });
      }
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        reconnectAttempt = 0;
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => {
        // The browser emits the concrete connection error. Wait for close so
        // reconnect backoff stays in one place.
      };
      ws.onclose = scheduleReconnect;
    }

    connect();
    // Begin pushing viewer state (camera, selection, visibility) to the
    // backend for the CLI / MCP read path. Idempotent and self-guarded for
    // browser-only builds, so it simply follows this effect's lifecycle.
    viewerStateReporter.start();

    return () => {
      disposed = true;
      viewerStateReporter.stop();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    };
  }, [modelLoaded]);

  const inTabsMode = rightSidebarMode === 'tabs';
  const showStackedRight = !inTabsMode && modelLoaded
    && (propsOpen || chatOpen || activityOpen || viewpointsOpen);
  const showTabsRight = inTabsMode && modelLoaded && rightSidebarOpen;
  const viewerKey = loadStartTs ? `model-${loadStartTs}` : 'model-none';

  return (
    <div className="app-shell">
      <DemoModeBanner />
      <Menubar
        onCameraView={handleCameraView}
        onFitModel={handleFitModel}
        onScreenshot={handleScreenshot}
        onSaveViewpoint={handleSaveViewpoint}
      />
      <Topbar
        onFitModel={handleFitModel}
        onScreenshot={handleScreenshot}
        onCameraView={handleCameraView}
      />
      <EditScopeBanner />

      <div className="app-shell-workspace">
        {modelLoaded && leftSidebarOpen && !rightSidebarExpanded && (
          <Suspense
            fallback={
              /* Reserve the left column's exact box (grid-column 1 +
                 width: var(--w-outliner, 244px)) so the canvas does not
                 shift when the lazy Outliner chunk resolves (CLS ~0). */
              <aside className="outliner-column" aria-hidden />
            }
          >
            <Outliner />
          </Suspense>
        )}

        {modelLoaded && !leftSidebarOpen && !rightSidebarExpanded && (
          <button
            className="sidebar-pulltab sidebar-pulltab-left"
            onClick={() => setLeftSidebarOpen(true)}
            title="Show outliner"
            aria-label="Show outliner"
          >
            <Icon name="panel-left-open" size={16} />
          </button>
        )}

        <div className="viewer-area">
          {/* Desktop-only: OS "Open with" file-association handoff (renders nothing). */}
          <DesktopOpenFileBridge />
          {!modelLoaded && <UploadOverlay />}
          {modelLoaded && (
            <ErrorBoundary label="ViewerPanel">
              <Suspense fallback={null}>
                <ViewerPanel
                  key={viewerKey}
                  onCameraViewRef={cameraViewRef}
                  onFitModelRef={fitModelRef}
                  onScreenshotRef={screenshotRef}
                  onSaveViewpointRef={saveViewpointRef}
                  onRestoreViewpointRef={restoreViewpointRef}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          {modelLoaded && !rightSidebarExpanded && (
            <Suspense fallback={null}>
              <ViewerToolsPanel />
            </Suspense>
          )}
          {modelLoaded && (
            <Suspense fallback={null}>
              <ColourLayerLegend />
            </Suspense>
          )}
        </div>

        {showTabsRight && (
          <Suspense
            fallback={
              /* Reserve the right column's exact box (grid-column 3 +
                 width: var(--w-inspector, 288px), or the wider expanded
                 clamp when expanded) so the canvas does not shift when the
                 lazy RightSidebar chunk resolves (CLS ~0). Mirror the same
                 expanded modifier the real RightSidebar root carries. */
              <div
                className={`right-sidebar ${rightSidebarExpanded ? 'right-sidebar-expanded' : ''}`}
                aria-hidden
              />
            }
          >
            <RightSidebar
              onSaveViewpoint={handleSaveViewpoint}
              onRestoreViewpoint={handleRestoreViewpoint}
            />
          </Suspense>
        )}

        {modelLoaded && inTabsMode && !rightSidebarOpen && !rightSidebarExpanded && (
          <button
            className="sidebar-pulltab sidebar-pulltab-right"
            onClick={() => setRightSidebarOpen(true)}
            title="Show inspector"
            aria-label="Show inspector"
          >
            <Icon name="panel-right-open" size={16} />
          </button>
        )}

        {showStackedRight && (
          <div className="sidebar-right sidebar-right-stacked">
            <Suspense fallback={null}>
              {propsOpen && <PropertiesPanel />}
            {viewpointsOpen && (
              <ViewpointsPanel
                onSaveViewpoint={handleSaveViewpoint}
                onRestoreViewpoint={handleRestoreViewpoint}
              />
            )}
            {activityOpen && <ActivityPanel />}
            {chatOpen && !BROWSER_ONLY && <ChatPanel />}
            </Suspense>
          </div>
        )}
      </div>

      <StatusBar />

      <KeyboardShortcuts
        onCameraView={handleCameraView}
        onFitModel={handleFitModel}
        onScreenshot={handleScreenshot}
        onSaveViewpoint={handleSaveViewpoint}
      />
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            onCameraView={handleCameraView}
            onFitModel={handleFitModel}
            onScreenshot={handleScreenshot}
            onSaveViewpoint={handleSaveViewpoint}
            onRestoreViewpoint={handleRestoreViewpoint}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {pendingEditCount > 0 && (
        <Suspense fallback={null}>
          <DiffPreviewPanel />
        </Suspense>
      )}
      <ToastStack />
      {!BROWSER_ONLY && <AgentManagerPanelWrapper />}
      <Suspense fallback={null}>
        {checkpointPanelOpen && !BROWSER_ONLY && <TimelinePanel />}
        {budgetPanelOpen && !BROWSER_ONLY && <BudgetDashboardPanel />}
        {snippetPanelOpen && !BROWSER_ONLY && <PromptSnippetPanel />}
        {/* Quantity takeoff, IDS, BCF, plugins, statistics, element filter and
            model health all dock into the Tools tab (FeatureLauncherPanel) now,
            not floating windows - see openTool/closeTool in the store. */}
      </Suspense>
    </div>
  );
}
