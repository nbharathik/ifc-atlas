import { useCallback } from 'react';

import * as api from '../services/api';
import { useStore } from '../store/useStore';
import { getClientIfcFlag } from '../services/ifc/featureFlags';
import { BROWSER_ONLY } from '../config/featureFlags';
import type { ModelMeta, ProjectInfo } from '../types/ifc';

let uploadGeneration = 0;
let activePersistController: AbortController | null = null;

function beginUploadGeneration(): number {
  uploadGeneration += 1;
  if (activePersistController) {
    activePersistController.abort();
    activePersistController = null;
  }
  return uploadGeneration;
}

function isCurrentUpload(generation: number): boolean {
  return generation === uploadGeneration;
}

function queueOnIdle(task: () => void, timeoutMs = 2000): void {
  if (typeof window === 'undefined') {
    task();
    return;
  }
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof win.requestIdleCallback === 'function') {
    win.requestIdleCallback(task, { timeout: timeoutMs });
    return;
  }
  window.setTimeout(task, 60);
}

function waitForViewerReadyOrTimeout(
  expectedFingerprint: string,
  timeoutMs = 90_000,
): Promise<'ready' | 'timeout'> {
  if (typeof window === 'undefined') return Promise.resolve('timeout');
  return new Promise((resolve) => {
    let finished = false;
    let timer = 0;
    const finish = (result: 'ready' | 'timeout') => {
      if (finished) return;
      finished = true;
      window.removeEventListener('ifc-viewer-ready', onReady as EventListener);
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      resolve(result);
    };
    const onReady = (event: Event) => {
      const detail = (event as CustomEvent<{ fingerprint?: string | null }>).detail;
      const readyFingerprint = detail?.fingerprint ?? null;
      if (readyFingerprint && readyFingerprint !== expectedFingerprint) return;
      finish('ready');
    };
    window.addEventListener('ifc-viewer-ready', onReady as EventListener);
    timer = window.setTimeout(() => finish('timeout'), timeoutMs);
  });
}

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  if (!err || typeof err !== 'object') return false;
  return (err as { name?: string }).name === 'AbortError';
}

/**
 * Shared IFC upload flow used by both UploadOverlay and Menubar.
 */
