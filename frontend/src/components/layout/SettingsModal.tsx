import { useEffect, useCallback, useState, useRef } from 'react';

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

  // VS Code-style layout: left nav scrolls/highlights sections in a single
  // scrollable right pane. `activeSection` reflects which section the user
  // last clicked OR is currently scrolled into view of.
  type SectionId = 'appearance' | 'viewer' | 'performance' | 'storage' | 'integrations' | 'ai';
  const [activeSection, setActiveSection] = useState<SectionId>('appearance');
  const scrollPaneRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    appearance: null,
    viewer: null,
    performance: null,
    storage: null,
    integrations: null,
    ai: null,
  });
  const userScrollLockRef = useRef(false); // suppress scroll-spy while click-jumping
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
    if (BROWSER_ONLY) return; // Integrations section absent - no backend.
    if (!mcpData && !mcpLoading) void refreshMcp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (BROWSER_ONLY) return; // User-data-folder card absent - no backend.
    if (!dataPaths && !dataPathsLoading) void refreshDataPaths();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'viewer', label: 'Viewer' },
    { id: 'performance', label: 'Performance' },
    { id: 'storage', label: 'Storage' },
    // Integrations (MCP) and AI need the backend; in the static viewer-only
    // build the 'ai' slot becomes a pointer to the desktop app instead.
    ...(BROWSER_ONLY
      ? [{ id: 'ai', label: 'Desktop app' } as const]
      : [
          { id: 'integrations', label: 'Integrations' } as const,
          { id: 'ai', label: 'AI' } as const,
        ]),
  ];

  const jumpTo = useCallback((id: SectionId) => {
    const target = sectionRefs.current[id];
    const pane = scrollPaneRef.current;
    if (!target || !pane) return;
    setActiveSection(id);
    userScrollLockRef.current = true;
    pane.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
    window.setTimeout(() => { userScrollLockRef.current = false; }, 600);
  }, []);

  // Scroll-spy - highlight the section that's currently top-of-pane.
  useEffect(() => {
    const pane = scrollPaneRef.current;
    if (!pane) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (userScrollLockRef.current) return;
        // Pick the entry closest to the top of the pane that is visible.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          const id = visible[0].target.getAttribute('data-section-id') as SectionId | null;
          if (id) setActiveSection(id);
        }
      },
      { root: pane, rootMargin: '0px 0px -65% 0px', threshold: [0, 0.1, 0.5] },
    );
    for (const id of SECTIONS.map((s) => s.id)) {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="btn-icon" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="settings-vscode-body">
          <nav className="settings-vscode-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-vscode-nav-item${activeSection === s.id ? ' active' : ''}`}
                onClick={() => jumpTo(s.id)}
                type="button"
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-vscode-pane" ref={scrollPaneRef}>
            <section
              ref={(el) => { sectionRefs.current.appearance = el; }}
              data-section-id="appearance"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Appearance</h3>
              <div className="setting-group">
                <label className="setting-label">Theme</label>
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
                <label className="setting-label">Accent colour</label>
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
                  {ACCENT_PRESETS.find((p) => p.id === accentPreset)?.label ?? 'Blue'}, applied live, persisted across sessions.
                </p>
              </div>
            </section>

            <section
              ref={(el) => { sectionRefs.current.viewer = el; }}
              data-section-id="viewer"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Viewer</h3>
              <div className="setting-group">
                <label className="setting-label">Selection focus</label>
                <div className="provider-cards">
                  <button
                    className={`provider-card ${selectionFocusMode === 'off' ? 'selected' : ''}`}
                    onClick={() => setSelectionFocusMode('off')}
                  >
                    <span className="provider-name">Normal</span>
                    <span className="setting-hint" style={{ textAlign: 'center', fontSize: 11 }}>
                      Keep all elements fully opaque.
                    </span>
                  </button>
                  <button
                    className={`provider-card ${selectionFocusMode === 'ghost' ? 'selected' : ''}`}
                    onClick={() => setSelectionFocusMode('ghost')}
                  >
                    <span className="provider-name">Ghost others</span>
                    <span className="setting-hint" style={{ textAlign: 'center', fontSize: 11 }}>
                      Fade the scene while selection/highlight is active.
                    </span>
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
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={gridVisible}
                    onChange={() => toggleGrid()}
                  />
                  Ground grid
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Show the reference grid under the model. Also available on the toolbar.
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={hoverHighlightEnabled}
                    onChange={(e) => setHoverHighlightEnabled(e.target.checked)}
                  />
                  Hover highlight
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Preview-highlight the element under the cursor before you click.
                  Also available on the toolbar.
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={furnishingMerged}
                    onChange={(e) => setFurnishingMerged(e.target.checked)}
                  />
                  Simplify furnishings
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Merge furniture geometry into a single draw call for higher FPS on
                  dense models; turn off to restore per-element detail. Also available
                  on the toolbar.
                </p>
              </div>
            </section>

            <section
              ref={(el) => { sectionRefs.current.performance = el; }}
              data-section-id="performance"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Performance</h3>
              <div className="setting-group">
                <label className="setting-label">Renderer</label>
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
                <p className="setting-hint" style={{ marginTop: 6 }}>
                  Renderer selection applies on the next model load. Current session: WebGL 2.
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label">Startup mode</label>
                <div className="provider-cards">
                  <button
                    className={`provider-card ${startupMode === 'concurrent_fast' ? 'selected' : ''}`}
                    onClick={() => setStartupMode('concurrent_fast')}
                  >
                    <span className="provider-name">Concurrent fast</span>
                    <span className="setting-hint" style={{ textAlign: 'center', fontSize: 11 }}>
                      Geometry first, metadata hydrates in background.
                    </span>
                  </button>
                  <button
                    className={`provider-card ${startupMode === 'full_upfront' ? 'selected' : ''}`}
                    onClick={() => setStartupMode('full_upfront')}
                  >
                    <span className="provider-name">Full upfront</span>
                    <span className="setting-hint" style={{ textAlign: 'center', fontSize: 11 }}>
                      Wait for the full model tree before marking ready.
                    </span>
                  </button>
                </div>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Applies on the next model load.
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label">Graphics profile</label>
                <select
                  className="setting-select"
                  value={graphicsProfile}
                  onChange={(e) => handleGraphicsProfileChange(e.target.value as typeof graphicsProfile)}
                >
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                  <option value="performance">Performance</option>
                </select>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Balanced is the default. Performance trades visual fidelity for
                  speed. Applies on the next model load.
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={frustumCullingEnabled}
                    onChange={(e) => setFrustumCullingEnabled(e.target.checked)}
                  />
                  Frustum culling
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Off by default, so every object stays in the scene and nothing
                  flickers or pops in late when you zoom in and out. Turn it on for
                  very large models to skip drawing geometry outside the view - it
                  only activates automatically once a model is big enough to benefit
                  (1,500+ elements).
                </p>
              </div>

              <div className="setting-group">
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={largeModelLod}
                    onChange={(e) => setLargeModelLod(e.target.checked)}
                  />
                  Fast navigation for large models
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  On by default. While you orbit or pan a large model, shows a
                  lighter decimated copy for smooth motion, then snaps back to the
                  full-detail model the instant the camera stops. Only kicks in on
                  models big enough to need it.
                </p>
              </div>
            </section>

            <section
              ref={(el) => { sectionRefs.current.storage = el; }}
              data-section-id="storage"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Storage</h3>
              {!BROWSER_ONLY && (
              <div className="setting-group">
                <label className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={useServerCache}
                    onChange={(e) => setUseServerCache(e.target.checked)}
                  />
                  Use server-side fragment cache
                </label>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  Enabled by default. Reloading the same IFC reuses the backend's
                  pre-built fragments for a near-instant cache hit. Disable it only
                  when you need to force a fresh sidecar conversion.
                </p>
              </div>
              )}

              <div className="setting-group">
                <label className="setting-label">Browser cache policy</label>
                <select
                  className="setting-select"
                  value={cachePolicy}
                  onChange={(e) => setCachePolicy(e.target.value as typeof cachePolicy)}
                >
                  <option value="balanced">Balanced</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="off">Off</option>
                </select>
                <p className="setting-hint" style={{ marginTop: 4 }}>
                  In-browser IndexedDB cache of parsed geometry. Off (the default)
                  always re-parses; Balanced keeps recently opened models;
                  Aggressive keeps everything it can. Applies on the next model load.
                </p>
              </div>

              {!BROWSER_ONLY && (
              <div className="setting-group">
                <label className="setting-label">
                  Wait for server conversion
                  <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--f-2)' }}>
                    {!useServerCache
                      ? '(server cache off)'
                      : prebuildWaitPrefs.timeoutMs === 0
                        ? '(disabled)'
                        : `${(prebuildWaitPrefs.timeoutMs / 1000).toFixed(1)} s · poll ${prebuildWaitPrefs.pollIntervalMs} ms`}
                  </span>
                </label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  How long the viewer waits for the backend to finish pre-building a
                  model before falling back to a fresh upload, polling for status at
                  the interval below. Lower the timeout on a fast backend; raise it on
                  a slow network. A timeout of 0 always uploads immediately. Has no
                  effect while the server-side fragment cache is disabled.
                </p>
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
                    className="provider-card"
                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                    onClick={resetPrebuildWaitPrefs}
                    title="Restore the default 6 000 ms timeout / 800 ms poll interval"
                  >
                    Reset to defaults
                  </button>
                </div>
              </div>
              )}

              <div className="setting-group">
                <label className="setting-label">
                  Fragment cache
                  {cacheEntries !== null && (
                    <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--f-2)' }}>
                      {cacheEntries === 0
                        ? '(empty)'
                        : `(${cacheEntries} entr${cacheEntries === 1 ? 'y' : 'ies'}${cacheTotalBytes ? ` · ${(cacheTotalBytes / (1024 * 1024)).toFixed(1)} MB` : ''})`}
                    </span>
                  )}
                  {cachePolicy !== 'off' && <PersistenceBadge state={fragmentCachePersisted} />}
                </label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Pre-parsed geometry blobs stored in IndexedDB. Clearing forces a full
                  re-parse on next load but fixes stale-geometry issues after large edits.
                  {cachePolicy !== 'off' && fragmentCachePersisted === 'best-effort' && (
                    <>
                      {' '}The browser may evict the cache under storage pressure - load a
                      model again or visit more often to qualify for persistent storage.
                    </>
                  )}
                  {cachePolicy !== 'off' && fragmentCachePersisted === 'persistent' && (
                    <>{' '}The browser has granted persistent storage - the cache will not be evicted automatically.</>
                  )}
                </p>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="provider-card"
                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                    onClick={clearFragmentCache}
                    disabled={cacheClearing || cacheEntries === 0}
                  >
                    {cacheClearing ? 'Clearing…' : 'Clear fragment cache'}
                  </button>
                </div>
                {cacheClearMsg && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>{cacheClearMsg}</p>
                )}
              </div>

              <div className="setting-group">
                <label className="setting-label">
                  WASM service-worker cache
                  <span style={{ marginLeft: 8, fontWeight: 400, color: swReady ? 'var(--acc-hi)' : 'var(--f-2)' }}>
                    {swReady ? '⚡ active' : '(inactive)'}
                  </span>
                </label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Pre-caches web-ifc WASM and worker files so IFC loading skips network
                  on repeat visits. Clearing unregisters the service worker; it will
                  re-register on the next page reload.
                </p>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="provider-card"
                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                    onClick={clearWasmCache}
                    disabled={wasmCacheClearing || !swReady}
                  >
                    {wasmCacheClearing ? 'Clearing…' : 'Clear WASM cache'}
                  </button>
                </div>
                {wasmCacheClearMsg && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--acc-hi)' }}>{wasmCacheClearMsg}</p>
                )}
              </div>

              {!BROWSER_ONLY && (
              <div className="setting-group">
                <label className="setting-label">
                  User data folder
                  {dataPaths && (
                    <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--f-2)' }}>
                      ({(dataPaths.total_size_bytes / (1024 * 1024)).toFixed(1)} MB total)
                    </span>
                  )}
                </label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Uploads, snapshots, custom agents, prompts and edit history live in this
                  folder so the viewer never writes inside its install directory. Set the
                  <code> IFC_ATLAS_HOME</code> environment variable to choose a different location.
                </p>

                {dataPathsLoading && (
                  <p className="setting-hint" style={{ marginTop: 6 }}>Loading…</p>
                )}
                {dataPathsError && (
                  <p className="setting-hint" style={{ marginTop: 6, color: 'var(--err)' }}>{dataPathsError}</p>
                )}

                {dataPaths && (
                  <>
                    <div style={{ marginTop: 8, display: 'grid', gap: 4, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>
                      <div title={dataPaths.base} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <strong style={{ color: 'var(--f-1)' }}>base:</strong>
                        <code style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{dataPaths.base}</code>
                        <button
                          className="provider-card"
                          style={{ padding: '2px 8px', fontSize: 10 }}
                          onClick={() => handleCopyPath(dataPaths.base)}
                        >Copy</button>
                      </div>
                      {([
                        ['uploads', dataPaths.uploads],
                        ['snapshots', dataPaths.snapshots],
                        ['data', dataPaths.data],
                        ['checkpoints', dataPaths.checkpoints],
                        ['fragments', dataPaths.fragments],
                      ] as const).map(([key, entry]) => (
                        <div key={key} title={entry.path} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <strong style={{ color: 'var(--f-2)', width: 90 }}>{key}:</strong>
                          <span style={{ color: 'var(--f-2)' }}>
                            {entry.entries} entries · {(entry.size_bytes / (1024 * 1024)).toFixed(1)} MB
                          </span>
                          <button
                            className="provider-card"
                            style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 10 }}
                            onClick={() => handleFlushScope(key as CacheScope)}
                            disabled={flushingScope !== null || entry.size_bytes === 0}
                            title={`Delete every file under ${entry.path}`}
                          >
                            {flushingScope === key ? 'Flushing…' : 'Flush'}
                          </button>
                        </div>
                      ))}
                    </div>

                    {isDesktop && (
                      <p className="setting-hint" style={{ marginTop: 8 }}>
                        Open the folder in your file manager by pasting the path above into
                        Explorer / Finder / Nautilus.
                      </p>
                    )}

                    <div style={{ marginTop: 12 }}>
                      <label className="setting-label">
                        Uploads cap: {cacheCapGB.toFixed(2)} GB
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
                      <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                        <button
                          className="provider-card"
                          style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                          onClick={handleApplyCacheCap}
                        >Apply cap</button>
                        <button
                          className="provider-card"
                          style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                          onClick={() => handleFlushScope('all')}
                          disabled={flushingScope !== null}
                          title="Delete every file in the user data folder (uploads, snapshots, data, checkpoints, fragments)"
                        >Clear all caches</button>
                      </div>
                      <p className="setting-hint" style={{ marginTop: 6 }}>
                        The cap applies until the backend restarts. Set the
                        <code> IFC_VIEWER_CACHE_MAX_BYTES</code> environment variable to persist it.
                      </p>
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
              ref={(el) => { sectionRefs.current.integrations = el; }}
              data-section-id="integrations"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Integrations</h3>
              <div className="setting-group">
                <label className="setting-label">MCP servers</label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Model Context Protocol servers extend the chat agent with external tools.
                  Edit <code>mcp_servers.json</code> in your user data folder to configure;
                  click Reload to pick up changes without restarting the backend.
                </p>

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
                <label className="setting-label">IDS validation</label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  Attach a <code>.ids</code> file in chat and run the <strong>IDS Auditor</strong> preset
                  (or type <code>/ids</code>) to get a pass/fail report with sample failing elements.
                </p>
                <p className="setting-hint" style={{ marginTop: 6 }}>
                  Press <kbd>?</kbd> anywhere in the viewer to see the full keyboard-shortcut reference.
                </p>
              </div>
            </section>
            )}

            {BROWSER_ONLY && (
            <section
              ref={(el) => { sectionRefs.current.ai = el; }}
              data-section-id="ai"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">Desktop app</h3>
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
              ref={(el) => { sectionRefs.current.ai = el; }}
              data-section-id="ai"
              className="settings-section settings-vscode-section"
            >
              <h3 className="settings-vscode-section-title">AI</h3>
              <div className="setting-group">
                <label className="setting-label">Models, keys and agents</label>
                <p className="setting-hint" style={{ marginTop: 0 }}>
                  AI providers, API keys, the model catalogue, agents, skills and
                  chat defaults are managed in the Chat Manager so everything about
                  the assistant lives in one place.
                </p>
                <div style={{ marginTop: 6 }}>
                  <button
                    className="provider-card"
                    style={{ padding: '5px 14px', fontSize: 12, fontWeight: 500 }}
                    onClick={() => {
                      setChatManagerInitialSection('settings');
                      setAgentManagerOpen(true);
                      onClose();
                    }}
                  >
                    Open Chat Manager settings
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
