import { useEffect, useCallback, useState, useRef, type ReactNode } from 'react';

import { useStore } from '../../store/useStore';
import {
  listMcpServers,
  reloadMcpServers,
  type McpListResponse,
  getDataPaths,
  flushServerCache,
  updateCacheConfig,
  type DataPathsResponse,
  type CacheScope,
} from '../../services/api';
import { isDesktop } from '../../lib/platform';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { ACCENT_PRESETS, applyAccentPreset } from '../../utils/accentPreset';
import type { RendererMode } from '../../store/useStore';
import {
  getFragmentCacheIDBStats,
  clearFragmentCacheIDB,
  persistedStateLabel,
} from '../../services/viewer/fragmentCacheIDB';
import { unregisterWasmServiceWorker } from '../../services/viewer/swRegistration';
import {
  decideProfileChangeFlow,
  decideProfileTransition,
  formatProfileTransitionNotice,
} from '../../services/viewer/graphicsProfileTransitionHelpers';
import type { ParseProfile } from '../../services/viewer/parseProfiles';
import { buildSettingsNavigation, type SettingsSectionId } from './settingsCatalog';

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  // AI provider configuration lives in Chat Manager → Settings (moved
  // 2026-05-18); the AI section here is a pointer card only. Sections:
  // Appearance (theme/accent), Viewer (interaction + scene toggles),
  // Performance (renderer/profile/startup/culling), Storage (every cache
  // + the user data folder), Integrations (MCP/IDS), AI (pointer).

  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const accentPreset = useStore((s) => s.accentPreset);
  const setAccentPreset = useStore((s) => s.setAccentPreset);

  const startupMode = useStore((s) => s.startupMode);
  const cachePolicy = useStore((s) => s.cachePolicy);
  const useServerCache = useStore((s) => s.useServerCache);
  const setUseServerCache = useStore((s) => s.setUseServerCache);
  const frustumCullingEnabled = useStore((s) => s.frustumCullingEnabled);
  const setFrustumCullingEnabled = useStore((s) => s.setFrustumCullingEnabled);
  const largeModelLod = useStore((s) => s.largeModelLod);
  const setLargeModelLod = useStore((s) => s.setLargeModelLod);
  const graphicsProfile = useStore((s) => s.graphicsProfile);
  const rendererMode = useStore((s) => s.rendererMode);
  const selectionFocusMode = useStore((s) => s.selectionFocusMode);
  const selectionGhostOpacity = useStore((s) => s.selectionGhostOpacity);
  const prebuildWaitPrefs = useStore((s) => s.prebuildWaitPrefs);
  const setStartupMode = useStore((s) => s.setStartupMode);
  const setCachePolicy = useStore((s) => s.setCachePolicy);
  const setGraphicsProfile = useStore((s) => s.setGraphicsProfile);
  const setRendererMode = useStore((s) => s.setRendererMode);
  const setSelectionFocusMode = useStore((s) => s.setSelectionFocusMode);
  const setSelectionGhostOpacity = useStore((s) => s.setSelectionGhostOpacity);
  const setPrebuildWaitTimeoutMs = useStore((s) => s.setPrebuildWaitTimeoutMs);
  const setPrebuildWaitPollIntervalMs = useStore((s) => s.setPrebuildWaitPollIntervalMs);
  const resetPrebuildWaitPrefs = useStore((s) => s.resetPrebuildWaitPrefs);
  const swReady = useStore((s) => s.swReady);
  const setSwReady = useStore((s) => s.setSwReady);
  const fragmentCachePersisted = useStore((s) => s.fragmentCachePersisted);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const addToast = useStore((s) => s.addToast);

  // Viewer scene toggles - same store keys as the Topbar buttons, so the
  // two surfaces can never diverge.
  const gridVisible = useStore((s) => s.gridVisible);
  const toggleGrid = useStore((s) => s.toggleGrid);
  const hoverHighlightEnabled = useStore((s) => s.hoverHighlightEnabled);
  const setHoverHighlightEnabled = useStore((s) => s.setHoverHighlightEnabled);
  const furnishingMerged = useStore((s) => s.furnishingMerged);
  const setFurnishingMerged = useStore((s) => s.setFurnishingMerged);

  // AI pointer card → Chat Manager
  const setAgentManagerOpen = useStore((s) => s.setAgentManagerOpen);
  const setChatManagerInitialSection = useStore((s) => s.setChatManagerInitialSection);

  // A single focused page is shown at a time. This keeps advanced processing
  // controls out of the way until the user deliberately opens them.
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('appearance');
  const scrollPaneRef = useRef<HTMLDivElement | null>(null);
  const [mcpData, setMcpData] = useState<McpListResponse | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  // Renderer capability detection
  const [webgl2Support, setWebgl2Support] = useState<boolean | null>(null);
  const [webgpuSupport, setWebgpuSupport] = useState<boolean | null>(null);
  const capDetectedRef = useRef(false);

  // Fragment cache management
  const [cacheEntries, setCacheEntries] = useState<number | null>(null);
  const [cacheTotalBytes, setCacheTotalBytes] = useState<number | null>(null);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheClearMsg, setCacheClearMsg] = useState('');

  // WASM SW cache management
  const [wasmCacheClearing, setWasmCacheClearing] = useState(false);
  const [wasmCacheClearMsg, setWasmCacheClearMsg] = useState('');

  // Storage panel - backend data paths + cache cap
  const [dataPaths, setDataPaths] = useState<DataPathsResponse | null>(null);
  const [dataPathsLoading, setDataPathsLoading] = useState(false);
  const [dataPathsError, setDataPathsError] = useState<string | null>(null);
  const [cacheCapGB, setCacheCapGB] = useState<number>(2);
  const [flushingScope, setFlushingScope] = useState<CacheScope | null>(null);
  const [flushMsg, setFlushMsg] = useState('');

  const refreshMcp = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const data = await listMcpServers();
      setMcpData(data);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Failed to fetch MCP servers');
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const handleMcpReload = useCallback(async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      await reloadMcpServers();
      const data = await listMcpServers();
      setMcpData(data);
    } catch (e) {
      setMcpError(e instanceof Error ? e.message : 'Failed to reload MCP servers');
    } finally {
      setMcpLoading(false);
    }
  }, []);

  // All sections are mounted at once; load lazily on first open.
  useEffect(() => {
    if (BROWSER_ONLY || activeSection !== 'integrations') return;
    if (!mcpData && !mcpLoading) void refreshMcp();
  }, [activeSection, mcpData, mcpLoading, refreshMcp]);

  const handleAccentPreset = useCallback((id: string) => {
    setAccentPreset(id);
    applyAccentPreset(id);
  }, [setAccentPreset]);

  // Confirm modal for parse-time profile changes.
  // When `decideProfileChangeFlow` returns `confirm`, hold the
  // change behind a Yes/No modal instead of silently saving + toasting. The
  // modal's copy comes from the same pure helper so the toast / modal split
  // stays in lock-step with the underlying decision matrix.
  const [pendingProfileChange, setPendingProfileChange] = useState<{
    next: typeof graphicsProfile;
    title: string;
    body: string;
  } | null>(null);

  const applyProfileChange = useCallback(
    (next: typeof graphicsProfile) => {
      const plan = decideProfileTransition({
        prev: graphicsProfile as ParseProfile,
        next: next as ParseProfile,
        modelLoaded,
      });
      setGraphicsProfile(next);
      const notice = formatProfileTransitionNotice(plan, next as ParseProfile);
      if (notice.kind && notice.message) {
        addToast(notice.message, notice.kind);
      }
    },
    [graphicsProfile, modelLoaded, setGraphicsProfile, addToast],
  );

  const handleGraphicsProfileChange = useCallback(
    (next: typeof graphicsProfile) => {
      const plan = decideProfileTransition({
        prev: graphicsProfile as ParseProfile,
        next: next as ParseProfile,
        modelLoaded,
      });
      const flow = decideProfileChangeFlow(plan, next as ParseProfile);
      if (flow.flow === 'confirm' && flow.confirmTitle && flow.confirmBody) {
        // Stash the pending change; the modal renders below and dispatches
        // applyProfileChange / cancel via its two buttons.
        setPendingProfileChange({
          next,
          title: flow.confirmTitle,
          body: flow.confirmBody,
        });
        return;
      }
      // silent / immediate - persist now.
      applyProfileChange(next);
    },
    [graphicsProfile, modelLoaded, applyProfileChange],
  );

  const confirmPendingProfileChange = useCallback(() => {
    if (!pendingProfileChange) return;
    applyProfileChange(pendingProfileChange.next);
    setPendingProfileChange(null);
  }, [pendingProfileChange, applyProfileChange]);

  const cancelPendingProfileChange = useCallback(() => {
    setPendingProfileChange(null);
  }, []);

  // Detect WebGL2 + WebGPU capabilities once on mount.
  useEffect(() => {
    if (capDetectedRef.current) return;
    capDetectedRef.current = true;

    // WebGL2 check
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgl2');
      setWebgl2Support(ctx !== null);
    } catch {
      setWebgl2Support(false);
    }

    // WebGPU check (async)
    if ('gpu' in navigator) {
      (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu
        .requestAdapter()
        .then(a => setWebgpuSupport(a !== null))
        .catch(() => setWebgpuSupport(false));
    } else {
      setWebgpuSupport(false);
    }

    // Count IDB fragment cache entries
    getFragmentCacheIDBStats()
      .then(({ count, totalBytes }) => {
        setCacheEntries(count);
        setCacheTotalBytes(totalBytes);
      })
      .catch(() => { setCacheEntries(0); setCacheTotalBytes(0); });
  }, []);

  const clearFragmentCache = useCallback(async () => {
    setCacheClearing(true);
    setCacheClearMsg('');
    try {
      await clearFragmentCacheIDB();
      setCacheEntries(0);
      setCacheTotalBytes(0);
      setCacheClearMsg('Cache cleared. Next load will re-parse the IFC file.');
    } catch (e) {
      setCacheClearMsg(e instanceof Error ? e.message : 'Failed to clear cache');
    } finally {
      setCacheClearing(false);
    }
  }, []);

  const clearWasmCache = useCallback(async () => {
    setWasmCacheClearing(true);
    setWasmCacheClearMsg('');
    try {
      const removed = await unregisterWasmServiceWorker();
      setSwReady(false);
      setWasmCacheClearMsg(
        removed
          ? 'WASM cache removed. Reload the page to re-register the service worker.'
          : 'No WASM service worker was active.'
      );
    } catch (e) {
      setWasmCacheClearMsg(e instanceof Error ? e.message : 'Failed to clear WASM cache');
    } finally {
      setWasmCacheClearing(false);
    }
  }, [setSwReady]);

  const refreshDataPaths = useCallback(async () => {
    setDataPathsLoading(true);
    setDataPathsError(null);
    try {
      const data = await getDataPaths();
      setDataPaths(data);
      setCacheCapGB(Math.max(0.25, data.cache_max_bytes / (1024 * 1024 * 1024)));
    } catch (e) {
      setDataPathsError(e instanceof Error ? e.message : 'Failed to load data paths');
    } finally {
      setDataPathsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (BROWSER_ONLY || activeSection !== 'storage') return;
    if (!dataPaths && !dataPathsLoading) void refreshDataPaths();
  }, [activeSection, dataPaths, dataPathsLoading, refreshDataPaths]);

  const handleFlushScope = useCallback(async (scope: CacheScope) => {
    setFlushingScope(scope);
    setFlushMsg('');
    try {
      const result = await flushServerCache(scope);
      setFlushMsg(
        `Freed ${(result.bytes_freed / (1024 * 1024)).toFixed(1)} MB across ${result.files_removed} files (${scope}).`,
      );
      await refreshDataPaths();
    } catch (e) {
      setFlushMsg(e instanceof Error ? e.message : 'Flush failed');
    } finally {
      setFlushingScope(null);
    }
  }, [refreshDataPaths]);

  const handleApplyCacheCap = useCallback(async () => {
    setFlushMsg('');
    try {
      const result = await updateCacheConfig(Math.round(cacheCapGB * 1024 * 1024 * 1024));
      setFlushMsg(
        `Cap set to ${(result.cache_max_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB. ${result.bytes_freed > 0 ? `Evicted ${result.files_removed} files (${(result.bytes_freed / (1024 * 1024)).toFixed(1)} MB).` : 'No eviction needed.'}`,
      );
      await refreshDataPaths();
    } catch (e) {
      setFlushMsg(e instanceof Error ? e.message : 'Failed to set cap');
    }
  }, [cacheCapGB, refreshDataPaths]);

  const handleCopyPath = useCallback((path: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(path);
      addToast('Path copied to clipboard', 'success');
    }
  }, [addToast]);

  const NAV_GROUPS = buildSettingsNavigation(BROWSER_ONLY);

  const jumpTo = useCallback((id: SettingsSectionId) => {
    setActiveSection(id);
    scrollPaneRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Workspace settings</h2>
            <p className="settings-modal-subtitle">Tune IFC Atlas for this device. Changes are saved automatically.</p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close settings">
            &times;
          </button>
        </div>

        <div className="settings-vscode-body">
          <nav className="settings-vscode-nav" aria-label="Settings sections">
            {NAV_GROUPS.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-group-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-vscode-nav-item${activeSection === item.id ? ' active' : ''}`}
                    onClick={() => jumpTo(item.id)}
                    type="button"
                    aria-current={activeSection === item.id ? 'page' : undefined}
                  >
                    <span>{item.label}</span>
                    <small>{item.description}</small>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="settings-vscode-pane" ref={scrollPaneRef}>
            <section
              data-section-id="appearance"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'appearance'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">Workspace</div>
                  <h3 className="settings-vscode-section-title">General & appearance</h3>
                  <p>Choose a comfortable visual foundation for long model-review sessions.</p>
                </div>
                <button
                  type="button"
                  className="settings-reset-btn"
                  onClick={() => {
                    setTheme('dark');
                    handleAccentPreset('blue');
                  }}
                >
                  Reset section
                </button>
              </div>
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Theme
                  <InfoHint text="Dark is easier on the eyes for long model-review sessions; Light suits bright rooms. Applied instantly and remembered on this device." />
                </label>
                <div className="provider-cards">
                  <button
                    className={`provider-card ${theme === 'dark' ? 'selected' : ''}`}
                    onClick={() => setTheme('dark')}
                  >
                    <span className="provider-name">Dark</span>
                  </button>
                  <button
                    className={`provider-card ${theme === 'light' ? 'selected' : ''}`}
                    onClick={() => setTheme('light')}
                  >
                    <span className="provider-name">Light</span>
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Accent colour
                  <InfoHint text="Sets the highlight colour used across buttons, selection and links. Applied live and persisted across sessions on this device." />
                </label>
                <div className="accent-presets">
                  {ACCENT_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={`accent-chip ${accentPreset === p.id ? 'active' : ''}`}
                      style={{ '--chip-color': p.acc } as React.CSSProperties}
                      onClick={() => handleAccentPreset(p.id)}
                      title={p.label}
                      aria-label={`Accent: ${p.label}`}
                    />
                  ))}
                </div>
                <p className="setting-hint">
                  {ACCENT_PRESETS.find((p) => p.id === accentPreset)?.label ?? 'Blue'}
                </p>
              </div>
            </section>

            <section
              data-section-id="viewer"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'viewer'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">Workspace</div>
                  <h3 className="settings-vscode-section-title">Viewer</h3>
                  <p>Control how selection, context and scene helpers behave.</p>
                </div>
                <button
                  type="button"
                  className="settings-reset-btn"
                  onClick={() => {
                    setSelectionFocusMode('off');
                    setSelectionGhostOpacity(0.22);
                    if (!gridVisible) toggleGrid();
                    setHoverHighlightEnabled(false);
                    setFurnishingMerged(false);
                  }}
                >
                  Reset section
                </button>
              </div>
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Selection focus
                  <InfoHint text={<><strong>Normal</strong> keeps every element fully opaque. <strong>Ghost others</strong> fades the rest of the scene to the opacity below while a selection or highlight is active, so the focused element stands out.</>} />
                </label>
                <div className="provider-cards">
                  <button
                    className={`provider-card ${selectionFocusMode === 'off' ? 'selected' : ''}`}
                    onClick={() => setSelectionFocusMode('off')}
                  >
                    <span className="provider-name">Normal</span>
                  </button>
                  <button
                    className={`provider-card ${selectionFocusMode === 'ghost' ? 'selected' : ''}`}
                    onClick={() => setSelectionFocusMode('ghost')}
                  >
                    <span className="provider-name">Ghost others</span>
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  Ghost opacity: {Math.round(selectionGhostOpacity * 100)}%
                </label>
                <input
                  type="range"
                  min="0.05"
                  max="0.8"
                  step="0.01"
                  value={selectionGhostOpacity}
                  onChange={(e) => setSelectionGhostOpacity(parseFloat(e.target.value))}
                  className="setting-range"
                />
                <div className="range-labels">
                  <span>More transparent</span>
                  <span>Less transparent</span>
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={gridVisible}
                      onChange={() => toggleGrid()}
                    />
                    Ground grid
                  </label>
                  <InfoHint text="Show the reference grid under the model. Also available on the toolbar." />
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={hoverHighlightEnabled}
                      onChange={(e) => setHoverHighlightEnabled(e.target.checked)}
                    />
                    Hover highlight
                  </label>
                  <InfoHint text="Preview-highlight the element under the cursor before you click. Also available on the toolbar." />
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={furnishingMerged}
                      onChange={(e) => setFurnishingMerged(e.target.checked)}
                    />
                    Simplify furnishings
                  </label>
                  <InfoHint text="Merge furniture geometry into a single draw call for higher FPS on dense models; turn off to restore per-element detail. Also available on the toolbar." />
                </div>
              </div>
            </section>

            <section
              data-section-id="performance"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'performance'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">IFC model</div>
                  <h3 className="settings-vscode-section-title">Processing & performance</h3>
                  <p>Balance first render, navigation quality and memory use. Most users should keep the defaults.</p>
                </div>
                <button
                  type="button"
                  className="settings-reset-btn"
                  onClick={() => {
                    setRendererMode('auto');
                    setStartupMode('concurrent_fast');
                    handleGraphicsProfileChange('balanced');
                    setFrustumCullingEnabled(false);
                    setLargeModelLod(false);
                  }}
                >
                  Reset section
                </button>
              </div>
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Renderer
                  <InfoHint text={<>Chooses the graphics backend. <strong>Auto</strong> picks the best available. <strong>WebGL 2</strong> is the maximum-compatibility choice; <strong>WebGPU</strong> is a GPU-native pipeline that needs Chrome/Edge 113+. Applies on the next model load; the current session runs WebGL 2.</>} />
                </label>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  {([
                    { id: 'auto', label: 'Auto', hint: 'Use the best available renderer' },
                    { id: 'webgl', label: 'WebGL 2', hint: 'Force WebGL 2 (maximum compatibility)' },
                    { id: 'webgpu', label: 'WebGPU', hint: 'GPU-native pipeline - requires Chrome 113+ / Edge 113+' },
                  ] as Array<{ id: RendererMode; label: string; hint: string }>).map((m) => {
                    const unavailable = m.id === 'webgpu' && webgpuSupport === false;
                    return (
                      <button
                        key={m.id}
                        className={`provider-card${rendererMode === m.id ? ' selected' : ''}${unavailable ? ' disabled' : ''}`}
                        style={{ flex: '1 1 0', minWidth: 90, opacity: unavailable ? 0.45 : 1 }}
                        onClick={() => !unavailable && setRendererMode(m.id)}
                        title={unavailable ? 'WebGPU not available in this browser' : m.hint}
                        disabled={unavailable}
                      >
                        <span className="provider-name">{m.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <CapBadge label="WebGL 2" state={webgl2Support} />
                  <CapBadge label="WebGPU" state={webgpuSupport} />
                  <CapBadge label="Clip Edge Compute" state={webgpuSupport} />
                </div>
                {rendererMode === 'webgpu' && webgpuSupport && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>
                    Main rendering uses WebGL 2 for now; native WebGPU rendering is coming in a future release.
                  </p>
                )}
                {webgpuSupport && (
                  <p className="setting-hint" style={{ marginTop: 6 }}>
                    WebGPU compute is active: clip-section edge generation runs on the GPU automatically.
                  </p>
                )}
              </div>

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Startup mode
                  <InfoHint text={<><strong>Concurrent fast</strong> paints geometry first and hydrates the model tree/metadata in the background. <strong>Full upfront</strong> waits for the complete tree before marking the model ready. Applies on the next model load.</>} />
                </label>
                <div className="provider-cards">
                  <button
                    className={`provider-card ${startupMode === 'concurrent_fast' ? 'selected' : ''}`}
                    onClick={() => setStartupMode('concurrent_fast')}
                  >
                    <span className="provider-name">Concurrent fast</span>
                  </button>
                  <button
                    className={`provider-card ${startupMode === 'full_upfront' ? 'selected' : ''}`}
                    onClick={() => setStartupMode('full_upfront')}
                  >
                    <span className="provider-name">Full upfront</span>
                  </button>
                </div>
              </div>

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Graphics profile
                  <InfoHint text={<><strong>Balanced</strong> (default) is the best mix for most models. <strong>Quality</strong> favours visual fidelity; <strong>Performance</strong> trades fidelity for speed. Applies on the next model load.</>} />
                </label>
                <select
                  className="setting-select"
                  value={graphicsProfile}
                  onChange={(e) => handleGraphicsProfileChange(e.target.value as typeof graphicsProfile)}
                >
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                  <option value="performance">Performance</option>
                </select>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={frustumCullingEnabled}
                      onChange={(e) => setFrustumCullingEnabled(e.target.checked)}
                    />
                    Spatial visibility culling
                  </label>
                  <InfoHint text="Off by default. For very large models it hides geometry outside the view to save GPU, revealing tiles during navigation and hiding them only after the camera settles. Leave off for the most stable picture, where nothing pops in or out." />
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={largeModelLod}
                      onChange={(e) => setLargeModelLod(e.target.checked)}
                    />
                    Fast navigation for large models
                  </label>
                  <InfoHint text="Experimental and off by default. While you orbit or pan a large model it swaps in a lighter decimated copy, then restores full detail when the camera stops. This can visibly pop, and it is suspended while selection, filtering, colours or transparency need the exact model." />
                </div>
              </div>
            </section>

            <section
              data-section-id="storage"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'storage'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">IFC model</div>
                  <h3 className="settings-vscode-section-title">Privacy & data</h3>
                  <p>Review what is stored locally and remove cached model data when needed.</p>
                </div>
                <button
                  type="button"
                  className="settings-reset-btn"
                  onClick={() => {
                    setUseServerCache(true);
                    setCachePolicy('off');
                    resetPrebuildWaitPrefs();
                  }}
                >
                  Reset section
                </button>
              </div>
              {!BROWSER_ONLY && (
              <div className="setting-group">
                <div className="setting-row">
                  <label className="setting-check">
                    <input
                      type="checkbox"
                      checked={useServerCache}
                      onChange={(e) => setUseServerCache(e.target.checked)}
                    />
                    Use server-side fragment cache
                  </label>
                  <InfoHint text="Enabled by default. Reloading the same IFC reuses the backend's pre-built fragments for a near-instant cache hit. Disable it only when you need to force a fresh sidecar conversion." />
                </div>
              </div>
              )}

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Browser cache policy
                  <InfoHint text={<>In-browser IndexedDB cache of parsed geometry. <strong>Balanced</strong> (default) keeps recently opened, version-compatible models; <strong>Aggressive</strong> keeps everything it can; <strong>Off</strong> always re-parses. Applies on the next model load.</>} />
                </label>
                <select
                  className="setting-select"
                  value={cachePolicy}
                  onChange={(e) => setCachePolicy(e.target.value as typeof cachePolicy)}
                >
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="off">Off</option>
                </select>
              </div>

              {!BROWSER_ONLY && (
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Wait for server conversion
                  <InfoHint text="How long the viewer waits for the backend to finish pre-building a model before falling back to a fresh upload, polling for status at the interval below. Lower the timeout on a fast backend; raise it on a slow network. A timeout of 0 always uploads immediately. Has no effect while the server-side fragment cache is disabled." />
                  <span style={{ marginLeft: 4, fontWeight: 400, color: 'var(--f-2)', textTransform: 'none', letterSpacing: 0 }}>
                    {!useServerCache
                      ? '(server cache off)'
                      : prebuildWaitPrefs.timeoutMs === 0
                        ? '(disabled)'
                        : `${(prebuildWaitPrefs.timeoutMs / 1000).toFixed(1)} s · poll ${prebuildWaitPrefs.pollIntervalMs} ms`}
                  </span>
                </label>
                <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                  <div>
                    <label className="setting-hint" style={{ display: 'block', marginBottom: 2 }}>
                      Timeout (ms): {prebuildWaitPrefs.timeoutMs}
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={30_000}
                      step={500}
                      value={prebuildWaitPrefs.timeoutMs}
                      onChange={(e) => setPrebuildWaitTimeoutMs(parseInt(e.target.value, 10))}
                      className="setting-range"
                      disabled={!useServerCache}
                      aria-label="Server pre-build wait timeout in milliseconds"
                    />
                  </div>
                  <div>
                    <label className="setting-hint" style={{ display: 'block', marginBottom: 2 }}>
                      Poll interval (ms): {prebuildWaitPrefs.pollIntervalMs}
                    </label>
                    <input
                      type="range"
                      min={100}
                      max={Math.max(100, prebuildWaitPrefs.timeoutMs || 30_000)}
                      step={100}
                      value={prebuildWaitPrefs.pollIntervalMs}
                      onChange={(e) => setPrebuildWaitPollIntervalMs(parseInt(e.target.value, 10))}
                      className="setting-range"
                      disabled={!useServerCache || prebuildWaitPrefs.timeoutMs === 0}
                      aria-label="Server pre-build status poll interval in milliseconds"
                    />
                  </div>
                </div>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="settings-btn compact"
                    onClick={resetPrebuildWaitPrefs}
                    title="Restore the default 6 000 ms timeout / 800 ms poll interval"
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>
              )}

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Fragment cache
                  <InfoHint text={<>Pre-parsed geometry blobs stored in your browser's IndexedDB. Clearing forces a full re-parse on the next load but fixes stale-geometry issues after large edits.{cachePolicy !== 'off' && fragmentCachePersisted === 'best-effort' && ' The browser may evict this cache under storage pressure - load a model again or visit more often to qualify for persistent storage.'}{cachePolicy !== 'off' && fragmentCachePersisted === 'persistent' && ' The browser has granted persistent storage - this cache will not be evicted automatically.'}</>} />
                  {cacheEntries !== null && (
                    <span style={{ marginLeft: 4, fontWeight: 400, color: 'var(--f-2)', textTransform: 'none', letterSpacing: 0 }}>
                      {cacheEntries === 0
                        ? '(empty)'
                        : `${cacheEntries} entr${cacheEntries === 1 ? 'y' : 'ies'}${cacheTotalBytes ? ` · ${(cacheTotalBytes / (1024 * 1024)).toFixed(1)} MB` : ''}`}
                    </span>
                  )}
                  {cachePolicy !== 'off' && <PersistenceBadge state={fragmentCachePersisted} />}
                </label>
                <div style={{ marginTop: 2 }}>
                  <button
                    className="settings-btn danger"
                    onClick={clearFragmentCache}
                    disabled={cacheClearing || cacheEntries === 0}
                  >
                    {cacheClearing ? 'Clearing…' : 'Clear parsed-geometry cache'}
                  </button>
                </div>
                {cacheClearMsg && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>{cacheClearMsg}</p>
                )}
              </div>

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  WASM engine cache
                  <InfoHint text="Pre-caches the web-ifc WASM and worker files via a service worker so IFC loading skips the network on repeat visits. Clearing unregisters the service worker; it re-registers on the next page reload." />
                  <span style={{ marginLeft: 4, fontWeight: 400, color: swReady ? 'var(--acc-hi)' : 'var(--f-2)', textTransform: 'none', letterSpacing: 0 }}>
                    {swReady ? '⚡ active' : '(inactive)'}
                  </span>
                </label>
                <div style={{ marginTop: 2 }}>
                  <button
                    className="settings-btn danger"
                    onClick={clearWasmCache}
                    disabled={wasmCacheClearing || !swReady}
                  >
                    {wasmCacheClearing ? 'Clearing…' : 'Clear WASM engine cache'}
                  </button>
                </div>
                {wasmCacheClearMsg && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>{wasmCacheClearMsg}</p>
                )}
              </div>

              {!BROWSER_ONLY && (
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  Local data &amp; caches
                  <InfoHint text={<>Everything IFC Atlas stores on this machine lives in one folder so it never writes inside its install directory. Each row below shows how much space it uses and clears just that data. Set the <code>IFC_ATLAS_HOME</code> environment variable to move the folder.</>} />
                  {dataPaths && (
                    <span style={{ marginLeft: 4, fontWeight: 400, color: 'var(--f-2)', textTransform: 'none', letterSpacing: 0 }}>
                      {(dataPaths.total_size_bytes / (1024 * 1024)).toFixed(1)} MB total
                    </span>
                  )}
                </label>

                {dataPathsLoading && (
                  <p className="setting-hint" style={{ marginTop: 6 }}>Loading…</p>
                )}
                {dataPathsError && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--err)' }}>{dataPathsError}</p>
                )}

                {dataPaths && (
                  <>
                    <div className="data-scope-path" title={dataPaths.base}>
                      <code>{dataPaths.base}</code>
                      <button
                        className="settings-btn compact"
                        onClick={() => handleCopyPath(dataPaths.base)}
                      >Copy path</button>
                    </div>

                    <div className="data-scope-list">
                      {([
                        ['uploads', 'Uploaded IFC files', 'The original IFC files you have opened.', dataPaths.uploads],
                        ['snapshots', 'Snapshots', 'Saved viewpoints and exported snapshots.', dataPaths.snapshots],
                        ['data', 'App data', 'Custom agents, prompts and saved app state.', dataPaths.data],
                        ['checkpoints', 'Edit history', 'Undo checkpoints created while editing models.', dataPaths.checkpoints],
                        ['fragments', 'Pre-built fragments', 'Backend geometry cache that makes reopening a model near-instant.', dataPaths.fragments],
                      ] as const).map(([key, label, desc, entry]) => (
                        <div key={key} className="data-scope-row" title={entry.path}>
                          <div className="data-scope-meta">
                            <span className="data-scope-name">
                              {label}
                              <InfoHint text={desc} />
                            </span>
                            <span className="data-scope-sub">
                              {entry.entries} item{entry.entries === 1 ? '' : 's'} · {(entry.size_bytes / (1024 * 1024)).toFixed(1)} MB
                            </span>
                          </div>
                          <button
                            className="settings-btn danger"
                            onClick={() => handleFlushScope(key as CacheScope)}
                            disabled={flushingScope !== null || entry.size_bytes === 0}
                            title={`Delete every file under ${entry.path}`}
                          >
                            {flushingScope === key ? 'Clearing…' : `Clear ${label.toLowerCase()}`}
                          </button>
                        </div>
                      ))}
                    </div>

                    {isDesktop && (
                      <p className="setting-hint" style={{ marginTop: 8 }}>
                        Open the folder by pasting the path above into Explorer / Finder / Nautilus.
                      </p>
                    )}

                    <div style={{ marginTop: 14 }}>
                      <label className="setting-label setting-label-inline">
                        Uploads size cap: {cacheCapGB.toFixed(2)} GB
                        <InfoHint text={<>The uploads folder is trimmed to this size (oldest files first) once it is exceeded. The cap applies until the backend restarts; set the <code>IFC_VIEWER_CACHE_MAX_BYTES</code> environment variable to make it permanent.</>} />
                      </label>
                      <input
                        type="range"
                        min={0.25}
                        max={20}
                        step={0.25}
                        value={cacheCapGB}
                        onChange={(e) => setCacheCapGB(parseFloat(e.target.value))}
                        className="setting-range"
                        aria-label="Maximum bytes the uploads folder may hold before LRU eviction"
                      />
                      <div className="range-labels">
                        <span>0.25 GB</span>
                        <span>20 GB</span>
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="settings-btn"
                          onClick={handleApplyCacheCap}
                        >Apply size cap</button>
                        <button
                          className="settings-btn danger"
                          onClick={() => handleFlushScope('all')}
                          disabled={flushingScope !== null}
                          title="Delete every file in the local data folder (uploads, snapshots, app data, edit history, fragments)"
                        >{flushingScope === 'all' ? 'Clearing…' : 'Clear all local data'}</button>
                      </div>
                      {flushMsg && (
                        <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>{flushMsg}</p>
                      )}
                    </div>
                  </>
                )}
              </div>
              )}
            </section>

            {!BROWSER_ONLY && (
            <section
              data-section-id="integrations"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'integrations'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">Assistant</div>
                  <h3 className="settings-vscode-section-title">Advanced</h3>
                  <p>External tool servers and validation integrations for experienced users.</p>
                </div>
              </div>
              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  MCP servers
                  <InfoHint text={<>Model Context Protocol servers extend the chat agent with external tools. Edit <code>mcp_servers.json</code> in your user data folder to configure, then click Reload to pick up changes without restarting the backend.</>} />
                </label>

                {mcpError && (
                  <div className="setting-hint" style={{ color: 'var(--err, #e5736a)', marginTop: 8 }}>
                    {mcpError}
                  </div>
                )}

                {mcpData && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <span className="setting-hint" style={{ margin: 0 }}>
                      Source: <strong>{mcpData.source}</strong>
                      {mcpData.source === 'example' && ' (example servers shown - add mcp_servers.json to enable)'}
                      {mcpData.source === 'none' && ' (no config file found)'}
                      {mcpData.source === 'error' && ' (config file could not be parsed)'}
                    </span>
                    <span className="setting-hint" style={{ margin: 0 }}>
                      · {mcpData.servers.length} server{mcpData.servers.length === 1 ? '' : 's'}
                    </span>
                    <span className="setting-hint" style={{ margin: 0 }}>
                      · {mcpData.enabled.length} enabled
                    </span>
                    <button
                      className="btn-icon"
                      style={{ marginLeft: 'auto' }}
                      onClick={handleMcpReload}
                      disabled={mcpLoading}
                      title="Re-read mcp_servers.json"
                    >
                      {mcpLoading ? '…' : 'Reload'}
                    </button>
                  </div>
                )}

                {mcpLoading && !mcpData && (
                  <div className="setting-hint" style={{ marginTop: 8 }}>Loading…</div>
                )}

                {mcpData && mcpData.servers.length === 0 && (
                  <div className="setting-hint" style={{ marginTop: 8 }}>
                    No MCP servers configured. Add an <code>mcp_servers.json</code> file in your
                    user data folder with <code>enabled: true</code> on the servers you want active.
                  </div>
                )}

                {mcpData && mcpData.servers.length > 0 && (
                  <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                    {mcpData.servers.map((s) => {
                      const live = mcpData.source === 'live';
                      return (
                        <div
                          key={s.name}
                          style={{
                            border: '1px solid var(--b-2)',
                            borderRadius: 6,
                            padding: 10,
                            background: 'var(--s-2)',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <strong style={{ fontSize: 13 }}>{s.name}</strong>
                            <span
                              className="chip"
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: s.enabled ? 'var(--acc-dim)' : 'var(--s-4)',
                                color: s.enabled ? 'var(--acc-hi)' : 'var(--f-2)',
                                fontWeight: 600,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                              }}
                            >
                              {s.enabled ? 'Enabled' : live ? 'Disabled' : 'Example'}
                            </span>
                            <span className="setting-hint" style={{ margin: 0, fontSize: 11 }}>
                              transport: {s.transport}
                            </span>
                          </div>
                          {s.description && (
                            <div className="setting-hint" style={{ marginTop: 4 }}>{s.description}</div>
                          )}
                          {s.transport === 'stdio' && s.command && (
                            <div className="setting-hint" style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
                              $ {s.command}{s.args && s.args.length > 0 ? ' ' + s.args.join(' ') : ''}
                            </div>
                          )}
                          {s.transport === 'http' && s.url && (
                            <div className="setting-hint" style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
                              {s.url}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="setting-group">
                <label className="setting-label setting-label-inline">
                  IDS validation
                  <InfoHint text={<>Attach a <code>.ids</code> file in chat and run the <strong>IDS Auditor</strong> preset (or type <code>/ids</code>) to get a pass/fail report with sample failing elements.</>} />
                </label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Press <kbd>?</kbd> anywhere in the viewer to see the full keyboard-shortcut reference.
                </p>
              </div>
            </section>
            )}

            {BROWSER_ONLY && (
            <section
              data-section-id="ai"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'ai'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">Edition</div>
                  <h3 className="settings-vscode-section-title">Desktop features</h3>
                  <p>AI, editing and export are available in the local desktop workspace.</p>
                </div>
              </div>
              <div className="setting-group">
                <label className="setting-label">AI chat, editing and exports</label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  This is the viewer-only web demo - IFC files are parsed locally in
                  your browser and never uploaded anywhere. The AI assistant, model
                  editing, save-as and server-side caching need the desktop app,
                  which runs the full engine on your own machine.
                </p>
              </div>
            </section>
            )}

            {!BROWSER_ONLY && (
            <section
              data-section-id="ai"
              className="settings-section settings-vscode-section"
              hidden={activeSection !== 'ai'}
            >
              <div className="settings-section-heading">
                <div>
                  <div className="settings-section-eyebrow">Assistant</div>
                  <h3 className="settings-vscode-section-title">AI workspace</h3>
                  <p>Configure who the assistant talks to, what it may do and when edits require approval.</p>
                </div>
              </div>
              <div className="setting-group">
                <div className="settings-ai-map" aria-label="AI configuration areas">
                  <div>
                    <strong>Provider & models</strong>
                    <span>Choose OpenAI, Anthropic, OpenRouter or a local endpoint and select the default model.</span>
                  </div>
                  <div>
                    <strong>API keys</strong>
                    <span>Keys are stored by the local backend and are never written into exported IFC files.</span>
                  </div>
                  <div>
                    <strong>Agent behaviour</strong>
                    <span>Choose presets, tool access, context limits and how the assistant reports progress.</span>
                  </div>
                  <div>
                    <strong>Code execution & edits</strong>
                    <span>Review sandbox limits and require approval before semantic or geometry changes are applied.</span>
                  </div>
                </div>
                <p className="setting-hint">
                  These controls live together in Assistant settings so provider credentials and edit permissions are not duplicated across the app.
                </p>
                <div>
                  <button
                    className="btn btn-primary settings-ai-open"
                    onClick={() => {
                      setChatManagerInitialSection('settings');
                      setAgentManagerOpen(true);
                      onClose();
                    }}
                  >
                    Open Assistant settings
                  </button>
                </div>
              </div>
            </section>
            )}
          </div>
        </div>
      </div>
    </div>
    {pendingProfileChange && (
      <div
        className="modal-overlay"
        style={{ zIndex: 1000 }}
        onClick={cancelPendingProfileChange}
      >
        <div
          className="modal-content"
          style={{ maxWidth: 480 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>
              {pendingProfileChange.title}
            </h2>
          </div>
          <div style={{ padding: 'var(--space-4)', lineHeight: 1.5 }}>
            <p style={{ margin: 0, color: 'var(--f-1)' }}>
              {pendingProfileChange.body}
            </p>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              justifyContent: 'flex-end',
              padding: 'var(--space-4)',
              borderTop: '1px solid var(--bg-3)',
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={cancelPendingProfileChange}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={confirmPendingProfileChange}
              autoFocus
            >
              Apply profile
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

/**
 * A small "i" icon that reveals its description in a hover/focus bubble, so the
 * settings page can stay scannable instead of stacking a paragraph under every
 * control. The bubble is position:fixed and placed from the icon's rect, so it
 * is never clipped by the settings scroll pane; it flips above the icon in the
 * lower half of the viewport. Works on touch too (tap toggles).
 */
function InfoHint({ text, label = 'More information' }: { text: ReactNode; label?: string }) {
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const [bubble, setBubble] = useState<{ top: number; left: number; place: 'top' | 'bottom' } | null>(null);

  const open = useCallback(() => {
    const el = iconRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 300;
    const margin = 12;
    const place: 'top' | 'bottom' = r.top > window.innerHeight * 0.5 ? 'top' : 'bottom';
    let left = r.left + r.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    const top = place === 'top' ? r.top - 8 : r.bottom + 8;
    setBubble({ top, left, place });
  }, []);

  const close = useCallback(() => setBubble(null), []);

  return (
    <span className="setting-info-wrap">
      <button
        type="button"
        ref={iconRef}
        className="setting-info-icon"
        aria-label={label}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={(e) => { e.preventDefault(); if (bubble) close(); else open(); }}
      >
        i
      </button>
      {bubble && (
        <span
          role="tooltip"
          className="setting-info-bubble"
          style={{
            position: 'fixed',
            top: bubble.top,
            left: bubble.left,
            width: 300,
            transform: bubble.place === 'top' ? 'translateY(-100%)' : undefined,
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

function CapBadge({ label, state }: { label: string; state: boolean | null }) {
  const color = state === null ? 'var(--f-3)' : state ? '#10b981' : '#6b7280';
  const text = state === null ? 'checking…' : state ? 'available' : 'not available';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
      {label}: {text}
    </span>
  );
}

/** Chip rendered alongside the Fragment-cache header
 *  showing whether `navigator.storage.persist()` has promoted the IDB
 *  cache to "persistent" (survives storage-pressure eviction) or it's
 *  still "best-effort" (browser may evict). */
function PersistenceBadge({
  state,
}: {
  state: import('../../services/viewer/fragmentCacheIDB').PersistedState | null;
}) {
  const { text, tone } = persistedStateLabel(state);
  const color =
    tone === 'good' ? '#10b981' : tone === 'warn' ? '#f59e0b' : 'var(--f-3)';
  return (
    <span
      style={{
        marginLeft: 8,
        padding: '1px 8px',
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color,
        background: 'var(--s-2)',
        border: `1px solid ${color}33`,
      }}
      title={
        state === 'persistent'
          ? 'navigator.storage.persist() granted - cache survives storage-pressure eviction'
          : state === 'best-effort'
            ? 'navigator.storage.persist() denied - browser may evict the cache under pressure'
            : state === 'unavailable'
              ? 'Storage API not exposed in this browser'
              : 'Persistent-storage request not yet made (load a model first)'
      }
    >
      {state === 'persistent' ? '⚡ ' : ''}
      {text}
    </span>
  );
}