export function useIfcUpload() {
  const setProject = useStore((s) => s.setProject);
  const setSpatialTree = useStore((s) => s.setSpatialTree);
  const setStats = useStore((s) => s.setStats);
  const setModelLoaded = useStore((s) => s.setModelLoaded);
  const setLoading = useStore((s) => s.setLoading);
  const setIfcFileBytes = useStore((s) => s.setIfcFileBytes);
  const setModelContract = useStore((s) => s.setModelContract);
  const setLoadStartTs = useStore((s) => s.setLoadStartTs);
  const logActivity = useStore((s) => s.logActivity);
  const loadViewpointsForProject = useStore((s) => s.loadViewpointsForProject);
  const reset = useStore((s) => s.reset);

  return useCallback(async (file: File): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!file.name.toLowerCase().endsWith('.ifc')) {
      return { ok: false, error: 'Please select an .ifc file' };
    }

    const generation = beginUploadGeneration();

    if (useStore.getState().modelLoaded) reset();

    setLoading(true);
    const loadStart = Date.now();
    setLoadStartTs(loadStart);
    logActivity({
      kind: 'info',
      summary: `Uploading ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`,
    });

    const clientAuthoritative =
      BROWSER_ONLY ||
      getClientIfcFlag('statsClient') ||
      getClientIfcFlag('treeClient');

    try {
      const fileBytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrentUpload(generation)) return { ok: true };

      if (clientAuthoritative) {
        setIfcFileBytes(fileBytes);

        const provisionalProject: ProjectInfo = {
          name: file.name.replace(/\.ifc$/i, ''),
          description: null,
          schema_version: '',
          author: null,
          organization: null,
        };
        setProject(provisionalProject);

        // Prefer the backend-compatible SHA-256 fingerprint so the viewer's
        // manifest fast-path can fire on first load when the backend
        // fragment cache is warm (skipping the 50 MB `/convert` POST).
        // Falls back to the cheap FNV-1a fingerprint when SubtleCrypto
        // isn't available or the digest fails.
        const sha256Fingerprint = await buildBackendSha256(fileBytes);
        if (!isCurrentUpload(generation)) return { ok: true };
        const fingerprint = sha256Fingerprint ?? buildFingerprint(fileBytes);
        setModelContract({
          model_version: 1,
          model_fingerprint: fingerprint,
          edit_id: null,
        });
        loadViewpointsForProject(`${provisionalProject.name}|${fingerprint}`);
        setModelLoaded(true);
        setLoading(false);

        const persistToBackend = () => {
          if (!isCurrentUpload(generation)) return;

          const controller = new AbortController();
          activePersistController = controller;

          const useServerCache = useStore.getState().useServerCache;
          void api.uploadIfcWithMode(file, 'minimal', {
            signal: controller.signal,
            prebuildFragments: useServerCache,
            // Prebuild the profile the viewer actually loads with, so the
            // eager conversion warms the cache entry POST /convert reads.
            prebuildProfile: useStore.getState().graphicsProfile,
          })
            .then((meta) => {
              if (!isCurrentUpload(generation)) return;

              const state = useStore.getState();
              if (!state.modelLoaded) return;
              const currentFingerprint = state.modelFingerprint;
              if (
                currentFingerprint &&
                currentFingerprint !== fingerprint &&
                currentFingerprint !== meta.model_fingerprint
              ) {
                return;
              }

              // When the client computed a SHA-256 that matches what the
              // backend stored, mergeBackendMeta is a no-op for the
              // fingerprint field but still patches author / schema_version.
              mergeBackendMeta(meta, provisionalProject);
              // Backend now has the same model bytes, so remount fallback can
              // safely read from /api/ifc/file without resurrecting older IFC.
              state.setIfcFileBytes(null);
              void import('../services/ifc/ModelService').then(({ modelService }) => {
                modelService.releaseRawBytes();
              });
              logActivity({
                kind: 'info',
                summary: 'Backend persisted model (version sync ready).',
              });
            })
            .catch((e) => {
              if (!isCurrentUpload(generation)) return;
              if (isAbortError(e)) return;
              const msg = e instanceof Error ? e.message : 'Backend upload failed';
              logActivity({
                kind: 'error',
                summary: 'Backend persistence failed - chat tools may be unavailable',
                detail: msg,
              });
            })
            .finally(() => {
              if (activePersistController === controller) {
                activePersistController = null;
              }
            });
        };

        if (BROWSER_ONLY) {
          // No backend exists: never persist, and keep ifcFileBytes in the
          // store for the model's lifetime - the metadata worker serves all
          // properties from them.
          return { ok: true };
        }

        const startupMode = useStore.getState().startupMode;
        if (startupMode === 'concurrent_fast') {
          void waitForViewerReadyOrTimeout(fingerprint).then((result) => {
            if (!isCurrentUpload(generation)) return;
            if (result === 'timeout') {
              logActivity({
                kind: 'info',
                summary: 'Viewer-ready signal timed out; persisting backend model in background.',
              });
            }
            queueOnIdle(() => {
              if (!isCurrentUpload(generation)) return;
              persistToBackend();
            }, 2500);
          });
        } else {
          persistToBackend();
        }

        return { ok: true };
      }

      // Legacy backend-parse path.
      const initialMeta = await api.uploadIfcWithMode(file, 'full');
      if (!isCurrentUpload(generation)) return { ok: true };

      setIfcFileBytes(fileBytes);
      setProject(initialMeta.project);
      setModelContract(initialMeta);
      setSpatialTree(initialMeta.tree ?? null);
      setStats(initialMeta.stats ?? null);
      const projectKey = `${initialMeta.project.name}|${initialMeta.project.schema_version}`;
      loadViewpointsForProject(projectKey);
      setModelLoaded(true);
      setLoading(false);
      if (initialMeta.stats) {
        logActivity({
          kind: 'info',
          summary: `Metadata loaded: ${initialMeta.stats.total_elements} elements, ${initialMeta.stats.storeys.length} storeys`,
        });
      }
      return { ok: true };
    } catch (e) {
      if (!isCurrentUpload(generation)) return { ok: true };

      const msg = e instanceof Error ? e.message : 'Failed to load file';
      logActivity({ kind: 'error', summary: 'Upload failed', detail: msg });
      setModelLoaded(false);
      setIfcFileBytes(null);
      setLoading(false);
      return { ok: false, error: msg };
    }
  }, [
    loadViewpointsForProject,
    logActivity,
    reset,
    setIfcFileBytes,
    setLoadStartTs,
    setLoading,
    setModelContract,
    setModelLoaded,
    setProject,
    setSpatialTree,
    setStats,
  ]);
}

// Stable client-side fingerprint that matches ViewerPanel's
// buildFastFingerprint. Kept here to avoid importing the viewer.
function buildFingerprint(bytes: Uint8Array): string {
  const length = bytes.length;
  if (length === 0) return '0-0';
  const sampleCount = Math.min(4096, length);
  const stride = Math.max(1, Math.floor(length / sampleCount));
  let hash = 2166136261;
  for (let i = 0, sampled = 0; i < length && sampled < sampleCount; i += stride, sampled++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return `${length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

/**
 * Compute SHA-256 of the IFC bytes - same hash the backend uses to key the
 * fragment cache. Returns 64 lowercase hex characters. When available, the
 * viewer's manifest fast-path uses this to skip the 50 MB POST upload and
 * fetch the pre-built fragments by fingerprint instead.
 *
 * Falls back to the FNV-1a fingerprint when SubtleCrypto is unavailable
 * (e.g. non-secure context) - the manifest fast-path simply doesn't fire
 * in that case, and the viewer takes the normal `/convert` upload path.
 */
async function buildBackendSha256(bytes: Uint8Array): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const view = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < view.length; i++) {
      hex += view[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

// If backend metadata arrives and the client hasn't filled in author /
// organization / schema_version, patch those in. Never overwrite the
// client's counts - client is authoritative on stats/tree.
function mergeBackendMeta(meta: ModelMeta, provisional: ProjectInfo): void {
  const state = useStore.getState();
  const current = state.project ?? provisional;
  const merged: ProjectInfo = {
    ...current,
    author: current.author ?? meta.project.author,
    organization: current.organization ?? meta.project.organization,
    schema_version: current.schema_version || meta.project.schema_version,
    description: current.description ?? meta.project.description,
    // Keep the client-derived name unless it was the provisional fallback.
    name: current.name === provisional.name && meta.project.name
      ? meta.project.name
      : current.name,
  };
  state.setProject(merged);
  state.setModelContract({
    model_version: meta.model_version,
    model_fingerprint: meta.model_fingerprint,
    edit_id: meta.edit_id,
  });
}
