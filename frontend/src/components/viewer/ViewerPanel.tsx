import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/components-front';
import * as FRAGS from '@thatopen/fragments';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { useStore } from '../../store/useStore';
import type { ViewerPerformanceMode } from '../../store/useStore';
import { apiUrl } from '../../lib/platform';
import { BROWSER_ONLY, RENDER_ON_DEMAND } from '../../config/featureFlags';
import { modelService } from '../../services/ifc/ModelService';
import { ClipPlaneController } from '../../services/viewer/clipPlaneController';
import { SectionBoxController } from '../../services/viewer/sectionBoxController';
import {
  LatestSectionWorkspaceController,
  createSectionWorkspace,
  createSelectionSectionPreset,
  parseSectionWorkspace,
  toRelativeClipPlaneStates,
  type SectionBounds,
} from '../../services/viewer/sectionWorkspace';
import { ClipEdgesService } from '../../services/viewer/clipEdgesService';
import {
  MeasurementController,
  type MeasurementSnapshot,
} from '../../services/viewer/measurementController';
import { facePointsToVec3 } from '../../services/viewer/vertexSnapHelpers';
import {
  snapToTriangleFeatures,
  type ConstructionSnapCandidate,
} from '../../services/viewer/constructionSnapCandidates';
import {
  shortestDistanceBetweenTriangles,
  type Triangle3,
} from '../../services/viewer/constructionMeasurement';
// B5 mount point: wall drawing tool - all logic lives in services/editor/.
import { WallDrawController } from '../../services/editor/wallDrawController';
import EditToolbar from './EditToolbar';
import HighlightBadge from './HighlightBadge';
import SelectionSummaryChip from './SelectionSummaryChip';
import PerformanceHud from './PerformanceHud';
import PerformanceDashboard from './PerformanceDashboard';
import FloatingChatDock from './FloatingChatDock';
import MeasurementControls from './MeasurementControls';
import MeasurementLabels from './MeasurementLabels';
import MeasurementPanel from './MeasurementPanel';
import ViewerContextMenu, { type ContextMenuState } from './ViewerContextMenu';
import ViewerHoverTooltip from './ViewerHoverTooltip';
import ViewportNavControls from './ViewportNavControls';
import ErrorBoundary from '../ui/ErrorBoundary';
import { findIfcTypeForId, collectLeavesUnder, getSpatialNodeIndex } from '../../services/viewer/spatialTreeHelpers';
import { setHoverTooltipData } from '../../services/viewer/hoverTooltipBridge';
import {
  registerViewerBridge,
  unregisterViewerBridge,
  type ViewerBridgeCapabilities,
} from '../../services/viewer/viewerBridge';
import { buildColourGroups } from '../../services/viewer/colourByHelper';
import { flattenColourLayers } from '../../services/viewer/colourLayers';
import {
  resolveParseProfile,
  configureImporter,
  getRendererFlagsForProfile,
  getWebIfcSettingsForProfile,
  AUTO_PERF_PROFILE_THRESHOLD_BYTES,
} from '../../services/viewer/parseProfiles';
import { GHOST_ISOLATION_OPACITY } from '../../services/viewer/ghostModeHelpers';
import {
  pushClickLatencySample,
  medianClickLatency,
  maxClickLatency,
  p95ClickLatency,
  CLICK_LATENCY_OK_MS,
} from '../../services/viewer/clickLatencyHelpers';
import {
  decideHoverWork,
} from '../../services/viewer/hoverHighlightHelpers';
import { HOVER_HIGHLIGHT_MATERIAL } from '../../services/viewer/hoverMaterialRegistry';
import {
  DEFAULT_INTERACTION_QUALITY_STATE,
  HOVER_INTENT_DELAY_MS,
  getRuntimeQualitySettings,
  reduceInteractionQuality,
  shouldDelayHoverRaycast,
  shouldRunHoverRaycast,
  type InteractionQualityEvent,
  type InteractionQualityState,
  type RuntimeViewerQuality,
} from '../../services/viewer/interactionQualityController';
import {
  canReuseExactHoverPick,
  canReusePrefetchedPick,
  createPickLeaseCoordinator,
  isClickGesture,
  isConfirmedVoidPick,
  isNoopSameElementClick,
  type PickLeaseCoordinator,
} from '../../services/viewer/pickingPipeline';
import {
  createContextMenuPickGuard,
  type ContextMenuPickOutcome,
} from '../../services/viewer/contextMenuPickGuard';
import {
  canUseFurnishingMerge,
  canUseNavigationLod,
  resolveLodTier,
  resolveModelGraphicsQuality,
  shouldAttachNavigationLod,
  shouldPinAllVisible,
  type LodTier,
} from '../../services/viewer/lodTierPolicy';
import { solveCameraFrame } from '../../services/viewer/frameCameraMath';
import {
  createFragmentUpdateScheduler,
  type FragmentUpdatePriority,
  type FragmentUpdateReason,
  type FragmentUpdateScheduler,
} from '../../services/viewer/fragmentUpdateScheduler';
import { prewarmExpressToLocalCache } from '../../services/viewer/localIdCachePrewarm';
import {
  PANEL_RESIZE_END_EVENT,
  PANEL_RESIZE_START_EVENT,
} from '../../services/viewer/panelResizeSession';
import {
  shouldContinueFrameSampling,
  summarizeFrameDeltas,
} from '../../services/viewer/frameTimeRecorder';
import {
  getMainPassStats,
  isMainPassFresh,
  recordMainPass,
  resetMainPassStats,
} from '../../services/viewer/renderStatsSnapshot';
import { LodSwapController, loadAndAttachLod, type AttachedLod } from '../../services/viewer/lodSwap';
import {
  applyGhostPostproductionState,
  type GhostPostproductionTarget,
} from '../../services/viewer/ghostPostproductionController';
import {
  SELECTION_HIGHLIGHT_OPACITY,
  computeAmberIds,
  getSelectionHighlightColor,
} from '../../services/viewer/selectionHighlightHelpers';
import {
  createLatestAsyncScheduler,
  type LatestAsyncRunContext,
  type LatestAsyncScheduler,
} from '../../services/viewer/latestAsyncScheduler';
import {
  RenderStateCoordinator,
  type VisibilityMutationTarget,
} from '../../services/viewer/renderStateCoordinator';
import {
  convertIfcOnServer,
  getServerCapabilities,
  checkFragmentManifest,
  fetchFragmentByFingerprint,
  pollConvertProgress,
  waitForFragmentReady,
} from '../../services/ifc/serverConvert';
import {
  shouldAttemptServerConvert,
  shouldRepromoteCapabilities,
  defaultParsePathLabel,
  isRecoverableServerConvertFailure,
} from '../../services/viewer/loadStrategy';
import {
  fetchNativeGeometryPreview,
  removeNativePreview,
  type NativeGeometryPreview,
} from '../../services/ifc/nativeGeometry';
import {
  streamNativeGeometry,
  type DecodedMesh,
} from '../../services/viewer/streamingGeometryConsumer';
import {
  appendBatchToGroup,
  createStreamingMaterialCache,
  disposeStreamingPreview,
} from '../../services/viewer/streamingPreviewBuilder';
import {
  computeSceneBVH,
  getBVHCoverage,
  installBVH,
} from '../../services/viewer/bvhSetup';
import {
  applyFragmentZFightingMitigation,
  hasPendingFragmentZFightingMitigation,
  resetFragmentZFightingTracking,
} from '../../services/viewer/zFightingMitigation';
import {
  applyFurnishingMerge,
  FurnishingMergeLifecycle,
} from '../../services/viewer/furnishingMerge';
import {
  StoreyFrustumCuller,
  extractStoreyNodes,
} from '../../services/viewer/storeyFrustumCuller';
import { ElementFrustumCuller } from '../../services/viewer/elementFrustumCuller';
import { createInvalidationRenderLoop } from '../../services/viewer/invalidationRenderLoop';
import { getSpatialTileManifest } from '../../services/api';
import { SpatialTileLodService } from '../../services/viewer/spatialTileLod';
import {
  adaptSpatialTileManifest,
  rebaseSpatialTileManifestBounds,
} from '../../services/viewer/spatialTileManifestAdapter';
import { SpatialTileVisibilityController } from '../../services/viewer/spatialTileVisibilityController';
import {
  decideCullerWork,
  runCullerPlan,
  type CullerSnapshot,
} from '../../services/viewer/cullerCoordinationHelpers';
import { decideCullerPolicy } from '../../services/viewer/cullerStatePolicy';
import {
  INITIAL_TREE_HOVER_STATE,
  isResolutionStale,
  onTreeHoverEnter,
  onTreeHoverLeave,
  onTreeHoverPainted,
  shouldSkipResetForSelection,
  type TreeHoverPreviewState,
} from '../../services/viewer/treeHoverPreviewHelpers';
import { IfcConvertWorker } from '../../services/viewer/ifcConvertWorker';
import {
  readFragmentCacheIDB,
  deleteFragmentCacheIDBEntry,
  writeRawFragmentCacheIDB,
  scheduleFragmentCacheIDBPersist,
  requestPersistentStorageOnce,
  type FragmentCachePolicy,
} from '../../services/viewer/fragmentCacheIDB';
import {
  fetchStoreyFragment,
  type StoreyFragmentResult,
} from '../../services/viewer/streamingLoader';
import {
  STOREY_FRAGMENT_LOAD_TIMEOUT_MS,
  computeFragmentLoadTimeoutMs,
  computeLiveParseTimeoutMs,
  raceWithTimeout,
} from '../../services/viewer/loadTimeoutHelpers';
import {
  IMPORT_STAGE_LABELS,
  SERVER_FRAGMENT_LOAD_RETRIES,
  VIEWER_PERF_LOG_STORAGE_KEY,
  attachGeometryTitle,
  buildFragmentCacheKey,
  buildViewerPerfLogEntry,
  clearFragmentThreadPlaceholder,
  computeViewerReadyMetrics,
  formatUnknownLoadError,
  formatImportProgressDetail,
  formatStageTimings,
  formatViewerReadySummary,
  isCacheHitModelLoadSource,
  isBackendShaFingerprint,
  isSuspiciousServerFragmentBytes,
  loadFragmentsWithTimeout,
  makeViewerModelId,
  modelLoadSourceForServerFragmentSource,
  modelLoadSourceHint,
  normalizeImportProgress,
  serverCapabilityWaitMs,
  shouldUseServerFragmentManifest,
  shouldWaitForServerPrebuild,
  prependViewerPerfLogEntry,
  type ViewerLoadStageTimings,
  type ViewerModelLoadSource,
  type ViewerLoadProgress,
  type ViewerPerfLogEntry,
} from '../../services/viewer/loadPipelineHelpers';
import {
  LOAD_STAGES,
  advancePace,
  createPaceState,
  estimateExpectedTotal,
  formatEta,
  pathKindForSourceHint,
  presentLoadProgress,
  type LoadPathKind,
  type PaceState,
} from '../../services/viewer/loadProgressPresenter';

// Shared viewer references so toolbar and other components can access them
export interface ViewerRefs {
  components: OBC.Components;
  world: OBC.SimpleScene & { camera: OBC.SimpleCamera; renderer: OBC.SimpleRenderer; scene: OBC.SimpleScene };
  model: FRAGS.FragmentsModel;
  modelCenter: THREE.Vector3;
  modelSize: THREE.Vector3;
  /** Grid object returned by OBC.Grids.create(world). Used for theme updates. */
  grid?: { three: THREE.Object3D };
}

type FragmentRaycastHit = NonNullable<Awaited<ReturnType<FRAGS.FragmentsModel['raycast']>>>;

/** Theme-driven scene colors. Keeps the 3D scene in sync with the CSS theme.
 *  The dark bottom stop is intentionally lifted off pure black so that dark
 *  IFC materials (e.g. roofs with low-luminance surface styles) don't blend
 *  into the void and disappear; the top stop leans toward the AMOLED app
 *  chrome so the canvas no longer reads as a flat colored island. */
const THEME_COLORS = {
  dark: {
    background: 0x1a212e,
    backgroundTop: 0x10141c,
    backgroundBottom: 0x242d3d, // horizon - keeps dark materials separated
    grid: 0x39414f,
  },
  light: {
    background: 0xf3f4f6,
    backgroundTop: 0xf7f9fc,
    backgroundBottom: 0xe7ebf1,
    grid: 0xcbd5e0,
  },
} as const;

// Per-scene texture registry so theme changes dispose the old background.
const sceneBackgroundTextures = new WeakMap<THREE.Scene, THREE.Texture>();

function buildVerticalGradientTexture(top: number, bottom: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
    grad.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

type ViewerTheme = keyof typeof THEME_COLORS;

const CHAT_HIGHLIGHT_COLOR = new THREE.Color(0x00d2ff);
const CHAT_HIGHLIGHT_LIMIT = 500;

// Map the user-facing performance mode onto the runtime quality ladder.
function performanceModeToQualityTarget(mode: ViewerPerformanceMode): RuntimeViewerQuality {
  switch (mode) {
    case 'performance':
      return 'interactive';
    case 'quality':
      return 'quality';
    case 'balanced':
    case 'auto':
    default:
      return 'balanced';
  }
}

function isExpressIdSelected(
  expressId: number | null,
  selectedElementId: number | null,
  selectedIds: readonly number[],
): boolean {
  if (expressId === null) return false;
  if (selectedElementId === expressId) return true;
  return selectedIds.includes(expressId);
}

function applySceneTheme(
  world: ViewerRefs['world'],
  grid: ViewerRefs['grid'] | undefined,
  theme: ViewerTheme,
) {
  const colors = THEME_COLORS[theme];

  try {
    const sceneThree = world.scene.three as THREE.Scene;
    if (sceneThree) {
      const texture = buildVerticalGradientTexture(colors.backgroundTop, colors.backgroundBottom);
      const previous = sceneBackgroundTextures.get(sceneThree);
      sceneThree.background = texture;
      sceneBackgroundTextures.set(sceneThree, texture);
      previous?.dispose();
    }
    // Fallback for capture/postproduction paths that bypass scene.background.
    world.renderer?.three.setClearColor(colors.background, 1);
  } catch {
    /* ignore */
  }

  try {
    if (grid?.three) {
      grid.three.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        const setColor = (m: THREE.Material) => {
          // OBC SimpleGrid exposes its line color through the uColor uniform.
          const uniformMaterial = m as unknown as { uniforms?: { uColor?: { value: THREE.Color } } };
          if (uniformMaterial.uniforms?.uColor?.value) {
            uniformMaterial.uniforms.uColor.value.setHex(colors.grid);
            m.needsUpdate = true;
          }
        };
        if (Array.isArray(mat)) mat.forEach(setColor);
        else setColor(mat);
      });
    }
  } catch {
    /* grid material API differs across @thatopen versions; safe to ignore */
  }
}

export interface CameraState {
  pos: [number, number, number];
  target: [number, number, number];
}

interface ViewerPanelProps {
  onCameraViewRef?: React.MutableRefObject<((view: string) => void) | null>;
  onFitModelRef?: React.MutableRefObject<(() => void) | null>;
  onScreenshotRef?: React.MutableRefObject<(() => void) | null>;
  onSaveViewpointRef?: React.MutableRefObject<((name: string) => void) | null>;
  onRestoreViewpointRef?: React.MutableRefObject<((id: string) => void) | null>;
}

export default function ViewerPanel({
  onCameraViewRef,
  onFitModelRef,
  onScreenshotRef,
  onSaveViewpointRef,
  onRestoreViewpointRef,
}: ViewerPanelProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerRefs | null>(null);
  const sceneThemeTargetsRef = useRef<Pick<ViewerRefs, 'world' | 'grid'> | null>(null);
  // Kept for the viewer lifetime; subsequent fragment loads reuse this worker URL.
  const workerBlobUrlRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingFading, setLoadingFading] = useState(false);
  const [loadingSlow, setLoadingSlow] = useState(false);
  // Drives the loader's elapsed/remaining time line.
  const [loadElapsedSec, setLoadElapsedSec] = useState<number | null>(null);
  const [loadProgress, setLoadProgress] = useState<ViewerLoadProgress>({
    title: 'Initializing 3D viewport',
    detail: 'Preparing renderer, camera, and worker...',
    progress: 4,
    sourceHint: 'Startup',
  });
  const [viewerReady, setViewerReady] = useState(false);
  // Canvas context-menu state; listeners call through a ref to avoid reattachment.
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);
  const theme = useStore((s) => s.theme);
  const perfDashOpen = useStore((s) => s.perfDashOpen);
  const setPerfDashOpen = useStore((s) => s.setPerfDashOpen);
  const setContextMenuStateRef = useRef(setContextMenuState);
  setContextMenuStateRef.current = setContextMenuState;
  // Allows click handling to bypass the queued highlight rebuild when needed.
  const rebuildSchedulerRef = useRef<LatestAsyncScheduler | null>(null);
  // In-flight async state readers are retained until their model reads settle,
  // so the main teardown can keep fragment workers alive long enough.
  const latestAsyncSchedulersRef = useRef<Set<LatestAsyncScheduler>>(new Set());
  // Hover refs update at pointer frequency without re-rendering the viewer.
  const hoveredLocalIdRef = useRef<number | null>(null);
  const hoveredExpressIdRef = useRef<number | null>(null);
  // Raycasts provide both IDs; cache them to avoid later per-id async lookups.
  const expressToLocalCacheRef = useRef<Map<number, number>>(new Map());
  // Per-session rolling window for the PerformanceHud click-latency chip.
  const clickLatencyWindowRef = useRef<number[]>([]);
  // Armed for hit-clicks and cleared when the matching highlight flush lands.
  const pendingClickStartRef = useRef<number | null>(null);
  // Development-only attribution for slow click samples.
  const clickFlushAttributionRef = useRef<{
    runStartTs: number | null;
    paceWaitMs: number;
    flushMs: number;
  }>({ runStartTs: null, paceWaitMs: 0, flushMs: 0 });
  // Stale in-flight hover raycasts bail when this generation changes.
  const hoverGenRef = useRef(0);
  // Drops cached/prefetched raycast hits when a fragment replacement
  // (furnishing merge/unmerge) lands: a pre-swap hit reused inside the
  // 150 ms exact-hover click window would select geometry that no longer
  // exists. Installed by the canvas-interaction closure.
  const pointerPickCachesInvalidateRef = useRef<(() => void) | null>(null);
  // Suppresses low-priority hover work during camera navigation.
  const cameraNavigatingRef = useRef(false);
  const lodCleanupRef = useRef<(() => void) | null>(null);
  const navigationLodAppearanceRefreshRef = useRef<(() => void) | null>(null);
  const furnishingMergeDesiredRefreshRef = useRef<(() => void) | null>(null);
  const visibilityRepairRef = useRef<(() => Promise<void>) | null>(null);
  const exactPickLeaseRef = useRef<PickLeaseCoordinator | null>(null);
  // Runtime pixel ratio, graphics quality, and hover-gate ladder state.
  const interactionQualityRef = useRef<InteractionQualityState>(
    DEFAULT_INTERACTION_QUALITY_STATE,
  );
  // Full local-ID list cache for ghost-mode set calculations.
  const allLocalIdsCacheRef = useRef<number[] | null>(null);
  // Structural ref: Postproduction is not a public export from OBC Front.
  const postproductionRef =
    useRef<GhostPostproductionTarget<OBCF.EdgeDetectionPassMode> | null>(null);
  const fragmentUpdateSchedulerRef = useRef<FragmentUpdateScheduler | null>(null);
  const renderKickRef = useRef<((ms?: number) => void) | null>(null);
  // The sole normal-path owner of fragment visibility, opacity, and highlight
  // mutations. Subsystems publish named masks/layers instead of writing the
  // shared worker state directly.
  const renderStateCoordinatorRef = useRef<RenderStateCoordinator | null>(null);
  const renderStateShutdownRef = useRef<Promise<void> | null>(null);
  const storeyCullerVisibilityRef = useRef<VisibilityMutationTarget | null>(null);
  const elementCullerVisibilityRef = useRef<VisibilityMutationTarget | null>(null);
  const spatialTileVisibilityRef = useRef<VisibilityMutationTarget | null>(null);
  const furnishingVisibilityRef = useRef<VisibilityMutationTarget | null>(null);

  const updateLoadProgress = useCallback((next: Partial<ViewerLoadProgress>) => {
    setLoadProgress((previous) => {
      const merged: ViewerLoadProgress = {
        ...previous,
        ...next,
      };
      if (
        merged.title === previous.title
        && merged.detail === previous.detail
        && merged.progress === previous.progress
        && merged.sourceHint === previous.sourceHint
      ) {
        return previous;
      }
      return merged;
    });
  }, []);

  const applyGhostPostproduction = useCallback((navigating = cameraNavigatingRef.current) => {
    applyGhostPostproductionState(postproductionRef.current, {
      ghostModeOn: useStore.getState().ghostModeOn,
      navigating,
      fastEdgeMode: OBCF.EdgeDetectionPassMode.GLOBAL,
    });
  }, []);

  const requestFragmentUpdate = useCallback((
    reason: FragmentUpdateReason,
    force = true,
    priority: FragmentUpdatePriority = 'visual',
  ) => {
    const scheduler = fragmentUpdateSchedulerRef.current;
    if (scheduler) {
      scheduler.request({ priority, force, reason });
      return;
    }
    const refs = viewerRef.current;
    if (!refs) return;
    try {
      const fm = refs.components.get(OBC.FragmentsManager);
      void Promise.resolve(fm.core.update(force)).catch(() => {});
    } catch {
      /* best-effort render kick */
    }
  }, []);

  /** Invalidate only the renderer for plain Three.js visibility/buffer changes. */
  const requestViewerRender = useCallback((ms = 100) => {
    renderKickRef.current?.(ms);
  }, []);

  // Create one coordinator per mounted fragments model. Effects declared
  // below publish their current layers after this effect has installed it.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { model, components } = viewerRef.current;
    const waitForPaintBoundary = () => new Promise<void>((resolve) => {
      let settled = false;
      let timeout = 0;
      let firstFrame = 0;
      let secondFrame = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        document.removeEventListener('visibilitychange', armTimeout);
        if (firstFrame) window.cancelAnimationFrame(firstFrame);
        if (secondFrame) window.cancelAnimationFrame(secondFrame);
        resolve();
      };
      // Hidden/background WebViews can suspend rAF indefinitely, so a hidden
      // document keeps a short bounded fallback. A visible viewport must
      // prefer the true paint boundary even under heavy load; its longer
      // bound exists only to keep shutdown finite.
      const armTimeout = () => {
        window.clearTimeout(timeout);
        timeout = window.setTimeout(
          finish,
          document.visibilityState === 'hidden' ? 160 : 2_000,
        );
      };
      document.addEventListener('visibilitychange', armTimeout);
      armTimeout();
      // One rAF callback runs before its frame is painted. Resolving from the
      // following rAF guarantees at least one compositor paint has occurred
      // after the renderer was armed.
      firstFrame = window.requestAnimationFrame(() => {
        firstFrame = 0;
        secondFrame = window.requestAnimationFrame(() => {
          secondFrame = 0;
          finish();
        });
      });
    });
    const coordinator = new RenderStateCoordinator({
      model,
      requestRender: async (_generation, source) => {
        const scheduler = fragmentUpdateSchedulerRef.current;
        const isCullerShow = source.includes('culler-show');
        const isCullerHide = source.includes('culler-hide');
        const isHover = source.includes('hover');
        const reason: FragmentUpdateReason = isCullerShow
          ? 'culler-show'
          : isCullerHide
            ? 'culler-hide'
            : isHover
              ? 'hover-highlight'
              : source.includes('highlight')
                ? 'click-highlight'
                : 'ghost-visibility';
        // Coordinator urgency controls when an idle culler hide is allowed to
        // mutate worker state. Once that mutation has happened its refresh may
        // never be held behind navigation, or already-hidden geometry can be
        // painted for the duration of an orbit.
        const priority: FragmentUpdatePriority = 'visual';
        if (scheduler) {
          // Every scheduler run serializes through this model's FINISH event;
          // requestAndWait therefore cannot be satisfied by a late event from
          // the preceding camera batch.
          await scheduler.requestAndWait({ priority, force: true, reason });
          // onRunEnd arms the renderer before requestAndWait resolves. Queue
          // this callback afterwards, so acknowledgement crosses the next
          // painted-frame boundary instead of merely the worker-update edge.
          await waitForPaintBoundary();
          return;
        }
        // Startup fallback before the normal scheduler is attached.
        const fragmentsManager = components.get(OBC.FragmentsManager);
        await fragmentsManager.core.update(true);
        requestViewerRender(120);
        await waitForPaintBoundary();
      },
      raf: (callback) => window.requestAnimationFrame(callback),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle as number),
      onError: (error) => {
        if (import.meta.env.DEV) console.debug('[viewer] render-state reconciliation failed', error);
      },
    });
    renderStateCoordinatorRef.current = coordinator;
    const guardCullerTarget = (target: VisibilityMutationTarget): VisibilityMutationTarget => {
      const guard = async (run: () => Promise<void>, includesHide: boolean) => {
        const state = useStore.getState();
        const userPolicy = state.isolatedIds.length > 0 || state.hiddenIds.length > 0;
        if (userPolicy || (includesHide && cameraNavigatingRef.current)) {
          if (userPolicy) await target.clearVisibility?.();
          const error = new Error(userPolicy
            ? 'Culler mutation superseded by user visibility'
            : 'Culler hide superseded by active navigation');
          error.name = 'AbortError';
          throw error;
        }
        await run();
      };
      return {
        setVisible: (ids, visible) => guard(() => target.setVisible(ids, visible), !visible),
        applyVisibilityDelta: (toHide, toShow) => guard(() => (
          target.applyVisibilityDelta?.(toHide, toShow) ?? Promise.resolve()
        ), toHide.length > 0),
        clearVisibility: () => target.clearVisibility?.() ?? Promise.resolve(),
      };
    };
    storeyCullerVisibilityRef.current = guardCullerTarget(coordinator.createVisibilityTarget('culler:storey', {
      urgency: 'idle',
      reason: 'culler-hide:storey',
    }, {
      urgency: 'visual',
      reason: 'culler-show:storey',
    }));
    elementCullerVisibilityRef.current = guardCullerTarget(coordinator.createVisibilityTarget('culler:element', {
      urgency: 'idle',
      reason: 'culler-hide:element',
    }, {
      urgency: 'visual',
      reason: 'culler-show:element',
    }));
    spatialTileVisibilityRef.current = guardCullerTarget(coordinator.createVisibilityTarget('culler:spatial-tiles', {
      urgency: 'idle',
      reason: 'culler-hide:spatial-tiles',
    }, {
      urgency: 'visual',
      reason: 'culler-show:spatial-tiles',
    }));
    furnishingVisibilityRef.current = coordinator.createVisibilityTarget('geometry:furnishing-merge', {
      urgency: 'visual',
      reason: 'furnishing-merge',
    });
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__ifcRenderState = () => coordinator.snapshot();
    }
    return () => {
      const shutdown = coordinator.shutdown();
      renderStateShutdownRef.current = shutdown;
      void shutdown.finally(() => {
        if (renderStateCoordinatorRef.current === coordinator) renderStateCoordinatorRef.current = null;
        if (renderStateShutdownRef.current === shutdown) renderStateShutdownRef.current = null;
      });
      storeyCullerVisibilityRef.current = null;
      elementCullerVisibilityRef.current = null;
      spatialTileVisibilityRef.current = null;
      furnishingVisibilityRef.current = null;
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__ifcRenderState;
      }
    };
  }, [viewerReady, requestViewerRender]);

  const setCoordinatedHover = useCallback(async (
    source: 'canvas' | 'tree',
    localId: number | null,
  ) => {
    const coordinator = renderStateCoordinatorRef.current;
    if (!coordinator) return;
    const layer = `appearance:hover:${source}`;
    await coordinator.update({
      highlights: [{
        layer,
        definition: localId === null
          ? null
          : {
              layer,
              priority: 30,
              entries: [{
                styleKey: 'hover:amber',
                ids: [localId],
                material: HOVER_HIGHLIGHT_MATERIAL,
              }],
            },
      }],
    }, { urgency: 'visual', reason: `highlight:hover:${source}` });
  }, []);

  // Disabling hover must also release an already-painted preview; merely
  // suppressing future raycasts leaves stale tint behind.
  useEffect(() => useStore.subscribe(
    (state) => state.hoverHighlightEnabled,
    (enabled) => {
      if (enabled) return;
      hoveredLocalIdRef.current = null;
      hoveredExpressIdRef.current = null;
      void setCoordinatedHover('canvas', null).catch(() => {});
      void setCoordinatedHover('tree', null).catch(() => {});
    },
  ), [setCoordinatedHover]);

  // Click-to-highlight latency is recorded after the highlight flush resolves.
  const recordClickLatencyFlush = useCallback(() => {
    const tClickStart = pendingClickStartRef.current;
    if (tClickStart === null) return;
    pendingClickStartRef.current = null;
    const latencyMs = performance.now() - tClickStart;
    clickLatencyWindowRef.current = pushClickLatencySample(
      clickLatencyWindowRef.current,
      latencyMs,
    );
    // p95 is the number the plan's <= 80 ms p95 target is judged against;
    // it surfaces in the PerformanceHud chip alongside median/max (the
    // store write is gated behind the perf-UI gate).
    const p95 = p95ClickLatency(clickLatencyWindowRef.current);
    useStore.getState().updatePerfMetrics({
      clickToHighlightMs: latencyMs,
      clickToHighlightMedianMs: medianClickLatency(clickLatencyWindowRef.current),
      clickToHighlightMaxMs: maxClickLatency(clickLatencyWindowRef.current),
      clickToHighlightP95Ms: p95,
    });
    if (import.meta.env.DEV) {
      if (latencyMs > CLICK_LATENCY_OK_MS) {
        console.warn(`[viewer] click-to-highlight ${latencyMs.toFixed(0)} ms exceeds ${CLICK_LATENCY_OK_MS} ms budget`);
      }
      // Self-attributing breakdown so a slow sample names its bottleneck:
      // queueWait = pick + highlight RPC posting + waiting out any in-flight
      // engine run; paceWait = engine drop-window deferral; flush = the
      // forced engine update (refresh round-trip + tile pump + fence).
      const attribution = clickFlushAttributionRef.current;
      console.debug('[viewer] click-to-highlight', {
        last: Math.round(latencyMs),
        median: medianClickLatency(clickLatencyWindowRef.current),
        p95,
        max: maxClickLatency(clickLatencyWindowRef.current),
        queueWaitMs: attribution.runStartTs === null
          ? null
          : Math.round(attribution.runStartTs - tClickStart),
        paceWaitMs: Math.round(attribution.paceWaitMs),
        flushMs: Math.round(attribution.flushMs),
      });
      attribution.runStartTs = null;
    }
  }, []);

  // Selection / highlight / focus-mode / ghost-opacity are not subscribed at
  // the React render level. The coordinator schedulers consume the latest
  // values via `useStore.getState()` plus reactive
  // `useStore.subscribe(...)` calls. Subscribing here was forcing a full
  // ViewerPanel re-render on every click for no JSX benefit.
  const isolatedIds = useStore((s) => s.isolatedIds);
  // Ghost mode: shows non-isolated elements as semi-transparent ghosts with
  // xray edge rendering instead of hiding them completely. Stored in Zustand
  // so the Shift+G keyboard shortcut and the ghost button share the same state.
  const ghostModeOn = useStore((s) => s.ghostModeOn);
  const setGhostModeOn = useStore((s) => s.setGhostModeOn);

  // Translate IFC Express IDs into FragmentsModel local IDs; mixing them breaks
  // visibility/highlight operations.
  const expressToLocalIds = useCallback(async (
    model: FRAGS.FragmentsModel,
    expressIds: number[],
  ): Promise<number[]> => {
    const cache = expressToLocalCacheRef.current;
    const out: number[] = [];
    const misses: number[] = [];
    for (const id of expressIds) {
      const cached = cache.get(id);
      if (cached !== undefined) {
        out.push(cached);
      } else {
        const remembered = modelService.getRememberedLocalId(id);
        if (remembered !== null) {
          cache.set(id, remembered);
          out.push(remembered);
        } else {
          misses.push(id);
        }
      }
    }
    if (misses.length === 0) return out;
    // Resolve cache misses in chunks.
    const MISS_CHUNK = 64;
    for (let i = 0; i < misses.length; i += MISS_CHUNK) {
      const slice = misses.slice(i, i + MISS_CHUNK);
      const resolved = await Promise.all(
        slice.map(async (id) => {
          try {
            const item = model.getItem(id);
            const localId = await item.getLocalId();
            return localId != null ? { express: id, local: localId } : null;
          } catch {
            return null;
          }
        }),
      );
      for (const entry of resolved) {
        if (entry) {
          cache.set(entry.express, entry.local);
          out.push(entry.local);
        }
      }
      if (i + MISS_CHUNK < misses.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    return out;
  }, []);


  /**
   * Phase-1 layered compositor. Each semantic source publishes a named layer;
   * RenderStateCoordinator diffs the effective winner per local ID. This path
   * never performs a model-wide reset during an ordinary selection, AI result,
   * or colour change.
   */
  /** Rebuild the expensive colour-by/colour-layer base only when it changes. */
  const rebuildCoordinatedBaseAppearance = useCallback(async (run: LatestAsyncRunContext) => {
    const coordinator = renderStateCoordinatorRef.current;
    const refs = viewerRef.current;
    if (!coordinator || !refs) return;
    const isStale = () => (
      run.isSuperseded()
      || renderStateCoordinatorRef.current !== coordinator
      || viewerRef.current !== refs
    );
    const state = useStore.getState();
    const mergedBase = new Map<number, {
      styleKey: string;
      material: FRAGS.MaterialDefinition;
    }>();

    if (state.colourBy !== 'off' && state.spatialTree) {
      for (const group of buildColourGroups(state.spatialTree, state.colourBy)) {
        const localIds = await expressToLocalIds(refs.model, group.ids);
        if (isStale()) return;
        const styleKey = `colour-by:${group.color.getHexString()}`;
        const material: FRAGS.MaterialDefinition = {
          color: group.color,
          opacity: 0.95,
          transparent: false,
          renderedFaces: FRAGS.RenderedFaces.ONE,
          customId: styleKey,
        };
        for (const id of localIds) mergedBase.set(id, { styleKey, material });
      }
    }

    const layerColourCache = new Map<string, THREE.Color>();
    for (const group of flattenColourLayers(state.colourLayers)) {
      const localIds = await expressToLocalIds(refs.model, group.ids);
      if (isStale()) return;
      let colour = layerColourCache.get(group.color);
      if (!colour) {
        colour = new THREE.Color(group.color);
        layerColourCache.set(group.color, colour);
      }
      const styleKey = `colour-layer:${colour.getHexString()}`;
      const material: FRAGS.MaterialDefinition = {
        color: colour,
        opacity: 0.95,
        transparent: false,
        renderedFaces: FRAGS.RenderedFaces.ONE,
        customId: styleKey,
      };
      for (const id of localIds) mergedBase.set(id, { styleKey, material });
    }

    const grouped = new Map<string, {
      ids: number[];
      material: FRAGS.MaterialDefinition;
    }>();
    for (const [id, visual] of mergedBase) {
      const group = grouped.get(visual.styleKey);
      if (group) group.ids.push(id);
      else grouped.set(visual.styleKey, { ids: [id], material: visual.material });
    }
    if (isStale()) return;
    await coordinator.update({
      highlights: [{
        layer: 'appearance:base-colour',
        definition: grouped.size > 0
          ? {
              layer: 'appearance:base-colour',
              priority: 10,
              entries: [...grouped].map(([styleKey, group]) => ({
                styleKey,
                ids: group.ids,
                material: group.material,
              })),
            }
          : null,
      }],
    }, { urgency: 'frame', reason: 'highlight:base-colour' });
  }, [expressToLocalIds]);

  /** AI/search results own a separate lower-priority durable layer. */
  const rebuildCoordinatedResultHighlights = useCallback(async (run: LatestAsyncRunContext) => {
    const coordinator = renderStateCoordinatorRef.current;
    const refs = viewerRef.current;
    if (!coordinator || !refs) return;
    const highlightedIds = useStore.getState().highlightedIds.slice(0, CHAT_HIGHLIGHT_LIMIT);
    const localIds = await expressToLocalIds(
      refs.model,
      highlightedIds,
    );
    if (
      run.isSuperseded()
      || renderStateCoordinatorRef.current !== coordinator
      || viewerRef.current !== refs
    ) return;
    await coordinator.update({
      highlights: [{
        layer: 'appearance:ai-results',
        definition: localIds.length > 0
          ? {
              layer: 'appearance:ai-results',
              priority: 20,
              entries: [{
                styleKey: 'ai-results:cyan',
                ids: localIds,
                material: {
                  color: CHAT_HIGHLIGHT_COLOR,
                  opacity: 1,
                  transparent: false,
                  renderedFaces: FRAGS.RenderedFaces.ONE,
                  customId: 'ai-results:cyan',
                },
              }],
            }
          : null,
      }],
    }, { urgency: 'visual', reason: 'highlight:ai-results' });
  }, [expressToLocalIds]);

  /** Selection is the highest durable layer and owns click-to-paint timing. */
  const rebuildCoordinatedSelection = useCallback(async (run: LatestAsyncRunContext) => {
    const coordinator = renderStateCoordinatorRef.current;
    const refs = viewerRef.current;
    if (!coordinator || !refs) return;
    const clickStartForRun = pendingClickStartRef.current;
    try {
      const state = useStore.getState();
      const localIds = await expressToLocalIds(
        refs.model,
        computeAmberIds(state.selectedElementId, state.selectedIds),
      );
      if (
        run.isSuperseded()
        || renderStateCoordinatorRef.current !== coordinator
        || viewerRef.current !== refs
      ) return;
      await coordinator.update({
        highlights: [{
          layer: 'appearance:selection',
          definition: localIds.length > 0
            ? {
                layer: 'appearance:selection',
                priority: 40,
                entries: [{
                  styleKey: 'selection:amber',
                  ids: localIds,
                  material: {
                    color: getSelectionHighlightColor(),
                    opacity: SELECTION_HIGHLIGHT_OPACITY,
                    transparent: false,
                    renderedFaces: FRAGS.RenderedFaces.ONE,
                    customId: 'selection:amber',
                  },
                }],
              }
            : null,
        }],
      }, { urgency: 'visual', reason: 'highlight:selection' });
      if (
        clickStartForRun !== null
        && pendingClickStartRef.current === clickStartForRun
      ) {
        recordClickLatencyFlush();
      }
    } catch (error) {
      if (pendingClickStartRef.current === clickStartForRun) {
        pendingClickStartRef.current = null;
      }
      throw error;
    }
  }, [expressToLocalIds, recordClickLatencyFlush]);

  // Keep expensive appearance sources on independent latest-state schedulers.
  // A selection click no longer rebuilds or translates every colour-by ID.
  useEffect(() => {
    if (!viewerReady) return;
    const makeScheduler = (
      label: string,
      run: (context: LatestAsyncRunContext) => Promise<void>,
    ) => (
      createLatestAsyncScheduler({
        raf: (cb) => window.requestAnimationFrame(cb),
        cancelRaf: (handle) => window.cancelAnimationFrame(handle),
        run,
        onError: (error) => {
          if (import.meta.env.DEV) console.debug(`[viewer] ${label} scheduler failed`, error);
        },
      })
    );
    const baseScheduler = makeScheduler('base appearance', rebuildCoordinatedBaseAppearance);
    const resultScheduler = makeScheduler('result highlight', rebuildCoordinatedResultHighlights);
    const selectionScheduler = makeScheduler('selection highlight', rebuildCoordinatedSelection);
    const schedulers = [baseScheduler, resultScheduler, selectionScheduler];
    for (const scheduler of schedulers) latestAsyncSchedulersRef.current.add(scheduler);
    rebuildSchedulerRef.current = selectionScheduler;

    const unsubscribers = [
      useStore.subscribe((state) => state.colourBy, baseScheduler.schedule),
      useStore.subscribe((state) => state.spatialTree, baseScheduler.schedule),
      useStore.subscribe((state) => state.colourLayers, baseScheduler.schedule),
      useStore.subscribe((state) => state.highlightedIds, resultScheduler.schedule),
      useStore.subscribe((state) => state.selectedElementId, selectionScheduler.schedule),
      useStore.subscribe((state) => state.selectedIds, selectionScheduler.schedule),
    ];
    baseScheduler.schedule();
    resultScheduler.schedule();
    selectionScheduler.schedule();

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const scheduler of schedulers) {
        const shutdown = scheduler.shutdown();
        void shutdown.finally(() => latestAsyncSchedulersRef.current.delete(scheduler));
      }
      if (rebuildSchedulerRef.current === selectionScheduler) {
        rebuildSchedulerRef.current = null;
      }
    };
  }, [
    viewerReady,
    rebuildCoordinatedBaseAppearance,
    rebuildCoordinatedResultHighlights,
    rebuildCoordinatedSelection,
  ]);

  // Tear down the optional whole-model LOD swap between model sessions.
  useEffect(() => () => {
    try { lodCleanupRef.current?.(); } catch { /* best-effort */ }
    lodCleanupRef.current = null;
  }, []);

  // Ghost mode for focused selection: use native setOpacity instead of
  // traversing THREE.js materials directly (avoids transparency-sort flickering).
  //
  // Performance strategy:
  //   1. Early-exit when nothing changed (mode='off' AND nothing applied).
  //   2. Cache `model.getLocalIds()` - the full id list is immutable per
  //      model load, so we only fetch it once instead of once per change.
  //   3. Apply only the *delta* between the previous focus set and the new
  //      one - `setOpacity` on a few elements is fast; `setOpacity` on
  //      thousands every selection click was the main slowness.
  //   4. rAF-coalesce slider drags via
  //      `createLatestAsyncScheduler`. Profiling measured up to ~60
  //      `selectionGhostOpacity` writes/second during a continuous drag,
  //      each one firing a fresh fire-and-forget `apply()` that raced
  //      worker round-trips. The scheduler caps that at one apply per
  //      rAF and reads the latest opacity from `useStore.getState()` at
  //      apply time, so a 60-tick burst inside one frame collapses to a
  //      single `setOpacity` at the final value.
  useEffect(() => {
    if (!viewerReady) return;

    const applyCoordinatedFocusOpacity = async (run: LatestAsyncRunContext) => {
      const coordinator = renderStateCoordinatorRef.current;
      const refs = viewerRef.current;
      if (!coordinator || !refs || !useStore.getState().modelLoaded) return;
      const isStale = () => (
        run.isSuperseded()
        || renderStateCoordinatorRef.current !== coordinator
        || viewerRef.current !== refs
      );
      const state = useStore.getState();
      const focusExpressIds = new Set<number>();
      if (state.selectedElementId != null) focusExpressIds.add(state.selectedElementId);
      for (const id of state.selectedIds) focusExpressIds.add(id);
      for (const id of state.highlightedIds) focusExpressIds.add(id);
      const shouldGhost = state.selectionFocusMode === 'ghost' && focusExpressIds.size > 0;

      if (!shouldGhost) {
        if (isStale()) return;
        await coordinator.setOpacityLayer('opacity:selection-focus', null, 1, {
          urgency: 'visual',
          reason: 'opacity:selection-focus-clear',
        });
        return;
      }

      let allLocalIds = allLocalIdsCacheRef.current;
      if (!allLocalIds) {
        allLocalIds = await refs.model.getLocalIds();
        if (isStale()) return;
        allLocalIdsCacheRef.current = allLocalIds;
      }
      const focusLocal = new Set(await expressToLocalIds(refs.model, [...focusExpressIds]));
      if (isStale()) return;
      const ghosted: number[] = [];
      for (const id of allLocalIds) if (!focusLocal.has(id)) ghosted.push(id);
      await coordinator.setOpacityLayer(
        'opacity:selection-focus',
        ghosted,
        state.selectionGhostOpacity,
        { urgency: 'frame', reason: 'opacity:selection-focus' },
      );
    };

    const scheduler = createLatestAsyncScheduler({
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle),
      run: applyCoordinatedFocusOpacity,
      onError: (error) => {
        if (import.meta.env.DEV) console.debug('[viewer] focus opacity scheduler failed', error);
      },
    });
    latestAsyncSchedulersRef.current.add(scheduler);
    const u1 = useStore.subscribe((s) => s.selectedElementId, scheduler.schedule);
    const u2 = useStore.subscribe((s) => s.highlightedIds, scheduler.schedule);
    const u3 = useStore.subscribe((s) => s.selectedIds, scheduler.schedule);
    const u4 = useStore.subscribe((s) => s.selectionFocusMode, scheduler.schedule);
    const u5 = useStore.subscribe((s) => s.selectionGhostOpacity, scheduler.schedule);
    // Evaluate the current focus state on mount.
    scheduler.schedule();

    return () => {
      u1(); u2(); u3(); u4(); u5();
      const shutdown = scheduler.shutdown();
      void shutdown.finally(() => latestAsyncSchedulersRef.current.delete(scheduler));
    };
  }, [viewerReady, expressToLocalIds, requestFragmentUpdate]);

  // Visibility changes (isolate / hide), coalesced into one rebuild per frame.
  useEffect(() => {
    if (!viewerReady) return;
    const applyCoordinatedVisibility = async (run: LatestAsyncRunContext) => {
      const coordinator = renderStateCoordinatorRef.current;
      const refs = viewerRef.current;
      if (!coordinator || !refs || !useStore.getState().modelLoaded) return;
      const isStale = () => (
        run.isSuperseded()
        || renderStateCoordinatorRef.current !== coordinator
        || viewerRef.current !== refs
      );
      const state = useStore.getState();
      let userHiddenLocal: number[] = [];
      let isolateGhostLocal: number[] | null = null;

      if (state.isolatedIds.length > 0) {
        let allLocalIds = allLocalIdsCacheRef.current;
        if (!allLocalIds) {
          allLocalIds = await refs.model.getLocalIds();
          if (isStale()) return;
          allLocalIdsCacheRef.current = allLocalIds;
        }
        const isolatedLocal = new Set(await expressToLocalIds(refs.model, state.isolatedIds));
        if (isStale()) return;
        if (isolatedLocal.size === 0) {
          // Stale express IDs (for example after a revision) must never turn
          // into "hide every local ID". Clear the renderer mask while keeping
          // the semantic selection available for diagnostics.
          if (import.meta.env.DEV) {
            console.warn('[viewer] isolate request resolved to no local IDs; visibility left intact');
          }
        } else {
          const outsideIsolation: number[] = [];
          for (const id of allLocalIds) if (!isolatedLocal.has(id)) outsideIsolation.push(id);
          if (state.ghostModeOn) isolateGhostLocal = outsideIsolation;
          else userHiddenLocal = outsideIsolation;
        }
      } else if (state.hiddenIds.length > 0) {
        userHiddenLocal = await expressToLocalIds(refs.model, state.hiddenIds);
        if (isStale()) return;
      }

      const hasUserVisibilityPolicy = state.isolatedIds.length > 0 || state.hiddenIds.length > 0;
      if (hasUserVisibilityPolicy) {
        // The patch below releases the actual culler masks atomically. Reset
        // local ownership in the same turn so the next post-policy settle
        // recomputes a fresh verdict instead of trusting stale flags.
        storeyFrustumCullerRef.current?.releaseOwnership();
        elementFrustumCullerRef.current?.releaseOwnership();
        spatialTileCullerRef.current?.releaseOwnership();
      }
      if (isStale()) return;
      await coordinator.update({
        visibility: [
          { layer: 'visibility:user', hiddenIds: userHiddenLocal },
          // Culling is a performance hint, never a semantic override. Release
          // stale masks atomically whenever the user hides or isolates.
          ...(hasUserVisibilityPolicy
            ? [
                { layer: 'culler:storey', hiddenIds: null },
                { layer: 'culler:element', hiddenIds: null },
                { layer: 'culler:spatial-tiles', hiddenIds: null },
              ]
            : []),
        ],
        opacity: [{
          layer: 'opacity:isolation-ghost',
          ids: isolateGhostLocal,
          opacity: GHOST_ISOLATION_OPACITY,
        }],
      }, {
        urgency: 'visual',
        reason: 'visibility:user',
      });
    };

    const scheduler = createLatestAsyncScheduler({
      raf: (cb) => window.requestAnimationFrame(cb),
      cancelRaf: (handle) => window.cancelAnimationFrame(handle),
      run: applyCoordinatedVisibility,
    });
    latestAsyncSchedulersRef.current.add(scheduler);
    const repairVisibility = async () => {
      const coordinator = renderStateCoordinatorRef.current;
      if (!coordinator) return;
      await coordinator.repair({ urgency: 'visual', reason: 'visibility:repair' });
    };
    visibilityRepairRef.current = repairVisibility;
    const unsubIso = useStore.subscribe((state) => state.isolatedIds, scheduler.schedule);
    const unsubHide = useStore.subscribe((state) => state.hiddenIds, scheduler.schedule);
    const unsubGhost = useStore.subscribe((state) => state.ghostModeOn, scheduler.schedule);
    scheduler.schedule();

    return () => {
      if (visibilityRepairRef.current === repairVisibility) {
        visibilityRepairRef.current = null;
      }
      unsubIso();
      unsubHide();
      unsubGhost();
      const shutdown = scheduler.shutdown();
      void shutdown.finally(() => latestAsyncSchedulersRef.current.delete(scheduler));
    };
  }, [viewerReady, expressToLocalIds, requestFragmentUpdate]);

  // Clip planes are controller-owned; store updates are consumed transiently.
  const updateClipPlane = useStore((s) => s.updateClipPlane);
  const clipControllerRef = useRef<ClipPlaneController | null>(null);
  const clipEdgesServiceRef = useRef<ClipEdgesService | null>(null);
  const sectionBoxEnabled = useStore((s) => s.sectionBoxEnabled);
  const sectionWorkspace = useStore((s) => s.sectionWorkspace);
  const setSectionWorkspace = useStore((s) => s.setSectionWorkspace);
  const toggleSectionBox = useStore((s) => s.toggleSectionBox);
  const sectionBoxControllerRef = useRef<SectionBoxController | null>(null);
  const sectionWorkspaceControllerRef = useRef<LatestSectionWorkspaceController | null>(null);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { components, world, modelCenter } = viewerRef.current;
    const clipper = components.get(OBC.Clipper);
    const edgesService = new ClipEdgesService(components, world as unknown as OBC.World);
    clipEdgesServiceRef.current = edgesService;
    const controller = new ClipPlaneController(clipper, world as unknown as OBC.World, modelCenter, {
      onOffsetChanged: (id, offset) => updateClipPlane(id, { offset }),
      clipEdgesService: edgesService,
    });
    clipControllerRef.current = controller;
    return () => {
      controller.dispose();
      edgesService.dispose();
      clipControllerRef.current = null;
      clipEdgesServiceRef.current = null;
    };
  }, [viewerReady, updateClipPlane]);

  // Section box controller for the viewer lifetime.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { components, world, modelCenter } = viewerRef.current;
    const clipper = components.get(OBC.Clipper);
    const ctrl = new SectionBoxController(clipper, world as unknown as OBC.World);
    const workspaceCtrl = new LatestSectionWorkspaceController({
      apply: (definition, context) => {
        if (context.isSuperseded()) return;
        const boxDefinition = definition.box;
        if (boxDefinition?.enabled) {
          const [minX, minY, minZ, maxX, maxY, maxZ] = boxDefinition.bounds;
          ctrl.enable(new THREE.Box3(
            new THREE.Vector3(minX, minY, minZ),
            new THREE.Vector3(maxX, maxY, maxZ),
          ));
          clipper.enabled = true;
        } else {
          ctrl.disable();
        }
        // Workspace planes are durable world-space definitions; the clip-plane
        // sync effect consumes the reconciled store planes and re-enables the
        // shared clipper, so no direct controller write happens here.
        useStore.getState().applyWorkspaceClipPlanes(toRelativeClipPlaneStates(
          definition,
          [modelCenter.x, modelCenter.y, modelCenter.z],
        ));
        requestFragmentUpdate('manual', false, 'camera');
      },
      onError: (error) => console.warn('Section workspace apply failed:', error),
    });
    sectionBoxControllerRef.current = ctrl;
    sectionWorkspaceControllerRef.current = workspaceCtrl;
    return () => {
      void workspaceCtrl.shutdown();
      ctrl.dispose();
      sectionBoxControllerRef.current = null;
      sectionWorkspaceControllerRef.current = null;
    };
  }, [viewerReady, requestFragmentUpdate]);

  useEffect(() => {
    const controller = clipControllerRef.current;
    if (!controller) return;
    // Drag frames repaint cheaply; the delayed commit refreshes fragment state once.
    let commitTimer: number | null = null;
    const syncPlanes = (planes: Parameters<ClipPlaneController['sync']>[0]) => {
      controller.sync(planes);
      // Keep the shared clipper enabled while the section box is active.
      if (sectionBoxEnabled && viewerRef.current) {
        viewerRef.current.components.get(OBC.Clipper).enabled = true;
      }
      requestFragmentUpdate('manual', false, 'camera');
      if (commitTimer !== null) window.clearTimeout(commitTimer);
      commitTimer = window.setTimeout(() => {
        commitTimer = null;
        requestFragmentUpdate('manual');
      }, 160);
    };
    syncPlanes(useStore.getState().clipPlanes);
    const unsubscribe = useStore.subscribe((s) => s.clipPlanes, syncPlanes);
    return () => {
      unsubscribe();
      if (commitTimer !== null) {
        window.clearTimeout(commitTimer);
        commitTimer = null;
      }
    };
  }, [viewerReady, sectionBoxEnabled, requestFragmentUpdate]);

  // Apply the durable section workspace. The bounds that produced a selection
  // or storey crop remain authoritative while the box is toggled, so enabling
  // can never replace them with the full-model AABB.
  useEffect(() => {
    const workspaceCtrl = sectionWorkspaceControllerRef.current;
    const refs = viewerRef.current;
    if (!workspaceCtrl || !refs) return;

    let workspace = sectionWorkspace;
    if (sectionBoxEnabled && !workspace?.box) {
      const { modelCenter: c, modelSize: s } = refs;
      const half = s.clone().multiplyScalar(0.5);
      const min = c.clone().sub(half);
      const max = c.clone().add(half);
      workspace = createSectionWorkspace({
        id: 'model-bounds',
        name: 'Full model section box',
        source: 'custom',
        planes: [],
        box: { enabled: true, bounds: [min.x, min.y, min.z, max.x, max.y, max.z] },
      });
      setSectionWorkspace(workspace);
    }

    const desired = workspace
      ? createSectionWorkspace({
          id: workspace.id,
          name: workspace.name,
          source: workspace.source,
          planes: workspace.planes,
          box: workspace.box
            ? { ...workspace.box, enabled: sectionBoxEnabled }
            : null,
        })
      : createSectionWorkspace({
          id: 'section-off',
          name: 'Section box off',
          source: 'custom',
          planes: [],
          box: null,
        });
    void workspaceCtrl.setDefinition(desired).catch(() => {});
  }, [sectionBoxEnabled, sectionWorkspace, setSectionWorkspace]);

  // Alt+B toggles the section box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'b') return;
      // Avoid hijacking text fields.
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      toggleSectionBox();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleSectionBox]);

  // Alt+X clips the section box to the selected element.
  useEffect(() => {
    if (!viewerReady) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'x') return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const { selectedElementId, selectedIds, clipToElementFn, clipToElementsFn } = useStore.getState();
      if (selectedIds.length > 0 && clipToElementsFn) {
        clipToElementsFn(selectedIds, `${selectedIds.length} selected elements`);
      } else if (selectedElementId != null && clipToElementFn) {
        clipToElementFn(selectedElementId);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewerReady]);

  // Measurement tool: the controller owns scene state; Zustand owns preferences.
  const measurementMode = useStore((s) => s.measurement.mode);
  const measurementUnit = useStore((s) => s.measurement.unit);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);
  const editMode = useStore((s) => s.editMode);
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const pickPlaneMode = useStore((s) => s.pickPlaneMode);
  const measurementControllerRef = useRef<MeasurementController | null>(null);
  const clearanceFirstTriangleRef = useRef<Triangle3 | null>(null);
  const [measurementSnapshot, setMeasurementSnapshot] = useState<MeasurementSnapshot | null>(null);

  /** Active furnishing merge, disposed on toggle-off. */
  const furnishingMergeLifecycleRef = useRef<FurnishingMergeLifecycle | null>(null);
  const furnishingMergeShutdownRef = useRef<Promise<void> | null>(null);

  /** Per-storey AABB frustum culler. */
  const storeyFrustumCullerRef = useRef<StoreyFrustumCuller | null>(null);
  const elementFrustumCullerRef = useRef<ElementFrustumCuller | null>(null);
  const spatialTileCullerRef = useRef<SpatialTileVisibilityController | null>(null);
  const storeyCullerEpochRef = useRef(0);
  const elementCullerEpochRef = useRef(0);
  const spatialTileCullerEpochRef = useRef(0);
  const storeyCullerTransitionRef = useRef<Promise<void>>(Promise.resolve());
  const elementCullerTransitionRef = useRef<Promise<void>>(Promise.resolve());
  const spatialTileCullerTransitionRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { world, model } = viewerRef.current;
    const scene = world.scene.three as THREE.Scene;
    const controller = new MeasurementController(scene, model, {
      onChange: (snap) => setMeasurementSnapshot(snap),
    });
    measurementControllerRef.current = controller;
    // Seed the HUD with an empty snapshot.
    setMeasurementSnapshot(controller.snapshot());
    return () => {
      controller.dispose();
      measurementControllerRef.current = null;
      setMeasurementSnapshot(null);
      // Reset store mode so the next mount does not inherit measurement clicks.
      useStore.getState().setMeasurementMode('off');
    };
  }, [viewerReady]);

  useEffect(() => {
    const controller = measurementControllerRef.current;
    if (!controller) return;
    clearanceFirstTriangleRef.current = null;
    controller.setMode(measurementMode);
  }, [measurementMode]);

  // B5 mount point: wall drawing tool (Edit mode). ViewerPanel only owns the
  // instance lifetime - same seam as the MeasurementController above. The ref
  // feeds the pointer-up click hub; the state feeds the EditToolbar overlay.
  const wallDrawControllerRef = useRef<WallDrawController | null>(null);
  const [wallDrawController, setWallDrawController] = useState<WallDrawController | null>(null);
  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !editModeAvailable || !editMode) return;
    const { world } = viewerRef.current;
    const controller = new WallDrawController({
      scene: world.scene.three as THREE.Scene,
      dom: world.renderer!.three.domElement,
      getCamera: () => world.camera.three as THREE.Camera,
      onPreviewChange: () => requestViewerRender(80),
      onArm: () => {
        const state = useStore.getState();
        state.setMeasurementMode('off');
        state.setPickPlaneMode(false);
      },
    });
    wallDrawControllerRef.current = controller;
    setWallDrawController(controller);
    return () => {
      controller.dispose();
      wallDrawControllerRef.current = null;
      setWallDrawController(null);
    };
  }, [viewerReady, editModeAvailable, editMode, requestViewerRender]);

  useEffect(() => {
    if (measurementMode !== 'off') wallDrawControllerRef.current?.disarm();
  }, [measurementMode]);

  useEffect(() => {
    if (pickPlaneMode) wallDrawControllerRef.current?.disarm();
  }, [pickPlaneMode]);

  // Escape cancels pending measurement points, then exits the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ctrl = measurementControllerRef.current;
      if (!ctrl || ctrl.getMode() === 'off') return;
      const snap = ctrl.snapshot();
      if (snap.pending.length > 0) {
        e.stopPropagation();
        clearanceFirstTriangleRef.current = null;
        ctrl.cancel();
      } else {
        e.stopPropagation();
        setMeasurementMode('off');
      }
    };
    // Capture phase keeps measurement Escape handling ahead of global shortcuts.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setMeasurementMode]);

  /** Apply theme colors to the live 3D scene. */
  const applyTheme = useCallback((theme: ViewerTheme) => {
    const targets = sceneThemeTargetsRef.current ?? viewerRef.current;
    if (!targets) return;

    applySceneTheme(targets.world, targets.grid, theme);

    // Background and grid color changes render on the next normal tick.
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  // Grid visibility mirrors the persisted viewer preference.
  const gridVisible = useStore((s) => s.gridVisible);
  // Frustum-culling master switch from Settings > Performance.
  const frustumCullingEnabled = useStore((s) => s.frustumCullingEnabled);
  const modelFingerprint = useStore((s) => s.modelFingerprint);
  useEffect(() => {
    if (!viewerReady) return;
    const gridObj = viewerRef.current?.grid?.three;
    if (gridObj) {
      gridObj.visible = gridVisible;
    }
  }, [viewerReady, gridVisible]);

  // Furnishing merge replaces furnishing meshes with one static mesh.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current) return;
    const { model, world } = viewerRef.current;
    const scene = world.scene.three as THREE.Scene;
    let active = true;
    const lifecycle = new FurnishingMergeLifecycle({
      apply: (signal) => applyFurnishingMerge(
        model,
        scene,
        signal,
        furnishingVisibilityRef.current ?? model,
      ),
      afterUnmerge: async () => {
        if (!active) return;
        // Furnishing disposal restores its source ids directly. First release
        // app-culler ownership so their autoCulled flags cannot claim ids that
        // were just made visible, then rebuild the authoritative user policy.
        const storeyCuller = storeyFrustumCullerRef.current;
        const elementCuller = elementFrustumCullerRef.current;
        const spatialTileCuller = spatialTileCullerRef.current;
        if (spatialTileCuller?.isBuilt) {
          await spatialTileCuller.clearCull(spatialTileVisibilityRef.current ?? model);
        } else if (storeyCuller?.isBuilt) {
          await storeyCuller.clearCull(model, storeyCullerVisibilityRef.current ?? model);
        }
        if (!spatialTileCuller?.isBuilt && elementCuller?.isBuilt) {
          await elementCuller.clearCull(model, elementCullerVisibilityRef.current ?? model);
        }
        await visibilityRepairRef.current?.();

        const state = useStore.getState();
        let culledStoreys = 0;
        let culledElements = 0;
        if (state.isolatedIds.length === 0 && state.hiddenIds.length === 0) {
          const camera = world.camera.three as THREE.Camera;
          if (spatialTileCuller?.isBuilt) {
            // Mirror getSpatialTileViewOptions: the selection's tile stays
            // pinned through this idle hide pass.
            const selectedExpressIds = new Set<number>([
              ...state.selectedIds,
              ...(state.selectedElementId == null ? [] : [state.selectedElementId]),
            ]);
            const pinnedLocalIds = new Set<number>();
            for (const expressId of selectedExpressIds) {
              const localId = expressToLocalCacheRef.current.get(expressId)
                ?? modelService.getRememberedLocalId(expressId)
                ?? undefined;
              if (localId !== undefined) pinnedLocalIds.add(localId);
            }
            const result = await spatialTileCuller.tick(
              camera,
              spatialTileVisibilityRef.current ?? model,
              {
                pinnedLocalIds,
                viewportHeightPx: world.renderer?.three.domElement.clientHeight
                  || containerRef.current?.clientHeight
                  || window.innerHeight,
              },
            );
            culledElements = result.hiddenElementCount;
          } else if (storeyCuller?.isBuilt) {
            culledStoreys = await storeyCuller.tick(
              camera,
              model,
              storeyCullerVisibilityRef.current ?? model,
            );
          }
          if (!spatialTileCuller?.isBuilt && elementCuller?.isBuilt) {
            const ownedByStorey = storeyCuller?.isBuilt
              ? new Set(storeyCuller.getCulledMemberIds())
              : undefined;
            culledElements = await elementCuller.tick(
              camera,
              model,
              ownedByStorey,
              elementCullerVisibilityRef.current ?? model,
            );
          }
        }
        if (spatialTileCuller?.isBuilt || storeyCuller?.isBuilt || elementCuller?.isBuilt) {
          useStore.getState().updatePerfMetrics({ culledStoreys, culledElements });
        }

        // Keep all repairs inside the serialized lifecycle. A new merge cannot
        // start until culling, visibility, and durable highlight layers settle.
        rebuildSchedulerRef.current?.schedule();
        requestFragmentUpdate('manual');
      },
      onStateChange: () => {
        if (!active) return;
        // A merge/unmerge swaps fragments under an unchanged camera, which
        // the exact-hover/prefetch reuse guards cannot detect on their own.
        pointerPickCachesInvalidateRef.current?.();
        // Keep an unstyled LOD proxy out of the scene for the whole merge /
        // unmerge transition, not just while the persisted toggle is true.
        navigationLodAppearanceRefreshRef.current?.();
        requestFragmentUpdate('manual');
      },
    });
    furnishingMergeLifecycleRef.current = lifecycle;
    const canMergeForState = (state: ReturnType<typeof useStore.getState>) => (
      canUseFurnishingMerge({
        enabled: state.furnishingMerged,
        isolatedCount: state.isolatedIds.length,
        hiddenCount: state.hiddenIds.length,
        ghostModeOn: state.ghostModeOn,
        selectedElementId: state.selectedElementId,
        selectedCount: state.selectedIds.length,
        highlightedCount: state.highlightedIds.length,
        colourBy: state.colourBy,
        colourLayerCount: Object.keys(state.colourLayers).length,
        hoverHighlightEnabled: state.hoverHighlightEnabled,
        measurementMode: state.measurement.mode,
      })
    );
    const reconcileDesiredState = (enabled: boolean) => {
      void lifecycle.setDesired(enabled && !exactPickLeaseRef.current?.active);
    };
    const refreshDesiredState = () => {
      reconcileDesiredState(canMergeForState(useStore.getState()));
    };
    furnishingMergeDesiredRefreshRef.current = refreshDesiredState;
    const unsubscribe = useStore.subscribe(
      canMergeForState,
      reconcileDesiredState,
      { fireImmediately: true },
    );
    return () => {
      active = false;
      unsubscribe();
      if (furnishingMergeDesiredRefreshRef.current === refreshDesiredState) {
        furnishingMergeDesiredRefreshRef.current = null;
      }
      if (furnishingMergeLifecycleRef.current === lifecycle) {
        furnishingMergeLifecycleRef.current = null;
      }
      const shutdown = lifecycle.shutdown();
      furnishingMergeShutdownRef.current = shutdown;
      const clearShutdownRef = () => {
        if (furnishingMergeShutdownRef.current === shutdown) {
          furnishingMergeShutdownRef.current = null;
        }
      };
      void shutdown.then(clearShutdownRef, clearShutdownRef);
      navigationLodAppearanceRefreshRef.current?.();
    };
  }, [viewerReady, requestFragmentUpdate]);

  // Storey AABB frustum culler builds when model and tree are ready.
  const spatialTree = useStore((s) => s.spatialTree);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;
    let cancelled = false;

    // Backend metadata mode can seed the express-to-local cache directly.
    const bridgeEntries = modelService.getIdBridgeEntries();
    if (bridgeEntries && bridgeEntries.length > 0) {
      const cache = expressToLocalCacheRef.current;
      for (const [localId, expressId] of bridgeEntries) {
        if (!cache.has(expressId)) cache.set(expressId, localId);
      }
      return;
    }

    const expressIds = collectLeavesUnder(spatialTree);
    void prewarmExpressToLocalCache(model, expressIds, expressToLocalCacheRef.current, {
      batchSize: 16,
      isCancelled: () => cancelled || viewerRef.current?.model !== model,
      yieldAfterBatch: () => new Promise<void>((resolve) => {
        window.setTimeout(resolve, 8);
      }),
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [viewerReady, spatialTree]);

  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;
    const epoch = ++storeyCullerEpochRef.current;
    const prev = storeyFrustumCullerRef.current;
    storeyFrustumCullerRef.current = null;
    const storeyNodes = extractStoreyNodes(spatialTree);
    const totalLeaves = collectLeavesUnder(spatialTree).length;
    const policy = decideCullerPolicy({
      navigationState: 'idle',
      elementCount: totalLeaves,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: true,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    });
    const shouldBuild = frustumCullingEnabled
      && storeyNodes.length >= 2
      && policy.storeyCullerEnabled;
    const install = async () => {
      if (prev) {
        await prev.dispose(model, storeyCullerVisibilityRef.current ?? model).catch(() => {});
      }
      if (!shouldBuild || epoch !== storeyCullerEpochRef.current) return;
      const culler = new StoreyFrustumCuller({ padFraction: 0.03 });
      storeyFrustumCullerRef.current = culler;
      await culler.build(model, storeyNodes, expressToLocalCacheRef.current).catch(() => {});
      if (epoch !== storeyCullerEpochRef.current) {
        if (storeyFrustumCullerRef.current === culler) storeyFrustumCullerRef.current = null;
        await culler.dispose();
      }
    };
    const transition = storeyCullerTransitionRef.current
      .catch(() => {})
      .then(install);
    storeyCullerTransitionRef.current = transition;
    return () => {
      if (storeyCullerEpochRef.current === epoch) storeyCullerEpochRef.current += 1;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady, spatialTree, frustumCullingEnabled]);

  // Element-level AABB frustum culler.
  useEffect(() => {
    if (!viewerReady || !viewerRef.current || !spatialTree) return;
    const { model } = viewerRef.current;
    const epoch = ++elementCullerEpochRef.current;
    const prev = elementFrustumCullerRef.current;
    elementFrustumCullerRef.current = null;
    const allExpressIds = collectLeavesUnder(spatialTree);
    const policy = decideCullerPolicy({
      navigationState: 'idle',
      elementCount: allExpressIds.length,
      isolatedCount: 0,
      hiddenCount: 0,
      storeyCullerBuilt: false,
      elementCullerBuilt: true,
      autoCulledCount: 0,
    });
    const shouldBuild = frustumCullingEnabled && policy.elementCullerEnabled;
    const buildAsync = async () => {
      if (prev) {
        await prev.dispose(model, elementCullerVisibilityRef.current ?? model).catch(() => {});
      }
      if (!shouldBuild || epoch !== elementCullerEpochRef.current) return;
      const culler = new ElementFrustumCuller({ padFraction: 0.03 });
      elementFrustumCullerRef.current = culler;
      try {
        const localIds = await expressToLocalIds(model, allExpressIds);
        if (localIds.length > 0 && epoch === elementCullerEpochRef.current) {
          await culler.build(model, localIds);
        }
      } catch { /* build failure is silent */ }
      if (epoch !== elementCullerEpochRef.current) {
        if (elementFrustumCullerRef.current === culler) elementFrustumCullerRef.current = null;
        await culler.dispose();
      }
    };
    const transition = elementCullerTransitionRef.current
      .catch(() => {})
      .then(buildAsync);
    elementCullerTransitionRef.current = transition;
    return () => {
      if (elementCullerEpochRef.current === epoch) elementCullerEpochRef.current += 1;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerReady, spatialTree, frustumCullingEnabled]);

  // Prefer backend-preprocessed, geometry-derived tiles when available. This
  // replaces the client geometry scan above for large models, but keeps those
  // cullers as a safe fallback while upload/AABB preprocessing is still warm.
  useEffect(() => {
    const epoch = ++spatialTileCullerEpochRef.current;
    const previous = spatialTileCullerRef.current;
    spatialTileCullerRef.current = null;
    const abort = new AbortController();
    const model = viewerRef.current?.model ?? null;
    const shouldBuild = viewerReady
      && !!model
      && !BROWSER_ONLY
      && frustumCullingEnabled
      && !!modelFingerprint;

    const waitForRetry = (delayMs: number) => new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      const timer = window.setTimeout(done, delayMs);
      function done() {
        window.clearTimeout(timer);
        abort.signal.removeEventListener('abort', done);
        resolve();
      }
      abort.signal.addEventListener('abort', done, { once: true });
    });

    const install = async () => {
      if (previous) {
        await previous.dispose(spatialTileVisibilityRef.current ?? undefined).catch(() => {});
      }
      if (!shouldBuild || !model || abort.signal.aborted
        || epoch !== spatialTileCullerEpochRef.current) return;

      const retryDelays = [750, 1_500, 3_000, 5_000, 8_000, 8_000, 8_000];
      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        if (abort.signal.aborted || epoch !== spatialTileCullerEpochRef.current) return;
        try {
          const dto = await getSpatialTileManifest(4, { signal: abort.signal });
          const currentFingerprint = useStore.getState().modelFingerprint;
          // Placement points are not conservative bounds. Wait for the real
          // geometry AABB sidecar rather than risking false-negative culls.
          if (dto.aabb_source !== 'real' || dto.source_sha256 !== currentFingerprint) {
            if (attempt < retryDelays.length) await waitForRetry(retryDelays[attempt]);
            continue;
          }

          const expressIds = [...new Set(dto.tiles.flatMap((tile) => tile.element_ids))];
          await expressToLocalIds(model, expressIds);
          if (abort.signal.aborted || epoch !== spatialTileCullerEpochRef.current) return;

          // IfcOpenShell reports IFC world coordinates, while a fragment may
          // be axis-converted or auto-coordinated. Keep backend membership but
          // prove each active tile's bounds in the mounted renderer space.
          const rebased = await rebaseSpatialTileManifestBounds(
            dto,
            expressToLocalCacheRef.current,
            async (localIds) => {
              const box = await model.getMergedBox([...localIds]);
              if (!box || box.isEmpty()) return null;
              return [
                box.min.x, box.min.y, box.min.z,
                box.max.x, box.max.y, box.max.z,
              ];
            },
            {
              batchSize: 8,
              isCancelled: () => (
                abort.signal.aborted || epoch !== spatialTileCullerEpochRef.current
              ),
              yieldAfterBatch: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
            },
          );
          if (abort.signal.aborted || epoch !== spatialTileCullerEpochRef.current) return;
          const adapted = adaptSpatialTileManifest(rebased.manifest, {
            mountedFingerprint: currentFingerprint,
            expressToLocal: expressToLocalCacheRef.current,
          });
          const controller = new SpatialTileVisibilityController(
            new SpatialTileLodService(adapted.manifest),
            { padFraction: 0.03 },
          );
          if (!controller.isBuilt) return;

          // One visibility owner at a time. Let any fallback build settle,
          // clear its mask, and then install the preprocessed tile controller.
          await Promise.all([
            storeyCullerTransitionRef.current.catch(() => {}),
            elementCullerTransitionRef.current.catch(() => {}),
          ]);
          if (abort.signal.aborted || epoch !== spatialTileCullerEpochRef.current) {
            await controller.dispose();
            return;
          }
          const storey = storeyFrustumCullerRef.current;
          const element = elementFrustumCullerRef.current;
          storeyFrustumCullerRef.current = null;
          elementFrustumCullerRef.current = null;
          if (storey) {
            await storey.dispose(model, storeyCullerVisibilityRef.current ?? model).catch(() => {});
          }
          if (element) {
            await element.dispose(model, elementCullerVisibilityRef.current ?? model).catch(() => {});
          }

          spatialTileCullerRef.current = controller;
          try {
            const state = useStore.getState();
            if (state.isolatedIds.length === 0 && state.hiddenIds.length === 0) {
              const selectedExpressIds = new Set<number>([
                ...state.selectedIds,
                ...(state.selectedElementId == null ? [] : [state.selectedElementId]),
              ]);
              const pinnedLocalIds = new Set<number>();
              for (const expressId of selectedExpressIds) {
                const localId = expressToLocalCacheRef.current.get(expressId);
                if (localId !== undefined) pinnedLocalIds.add(localId);
              }
              const viewportHeightPx = viewerRef.current?.world.renderer?.three.domElement.clientHeight
                || containerRef.current?.clientHeight
                || window.innerHeight;
              const result = await controller.tick(
                viewerRef.current!.world.camera.three as THREE.Camera,
                spatialTileVisibilityRef.current ?? model,
                { pinnedLocalIds, viewportHeightPx },
              );
              useStore.getState().updatePerfMetrics({
                culledStoreys: 0,
                culledElements: result.hiddenElementCount,
              });
            }
          } catch (tickError) {
            // The controller is installed and owns the visibility layer; the
            // next camera settle re-applies the hide pass. Retrying the whole
            // install would orphan this controller's hides in the shared layer.
            if (import.meta.env.DEV) {
              console.debug('[viewer] initial spatial tile tick deferred', tickError);
            }
          }
          useStore.getState().logActivity({
            kind: 'info',
            summary: `Spatial viewer index ready: ${controller.tileCount} tiles, ${adapted.mappedElements} stable elements.`,
            detail: adapted.unresolvedExpressIds.length > 0 || rebased.failedExpressIds.length > 0
              ? `${new Set([
                  ...adapted.unresolvedExpressIds,
                  ...rebased.failedExpressIds,
                ]).size} elements remain conservatively resident.`
              : 'Geometry remains mounted; visibility and LOD decisions are state-only.',
          });
          return;
        } catch (error) {
          if (abort.signal.aborted) return;
          if (attempt >= retryDelays.length) {
            if (import.meta.env.DEV) {
              console.debug('[viewer] preprocessed spatial tiles unavailable; retaining client culler', error);
            }
            return;
          }
          await waitForRetry(retryDelays[attempt]);
        }
      }
    };

    const transition = spatialTileCullerTransitionRef.current
      .catch(() => {})
      .then(install);
    spatialTileCullerTransitionRef.current = transition;
    return () => {
      abort.abort();
      if (spatialTileCullerEpochRef.current === epoch) spatialTileCullerEpochRef.current += 1;
    };
  }, [
    viewerReady,
    frustumCullingEnabled,
    modelFingerprint,
    expressToLocalIds,
  ]);

  // Tree/AI selection can target a tile that is currently outside the camera
  // frustum. Reveal its exact LOD0 immediately and keep highlight state intact.
  useEffect(() => useStore.subscribe(
    (state) => ({
      selectedElementId: state.selectedElementId,
      selectedIds: state.selectedIds,
    }),
    ({ selectedElementId, selectedIds }) => {
      const controller = spatialTileCullerRef.current;
      const target = spatialTileVisibilityRef.current;
      const model = viewerRef.current?.model;
      if (!controller?.isBuilt || !target || !model) return;
      const expressIds = [...new Set([
        ...selectedIds,
        ...(selectedElementId == null ? [] : [selectedElementId]),
      ])];
      if (expressIds.length === 0) return;
      void expressToLocalIds(model, expressIds)
        .then((localIds) => controller.revealLocalIds(new Set(localIds), target))
        .catch(() => {});
    },
    { equalityFn: (a, b) => (
      a.selectedElementId === b.selectedElementId
      && a.selectedIds === b.selectedIds
    ) },
  ), [expressToLocalIds]);

  const computeFitDistance = useCallback(
    (
      camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
      size: THREE.Vector3,
      padding = 1.1,
    ) => {
      const sx = Math.max(size.x, 0.001);
      const sy = Math.max(size.y, 0.001);
      const sz = Math.max(size.z, 0.001);

      if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
        const persp = camera as THREE.PerspectiveCamera;
        const vFov = THREE.MathUtils.degToRad(persp.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, persp.aspect));
        const fitHeight = (sy / 2) / Math.tan(vFov / 2);
        const fitWidth = (sx / 2) / Math.tan(hFov / 2);
        return (Math.max(fitHeight, fitWidth) + sz * 0.8) * padding;
      }

      return Math.max(sx, sy, sz) * 1.5 * padding;
    },
    [],
  );

  const applyCameraPreset = useCallback(
    (view: string, animate: boolean) => {
      if (!viewerRef.current) return;

      const { world, modelCenter: c, modelSize: s } = viewerRef.current;
      const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
      const distance = computeFitDistance(camera, s, 1.08);

      const vectors: Record<string, THREE.Vector3> = {
        front: new THREE.Vector3(0, 0.18, 1),
        back: new THREE.Vector3(0, 0.18, -1),
        left: new THREE.Vector3(-1, 0.18, 0),
        right: new THREE.Vector3(1, 0.18, 0),
        top: new THREE.Vector3(0, 1, 0.0001),
        bottom: new THREE.Vector3(0, -1, 0.0001),
        iso: new THREE.Vector3(1, 0.76, 1),
      };

      const dir = vectors[view];
      if (!dir) return;
      dir.normalize();
      const pos = c.clone().addScaledVector(dir, distance);

      // Normalize accumulated orbit angles so preset animation takes the short path.
      if (animate) world.camera.controls.normalizeRotations();

      world.camera.controls.setLookAt(pos.x, pos.y, pos.z, c.x, c.y, c.z, animate);
      useStore.getState().logActivity({ kind: 'view', summary: `Camera: ${view}` });
    },
    [computeFitDistance],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const contextMenuPickGuard = createContextMenuPickGuard();
    const pendingRaycasts = new Set<Promise<unknown>>();
    const trackRaycast = <T,>(operation: Promise<T>): Promise<T> => {
      pendingRaycasts.add(operation);
      const release = () => pendingRaycasts.delete(operation);
      void operation.then(release, release);
      return operation;
    };
    const exactPickLease = createPickLeaseCoordinator((active) => {
      if (disposed || exactPickLeaseRef.current !== exactPickLease) return;
      if (active) {
        // Restore the authoritative full fragments before any worker raycast.
        navigationLodAppearanceRefreshRef.current?.();
        return;
      }
      // The awaiting click continuation publishes selection in a microtask.
      // Re-evaluate merge/LOD in the next task so durable appearance wins and
      // another overlapping pick can acquire its lease first.
      window.setTimeout(() => {
        if (
          disposed
          || exactPickLeaseRef.current !== exactPickLease
          || exactPickLease.active
        ) return;
        navigationLodAppearanceRefreshRef.current?.();
        furnishingMergeDesiredRefreshRef.current?.();
      }, 0);
    });
    exactPickLeaseRef.current = exactPickLease;
    const components = new OBC.Components();
    const initStart = performance.now();
    let perfSamplingCleanup: (() => void) | null = null;
    let firstFrameCaptured = false;
    let removePanelResizeHooks: (() => void) | null = null;
    let viewHelperCleanup: (() => void) | null = null;
    let pixelRatioCleanup: (() => void) | null = null;
    let renderOnDemandCleanup: (() => void) | null = null;
    let contextRecoveryCleanup: (() => void) | null = null;
    let zFightingCleanup: (() => void) | null = null;
    let fragmentUpdateScheduler: FragmentUpdateScheduler | null = null;
    let devPickAtHook: ((x: number, y: number) => Promise<{
      expressId: number;
      localId: number;
    } | null>) | null = null;
    let hoverIntentTimer: number | null = null;
    let globalSlowTimer: number | null = null;
    // Unsubscribe for the viewer-performance-mode listener.
    let interactionQualityUnsub: (() => void) | null = null;
    const startupState = useStore.getState();
    const graphicsProfile = startupState.graphicsProfile;
    const cachePolicy = startupState.cachePolicy;
    const useServerCache = startupState.useServerCache;
    const startupMode = startupState.startupMode;
    const rendererMode = startupState.rendererMode;
    // rendererMode preference is stored; WebGPU path wires in when @thatopen adds support.
    // For now, log the preference (dev only) and use WebGL 2 (OBC.SimpleRenderer).
    if (import.meta.env.DEV) {
      console.debug(`[viewer] rendererMode=${rendererMode} -> using WebGL 2 (OBC.SimpleRenderer)`);
    }

    let modelLoadSource: ViewerModelLoadSource = 'ifc-parse';
    const stageTimings: ViewerLoadStageTimings = {};
    // Lifted to useEffect scope so cleanup can dispose if component unmounts mid-stream.
    let storeySubModel: FRAGS.FragmentsModel | null = null;
    // Native preview - hoisted so the cleanup return can abort + dispose.
    let nativePreview: NativeGeometryPreview | null = null;
    const nativePreviewAbort = new AbortController();

    async function init() {
      // Show slow-load feedback after 20 s on any loading path.
      globalSlowTimer = window.setTimeout(() => {
        if (!disposed) setLoadingSlow(true);
      }, 20_000);
      try {
        // Install three-mesh-bvh global monkey-patch once at viewer boot so
        // all THREE.Raycaster.intersectObjects calls are BVH-accelerated.
        installBVH();

        // Set up the 3D world
        const worlds = components.get(OBC.Worlds);
        const world = worlds.create<
          OBC.SimpleScene,
          OBC.SimpleCamera,
          OBC.SimpleRenderer
        >();

        world.scene = new OBC.SimpleScene(components);
        // Renderer flags are construction-time only and come from the graphics profile.
        const rendererFlags = getRendererFlagsForProfile(graphicsProfile);
        world.renderer = new OBCF.PostproductionRenderer(components, container!, {
          antialias: rendererFlags.antialias,
          logarithmicDepthBuffer: rendererFlags.logarithmicDepthBuffer,
          powerPreference: 'high-performance',
          stencil: false,
          preserveDrawingBuffer: false,
        });
        world.renderer.showLogo = false;
        try {
          const ppRenderer = world.renderer as unknown as OBCF.PostproductionRenderer;
          // Keep postprocessing manual-mode churn off when the composer is disabled.
          ppRenderer.turnOffOnManualMode = false;
          ppRenderer.manualModeDelay = 120;
        } catch {
          /* older @thatopen/components-front versions may not expose these knobs */
        }
        // On-demand rendering keeps engine updates alive while drawing only after visual changes.
        let renderKick: (ms?: number) => void = () => {};
        if (RENDER_ON_DEMAND) {
          try {
            const onDemandRenderer = world.renderer as unknown as {
              mode: OBC.RendererMode;
              needsUpdate: boolean;
            };
            onDemandRenderer.mode = OBC.RendererMode.MANUAL;
            const invalidationLoop = createInvalidationRenderLoop({
              now: () => performance.now(),
              raf: (callback) => window.requestAnimationFrame(callback),
              cancelRaf: (handle) => window.cancelAnimationFrame(handle),
              invalidate: () => { onDemandRenderer.needsUpdate = true; },
              initialWindowMs: 1_500,
            });
            renderKick = (ms = 300) => invalidationLoop.kick(ms);
            renderOnDemandCleanup = () => {
              invalidationLoop.stop();
              try {
                onDemandRenderer.mode = OBC.RendererMode.AUTO;
              } catch { /* renderer may already be disposed */ }
            };
            // Input-level kicks cover interactions outside the fragment scheduler.
            const kickOnPointer = (e: PointerEvent) => {
              if (e.buttons !== 0) renderKick(200);
            };
            const kickOnWheel = () => renderKick(400);
            container!.addEventListener('pointermove', kickOnPointer, { passive: true });
            container!.addEventListener('pointerdown', kickOnPointer, { passive: true });
            container!.addEventListener('wheel', kickOnWheel, { passive: true });
            // Store-driven visuals without camera events still need draw kicks.
            const unsubThemeKick = useStore.subscribe(
              (s) => s.theme,
              () => renderKick(400),
            );
            const unsubClipKick = useStore.subscribe(
              (s) => s.clipPlanes,
              () => renderKick(400),
            );
            const prevCleanup = renderOnDemandCleanup;
            renderOnDemandCleanup = () => {
              container!.removeEventListener('pointermove', kickOnPointer);
              container!.removeEventListener('pointerdown', kickOnPointer);
              container!.removeEventListener('wheel', kickOnWheel);
              unsubThemeKick();
              unsubClipKick();
              prevCleanup?.();
            };
          } catch {
            /* flag is best-effort: any shape mismatch keeps AUTO mode */
          }
        }
        renderKickRef.current = renderKick;
        // The @thatopen renderer recreates its THREE.WebGLRenderer on context
        // restore, but application render state (selection highlights,
        // visibility masks, ghost opacity) lives in the coordinator's applied
        // caches and must be replayed onto the fresh GPU state.
        {
          const rendererCanvas = world.renderer!.three.domElement;
          const onContextLost = () => {
            useStore.getState().logActivity({
              kind: 'error',
              summary: 'WebGL context lost',
              detail: 'Waiting for the browser to restore the 3D context.',
            });
          };
          const onContextRestored = () => {
            renderKick(600);
            // repair() invalidates the applied caches, so visibility AND
            // appearance replay in full - invalidateAppearance alone would
            // leave hidden/isolated masks unrepainted.
            void renderStateCoordinatorRef.current
              ?.repair({ urgency: 'visual', reason: 'webgl-context-restored' })
              .catch(() => {});
            requestFragmentUpdate('manual');
            useStore.getState().logActivity({
              kind: 'info',
              summary: 'WebGL context restored',
              detail: 'Reapplied selection, visibility, and appearance state.',
            });
          };
          rendererCanvas.addEventListener('webglcontextlost', onContextLost);
          rendererCanvas.addEventListener('webglcontextrestored', onContextRestored);
          contextRecoveryCleanup = () => {
            rendererCanvas.removeEventListener('webglcontextlost', onContextLost);
            rendererCanvas.removeEventListener('webglcontextrestored', onContextRestored);
          };
        }
        // Postproduction starts disabled until an effect needs it.
        try {
          const pp = (world.renderer as unknown as OBCF.PostproductionRenderer).postproduction;
          pp.enabled = false;
          pp.edgesPass.mode = OBCF.EdgeDetectionPassMode.GLOBAL;
          postproductionRef.current = pp;
        } catch {
          postproductionRef.current = null;
        }
        // Disable the unused engine CSS2D pass; measurement labels use their own renderer.
        try {
          const with2D = world.renderer as unknown as {
            three2D?: { render: (...args: unknown[]) => void };
          };
          if (with2D.three2D) with2D.three2D.render = () => {};
        } catch { /* engine internals may change shape - stub is best-effort */ }
        world.camera = new OBC.SimpleCamera(components);
        // Tune camera controls for responsive orbiting and close indoor zoom.
        try {
          const feel = world.camera.controls;
          feel.smoothTime = 0.12;
          feel.draggingSmoothTime = 0.05;
          feel.minDistance = 0.5;
        } catch { /* camera-controls API varies by version - best-effort */ }

        // Use a close near plane so indoor orbiting does not clip nearby faces.
        try {
          const cam = world.camera.three;
          if (cam instanceof THREE.PerspectiveCamera) {
            cam.near = 0.05;
            cam.far = 5000;
            cam.updateProjectionMatrix();
          }
        } catch { /* best-effort */ }

        // Match device pixel ratio within a bounded cap for sharper orbiting.
        const HARD_PIXEL_RATIO_CAP = 2;
        const targetPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
        const navigationPixelRatioCap = 1.0;
        const cameraSettleDelayMs = 320;
        const cullerShowPassMinIntervalMs = 220;
        let activePixelRatioCap = targetPixelRatio;
        const applyPixelRatio = () => {
          try {
            const r = world.renderer!.three;
            const nextPixelRatio = Math.min(window.devicePixelRatio || 1, activePixelRatioCap);
            const cont = container!;
            // Skip setSize when the ratio and backing buffer are already correct.
            const wantW = Math.floor(cont.clientWidth * nextPixelRatio);
            const wantH = Math.floor(cont.clientHeight * nextPixelRatio);
            const canvasEl = r.domElement;
            if (
              r.getPixelRatio() === nextPixelRatio
              && canvasEl.width === wantW
              && canvasEl.height === wantH
            ) {
              return;
            }
            if (r.getPixelRatio() !== nextPixelRatio) {
              r.setPixelRatio(nextPixelRatio);
            }
            // setSize applies the new ratio to the canvas backing buffer.
            r.setSize(cont.clientWidth, cont.clientHeight, true);
            // The realloc cleared the drawing buffer; repaint it.
            renderKick(250);
          } catch { /* best-effort */ }
        };
        const setInteractionPixelRatioCap = (cap: number) => {
          activePixelRatioCap = Math.min(HARD_PIXEL_RATIO_CAP, Math.max(1, cap));
          applyPixelRatio();
        };
        // Restore the pixel-ratio cap chosen by the interaction-quality ladder.
        const restoreLadderPixelRatioCap = () => {
          setInteractionPixelRatioCap(
            getRuntimeQualitySettings(interactionQualityRef.current.active).pixelRatioCap,
          );
        };
        applyPixelRatio();

        // Lower DPR only for sustained drags; wheel zoom and short nudges stay sharp.
        const DPR_DROP_DELAY_MS = 180;
        const WHEEL_GESTURE_WINDOW_MS = 300;
        // Deferred drops require recent camera motion to avoid pointless reallocs.
        const DPR_DROP_RECENT_MOTION_MS = 120;
        let lastCameraUpdateTs = -Infinity;
        let dprDropTimer: number | null = null;
        let lastWheelTs = -Infinity;
        try {
          world.renderer!.three.domElement.addEventListener(
            'wheel',
            () => { lastWheelTs = performance.now(); },
            { passive: true },
          );
        } catch { /* best-effort */ }
        const isWheelGesture = () => performance.now() - lastWheelTs < WHEEL_GESTURE_WINDOW_MS;
        const cancelDprDrop = () => {
          if (dprDropTimer !== null) {
            window.clearTimeout(dprDropTimer);
            dprDropTimer = null;
          }
        };

        // Explicit color management keeps materials and highlights stable across bundles.
        try {
          const r = world.renderer!.three;
          r.outputColorSpace = THREE.SRGBColorSpace;
          r.toneMapping = THREE.NeutralToneMapping;
          r.toneMappingExposure = 1.0;
        } catch { /* best-effort */ }

        // Re-apply pixelRatio after container resize.
        const pixelRatioObserver = new ResizeObserver(() => {
          applyPixelRatio();
        });
        pixelRatioObserver.observe(container!);
        pixelRatioCleanup = () => pixelRatioObserver.disconnect();

        components.init();
        updateLoadProgress({
          title: 'Booting 3D runtime',
          detail: 'Creating scene, camera controls, and fragment worker...',
          progress: 10,
          sourceHint: 'Startup',
        });

        // Configure scene; applyTheme keeps the background theme-aware.
        world.scene.setup({
          backgroundColor: new THREE.Color(0x0a0a1a),
        });
        // Rebalance default lights so face orientation remains readable.
        try {
          const sceneThree = world.scene.three as THREE.Scene;
          for (const child of sceneThree.children) {
            if (child instanceof THREE.AmbientLight) child.intensity = 0.4;
            else if (child instanceof THREE.DirectionalLight) child.intensity = 2.0;
          }
        } catch { /* lighting fallback not critical */ }
        sceneThemeTargetsRef.current = { world: world as unknown as ViewerRefs['world'] };
        applyTheme(useStore.getState().theme);

        // Fill lighting keeps dark IFC materials readable from all directions.
        try {
          const sceneThree = world.scene.three as THREE.Scene;

          // Sky/ground hemisphere fill for shadowed surfaces.
          const hemi = new THREE.HemisphereLight(0xffffff, 0x6b7280, 0.75);
          hemi.name = 'hemi-fill';
          sceneThree.add(hemi);

          // Soft ambient floor so even fully-shadowed regions stay visible.
          const amb = new THREE.AmbientLight(0xffffff, 0.55);
          amb.name = 'ambient-fill';
          sceneThree.add(amb);

          // Counter-key light for faces turned away from the primary light.
          const counterKey = new THREE.DirectionalLight(0xffffff, 0.6);
          counterKey.position.set(-30, 40, -30);
          counterKey.name = 'counter-key';
          sceneThree.add(counterKey);
        } catch {
          /* lighting fallback not critical */
        }

        // Camera position
        world.camera.controls.setLookAt(15, 15, 15, 0, 0, 0);

        // Interactive 3D view gizmo (three.js ViewHelper). Renders a 128px
        // axis indicator in the TOP-right of the canvas that rotates with
        // the camera. Click an axis to snap the camera view. We bypass both
        // ViewHelper's built-in render (which places the gizmo bottom-right)
        // and its camera animation (which fights camera-controls), and route
        // axis picks through applyCameraPreset instead.
        const viewHelperCanvas = world.renderer!.three.domElement;
        const viewHelper = new ViewHelper(world.camera.three, viewHelperCanvas);
        viewHelper.setLabels('X', 'Y', 'Z');

        const GIZMO_DIM = 128;
        const gizmoOrthoCam = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4);
        gizmoOrthoCam.position.set(0, 0, 2);
        gizmoOrthoCam.updateProjectionMatrix();
        gizmoOrthoCam.updateMatrixWorld(true);
        const gizmoViewportBackup = new THREE.Vector4();

        // Honest per-frame counters (perf HUD chip, __ifcRenderStats).
        // THREE.js's `renderer.info.autoReset = true` (default) clears the
        // draw-call / triangle counters at the START of every
        // renderer.render() call, so the gizmo pass below used to wipe the
        // main scene's counts. Worse, a plain "manual reset on
        // onBeforeUpdate" is not enough either: the engine's RendererWith2D
        // base class re-triggers onBeforeUpdate from inside its own
        // constructor-time onAfterUpdate handler (it runs before any handler
        // we add), so a reset riding onBeforeUpdate fires AGAIN right after
        // the main render and the frame still ends gizmo-only (the perf
        // log's 9 calls / 72 tris). The fix:
        //   - autoReset stays off; we reset ONCE per frame at the real frame
        //     start, guarded by a cycle flag so the engine's re-trigger is a
        //     no-op;
        //   - renderGizmo accounts its own contribution into overlay
        //     counters;
        //   - after all overlay passes, captureMainPassStats snapshots
        //     (totals - overlay) into the renderStatsSnapshot singleton,
        //     which is what the HUD sampler and __ifcRenderStats read.
        // Off-frame passes (fast-picker ID pass, __ifcRenderStats' probe
        // render) land AFTER the capture and are wiped by the next frame's
        // reset, so they can never leak into the snapshot. Under
        // RENDER_ON_DEMAND no frame means no reset and no capture - the
        // snapshot keeps describing the frame that is actually on screen.
        world.renderer!.three.info.autoReset = false;
        let renderCycleOpen = false;
        let overlayDrawCalls = 0;
        let overlayTriangles = 0;
        const resetRenderInfo = () => {
          if (disposed || renderCycleOpen) return;
          renderCycleOpen = true;
          overlayDrawCalls = 0;
          overlayTriangles = 0;
          world.renderer!.three.info.reset();
        };
        world.renderer!.onBeforeUpdate.add(resetRenderInfo);

        const renderGizmo = () => {
          if (disposed) return;
          try {
            const renderer = world.renderer!.three;
            // Keep ViewHelper oriented to the main camera.
            viewHelper.quaternion.copy(world.camera.three.quaternion).invert();
            viewHelper.updateMatrixWorld(true);
            // WebGL viewport origin is bottom-left, so top-right of the canvas
            // is x = width - dim, y = height - dim.
            const x = viewHelperCanvas.offsetWidth - GIZMO_DIM;
            const y = viewHelperCanvas.offsetHeight - GIZMO_DIM;
            // CRITICAL: disable autoClear before the gizmo render. THREE.js's
            // renderer.render() calls renderer.clear() (color+depth+stencil)
            // when autoClear=true, IGNORING the viewport, so leaving it on
            // would wipe the main scene we just drew. We still manually
            // clear depth so gizmo depth-testing is independent.
            const savedAutoClear = renderer.autoClear;
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.getViewport(gizmoViewportBackup);
            renderer.setViewport(x, y, GIZMO_DIM, GIZMO_DIM);
            const callsBefore = renderer.info.render.calls;
            const trianglesBefore = renderer.info.render.triangles;
            renderer.render(viewHelper, gizmoOrthoCam);
            // Book the gizmo's cost as overlay so captureMainPassStats can
            // report the main scene alone.
            overlayDrawCalls += renderer.info.render.calls - callsBefore;
            overlayTriangles += renderer.info.render.triangles - trianglesBefore;
            renderer.setViewport(
              gizmoViewportBackup.x,
              gizmoViewportBackup.y,
              gizmoViewportBackup.z,
              gizmoViewportBackup.w,
            );
            renderer.autoClear = savedAutoClear;
          } catch {
            /* best-effort overlay; never break the main render */
          }
        };
        world.renderer!.onAfterUpdate.add(renderGizmo);

        // Registered AFTER renderGizmo on purpose: OBC events run handlers
        // in insertion order, so by the time this runs the frame's overlay
        // passes are fully booked and the counters hold the frame total.
        const captureMainPassStats = () => {
          if (disposed) return;
          renderCycleOpen = false;
          const info = world.renderer!.three.info;
          recordMainPass(
            info.render.calls,
            info.render.triangles,
            overlayDrawCalls,
            overlayTriangles,
            performance.now(),
          );
        };
        world.renderer!.onAfterUpdate.add(captureMainPassStats);

        // Click-to-align: raycast against ViewHelper's interactive sprites
        // using the same NDC math, adjusted for the top-right placement.
        const GIZMO_VIEW_MAP: Record<string, string> = {
          posX: 'right', negX: 'left',
          posY: 'top',   negY: 'bottom',
          posZ: 'front', negZ: 'back',
        };
        const gizmoRaycaster = new THREE.Raycaster();
        const gizmoMouseNdc = new THREE.Vector2();

        const hitGizmoAxis = (event: PointerEvent): string | null => {
          const domEl = world.renderer!.three.domElement;
          const rect = domEl.getBoundingClientRect();
          const offsetX = rect.left + (domEl.offsetWidth - GIZMO_DIM);
          const offsetY = rect.top;
          const boundY = rect.top + GIZMO_DIM;
          if (
            event.clientX < offsetX || event.clientX > rect.right ||
            event.clientY < offsetY || event.clientY > boundY
          ) return null;
          gizmoMouseNdc.x = ((event.clientX - offsetX) / (rect.right - offsetX)) * 2 - 1;
          gizmoMouseNdc.y = -((event.clientY - offsetY) / (boundY - offsetY)) * 2 + 1;
          gizmoRaycaster.setFromCamera(gizmoMouseNdc, gizmoOrthoCam);
          viewHelper.quaternion.copy(world.camera.three.quaternion).invert();
          viewHelper.updateMatrixWorld(true);
          const intersects = gizmoRaycaster.intersectObjects(viewHelper.children, false);
          for (const hit of intersects) {
            const type = hit.object?.userData?.type;
            if (typeof type === 'string' && type in GIZMO_VIEW_MAP) return type;
          }
          return null;
        };

        // Capture-phase listeners short-circuit the existing selection
        // raycast so a click on the gizmo doesn't also clear selection.
        let gizmoClickConsumed = false;
        const onGizmoPointerDown = (event: PointerEvent) => {
          if (event.button !== 0) return;
          const type = hitGizmoAxis(event);
          if (!type) return;
          const view = GIZMO_VIEW_MAP[type];
          if (!view) return;
          gizmoClickConsumed = true;
          event.stopImmediatePropagation();
          event.preventDefault();
          applyCameraPreset(view, true);
        };
        const onGizmoPointerUp = (event: PointerEvent) => {
          if (!gizmoClickConsumed) return;
          gizmoClickConsumed = false;
          event.stopImmediatePropagation();
          event.preventDefault();
        };
        viewHelperCanvas.addEventListener('pointerdown', onGizmoPointerDown, true);
        viewHelperCanvas.addEventListener('pointerup', onGizmoPointerUp, true);

        viewHelperCleanup = () => {
          try { world.renderer!.onAfterUpdate.remove(renderGizmo); } catch { /* renderer may be disposed */ }
          try { world.renderer!.onAfterUpdate.remove(captureMainPassStats); } catch { /* renderer may be disposed */ }
          try { world.renderer!.onBeforeUpdate.remove(resetRenderInfo); } catch { /* renderer may be disposed */ }
          resetMainPassStats();
          viewHelperCanvas.removeEventListener('pointerdown', onGizmoPointerDown, true);
          viewHelperCanvas.removeEventListener('pointerup', onGizmoPointerUp, true);
          try { viewHelper.dispose(); } catch { /* best-effort */ }
        };

        // Grid
        const grids = components.get(OBC.Grids);
        const grid = grids.create(world);
        sceneThemeTargetsRef.current = {
          world: world as unknown as ViewerRefs['world'],
          grid: grid as unknown as ViewerRefs['grid'],
        };
        applyTheme(useStore.getState().theme);

        // Initialize fragments with a blob-backed worker for broader runtime compatibility.
        const fragmentsManager = components.get(OBC.FragmentsManager);
        // Assigned once any load path converges. Scheduler runs after that
        // point wait for this model's FINISH event before the next run starts,
        // preventing a late camera event from acknowledging a later selection.
        let fragmentModelForUpdateAck: FRAGS.FragmentsModel | null = null;
        // Captured after FragmentsManager.init(). Normal engine calls are then
        // routed through the scheduler, while the scheduler itself invokes this
        // original method to avoid recursively enqueueing its own update.
        let rawCoreUpdate: ((force?: boolean) => Promise<void>) | null = null;
        // Pace forced flushes around the engine maxUpdateRate guard.
        let droppedForcedFlushes = 0;
        // Non-forced acknowledgement waits register here so newly enqueued
        // immediate work (a click flush, an orbit camera batch) can release
        // them instead of queueing behind a silent no-change tick.
        const ackPreemptors = new Set<() => void>();
        // Resolve `core` lazily because the getter is unavailable before init().
        const readEngineLastUpdate = (): number | null => {
          const enginePacing = fragmentsManager.core as unknown as { _lastUpdate?: unknown };
          return typeof enginePacing._lastUpdate === 'number' ? enginePacing._lastUpdate : null;
        };
        const invokeRawCoreUpdate = (force: boolean): Promise<void> => {
          if (rawCoreUpdate) return rawCoreUpdate(force);
          return fragmentsManager.core.update(force);
        };
        const coreUpdatePaced = async (force: boolean): Promise<boolean> => {
          if (!force) {
            const callAt = performance.now();
            await invokeRawCoreUpdate(false);
            const after = readEngineLastUpdate();
            // A rate-limited no-op has no model FINISH event to await.
            return after === null || after >= callAt;
          }
          const tForcedStart = performance.now();
          for (let attempt = 0; attempt < 3; attempt += 1) {
            // Route disposed updates through the scheduler error path.
            if (disposed) throw new Error('viewer-disposed');
            const last = readEngineLastUpdate();
            const rate = fragmentsManager.core.settings.maxUpdateRate;
            if (last !== null && rate > 0) {
              const since = performance.now() - last;
              if (since < rate) {
                await new Promise((resolve) => {
                  window.setTimeout(resolve, Math.max(1, Math.ceil(rate - since) + 1));
                });
              }
            }
            const callAt = performance.now();
            await invokeRawCoreUpdate(true);
            const after = readEngineLastUpdate();
            // _lastUpdate advancing past callAt means the engine accepted the run.
            if (after === null || after >= callAt) {
              if (import.meta.env.DEV) {
                const attribution = clickFlushAttributionRef.current;
                attribution.paceWaitMs = callAt - tForcedStart;
                attribution.flushMs = performance.now() - callAt;
              }
              return true;
            }
            droppedForcedFlushes += 1;
            if (import.meta.env.DEV) {
              console.debug('[viewer] forced fragment flush dropped by engine pacing - retrying', {
                attempt: attempt + 1,
                droppedForcedFlushes,
              });
            }
          }
          // Surface exhausted retries as a scheduler error.
          throw new Error('fragments forced update dropped by engine pacing (3 attempts)');
        };
        const coreUpdatePacedAndAcknowledged = async (force: boolean): Promise<void> => {
          const acknowledgedModel = fragmentModelForUpdateAck;
          if (!acknowledgedModel) {
            await coreUpdatePaced(force);
            return;
          }
          let finished = false;
          let acknowledgementTimeout = 0;
          let resolveFinished!: () => void;
          const finish = new Promise<void>((resolve) => {
            resolveFinished = resolve;
          });
          const onViewUpdated = () => {
            finished = true;
            resolveFinished();
          };
          acknowledgedModel.onViewUpdated.add(onViewUpdated);
          try {
            const accepted = await coreUpdatePaced(force);
            // A forced FragmentsModels update resolves only after
            // forceUpdateFinish has consumed the model's FINISH request, so its
            // returned promise is already the acknowledgement. Non-forced
            // camera work returns earlier and must wait for onViewUpdated.
            if (accepted && !force && !finished) {
              // A no-change tick never emits FINISH. Newly enqueued immediate
              // work preempts this wait so clicks never queue behind it, and
              // bounded silence resolves as a benign no-op acknowledgement.
              let preempted = false;
              const preempt = () => {
                preempted = true;
                resolveFinished();
              };
              ackPreemptors.add(preempt);
              try {
                acknowledgementTimeout = window.setTimeout(resolveFinished, 2_500);
                await finish;
              } finally {
                ackPreemptors.delete(preempt);
              }
              if (import.meta.env.DEV && !finished) {
                console.debug('[viewer] non-forced view-update acknowledgement released', {
                  reason: preempted ? 'preempted-by-immediate-work' : 'no-view-change-timeout',
                });
              }
            }
          } finally {
            window.clearTimeout(acknowledgementTimeout);
            try { acknowledgedModel.onViewUpdated.remove(onViewUpdated); } catch { /* disposed */ }
          }
        };
        fragmentUpdateScheduler = createFragmentUpdateScheduler({
          raf: (cb) => window.requestAnimationFrame(cb),
          cancelRaf: (handle) => window.cancelAnimationFrame(handle),
          update: (force) => coreUpdatePacedAndAcknowledged(force),
          // Queued immediate work must not sit behind a silent no-change
          // tick's acknowledgement watchdog; release those waits right away.
          onEnqueue: (request) => {
            if (request.priority === 'idle') return;
            for (const preempt of Array.from(ackPreemptors)) preempt();
          },
          // Stamp click-highlight flush starts for latency attribution.
          onRunStart: (run) => {
            // Every scheduler run mutates visuals; keep painting through it.
            renderKick(350);
            if (import.meta.env.DEV && run.reasons.includes('click-highlight')) {
              clickFlushAttributionRef.current.runStartTs = performance.now();
            }
          },
          onRunEnd: () => {
            // The flush just landed worker results - paint them.
            renderKick(350);
          },
        });
        fragmentUpdateSchedulerRef.current = fragmentUpdateScheduler;
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__ifcSchedSnapshot =
            () => fragmentUpdateSchedulerRef.current?.snapshot() ?? null;
        }
        {
          const workerHttpUrl = new URL('/worker.mjs', window.location.origin).href;
          let workerInitUrl = workerHttpUrl;
          try {
            const workerResp = await fetch(workerHttpUrl);
            if (workerResp.ok) {
              const workerText = await workerResp.text();
              const workerBlob = new Blob([workerText], { type: 'application/javascript' });
              workerInitUrl = URL.createObjectURL(workerBlob);
            }
          } catch {
            // Fallback to http URL if fetch fails
          }
          fragmentsManager.init(workerInitUrl);
          // Keep the blob URL alive; FragmentsManager reuses it on later loads.
          if (workerInitUrl !== workerHttpUrl) {
            workerBlobUrlRef.current = workerInitUrl;
          }
        }

        // Tune fragment update pacing for interaction-driven redraws.
        fragmentsManager.core.settings.maxUpdateRate = 8;
        fragmentsManager.core.settings.forceUpdateRate = 1;
        fragmentsManager.core.settings.forceUpdateBuffer = 2;

        // Guard fragments.core.load() against a disposed manager. When HMR or
        // any fast remount fires during the CPU-intensive WASM parse phase,
        // components.dispose() kills the fragment workers. The subsequent
        // core.load() call then creates a Worker that never sends 'ready' -
        // hanging the Promise chain forever at "Finalizing fragment model".
        // Patching the method lets the abandoned init() bail out cleanly.
        {
          const coreRef = fragmentsManager.core as unknown as { load: (...a: unknown[]) => Promise<unknown> };
          const origLoad = coreRef.load.bind(fragmentsManager.core);
          coreRef.load = (...args: unknown[]) => {
            if (disposed) return Promise.reject(new Error('viewer-disposed'));
            return origLoad(...args);
          };
        }

        // The engine's auto-redraw timer calls core.update directly after
        // worker messages. Route those calls through the same single-flight
        // scheduler as camera and appearance work so an unrelated FINISH event
        // can never acknowledge a later selection/visibility flush.
        try {
          const coreAny = fragmentsManager.core as unknown as {
            update: (force?: boolean) => Promise<void>;
          };
          rawCoreUpdate = coreAny.update.bind(fragmentsManager.core);
          coreAny.update = async (force = false) => {
            if (RENDER_ON_DEMAND) renderKick(350);
            const scheduler = fragmentUpdateScheduler;
            if (!scheduler || disposed) {
              if (disposed) return;
              await rawCoreUpdate?.(force);
              return;
            }
            try {
              await scheduler.requestAndWait({
                priority: force ? 'visual' : 'camera',
                force,
                reason: 'camera',
              });
            } catch (error) {
              // Auto-redraw calls are fire-and-forget inside the fragments
              // engine. Keep teardown cancellations and a lost FINISH event
              // from becoming unhandled promise rejections.
              if (!disposed && (error as { name?: string })?.name !== 'AbortError') {
                console.warn('[viewer] scheduled engine update failed', error);
              }
            }
          };
        } catch { /* best-effort: direct app updates still use the scheduler */ }

        // Adaptive graphics quality is now driven by the
        // interaction-quality ladder (interactionQualityController.ts) instead
        // of a hardcoded GQ_IDLE/GQ_ORBIT binary. `applyInteractionQuality`
        // maps the ladder's `active` level onto the two real renderer knobs we
        // own here (graphicsQuality + interaction pixel-ratio cap);
        // `dispatchQuality` feeds the reducer and re-applies only when the
        // resolved `active` level changes. Navigation transitions push
        // 'navigation-start'/'navigation-end'; the store's viewer-performance
        // mode pushes 'set-target'. Starting at the resolved idle level keeps
        // the first frame at full target detail; the orbit-throttle only kicks
        // in on real motion.
        // Per-model LOD tier, decided once per load from element count (the
        // post-load tier block below fills it). Unknown ids (mid-load race)
        // default to 'medium', whose floor rule is the safe behavior.
        const modelLodTiers = new Map<string, LodTier>();
        // The engine copies core.settings.graphicsQuality onto a model ONCE at
        // load; the worker reads the PER-MODEL field on every view refresh.
        // Without these writes the ladder's quality arm does nothing for
        // loaded models (the settings write below only seeds future loads).
        // The tier policy (lodTierPolicy.ts) keeps the navigation drop away
        // from small/medium models where it would widen the cull band and
        // make elements vanish during orbit.
        const applyPerModelGraphicsQuality = (ladderQuality: number) => {
          const idleQuality =
            getRuntimeQualitySettings(interactionQualityRef.current.target).graphicsQuality;
          let changed = false;
          try {
            for (const [id, m] of fragmentsManager.core.models.list) {
              const tier = modelLodTiers.get(id) ?? 'medium';
              const next = resolveModelGraphicsQuality(tier, ladderQuality, idleQuality);
              const target = m as unknown as { graphicsQuality?: unknown };
              if (typeof target.graphicsQuality === 'number' && target.graphicsQuality !== next) {
                target.graphicsQuality = next;
                changed = true;
              }
            }
          } catch { /* engine without the field keeps load-time behavior */ }
          if (changed) {
            // Ship the new per-model value with the next view refresh. During
            // navigation the camera stream refreshes anyway; this covers the
            // idle case (user flips the performance mode in Settings).
            requestFragmentUpdate('manual', true, 'idle');
          }
        };
        const applyInteractionQuality = (active: RuntimeViewerQuality) => {
          const settings = getRuntimeQualitySettings(active);
          try {
            fragmentsManager.core.settings.graphicsQuality = settings.graphicsQuality;
          } catch { /* ignore */ }
          applyPerModelGraphicsQuality(settings.graphicsQuality);
          // The ladder's pixelRatioCap is the *navigation* cap when navigating
          // (lower = cheaper) and the idle cap otherwise; both are clamped to
          // the device-derived targetPixelRatio inside setInteractionPixelRatioCap.
          // Cap DROPS are hysteresis-gated (wheel gestures never
          // degrade; drags degrade only after sustained motion); raises and
          // non-navigation changes apply immediately. A pending deferred drop
          // is cancelled by ANY later quality apply (e.g. the settle restore),
          // so short gestures never touch the backbuffer at all.
          cancelDprDrop();
          const droppingForNav =
            interactionQualityRef.current.navigating
            && settings.pixelRatioCap < activePixelRatioCap;
          if (!droppingForNav) {
            setInteractionPixelRatioCap(settings.pixelRatioCap);
            return;
          }
          if (isWheelGesture()) return;
          dprDropTimer = window.setTimeout(() => {
            dprDropTimer = null;
            if (disposed) return;
            if (!cameraNavigatingRef.current || isWheelGesture()) return;
            // Real sustained motion only - see DPR_DROP_RECENT_MOTION_MS.
            if (performance.now() - lastCameraUpdateTs > DPR_DROP_RECENT_MOTION_MS) return;
            setInteractionPixelRatioCap(settings.pixelRatioCap);
          }, DPR_DROP_DELAY_MS);
        };
        const dispatchQuality = (event: InteractionQualityEvent) => {
          const prev = interactionQualityRef.current;
          const next = reduceInteractionQuality(prev, event);
          interactionQualityRef.current = next;
          if (next.active !== prev.active) {
            applyInteractionQuality(next.active);
          }
        };
        // Seed the ladder target from the current preference, then apply the
        // resolved idle level for the very first frame.
        dispatchQuality({
          type: 'set-target',
          target: performanceModeToQualityTarget(useStore.getState().viewerPerformanceMode),
        });
        applyInteractionQuality(interactionQualityRef.current.active);
        // Live-update the ladder target when the user changes viewer performance mode.
        const unsubscribePerformanceMode = useStore.subscribe(
          (s) => s.viewerPerformanceMode,
          (mode: ViewerPerformanceMode) => {
            if (disposed) return;
            dispatchQuality({ type: 'set-target', target: performanceModeToQualityTarget(mode) });
          },
        );
        interactionQualityUnsub = unsubscribePerformanceMode;

        // Resize paths keep idle graphics quality while lowering pixel-ratio cap.
        const resolveIdleGraphicsQuality = () =>
          getRuntimeQualitySettings(interactionQualityRef.current.target).graphicsQuality;

        // Shared load-path state.
        const cacheEnabled = cachePolicy !== 'off';
        let cacheKey: string | null = null;
        let localFragmentCacheChecked = false;
        let model: FRAGS.FragmentsModel | null = null;

        // Manifest fast path for remounts with server-cached fragments.
        const storedFingerprint = useStore.getState().modelFingerprint;
        const serverCapsForManifest = useStore.getState().serverConvertCaps;
        const hasStoredIfcBytesForManifest = !!useStore.getState().ifcFileBytes;
        const manifestAttempt = {
          hasFileBytes: hasStoredIfcBytesForManifest,
          fingerprint: storedFingerprint,
          serverConvertAvailable: isRecoverableServerConvertFailure(serverCapsForManifest),
        };
        if (!BROWSER_ONLY && useServerCache && shouldUseServerFragmentManifest(manifestAttempt)) {
          const graphicsProfileForManifest = resolveParseProfile(graphicsProfile, 0);
          updateLoadProgress({
            title: 'Checking server fragment cache',
            detail: 'Querying server manifest (no re-upload needed)...',
            progress: 14,
            sourceHint: 'Manifest check',
          });
          try {
            const manifest = await checkFragmentManifest(manifestAttempt.fingerprint, graphicsProfileForManifest);
            if (manifest.cached && manifest.serve_url && !disposed) {
              updateLoadProgress({
                title: 'Fetching cached fragments',
                detail: `Server cache hit (${((manifest.size_bytes ?? 0) / 1024).toFixed(0)} KB). Skipping IFC re-upload...`,
                progress: 50,
                sourceHint: 'Server manifest',
              });
              const manifestResult = await fetchFragmentByFingerprint(manifestAttempt.fingerprint, graphicsProfileForManifest);
              if (!disposed) {
                updateLoadProgress({
                  title: 'Loading manifest fragments',
                  detail: `Received ${(manifestResult.bytes.byteLength / 1024).toFixed(0)} KB.`,
                  progress: 75,
                  sourceHint: 'Server manifest',
                });
                const manifestModelId = makeViewerModelId();
                const manifestLoadStart = performance.now();
                model = await loadFragmentsWithTimeout(
                  fragmentsManager,
                  manifestResult.bytes,
                  manifestModelId,
                  {
                    autoCoordinate:
                      graphicsProfileForManifest === 'quality' ||
                      graphicsProfileForManifest === 'balanced',
                    graphicsQuality: resolveIdleGraphicsQuality(),
                  },
                );
                stageTimings.cacheLoadMs = performance.now() - manifestLoadStart;
                modelLoadSource = 'server-cache';
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Load path chosen: server-cache (manifest fast-path) in ${stageTimings.cacheLoadMs.toFixed(0)} ms.`,
                });
              }
            }
          } catch {
            // Manifest path failed - fall through to normal load below.
            model = null;
          }
        }

        // Normal IFC byte fetch, skipped when the manifest already loaded the model.
        if (!model) {
          updateLoadProgress({
            title: 'Reading IFC bytes',
            detail: 'Using in-memory bytes or backend fallback...',
            progress: 16,
            sourceHint: 'Startup',
          });
        }

        // Prefer in-memory upload bytes, otherwise re-fetch from the backend.
        let fileBytes = useStore.getState().ifcFileBytes;
        if (!model && !fileBytes && BROWSER_ONLY) {
          // Browser-only builds have no server to re-fetch lost bytes from.
          throw new Error('Model bytes are no longer in memory. Drop the IFC file again to reload.');
        }
        if (!model && !fileBytes) {
          try {
            const resp = await fetch(apiUrl('/api/ifc/file'));
            if (!resp.ok) throw new Error(`server ${resp.status}`);
            const buf = await resp.arrayBuffer();
            fileBytes = new Uint8Array(buf);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Could not load IFC from backend: ${msg}`);
          }
        }

        if (disposed) return;

        // Optional native preview paths stay separate from the production fragment loader.
        const streamingEnabled = import.meta.env.VITE_STREAMING_GEOMETRY === 'true';
        const serverConvertAvailableForPreview =
          useStore.getState().serverConvertCaps?.server_convert === true;
        const nativeGeometryPreviewEnabled =
          import.meta.env.VITE_NATIVE_GEOMETRY_PREVIEW === 'true';
        const shouldRunNativePreview =
          !!fileBytes && nativeGeometryPreviewEnabled && !serverConvertAvailableForPreview;
        if (shouldRunNativePreview && streamingEnabled) {
          const scene = world.scene?.three as THREE.Scene | undefined;
          const matCache = createStreamingMaterialCache();
          const group = new THREE.Group();
          group.name = 'native-geometry-preview-streaming';
          let firstBatchAt: number | null = null;
          const startedAt = performance.now();
          const previewShell: NativeGeometryPreview = {
            group,
            meshCount: 0,
            elapsedMs: 0,
            dispose: () => disposeStreamingPreview(group, matCache),
          };
          // Add the empty group up front; meshes will pop in as they arrive.
          if (scene) scene.add(group);
          nativePreview = previewShell;

          void streamNativeGeometry(
            { ifcBytes: fileBytes!, signal: nativePreviewAbort.signal },
            {
              onBatch: (_batchIndex, decoded: DecodedMesh[]) => {
                if (disposed || nativePreviewAbort.signal.aborted) return;
                if (firstBatchAt === null) {
                  firstBatchAt = performance.now();
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: `Streaming preview: first batch in ${(firstBatchAt - startedAt).toFixed(0)} ms.`,
                  });
                }
                appendBatchToGroup(group, matCache, decoded);
                previewShell.meshCount = group.children.length;
              },
              onSummary: (ev) => {
                previewShell.elapsedMs = ev.totalElapsedMs;
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Streaming preview done: ${ev.meshCount} meshes in ${ev.totalElapsedMs} ms (${ev.batchCount} batches).`,
                });
              },
              onError: (ev) => {
                useStore.getState().logActivity({
                  kind: 'error',
                  summary: `Streaming preview error: ${ev.message}`,
                });
              },
            },
          ).catch(() => {
            // Leave any arrived batches in place; the main load replaces them shortly.
          });
        } else if (shouldRunNativePreview) {
          void fetchNativeGeometryPreview(fileBytes!, nativePreviewAbort.signal).then((preview) => {
            if (disposed || nativePreviewAbort.signal.aborted || !preview) return;
            nativePreview = preview;
            // Add preview group to the Three.js scene.
            const scene = world.scene?.three as THREE.Scene | undefined;
            if (scene) {
              scene.add(preview.group);
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Native preview: ${preview.meshCount} meshes ready in ${preview.elapsedMs} ms.`,
              });
            }
          });
        }

        let effectiveGraphicsProfile = resolveParseProfile(graphicsProfile, fileBytes?.byteLength ?? 0);
        // Browser-only large files use the performance parse profile unless the user overrides it.
        if (
          BROWSER_ONLY &&
          graphicsProfile === 'balanced' &&
          (fileBytes?.byteLength ?? 0) >= AUTO_PERF_PROFILE_THRESHOLD_BYTES
        ) {
          effectiveGraphicsProfile = 'performance';
          useStore.getState().logActivity({
            kind: 'info',
            summary: `Large file (${((fileBytes!.byteLength) / (1024 * 1024)).toFixed(0)} MB) on the web build: parsing with the performance profile. Pick a profile in Settings > Performance to override.`,
          });
        }
        const coordinateModel = effectiveGraphicsProfile === 'quality' || effectiveGraphicsProfile === 'balanced';

        // Unique per-mount ID avoids Worker thread placeholder conflicts when
        // two browser tabs load simultaneously with the same fixed modelId.
        let modelId = makeViewerModelId();
        if (
          cacheEnabled &&
          fileBytes &&
          (BROWSER_ONLY || !shouldAttemptServerConvert(useStore.getState().serverConvertCaps, true))
        ) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Checking fragment cache for this IFC...',
            progress: 22,
            sourceHint: 'Cache check',
          });

          cacheKey = await buildFragmentCacheKey(fileBytes, effectiveGraphicsProfile);
          const cacheReadStart = performance.now();
          const cachedFragments = await readFragmentCacheIDB(cacheKey, cachePolicy);
          localFragmentCacheChecked = true;
          stageTimings.cacheReadMs = performance.now() - cacheReadStart;
          if (cachedFragments) {
            try {
              updateLoadProgress({
                title: 'Loading cached fragments',
                detail: 'Cache hit. Skipping IFC parse and restoring geometry...',
                progress: 70,
                sourceHint: 'Cache hit',
              });
              const cacheLoadStart = performance.now();
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                cachedFragments,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              stageTimings.cacheLoadMs = performance.now() - cacheLoadStart;
              modelLoadSource = 'fragments-cache';
              useStore.getState().logActivity({
                kind: 'info',
                summary: 'Load path chosen: local-fragment-cache (backend hard-unavailable; IFC parse skipped).',
              });
            } catch {
              model = null;
              await deleteFragmentCacheIDBEntry(cacheKey);
              // Clear stale worker placeholders before falling back to live parse.
              clearFragmentThreadPlaceholder(fragmentsManager, modelId);
              modelId = makeViewerModelId();
              updateLoadProgress({
                title: 'Cache fallback',
                detail: 'Cached fragments were stale. Switching to browser parse fallback...',
                progress: 24,
                sourceHint: 'worker-parse',
              });
            }
          }
        } else if (cacheEnabled && fileBytes) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Preparing local fragment cache key. Backend conversion remains primary...',
            progress: 22,
            sourceHint: 'Server first',
          });
          cacheKey = await buildFragmentCacheKey(fileBytes, effectiveGraphicsProfile);
        } else if (!model) {
          updateLoadProgress({
            title: 'Resolving model source',
            detail: 'Fragment cache disabled. Backend conversion remains primary...',
            progress: 22,
            sourceHint: 'Server first',
          });
        }

        // Optional storey preview before the full sidecar convert completes.
        let storeyPreviewResult: StoreyFragmentResult | null = null;
        const streamingFp = useStore.getState().modelFingerprint;
        const streamingCaps = useStore.getState().serverConvertCaps;
        const storeyPreviewEnabled = import.meta.env.VITE_STOREY_FRAGMENT_PREVIEW === 'true';
        if (!model && storeyPreviewEnabled && isBackendShaFingerprint(streamingFp) && streamingCaps?.server_convert) {
          // Non-blocking: fetch storey[0] bytes; resolve/reject is handled below.
          const storeyFetchPromise = fetchStoreyFragment(streamingFp, 0).then(
            (r) => { storeyPreviewResult = r; },
          ).catch(() => { /* non-fatal: full model load continues unchanged */ });
          // Give the smaller storey fetch a short head start.
          await Promise.race([
            storeyFetchPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 800)),
          ]);
          if (!disposed && storeyPreviewResult) {
            const previewResult = storeyPreviewResult as StoreyFragmentResult;
            const storeyModelId = `storey-s0-${Date.now()}`;
            try {
              storeySubModel = await loadFragmentsWithTimeout(
                fragmentsManager,
                previewResult.bytes,
                storeyModelId,
                {
                  timeoutMs: STOREY_FRAGMENT_LOAD_TIMEOUT_MS,
                  autoCoordinate: coordinateModel,
                  graphicsQuality: resolveIdleGraphicsQuality(),
                },
              );
              updateLoadProgress({
                title: 'Streaming storey 1...',
                detail: `First storey visible (${previewResult.storeyName}). Loading full model in background...`,
                progress: 45,
                sourceHint: 'Storey stream',
              });
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Streaming: storey[0] "${previewResult.storeyName}" loaded as preview (source: ${previewResult.source}).`,
              });
            } catch {
              storeySubModel = null; // sub-model load failed - continue normally
            }
          }
        }

        // Reuse an in-flight backend pre-build before re-uploading IFC bytes.
        if (!model) {
          const serverCaps = useStore.getState().serverConvertCaps;
          const prebuildFingerprint = useStore.getState().modelFingerprint;
          const waitPrefs = useStore.getState().prebuildWaitPrefs;
          const prebuildWait = {
            caps: serverCaps,
            fingerprint: prebuildFingerprint,
            timeoutMs: waitPrefs.timeoutMs,
          };
          if (!BROWSER_ONLY && useServerCache && shouldWaitForServerPrebuild(prebuildWait)) {
            updateLoadProgress({
              title: 'Awaiting server pre-build',
              detail: 'Backend is already converting this file - waiting for cache...',
              progress: 22,
              sourceHint: 'Server pre-build',
            });
            const waitStart = performance.now();
            // Poll live pre-build progress while awaiting completion.
            const prebuildPollController = new AbortController();
            void pollConvertProgress(
              `${prebuildWait.fingerprint.slice(0, 12)}-${effectiveGraphicsProfile}`,
              {
                pollIntervalMs: 500,
                signal: prebuildPollController.signal,
                onProgress: (snapshot) => {
                  if (disposed || !snapshot.in_flight) return;
                  const pct = Math.max(0, Math.min(100, snapshot.progress ?? 0));
                  updateLoadProgress({
                    title: 'Awaiting server pre-build',
                    detail: snapshot.stage ?? '',
                    progress: 30 + Math.round(pct * 0.4),
                    sourceHint: 'Server convert',
                  });
                },
              },
            ).catch(() => undefined);
            let status;
            try {
              status = await waitForFragmentReady(
                prebuildWait.fingerprint,
                effectiveGraphicsProfile,
                {
                  timeoutMs: waitPrefs.timeoutMs,
                  pollIntervalMs: waitPrefs.pollIntervalMs,
                },
              );
            } finally {
              prebuildPollController.abort();
            }
            if (status.status === 'complete' && status.serve_url && !disposed) {
              try {
                const fetched = await fetchFragmentByFingerprint(
                  prebuildWait.fingerprint,
                  effectiveGraphicsProfile,
                );
                stageTimings.sidecarMs = performance.now() - waitStart;
                updateLoadProgress({
                  title: 'Loading pre-built fragments',
                  detail: `Cache hit (${(fetched.bytes.byteLength / 1024).toFixed(0)} KB). Skipping IFC upload.`,
                  progress: 70,
                  sourceHint: 'Server pre-build',
                });
                const fragLoadStart = performance.now();
                model = await loadFragmentsWithTimeout(
                  fragmentsManager,
                  fetched.bytes,
                  modelId,
                  { autoCoordinate: coordinateModel },
                );
                stageTimings.cacheLoadMs = performance.now() - fragLoadStart;
                modelLoadSource = 'server-cache';
                if (cacheKey && cachePolicy !== 'off') {
                  void writeRawFragmentCacheIDB(cacheKey, fetched.bytes, cachePolicy);
                }
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Load path chosen: server-cache (pre-build hit) in ${stageTimings.sidecarMs.toFixed(0)} ms.`,
                });
              } catch (servErr) {
                // Cache race: fall through to the upload path.
                clearFragmentThreadPlaceholder(fragmentsManager, modelId);
                modelId = makeViewerModelId();
                const msg = servErr instanceof Error ? servErr.message : String(servErr);
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Server pre-build serve failed (${msg}). Falling back to upload.`,
                });
              }
            }
          }
        }

        // Server-side fragment conversion is the default cold-load path.
        if (!model && !BROWSER_ONLY) {
          let serverCaps = useStore.getState().serverConvertCaps;
          if (fileBytes && shouldRepromoteCapabilities(serverCaps)) {
            const capsWaitMs = serverCapabilityWaitMs(fileBytes.byteLength);
            updateLoadProgress({
              title: 'Checking server converter',
              detail: 'Probing sidecar availability for default server-convert path...',
              progress: 26,
              sourceHint: 'Server convert',
            });
            const caps = await getServerCapabilities({ timeoutMs: capsWaitMs });
            if (!disposed) {
              serverCaps = caps;
              if (import.meta.env.DEV) {
                console.info('[ViewerPanel] server capability probe', {
                  server_convert: caps.server_convert,
                  reason: caps.reason,
                  version: caps.version,
                  waitMs: capsWaitMs,
                });
              }
              if (caps.server_convert || !isRecoverableServerConvertFailure(caps)) {
                useStore.getState().setServerConvertCaps(caps);
              } else {
                useStore.getState().setServerConvertCaps(null);
              }
            }
            if (disposed) return;
          }
          if (fileBytes && defaultParsePathLabel(serverCaps, true) === 'server-convert') {
            useStore.getState().logActivity({
              kind: 'info',
              summary: 'Load path primary attempt: server-convert.',
            });
          }
          if (shouldAttemptServerConvert(serverCaps, !!fileBytes)) {
            let serverBytes: Uint8Array | null = null;
            let serverSource: 'cache' | 'sidecar' = 'sidecar';
            // Pure conversion time as reported by the server (0 on cache
            // hits or when the header is unavailable). Logged next to the
            // round-trip total so "slow load" reports separate conversion
            // cost from upload/transfer/wait overhead.
            let serverConvertMs = 0;
            try {
              updateLoadProgress({
                title: 'Server fragment conversion',
                detail: 'Sending IFC to backend sidecar for fast pre-build...',
                progress: 30,
                sourceHint: 'Server convert',
              });
              const sidecarStart = performance.now();
              // 500 ms polling keeps the bar moving smoothly through the
              // longest phase (the backend captures sidecar progress far more
              // often than that). The detail carries the raw process token
              // ("geometries"/"attributes"/...) so the overlay presenter can
              // translate it into plain language.
              const result = await convertIfcOnServer(fileBytes!, effectiveGraphicsProfile, modelId, {
                bypassCache: !useServerCache,
                progressPollIntervalMs: 500,
                onProgress: (snapshot) => {
                  if (disposed || !snapshot.in_flight) return;
                  const sidecarPct = Math.max(0, Math.min(100, snapshot.progress ?? 0));
                  updateLoadProgress({
                    title: 'Server fragment conversion',
                    detail: snapshot.stage ?? '',
                    progress: 30 + Math.round(sidecarPct * 0.4),
                    sourceHint: 'Server convert',
                  });
                },
              });
              stageTimings.sidecarMs = performance.now() - sidecarStart;
              serverBytes = result.bytes;
              serverSource = result.source;
              serverConvertMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : 0;
              if (import.meta.env.DEV) console.info('[ViewerPanel] server-convert response', {
                source: result.source,
                profile: result.profile,
                bytes: result.bytes.byteLength,
                elapsedMs: result.elapsedMs,
                sourceSha256: result.sourceSha256?.slice(0, 12),
              });
            } catch (sidecarErr) {
              const msg = sidecarErr instanceof Error ? sidecarErr.message : String(sidecarErr);
              console.warn('[ViewerPanel] server-convert call failed', msg);
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Server convert failed (${msg}). Trying local-fragment-cache before browser parse.`,
              });
            }

            // Tiny fragment bytes usually mean an empty-model stub; use browser parse instead.
            if (isSuspiciousServerFragmentBytes(serverBytes)) {
              console.warn('[ViewerPanel] server-convert returned suspiciously small fragment', {
                bytes: serverBytes.byteLength,
                source: serverSource,
              });
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Server convert produced empty fragment (${serverBytes.byteLength} B). Trying local-fragment-cache before browser parse.`,
              });
              serverBytes = null;
            }

            // Load valid server bytes, retrying with a fresh model id if needed.
            if (serverBytes && !disposed) {
              const bytes: Uint8Array = serverBytes;
              const sidecarMs = stageTimings.sidecarMs ?? 0;
              updateLoadProgress({
                title: 'Loading server-built fragments',
                detail: `Received ${(bytes.byteLength / 1024).toFixed(0)} KB from ${serverSource} in ${sidecarMs.toFixed(0)} ms.`,
                progress: 70,
                sourceHint: serverSource === 'cache' ? 'Server cache' : 'Server convert',
              });
              // Big fragments need more headroom than the 60 s base.
              const fragLoadTimeoutMs = computeFragmentLoadTimeoutMs(bytes.byteLength);
              for (let attempt = 1; attempt <= SERVER_FRAGMENT_LOAD_RETRIES; attempt++) {
                try {
                  const fragLoadStart = performance.now();
                  model = await loadFragmentsWithTimeout(
                    fragmentsManager,
                    bytes,
                    modelId,
                    {
                      autoCoordinate: coordinateModel,
                      timeoutMs: fragLoadTimeoutMs,
                      graphicsQuality: resolveIdleGraphicsQuality(),
                    },
                  );
                  stageTimings.cacheLoadMs = performance.now() - fragLoadStart;
                  modelLoadSource = modelLoadSourceForServerFragmentSource(serverSource);
                  if (cacheKey && cachePolicy !== 'off') {
                    void writeRawFragmentCacheIDB(cacheKey, bytes, cachePolicy);
                  }
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: `Load path chosen: ${modelLoadSource} in ${sidecarMs.toFixed(0)} ms`
                      + (serverConvertMs > 0 ? ` (conversion ${serverConvertMs.toFixed(0)} ms,` : ' (')
                      + ` attempt ${attempt}/${SERVER_FRAGMENT_LOAD_RETRIES}).`,
                  });
                  break;
                } catch (loadErr) {
                  clearFragmentThreadPlaceholder(fragmentsManager, modelId);
                  modelId = makeViewerModelId();
                  const msg = formatUnknownLoadError(loadErr);
                  console.warn('[ViewerPanel] server-fragment load failed', { attempt, msg, fragBytesMB: (bytes.byteLength / (1024 * 1024)).toFixed(1), fragLoadTimeoutMs });
                  if (attempt < SERVER_FRAGMENT_LOAD_RETRIES && !disposed) {
                    useStore.getState().logActivity({
                      kind: 'info',
                      summary: `Fragment load attempt ${attempt}/${SERVER_FRAGMENT_LOAD_RETRIES} failed (${msg}). Retrying with fresh modelId...`,
                    });
                    updateLoadProgress({
                      title: 'Retrying fragment load',
                      detail: `Attempt ${attempt + 1}/${SERVER_FRAGMENT_LOAD_RETRIES} after worker stall...`,
                      progress: 72,
                      sourceHint: 'Server convert',
                    });
                  } else {
                    useStore.getState().logActivity({
                      kind: 'info',
                      summary: `Fragment load exhausted ${SERVER_FRAGMENT_LOAD_RETRIES} retries (${msg}). Trying local-fragment-cache before browser parse.`,
                    });
                    model = null;
                  }
                }
              }
            }
          } else if (import.meta.env.DEV) {
            console.info('[ViewerPanel] server-convert skipped; using local/browser fallbacks', {
              serverCaps,
              hasFileBytes: !!fileBytes,
              profile: effectiveGraphicsProfile,
            });
          }
        }

        if (!model && cacheEnabled && cacheKey && !localFragmentCacheChecked) {
          // Probe hint deliberately differs from the confirmed-hit hint
          // ('local-fragment-cache' below) so the overlay presenter does not
          // claim a cache hit before the IDB read resolves.
          updateLoadProgress({
            title: 'Checking local fragment cache',
            detail: 'Backend fragment path unavailable. Checking local browser cache...',
            progress: 74,
            sourceHint: 'Local cache check',
          });
          const cacheReadStart = performance.now();
          const cachedFragments = await readFragmentCacheIDB(cacheKey, cachePolicy);
          stageTimings.cacheReadMs = performance.now() - cacheReadStart;
          if (cachedFragments) {
            try {
              updateLoadProgress({
                title: 'Loading local fragment cache',
                detail: 'Local cache hit after backend path was unavailable.',
                progress: 78,
                sourceHint: 'local-fragment-cache',
              });
              const cacheLoadStart = performance.now();
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                cachedFragments,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              stageTimings.cacheLoadMs = performance.now() - cacheLoadStart;
              modelLoadSource = 'fragments-cache';
              useStore.getState().logActivity({
                kind: 'info',
                summary: 'Load path chosen: local-fragment-cache after backend fragments were unavailable.',
              });
            } catch {
              model = null;
              await deleteFragmentCacheIDBEntry(cacheKey);
              clearFragmentThreadPlaceholder(fragmentsManager, modelId);
              modelId = makeViewerModelId();
              updateLoadProgress({
                title: 'Local cache fallback',
                detail: 'Local fragments were stale. Switching to browser parse fallback...',
                progress: 80,
                sourceHint: 'worker-parse',
              });
            }
          }
        }

        // Worker-side IFC parse path: IfcImporter.process() runs in a
        // dedicated Web Worker so the main thread stays responsive at 60 fps
        // during the WASM geometry conversion step. Falls through to the
        // blocking IfcLoader.load() path on any worker error.
        if (!model && fileBytes) {
          const workerClient = new IfcConvertWorker();
          try {
            updateLoadProgress({
              title: 'Converting IFC (worker)',
              detail: 'Parsing geometry in background thread - UI stays responsive...',
              progress: 28,
              sourceHint: 'Worker parse',
            });
            const workerParseStart = performance.now();
            const workerTimeoutMs = computeLiveParseTimeoutMs(fileBytes.byteLength);
            const workerBytes = new ArrayBuffer(fileBytes.byteLength);
            new Uint8Array(workerBytes).set(fileBytes);
            const fragmentBytes = await raceWithTimeout(
              workerClient.convert(
                workerBytes,
                effectiveGraphicsProfile,
                import.meta.env.BASE_URL || '/',
                (stage, pct) => {
                  if (disposed) return;
                  // IfcImporter reports fractions (0..1); normalize before
                  // mapping into the 28-92 band or the bar freezes at ~28 %.
                  const cappedPct = Math.min(normalizeImportProgress(pct), 92);
                  updateLoadProgress({
                    title: stage ?? 'Converting IFC',
                    detail: cappedPct >= 92
                      ? 'Finalising geometry, please wait...'
                      : `Worker parse ${cappedPct.toFixed(0)}%`,
                    progress: 28 + Math.round(cappedPct * 0.64),
                    sourceHint: 'Worker parse',
                  });
                },
              ),
              workerTimeoutMs,
              'Worker parse',
            );
            stageTimings.parseMs = performance.now() - workerParseStart;

            if (!disposed) {
              updateLoadProgress({
                title: 'Loading worker fragments',
                detail: `Worker parse done in ${stageTimings.parseMs.toFixed(0)} ms. Loading geometry...`,
                progress: 94,
                sourceHint: 'Worker parse',
              });
              model = await loadFragmentsWithTimeout(
                fragmentsManager,
                fragmentBytes,
                modelId,
                { autoCoordinate: coordinateModel, graphicsQuality: resolveIdleGraphicsQuality() },
              );
              modelLoadSource = 'worker-parse';
              if (cacheKey) {
                scheduleFragmentCacheIDBPersist(cacheKey, model, cachePolicy);
              }
              useStore.getState().logActivity({
                kind: 'info',
                summary: `Load path chosen: worker-parse in ${stageTimings.parseMs.toFixed(0)} ms (main thread was free).`,
              });
            }
          } catch (workerErr) {
            clearFragmentThreadPlaceholder(fragmentsManager, modelId);
            modelId = makeViewerModelId();
            const msg = workerErr instanceof Error ? workerErr.message : String(workerErr);
            console.warn('[ViewerPanel] worker parse failed, falling back to IfcLoader:', msg);
            useStore.getState().logActivity({
              kind: 'info',
              summary: `Worker parse failed (${msg}). Falling back to blocking IFC parse.`,
            });
            model = null;
          } finally {
            workerClient.dispose();
          }
        }

        if (!model) {
          useStore.getState().logActivity({
            kind: 'info',
            summary: cacheEnabled
              ? 'Load path chosen: live-parse after server/local/worker fallbacks.'
              : 'Load path chosen: live-parse (cache disabled).',
          });

          const ifcLoader = components.get(OBC.IfcLoader);
          // BASE_URL keeps the wasm reachable on sub-path hosting (GH Pages
          // project sites); it is '/' in dev and root deployments.
          ifcLoader.settings.wasm.path = import.meta.env.BASE_URL || '/';
          ifcLoader.settings.wasm.absolute = true;
          ifcLoader.settings.autoSetWasm = false;
          ifcLoader.settings.webIfc = {
            ...ifcLoader.settings.webIfc,
            ...getWebIfcSettingsForProfile(effectiveGraphicsProfile),
          };

          updateLoadProgress({
            title: 'Preparing IFC importer',
            detail: 'Initializing WASM importer for live parse...',
            progress: 24,
            sourceHint: 'Live parse',
          });
          // Apply the single-thread web-ifc patch LAZILY but AWAITED,
          // right before the only main-thread IfcAPI.Init() in the app
          // (OBC.IfcLoader.setup() calls Init() on the calling thread). The
          // static import was removed from main.tsx so the entry no longer
          // pulls the web-ifc chunk before the shell paints (LCP); the .frag /
          // server / worker load paths never reach here, so web-ifc only loads
          // on the main thread when this blocking live-parse fallback fires.
          // The patch monkey-patches IfcAPI.prototype.Init, so applying it
          // before setup() (not before construction at components.get above) is
          // sufficient. Never fire-and-forget - Init() must see the patch.
          await import('../../services/ifc/webIfcPatch');
          const ifcSetupStart = performance.now();
          await ifcLoader.setup();
          stageTimings.ifcSetupMs = performance.now() - ifcSetupStart;

          const parseProgressTracker = {
            ts: 0,
            progress: -1,
            stage: '',
          };

          updateLoadProgress({
            title: 'Streaming geometry batches',
            detail: 'Live IFC parse in progress...',
            progress: 28,
            sourceHint: 'Live parse',
          });

          // Keep importer output compressed so the fragment worker can inflate it.
          const parseStart = performance.now();
          // Slow-load warning is handled by the pipeline-wide timer at the
          // top of init(), which covers this branch too.
          // Hard timeout so a broken FragmentsManager worker can't hang the
          // viewer indefinitely at "Finalizing fragment model 92 %".
          const liveParseTimeoutMs = computeLiveParseTimeoutMs(fileBytes!.byteLength);
          try {
            // coordinateModel is declared above (before the worker path) so both paths share it.
            model = await raceWithTimeout(
              ifcLoader.load(fileBytes!, coordinateModel, modelId, {
                processData: {
                  progressCallback: (progress, data) => {
                    if (disposed) return;

                    const normalizedProgress = normalizeImportProgress(progress);
                    const stageLabel = IMPORT_STAGE_LABELS[data.process] ?? 'Parsing IFC';
                    const now = performance.now();
                    const sameStage = parseProgressTracker.stage === stageLabel;
                    const tinyProgressStep = Math.abs(normalizedProgress - parseProgressTracker.progress) < 1;
                    const tooSoon = now - parseProgressTracker.ts < 70;
                    if (sameStage && tinyProgressStep && tooSoon) return;

                    parseProgressTracker.stage = stageLabel;
                    parseProgressTracker.progress = normalizedProgress;
                    parseProgressTracker.ts = now;

                    // Map importer progress into the viewer's 28-92 parse band.
                    const bandedProgress = 28 + Math.round(Math.min(normalizedProgress, 100) * 0.64);
                    const detail = normalizedProgress >= 92
                      ? 'Processing geometry, please wait...'
                      : formatImportProgressDetail(data);

                    updateLoadProgress({
                      title: stageLabel,
                      detail,
                      progress: bandedProgress,
                      sourceHint: 'Live parse',
                    });
                  },
                },
                instanceCallback: (importer) => {
                  configureImporter(importer, effectiveGraphicsProfile);
                },
              }),
              liveParseTimeoutMs,
              'Live IFC parse',
            );
          } catch (liveErr) {
            clearFragmentThreadPlaceholder(fragmentsManager, modelId);
            const msg = liveErr instanceof Error ? liveErr.message : String(liveErr);
            useStore.getState().logActivity({
              kind: 'error',
              summary: `Live IFC parse failed (${msg}).`,
              detail:
                'The viewer could not load the model after exhausting the server-convert, ' +
                'worker-parse, and live-parse paths. The fragment worker may be stuck - ' +
                'hard-refresh the page (Ctrl+Shift+R) to recover.',
            });
            throw liveErr;
          }
          stageTimings.parseMs = performance.now() - parseStart;

          if (disposed) return;

          updateLoadProgress({
            title: 'Finalizing fragment model',
            detail: 'Parse complete. Preparing render-ready scene...',
            progress: 94,
            sourceHint: 'Live parse',
          });
          if (cacheKey) {
            scheduleFragmentCacheIDBPersist(cacheKey, model, cachePolicy);
          }
        }

        if (!model) throw new Error('Model could not be loaded');
        fragmentModelForUpdateAck = model;

        // Cached-load backend warm-up: when the viewer loads from cached
        // fragments (manifest fast-path, IDB cache, or server cache hit
        // for a fingerprint that wasn't just uploaded), the backend's
        // IfcOpenShell handle may not be loaded - e.g. after a backend
        // restart, or when the page is reloaded without a fresh drop.
        // Without this, property queries return 400 and the AI ready chip
        // stays "idle". Fire-and-forget; never blocks the load path.
        if (!BROWSER_ONLY && isCacheHitModelLoadSource(modelLoadSource)) {
          const cachedFingerprint = useStore.getState().modelFingerprint;
          if (isBackendShaFingerprint(cachedFingerprint)) {
            void (async () => {
              if (disposed) return;
              try {
                const readiness = await import('../../services/api').then((m) => m.getReadiness());
                if (disposed) return;
                if (readiness.ifcopenshell !== 'ready' && readiness.ifcopenshell !== 'warming') {
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: 'Cached-load: warming backend IfcOpenShell handle from disk...',
                  });
                  await import('../../services/api').then((m) => m.warmFromCache(cachedFingerprint));
                  if (disposed) return;
                  useStore.getState().logActivity({
                    kind: 'info',
                    summary: 'Backend IfcOpenShell handle warm - property + AI queries ready.',
                  });
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                useStore.getState().logActivity({
                  kind: 'info',
                  summary: `Backend warm-from-cache skipped (${msg}). Drop the file again to re-upload.`,
                });
              }
            })();
          }
        }

        // Add model to scene and connect camera for tile-based LOD rendering
        updateLoadProgress({
          title: attachGeometryTitle(modelLoadSource),
          detail: 'Mounting fragments into the viewport scene...',
          progress: 94,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });
        world.scene.three.add(model.object);
        model.useCamera(world.camera.three as THREE.PerspectiveCamera);

        // Opportunistically promote the IDB fragment cache to
        // persistent storage on first cache-eligible model load. Idempotent
        // (once-only guard inside requestPersistentStorageOnce); silent on
        // browsers that don't expose the API. Fire-and-forget; never blocks
        // the load path.
        if (cachePolicy !== 'off') {
          void requestPersistentStorageOnce().then((state) => {
            if (disposed) return;
            useStore.getState().setFragmentCachePersisted(state);
          });
        }

        // Optional diagnostic BVH on non-instanced scene meshes after the model is
        // mounted.  This accelerates every THREE.Raycaster.intersectObjects
        // call (gizmo picks, clip-plane drag origin, future scene objects).
        // InstancedMesh is skipped - @thatopen manages those internally.
        // Runs async-deferred so it doesn't stall the first paint.
        if (import.meta.env.VITE_VIEWER_COMPUTE_SCENE_BVH === 'true') {
          setTimeout(() => {
            const bvhCount = computeSceneBVH(world.scene.three);
            const cov = getBVHCoverage(world.scene.three);
            console.info(
              `[BVH] Computed BVH for ${bvhCount} meshes. ` +
              `Coverage: ${cov.bvhMeshes}/${cov.totalMeshes} (${cov.coveragePct.toFixed(0)}%)`,
            );
          }, 500);
        }

        // Kick off the first tile update WITHOUT awaiting its completion.
        // Previously we `await fragmentsManager.core.update(true)` here -
        // which blocks until ALL fragment tiles resolve synchronously. On
        // a ~100 MB hospital IFC that's 5-10 s of "stuck at 85%" where the
        // user can't tell if the app is working. Fire-and-forget lets the
        // first tiles paint within a frame or two and the rest stream in
        // naturally via the normal camera-change tile update cycle.
        try { void fragmentsManager.core.update(false); } catch { /* best-effort */ }
        updateLoadProgress({
          title: 'Rendering first frame',
          detail: 'Geometry is visible. Aligning camera and grid...',
          progress: 96,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });
        const ttfg = performance.now() - initStart;
        useStore.getState().updatePerfMetrics({ ttfgMs: ttfg });

        // In concurrent_fast we keep bytes around so remounts cannot fall back
        // to a stale backend IFC before deferred persistence completes.
        if (startupMode === 'full_upfront') {
          useStore.getState().setIfcFileBytes(null);
          modelService.releaseRawBytes();
        }

        // Fit camera to the loaded model bounding box and align the grid
        // to the model's actual ground plane (box.min.y) instead of world y=0.
        // IFC models are usually exported with their ground at z=0 in IFC
        // space, which maps to y=0 in the viewer's Y-up Three.js scene -
        // but some authoring tools export with arbitrary offsets, and even
        // sub-meter offsets make the default y=0 grid look "floating".
        const modelCenter = new THREE.Vector3();
        const modelSize = new THREE.Vector3();
        let groundY = 0;
        try {
          const allIds = await model.getLocalIds();
          const box = await model.getMergedBox(allIds);
          if (box) {
            box.getCenter(modelCenter);
            box.getSize(modelSize);
            groundY = box.min.y;
            const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
            const dist = computeFitDistance(camera, modelSize, 1.22);
            const isoDir = new THREE.Vector3(1, 0.76, 1).normalize();
            const eye = modelCenter.clone().addScaledVector(isoDir, dist);

            world.camera.controls.setLookAt(
              eye.x, eye.y, eye.z,
              modelCenter.x, modelCenter.y, modelCenter.z,
              true,
            );
            // Guarantee tiles render after the camera animation finishes.
            // The 'update' event listener may not fire during animated setLookAt
            // in all @thatopen/components versions, so we schedule an explicit
            // forced update ~400 ms after the camera starts moving (animation
            // is typically 300 ms) so tiles resolve regardless.
            setTimeout(() => {
              if (!disposed) {
                fragmentUpdateScheduler?.request({
                  priority: 'visual',
                  force: true,
                  reason: 'camera',
                });
              }
            }, 450);
          }
        } catch {
          world.camera.controls.setLookAt(30, 30, 30, 0, 0, 0);
          modelCenter.set(0, 0, 0);
          modelSize.set(10, 10, 10);
        }

        // Align the grid mesh to the model's ground plane so it visually
        // sits at the same level as the model's floor slab / storey 0.
        try {
          const gridObj = (grid as unknown as { three?: THREE.Object3D }).three;
          if (gridObj) {
            gridObj.position.y = groundY;
            gridObj.updateMatrixWorld(true);
          }
        } catch {
          /* grid position adjustment is purely cosmetic */
        }

        // Stable per-mesh depth buckets reduce flicker from coplanar IFC surfaces.
        let zFightPollInterval = 0;
        let zFightStableTicks = 0;
        let zFightDeferredDuringNav = false;
        // Once the poll has seen the scene fully biased (stable), the
        // per-flush traverse is throttled hard: onViewUpdated fires after
        // EVERY forced flush (each hover/click highlight), and on a
        // thousands-of-meshes model even the WeakMap-skip walk is real
        // per-flush cost. A late LOD tile swap during the throttle window
        // self-heals on the next allowed pass (<= 2 s).
        let zFightStableSince = 0;
        let zFightLastRunTs = 0;
        const Z_FIGHT_STABLE_MIN_INTERVAL_MS = 2000;
        const applyZFightBias = () => {
          // Never traverse the scene mid-navigation. onViewUpdated fires
          // after every camera-driven tile swap, so during an orbit this ran
          // per flush; one deferred pass now runs from the settle handler.
          // (The traverse itself is also idempotent-cheap since the
          // zFightingMitigation tracking pass - repeat calls are WeakMap
          // lookups, no userData writes, no material.needsUpdate.)
          if (cameraNavigatingRef.current) {
            zFightDeferredDuringNav = true;
            return;
          }
          const now = performance.now();
          if (zFightStableSince > 0 && now - zFightLastRunTs < Z_FIGHT_STABLE_MIN_INTERVAL_MS) {
            return;
          }
          zFightLastRunTs = now;
          try {
            const stats = applyFragmentZFightingMitigation(model.object);
            if (import.meta.env.DEV && stats.meshCount > 0) {
              console.debug('[viewer] z-fighting mitigation', stats);
            }
          } catch {
            /* z-fighting mitigation is best-effort */
          }
        };
        // @thatopen/fragments streams meshes in incrementally and swaps mesh
        // materials during LOD updates; onViewUpdated doesn't fire for every
        // streaming addition, and the OBC renderer only ticks onBeforeUpdate
        // on render-triggering events. Poll the scene at low frequency and
        // re-apply whenever a mesh has lost polygonOffset or the per-element
        // depth shader patch. Stop polling once the scene has been fully
        // biased for several ticks; onViewUpdated then covers later LOD swaps.
        const stopZFightPoll = () => {
          if (zFightPollInterval) {
            window.clearInterval(zFightPollInterval);
            zFightPollInterval = 0;
          }
        };
        const hasUnmitigatedOpaqueMesh = (): boolean => hasPendingFragmentZFightingMitigation(model.object);
        const onZFightPoll = () => {
          if (disposed) { stopZFightPoll(); return; }
          if (hasUnmitigatedOpaqueMesh()) {
            zFightStableSince = 0; // new unbiased meshes - lift the throttle
            applyZFightBias();
            zFightStableTicks = 0;
          } else {
            // Stop polling after a few stable ticks; view updates cover later swaps.
            zFightStableTicks += 1;
            if (zFightStableTicks >= 3) {
              zFightStableSince = performance.now();
              stopZFightPoll();
            }
          }
        };
        try {
          // New model: reset processed-mesh tracking.
          resetFragmentZFightingTracking();
          applyZFightBias();
          model.onViewUpdated.add(applyZFightBias);
          zFightPollInterval = window.setInterval(onZFightPoll, 1000);
          zFightingCleanup = () => {
            stopZFightPoll();
            try { model.onViewUpdated.remove(applyZFightBias); } catch { /* model may be disposed */ }
          };
        } catch { /* z-fighting mitigation is best-effort */ }

        // Store viewer references
        viewerRef.current = {
          components,
          world: world as any,
          model,
          modelCenter,
          modelSize,
          grid: grid as unknown as { three: THREE.Object3D },
        };

        const setupNavigationLodSwap = () => {
          const lodSwap = new LodSwapController(() => requestViewerRender(180));
          lodSwap.setTargets(model.object, null);
          const lodControls = world.camera.controls;
          const onLodNav = () => lodSwap.onNavigate();
          const onLodRest = () => lodSwap.onRest();
          lodControls.addEventListener('wake', onLodNav);
          lodControls.addEventListener('controlstart', onLodNav);
          lodControls.addEventListener('update', onLodNav);
          lodControls.addEventListener('rest', onLodRest);
          lodControls.addEventListener('sleep', onLodRest);

          let lodAttached: AttachedLod | null = null;
          let lodAbort: AbortController | null = null;
          let lodLoadGeneration = 0;
          let lodLoading = false;

          const disposeAttached = () => {
            lodLoadGeneration += 1;
            lodLoading = false;
            try { lodAbort?.abort(); } catch { /* best-effort */ }
            lodAbort = null;
            try { lodAttached?.dispose(); } catch { /* best-effort */ }
            lodAttached = null;
            lodSwap.setTargets(model.object, null);
            if (import.meta.env.DEV) (window as any).__ifcLodAttached = false;
          };

          const startLodLoad = () => {
            if (
              disposed
              || lodLoading
              || lodAttached
              || !useStore.getState().largeModelLod
            ) return;
            lodLoading = true;
            const generation = ++lodLoadGeneration;
            const abort = new AbortController();
            lodAbort = abort;
            void loadAndAttachLod({
              fragmentsManager,
              worldScene: world.scene.three as unknown as THREE.Object3D,
              fullModelId: modelId,
              lodModelId: `${modelId}__lod_${generation}`,
              autoCoordinate: coordinateModel,
              camera: world.camera.three as THREE.Camera,
              fingerprint: useStore.getState().modelFingerprint,
              profile: graphicsProfile,
              signal: abort.signal,
              allVisibleLodMode: FRAGS.LodMode.ALL_VISIBLE,
            }).then((attached) => {
              if (generation !== lodLoadGeneration || disposed || !useStore.getState().largeModelLod) {
                attached?.dispose();
                return;
              }
              lodLoading = false;
              lodAbort = null;
              if (!attached) return;
              lodAttached = attached;
              lodSwap.setTargets(model.object, attached.lodObject);
              if (import.meta.env.DEV) (window as any).__ifcLodAttached = true;
            });
          };

          // The decimated proxy does not carry per-element appearance state
          // or the separately merged furnishing mesh. Keep the primary model
          // visible whenever one of those overrides is active.
          // Keep the subscription selector store-only. The lifecycle ref is
          // refreshed explicitly below; including it in the selector would
          // desynchronise Zustand's remembered value from LodSwapController
          // and could miss the next store-driven gate closure.
          const canSwapFromStore = (s: ReturnType<typeof useStore.getState>) => (
            canUseNavigationLod({
              enabled: s.largeModelLod,
              isolatedCount: s.isolatedIds.length,
              hiddenCount: s.hiddenIds.length,
              ghostModeOn: s.ghostModeOn,
              selectedElementId: s.selectedElementId,
              selectedCount: s.selectedIds.length,
              highlightedCount: s.highlightedIds.length,
              colourBy: s.colourBy,
              colourLayerCount: Object.keys(s.colourLayers).length,
              // Actual/pending merge state is owned by the lifecycle ref and
              // applied in refreshAppearanceGate below. The persisted request
              // alone must not disable navigation LOD while merge is suspended
              // for fragment interactions.
              furnishingMerged: false,
            })
          );
          const refreshAppearanceGate = () => {
            lodSwap.setEnabled(
              canSwapFromStore(useStore.getState())
              && !furnishingMergeLifecycleRef.current?.blocksNavigationLod
              && !exactPickLeaseRef.current?.active,
            );
          };
          navigationLodAppearanceRefreshRef.current = refreshAppearanceGate;
          const unsubAppearance = useStore.subscribe(
            canSwapFromStore,
            refreshAppearanceGate,
            { fireImmediately: true },
          );
          const unsubPreference = useStore.subscribe(
            (s) => s.largeModelLod,
            (enabled: boolean) => {
              if (enabled) startLodLoad();
              else disposeAttached();
            },
            { fireImmediately: true },
          );

          lodCleanupRef.current = () => {
            if (navigationLodAppearanceRefreshRef.current === refreshAppearanceGate) {
              navigationLodAppearanceRefreshRef.current = null;
            }
            try { unsubAppearance(); } catch { /* best-effort */ }
            try { unsubPreference(); } catch { /* best-effort */ }
            try {
              lodControls.removeEventListener('wake', onLodNav);
              lodControls.removeEventListener('controlstart', onLodNav);
              lodControls.removeEventListener('update', onLodNav);
              lodControls.removeEventListener('rest', onLodRest);
              lodControls.removeEventListener('sleep', onLodRest);
            } catch { /* best-effort */ }
            disposeAttached();
            lodSwap.dispose();
          };
        };

        // Small and medium models pin ALL_VISIBLE so no element ever pops in
        // or out with camera distance; only large models keep the worker's
        // coverage classifier (see lodTierPolicy.ts for the tier contract).
        void (async () => {
          try {
            const ids = await model.getLocalIds();
            if (disposed || ids.length === 0) return;
            const tier = resolveLodTier(ids.length);
            modelLodTiers.set(modelId, tier);
            if (typeof model.setLodMode === 'function') {
              await model.setLodMode(
                shouldPinAllVisible(tier)
                  ? FRAGS.LodMode.ALL_VISIBLE
                  : FRAGS.LodMode.DEFAULT,
              );
            }
            if (disposed) return;
            // A second fragments model is worthwhile only for genuinely large
            // models. Medium fixtures use worker LOD and avoid duplicate GPU /
            // worker memory entirely.
            // Prepare the lazy preference subscription for large models; the
            // proxy itself is fetched only while the preference is enabled.
            if (shouldAttachNavigationLod(tier, true)) {
              setupNavigationLodSwap();
            }
            // Re-apply the current ladder level now that the tier is known:
            // covers a ladder change racing the load and applies the
            // large-tier resting cap to the freshly copied load seed.
            applyPerModelGraphicsQuality(
              getRuntimeQualitySettings(interactionQualityRef.current.active).graphicsQuality,
            );
          } catch { /* LOD mode is an optimization, never fatal */ }
        })();

        // Tell the ClipEdgesService which model to section so filled caps
        // show up on subsequent section cuts (or any cuts already active).
        clipEdgesServiceRef.current?.setModel(modelId);

        // Publish half-extents to the store for UI widgets that need a
        // model-relative range (e.g. the clip plane offset slider).
        useStore.getState().setModelHalfExtents({
          x: Math.max(1, modelSize.x * 0.5),
          y: Math.max(1, modelSize.y * 0.5),
          z: Math.max(1, modelSize.z * 0.5),
        });

        // Register with the client-side ModelService so panels and LLM
        // tools can read project info / psets / quantities without a
        // backend round-trip. register() populates refs + the
        // expressID<->localID map; consumer panels move from backend to
        // ModelService behind feature flags.
        try {
          await modelService.register({ model, fileBytes: fileBytes!, components });
        } catch (err) {
          console.warn('[ViewerPanel] ModelService register failed', err);
        }

        // Cleanup - real model is loaded; remove preview meshes so
        // we don't double-render.
        if (nativePreview) {
          const scene = world.scene?.three as THREE.Scene | undefined;
          if (scene) removeNativePreview(scene, nativePreview);
          nativePreview = null;
        }

        // Development-only window hook so the preview/E2E harness can drive the
        // viewer without reaching through React. Only set in development - the
        // import.meta.env.DEV gate keeps it out of production bundles.
        if (import.meta.env.DEV) {
          (window as any).__ifcViewer = viewerRef.current;
          (window as any).__ifcStore = useStore;
          (window as any).__ifcModelService = modelService;
          // Development-only performance harness. __ifcRenderStats() reports
          // the live main-pass snapshot when a frame was captured recently
          // (renderStatsSnapshot.ts - no extra render pass), and only falls
          // back to a dedicated probe render when the snapshot is stale
          // (no frame drawn yet, or MANUAL mode idle beyond the dev
          // keep-alive cadence); __ifcOrbitBench(seconds, degrees) drives a
          // constant-speed orbit and reports frame-time percentiles - run it
          // in a VISIBLE tab (hidden tabs freeze rAF and the numbers are
          // meaningless).
          (window as any).__ifcRenderStats = () => {
            const renderer = world.renderer!.three;
            const info = renderer.info;
            const heap = (performance as unknown as {
              memory?: { usedJSHeapSize?: number };
            }).memory?.usedJSHeapSize;
            const jsHeapMB = typeof heap === 'number' ? Math.round(heap / 1048576) : null;
            // Fresh window: 2 s covers the 1 s RENDER_ON_DEMAND dev
            // keep-alive with margin; the AUTO loop refreshes every vsync.
            if (isMainPassFresh(performance.now(), 2000)) {
              const snap = getMainPassStats();
              return {
                drawCalls: snap.drawCalls,
                triangles: snap.triangles,
                geometries: info.memory.geometries,
                textures: info.memory.textures,
                programs: info.programs?.length ?? null,
                jsHeapMB,
              };
            }
            // Stale snapshot: measure with a dedicated render pass - one
            // extra full-scene draw per probe call in development. The extra
            // counts land after the frame capture, so the snapshot stays
            // clean (next frame's reset wipes them).
            const before = { calls: info.render.calls, triangles: info.render.triangles };
            try {
              renderer.render(world.scene!.three, world.camera.three);
            } catch { /* fall back to loop counters */ }
            const delta = {
              calls: info.render.calls - before.calls,
              triangles: info.render.triangles - before.triangles,
            };
            return {
              drawCalls: delta.calls > 0 ? delta.calls : info.render.calls,
              triangles: delta.triangles > 0 ? delta.triangles : info.render.triangles,
              geometries: info.memory.geometries,
              textures: info.memory.textures,
              programs: info.programs?.length ?? null,
              jsHeapMB,
            };
          };
          (window as any).__ifcOrbitBench = (seconds = 5, degrees = 360) =>
            new Promise((resolve) => {
              const benchControls = world.camera.controls as unknown as {
                rotate: (az: number, polar: number, transition?: boolean) => void;
              };
              const totalMs = Math.max(500, seconds * 1000);
              const minimumValidSamples = 6;
              const maximumMs = Math.max(10_000, totalMs * 5);
              const azPerMs = (degrees * (Math.PI / 180)) / totalMs;
              const deltas: number[] = [];
              let validPostFirstFrameSamples = 0;
              const t0 = performance.now();
              let last = t0;
              const step = () => {
                if (disposed) {
                  resolve(summarizeFrameDeltas(deltas));
                  return;
                }
                const now = performance.now();
                const dt = now - last;
                last = now;
                deltas.push(dt);
                if (deltas.length > 1 && Number.isFinite(dt) && dt > 0) {
                  validPostFirstFrameSamples += 1;
                }
                try {
                  benchControls.rotate(azPerMs * dt, 0, false);
                } catch { /* keep sampling even if the controls API shifts */ }
                if (shouldContinueFrameSampling({
                  elapsedMs: now - t0,
                  requestedDurationMs: totalMs,
                  validSamples: validPostFirstFrameSamples,
                  minimumSamples: minimumValidSamples,
                  maximumDurationMs: maximumMs,
                })) {
                  requestAnimationFrame(step);
                } else {
                  // First delta spans the call-to-first-frame gap; drop it.
                  const stats = {
                    ...summarizeFrameDeltas(deltas.slice(1)),
                    ...(window as any).__ifcRenderStats(),
                  };
                  console.info('[viewer] orbit bench', stats);
                  resolve(stats);
                }
              };
              requestAnimationFrame(step);
            });
          // One-shot draw-call/memory snapshot on the next rendered frame
          // after the model is ready - the per-load baseline line.
          const postLoadSnapshot = () => {
            try { world.renderer!.onAfterUpdate.remove(postLoadSnapshot); } catch { /* once */ }
            if (disposed) return;
            console.info('[viewer] post-load render stats', {
              modelId,
              source: modelLoadSource,
              ...(window as any).__ifcRenderStats(),
            });
          };
          world.renderer!.onAfterUpdate.add(postLoadSnapshot);
        }

        // Apply current theme to the live scene (background + grid colors)
        applyTheme(useStore.getState().theme);

        // Keep post-fit tile refresh out of the blocking startup path.
        // We trigger it after ready as fire-and-forget.
        updateLoadProgress({
          title: 'Finalizing viewport',
          detail: 'Applying interaction handlers and quality controls...',
          progress: 98,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });

        // Subscribe to camera movement so tiles re-evaluate LOD/visibility.
        // Two optimizations vs the previous straight listener:
        //
        //   1. rAF-coalesce - `update` fires on every mousemove during
        //      orbit, which was asking the tile system to reshuffle faster
        //      than it could complete, producing half-loaded frames. We
        //      schedule at most one non-forced update per animation frame.
        //   2. Adaptive graphicsQuality - drop to 0.7 while orbiting, snap
        //      back to 1.0 ~300 ms after the last movement. Idle users see
        //      full detail; orbiting users get +30-60% FPS on large models.
        //   3. A single forced update(true) 300 ms post-settle replaces the
        //      old [150, 400, 1000, 2500] ms setTimeout ladder, which caused
        //      visible pop-in/out as each forced update re-evaluated the
        //      LOD budget from scratch.
        try {
          const controls = world.camera.controls as unknown as {
            addEventListener: (ev: string, fn: () => void) => void;
          };
          let rafPending = false;
          let settleTimer: number | null = null;
          let orbiting = false;
          // Re-entrancy guard for the eager show-pass scheduled
          // from the rAF callback below. Without it a fast orbit can stack
          // overlapping showPass invocations and race their setVisible writes.
          let showPassPending = false;
          let lastShowPassTs = 0;
          let panelResizing = false;
          let windowResizeEndTimer: number | null = null;
          // Rest-keyed settle state guards active pointer gestures and damping tails.
          let controlActive = false;
          let suppressNavStartUntil = 0;

          const isPanelResizing = () => panelResizing || document.body.classList.contains('is-resizing');
          const getSpatialTileViewOptions = () => {
            const state = useStore.getState();
            const selectedExpressIds = new Set<number>([
              ...state.selectedIds,
              ...(state.selectedElementId == null ? [] : [state.selectedElementId]),
            ]);
            const pinnedLocalIds = new Set<number>();
            for (const expressId of selectedExpressIds) {
              const localId = expressToLocalCacheRef.current.get(expressId)
                ?? modelService.getRememberedLocalId(expressId)
                ?? undefined;
              if (localId !== undefined) pinnedLocalIds.add(localId);
            }
            return {
              pinnedLocalIds,
              viewportHeightPx: world.renderer?.three.domElement.clientHeight
                || containerRef.current?.clientHeight
                || window.innerHeight,
            };
          };

          const onPanelResizeStart = () => {
            panelResizing = true;
            cameraNavigatingRef.current = true;
            fragmentUpdateScheduler?.setNavigating(true);
            applyGhostPostproduction(true);
            cancelDprDrop();
            setInteractionPixelRatioCap(navigationPixelRatioCap);
            hoverGenRef.current += 1;
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
              hoverIntentTimer = null;
            }
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            orbiting = false;
            try {
              fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
            } catch {
              /* ignore */
            }
          };

          const onPanelResizeEnd = () => {
            panelResizing = false;
            cameraNavigatingRef.current = false;
            fragmentUpdateScheduler?.setNavigating(false);
            applyGhostPostproduction(false);
            restoreLadderPixelRatioCap();
            if (disposed) return;
            requestAnimationFrame(() => {
              if (disposed || isPanelResizing()) return;
              try {
                fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
                fragmentUpdateScheduler?.request({
                  priority: 'visual',
                  force: true,
                  reason: 'resize',
                });
              } catch {
                /* ignore */
              }
            });
          };

          const onWindowResize = () => {
            panelResizing = true;
            cameraNavigatingRef.current = true;
            fragmentUpdateScheduler?.setNavigating(true);
            applyGhostPostproduction(true);
            cancelDprDrop();
            setInteractionPixelRatioCap(navigationPixelRatioCap);
            hoverGenRef.current += 1;
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
              hoverIntentTimer = null;
            }
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            if (windowResizeEndTimer !== null) {
              window.clearTimeout(windowResizeEndTimer);
              windowResizeEndTimer = null;
            }
            orbiting = false;
            try {
              fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
            } catch {
              /* ignore */
            }

            // Treat a resize burst as one interaction and refresh once it settles.
            windowResizeEndTimer = window.setTimeout(() => {
              windowResizeEndTimer = null;
              panelResizing = false;
              cameraNavigatingRef.current = false;
              fragmentUpdateScheduler?.setNavigating(false);
              applyGhostPostproduction(false);
              restoreLadderPixelRatioCap();
              if (disposed) return;
              requestAnimationFrame(() => {
                if (disposed || isPanelResizing()) return;
                try {
                  fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
                  fragmentUpdateScheduler?.request({
                    priority: 'visual',
                    force: true,
                    reason: 'resize',
                  });
                } catch {
                  /* ignore */
                }
              });
            }, 180);
          };

          window.addEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart as EventListener);
          window.addEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd as EventListener);
          window.addEventListener('resize', onWindowResize);
          removePanelResizeHooks = () => {
            window.removeEventListener(PANEL_RESIZE_START_EVENT, onPanelResizeStart as EventListener);
            window.removeEventListener(PANEL_RESIZE_END_EVENT, onPanelResizeEnd as EventListener);
            window.removeEventListener('resize', onWindowResize);
            if (windowResizeEndTimer !== null) {
              window.clearTimeout(windowResizeEndTimer);
              windowResizeEndTimer = null;
            }
          };

          const onCameraChange = () => {
            if (disposed) return;
            lastCameraUpdateTs = performance.now();

            // During panel drag-resize, avoid LOD thrashing and forced tile refreshes.
            if (isPanelResizing()) {
              cameraNavigatingRef.current = true;
              fragmentUpdateScheduler?.setNavigating(true);
              applyGhostPostproduction(true);
              cancelDprDrop();
              setInteractionPixelRatioCap(navigationPixelRatioCap);
              hoverGenRef.current += 1;
              if (hoverIntentTimer !== null) {
                window.clearTimeout(hoverIntentTimer);
                hoverIntentTimer = null;
              }
              if (settleTimer !== null) {
                window.clearTimeout(settleTimer);
                settleTimer = null;
              }
              orbiting = false;
              try {
                fragmentsManager.core.settings.graphicsQuality = resolveIdleGraphicsQuality();
              } catch {
                /* ignore */
              }
              return;
            }

            // Suppress post-rest damping tails without losing repaint updates.
            if (!orbiting && performance.now() < suppressNavStartUntil) {
              // Renew suppression while programmatic transition tails keep emitting.
              suppressNavStartUntil = performance.now() + 400;
              fragmentUpdateScheduler?.request({
                priority: 'camera',
                force: false,
                reason: 'camera',
              });
              return;
            }

            // Adaptive LOD: drop quality while the user is actively moving.
            if (!orbiting) {
              orbiting = true;
              cameraNavigatingRef.current = true;
              fragmentUpdateScheduler?.setNavigating(true);
              applyGhostPostproduction(true);
              hoverGenRef.current += 1;
              hoveredLocalIdRef.current = null;
              hoveredExpressIdRef.current = null;
              void setCoordinatedHover('canvas', null).catch(() => {});
              void setCoordinatedHover('tree', null).catch(() => {});
              storeyFrustumCullerRef.current?.releaseOwnership();
              elementFrustumCullerRef.current?.releaseOwnership();
              void renderStateCoordinatorRef.current?.update({
                visibility: [
                  { layer: 'culler:storey', hiddenIds: null },
                  { layer: 'culler:element', hiddenIds: null },
                ],
              }, {
                urgency: 'visual',
                reason: 'culler-show:navigation-start',
              }).catch(() => {});
              if (hoverIntentTimer !== null) {
                window.clearTimeout(hoverIntentTimer);
                hoverIntentTimer = null;
              }
              // Orbit start moves the interaction-quality ladder to interactive.
              dispatchQuality({ type: 'navigation-start' });
            }
            // rAF coalesce - one non-forced update per frame, max.
            fragmentUpdateScheduler?.request({
              priority: 'camera',
              force: false,
              reason: 'camera',
            });
            if (!rafPending) {
              rafPending = true;
              requestAnimationFrame(() => {
                rafPending = false;
                if (disposed) return;

                // During orbit, reveal app-culled elements that re-enter the frustum.
                const now = performance.now();
                if (!showPassPending && now - lastShowPassTs >= cullerShowPassMinIntervalMs) {
                  const state = useStore.getState();
                  if (state.isolatedIds.length === 0 && state.hiddenIds.length === 0) {
                    const storeyCuller = storeyFrustumCullerRef.current;
                    const elemCuller = elementFrustumCullerRef.current;
                    const spatialTileCuller = spatialTileCullerRef.current;
                    if (spatialTileCuller?.isBuilt || storeyCuller?.isBuilt || elemCuller?.isBuilt) {
                      showPassPending = true;
                      lastShowPassTs = now;
                      const cameraThree = world.camera.three as THREE.Camera;
                      const runShow = async () => {
                        let revealed = 0;
                        try {
                          if (spatialTileCuller?.isBuilt) {
                            const result = await spatialTileCuller.showPass(
                              cameraThree,
                              spatialTileVisibilityRef.current ?? model,
                              getSpatialTileViewOptions(),
                            );
                            revealed += result.revealedElementCount;
                            useStore.getState().updatePerfMetrics({
                              culledStoreys: 0,
                              culledElements: result.hiddenElementCount,
                            });
                          } else if (storeyCuller?.isBuilt) {
                            revealed += await storeyCuller.showPass(
                              cameraThree,
                              model,
                              storeyCullerVisibilityRef.current ?? model,
                            );
                          }
                          if (!spatialTileCuller?.isBuilt && elemCuller?.isBuilt) {
                            const ownedByStorey = storeyCuller?.isBuilt
                              ? new Set(storeyCuller.getCulledMemberIds())
                              : undefined;
                            revealed += await elemCuller.showPass(
                              cameraThree,
                              model,
                              ownedByStorey,
                              elementCullerVisibilityRef.current ?? model,
                            );
                          }
                        } catch { /* best-effort */ }
                        // The coordinator's show target already awaited the
                        // visual fragment refresh for every revealed ID.
                        showPassPending = false;
                      };
                      void runShow();
                    }
                  }
                }
              });
            }
            // Re-arm the settle backstop for cases the rest event cannot cover.
            if (settleTimer !== null) window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(() => {
              settleTimer = null;
              runSettle();
            }, cameraSettleDelayMs);
          };

          // Refresh near/far planes at rest to preserve depth precision.
          const planeCorner = new THREE.Vector3();
          const planeTarget = new THREE.Vector3();
          const updateCameraPlanes = () => {
            try {
              const cam = world.camera.three as THREE.PerspectiveCamera;
              if (!cam.isPerspectiveCamera) return;
              const planeControls = world.camera.controls as unknown as {
                getTarget: (out: THREE.Vector3) => THREE.Vector3;
              };
              planeControls.getTarget(planeTarget);
              const dist = Math.max(0.05, cam.position.distanceTo(planeTarget));
              const half = modelSize.clone().multiplyScalar(0.5);
              let farthest = 0;
              for (let i = 0; i < 8; i += 1) {
                planeCorner.set(
                  modelCenter.x + (i & 1 ? half.x : -half.x),
                  modelCenter.y + (i & 2 ? half.y : -half.y),
                  modelCenter.z + (i & 4 ? half.z : -half.z),
                );
                farthest = Math.max(farthest, cam.position.distanceTo(planeCorner));
              }
              const nextNear = Math.min(1, Math.max(0.01, dist * 0.001));
              const nextFar = Math.max(dist * 10, farthest * 1.25, nextNear + 10);
              const nearDelta = Math.abs(nextNear - cam.near) / cam.near;
              const farDelta = Math.abs(nextFar - cam.far) / cam.far;
              if (nearDelta > 0.2 || farDelta > 0.2) {
                cam.near = nextNear;
                cam.far = nextFar;
                cam.updateProjectionMatrix();
              }
            } catch { /* best-effort precision tuning */ }
          };

          // Settle: restore quality, flush any tiles starved/hidden during
          // the reduced-quality phase, then run the culler hide-pass at idle
          // priority so the stop gesture does not hitch.
          const runSettle = () => {
              if (disposed) return;
              orbiting = false;
              cameraNavigatingRef.current = false;
              fragmentUpdateScheduler?.setNavigating(false);
              applyGhostPostproduction(false);
              updateCameraPlanes();
              // Orbit settle drives the ladder back toward its
              // target (was the hardcoded GQ_IDLE snap + targetPixelRatio
              // restore). 'navigation-end' clears the navigating flag; the
              // follow-up 'set-target' snaps `active` straight to the resolved
              // target (the reducer restores to target when not navigating),
              // preserving the old immediate full-quality restore.
              dispatchQuality({ type: 'navigation-end' });
              dispatchQuality({
                type: 'set-target',
                target: performanceModeToQualityTarget(useStore.getState().viewerPerformanceMode),
              });
              // Run the z-fight pass that was deferred while navigating
              // (it tags itself when onViewUpdated fired mid-orbit).
              if (zFightDeferredDuringNav) {
                zFightDeferredDuringNav = false;
                applyZFightBias();
              }
              try {
                fragmentUpdateScheduler?.request({
                  priority: 'idle',
                  force: true,
                  reason: 'camera',
                });
              } catch { /* ignore */ }

              // Single-owner culler coordination. Without sequencing, the
              // storey + element culler tick calls would
              // run in parallel (`void tick(...)` twice in a row), racing
              // `model.setVisible(...)` writes for any element id both
              // cullers had a verdict on. `decideCullerWork` + `runCullerPlan`
              // (cullerCoordinationHelpers.ts) sequence the writes so the
              // storey tick fully settles before the element tick starts.
              const spatialTileCuller = spatialTileCullerRef.current;
              if (spatialTileCuller?.isBuilt) {
                const state = useStore.getState();
                const tileWork = state.isolatedIds.length > 0 || state.hiddenIds.length > 0
                  ? spatialTileCuller.clearCull(spatialTileVisibilityRef.current ?? model)
                      .then(() => null)
                  : spatialTileCuller.tick(
                      world.camera.three as THREE.Camera,
                      spatialTileVisibilityRef.current ?? model,
                      getSpatialTileViewOptions(),
                    );
                void tileWork.then((result) => {
                  useStore.getState().updatePerfMetrics({
                    culledStoreys: 0,
                    culledElements: result?.hiddenElementCount ?? 0,
                  });
                }).catch(() => {});
                return;
              }
              const cullerRef = storeyFrustumCullerRef.current;
              const elemCullerRef = elementFrustumCullerRef.current;
              const cameraThree = world.camera.three as THREE.Camera;
              const cullerSnapshot: CullerSnapshot = {
                storeyCullerBuilt: !!cullerRef?.isBuilt,
                elementCullerBuilt: !!elemCullerRef?.isBuilt,
                isolatedCount: useStore.getState().isolatedIds.length,
                hiddenCount: useStore.getState().hiddenIds.length,
              };
              const cullerPlan = decideCullerWork(cullerSnapshot);
              // When no cullers are built (the default), runCullerPlan
              // resolves immediately and the chained 'culler-hide' force below
              // would be a second redundant forced flush per settle. Track it.
              const cullerPlanIsNoop = cullerPlan === 'noop';
              void runCullerPlan(cullerPlan, cullerSnapshot, {
                runStoreyTick: () => cullerRef!.tick(
                  cameraThree,
                  model,
                  storeyCullerVisibilityRef.current ?? model,
                ),
                runElementTick: () => {
                  // Exclude storey-owned ids from element-level culling.
                  const ownedByStorey = cullerRef?.isBuilt
                    ? new Set(cullerRef.getCulledMemberIds())
                    : undefined;
                  return elemCullerRef!.tick(
                    cameraThree,
                    model,
                    ownedByStorey,
                    elementCullerVisibilityRef.current ?? model,
                  );
                },
                runStoreyClear: async () => {
                  if (cullerRef?.isBuilt) {
                    await cullerRef.clearCull(model, storeyCullerVisibilityRef.current ?? model);
                  }
                },
                runElementClear: async () => {
                  if (elemCullerRef?.isBuilt) {
                    await elemCullerRef.clearCull(model, elementCullerVisibilityRef.current ?? model);
                  }
                },
                onStoreyCulled: (n) => {
                  useStore.getState().updatePerfMetrics({ culledStoreys: n });
                },
                onElementCulled: (n) => {
                  useStore.getState().updatePerfMetrics({ culledElements: n });
                },
                isDisposed: () => disposed,
              })
                // Coordinator targets already acknowledge the coalesced
                // fragment refresh; no second forced update is required.
                .then(() => undefined)
                .catch(() => { /* tick/clearCull throws ignored, matches prior fire-and-forget */ });
          };

          // Settle on the camera-controls rest signal, guarded against active gestures.
          const onCameraRest = () => {
            if (disposed || !orbiting || controlActive || isPanelResizing()) return;
            if (settleTimer !== null) {
              window.clearTimeout(settleTimer);
              settleTimer = null;
            }
            suppressNavStartUntil = performance.now() + 1500;
            runSettle();
          };
          const clearNavSuppression = () => { suppressNavStartUntil = 0; };

          // Zero-motion click guard. camera-controls fires controlstart /
          // controlend for EVERY left-click, motion or not, while 'update'
          // only fires on real camera deltas. Without the guard a plain
          // selection click entered the full navigation path - quality drop,
          // navigating flag, camera-priority refresh, and the settle backstop
          // with its forced idle flush - pure churn for a camera that never
          // moved. That churn also serialized the NEXT click's highlight
          // flush behind the settle flush (scheduler runs one update at a
          // time) and blocked hover raycasts while the navigating flag was
          // up, a large share of the click-to-highlight budget misses. Real
          // gestures (any 'update' during the gesture) behave exactly as
          // before; controlend with `orbiting` still true (e.g. releasing
          // while a damping tail is active) also passes through, because the
          // settle backstop must re-arm in that case.
          let gestureHadMotion = false;
          controls.addEventListener('update', () => {
            gestureHadMotion = true;
            // Real camera delta this frame (drags, damping tails, wheel,
            // programmatic transitions all emit 'update') - keep painting.
            renderKick(250);
            onCameraChange();
          });
          controls.addEventListener('controlend', () => {
            if (!gestureHadMotion && !orbiting) return;
            onCameraChange();
          });
          controls.addEventListener('rest', onCameraRest);
          controls.addEventListener('controlstart', () => {
            controlActive = true;
            gestureHadMotion = false;
            clearNavSuppression();
          });
          controls.addEventListener('controlend', () => { controlActive = false; });
          controls.addEventListener('transitionstart', clearNavSuppression);
          try {
            world.renderer!.three.domElement.addEventListener(
              'wheel',
              clearNavSuppression,
              { passive: true },
            );
          } catch { /* best-effort */ }
          // Seed the dynamic planes for the initial framing; settles keep
          // them current from here on.
          updateCameraPlanes();
        } catch {
          /* controls event API varies by @thatopen version */
        }

        // Element selection - attached to the WebGL canvas, not the outer
        // container, so clicks that land on overlay chrome (toolbar, HUD,
        // floating badges) don't trigger a raycast. We track pointer
        // down/up so that drag-orbits don't clear the selection: a real
        // click is defined as <= 4 px movement between down and up.
        const canvas = world.renderer!.three.domElement;
        const constructionSnapAt = (
          hit: FragmentRaycastHit,
          clientX: number,
          clientY: number,
          camera: THREE.Camera,
          thresholdPx = 20,
        ): ConstructionSnapCandidate | null => {
          const rect = canvas.getBoundingClientRect();
          return snapToTriangleFeatures(
            hit.facePoints,
            new THREE.Vector2(clientX - rect.left, clientY - rect.top),
            camera,
            canvas.clientWidth,
            canvas.clientHeight,
            thresholdPx,
          );
        };
        const hitTriangle = (hit: FragmentRaycastHit): Triangle3 | null => {
          if (!hit.facePoints || hit.facePoints.length < 9) return null;
          const points = facePointsToVec3(hit.facePoints);
          if (points.length < 3) return null;
          return [points[0], points[1], points[2]];
        };
        let downX = 0;
        let downY = 0;
        let downTs = 0;
        let rightDownX = 0;
        let rightDownY = 0;
        type ClickPickResult = {
          result: FragmentRaycastHit | null;
          error: unknown | null;
        };
        type ExactHoverPickCache = {
          result: FragmentRaycastHit;
          clientX: number;
          clientY: number;
          timestamp: number;
          cameraWorld: THREE.Matrix4;
          projection: THREE.Matrix4;
          isolatedIds: number[];
          hiddenIds: number[];
          clipPlanes: ReturnType<typeof useStore.getState>['clipPlanes'];
          sectionWorkspace: ReturnType<typeof useStore.getState>['sectionWorkspace'];
          sectionBoxEnabled: boolean;
        };
        let exactHoverPickCache: ExactHoverPickCache | null = null;
        let clickPickGeneration = 0;
        let pendingClickPick: {
          generation: number;
          x: number;
          y: number;
          cameraWorld: THREE.Matrix4;
          projection: THREE.Matrix4;
          isolatedIds: number[];
          hiddenIds: number[];
          clipPlanes: ReturnType<typeof useStore.getState>['clipPlanes'];
          sectionWorkspace: ReturnType<typeof useStore.getState>['sectionWorkspace'];
          sectionBoxEnabled: boolean;
          promise: Promise<ClickPickResult>;
        } | null = null;
        // Prefetch worker raycasts after a short hold so most click work is
        // complete before pointer-up, while real orbit drags avoid the pick.
        let prefetchTimer: number | null = null;
        let lastPointerClientX = 0;
        let lastPointerClientY = 0;
        const PREFETCH_DELAY_MS = 35;
        const CLICK_DRAG_THRESHOLD_PX = 4;

        // The reuse guards compare camera/visibility/clip state but cannot
        // see a fragment replacement that swaps geometry under an unchanged
        // camera; the merge lifecycle invalidates all pick caches explicitly.
        pointerPickCachesInvalidateRef.current = () => {
          exactHoverPickCache = null;
          pendingClickPick = null;
          clickPickGeneration += 1;
        };

        const suspendFurnishingMergeForExactPick = async (): Promise<void> => {
          const lifecycle = furnishingMergeLifecycleRef.current;
          if (!lifecycle?.blocksNavigationLod) return;
          await lifecycle.setDesired(false);
          // The lifecycle awaits visibility/highlight repair before settling,
          // so this exact worker raycast sees the authoritative fragment state.
        };

        const pickElementAt = async (pt: { x: number; y: number }): Promise<ClickPickResult> => {
          const releasePickLease = exactPickLease.acquire();
          try {
            await suspendFurnishingMergeForExactPick();
            const camera = world.camera.three as
              | THREE.PerspectiveCamera
              | THREE.OrthographicCamera;
            const mouse = new THREE.Vector2(pt.x, pt.y);
            // The fragments worker raycast is authoritative. FastModelPicker's
            // extra colour pass both stalled the GPU and sometimes reported a
            // miss for a valid thin/stale tile, vetoing a real exact hit.
            const result = await trackRaycast(model.raycast({ camera, mouse, dom: canvas }));
            return { result, error: null };
          } finally {
            releasePickLease();
          }
        };

        // Give the development regression harness an exact, awaited geometry
        // probe. Using the same pick lease and normalization as a real click
        // avoids racing a series of short-lived context-menu requests on slow
        // software renderers. This hook is excluded from production builds.
        if (import.meta.env.DEV) {
          devPickAtHook = async (x: number, y: number) => {
            const { result, error } = await pickElementAt({ x, y });
            if (error) throw error;
            if (!result) return null;
            return {
              expressId: modelService.resolveProductIdFromHitSync(
                result.itemId,
                result.localId,
              ),
              localId: result.localId,
            };
          };
          (window as any).__ifcPickAt = devPickAtHook;
        }

        const prefetchClickPick = (pt: { x: number; y: number }) => {
          const generation = clickPickGeneration;
          const camera = world.camera.three as THREE.Camera;
          const state = useStore.getState();
          const promise = pickElementAt(pt).catch((error: unknown) => {
            return { result: null, error };
          });
          pendingClickPick = {
            generation,
            x: pt.x,
            y: pt.y,
            cameraWorld: camera.matrixWorld.clone(),
            projection: camera.projectionMatrix.clone(),
            isolatedIds: state.isolatedIds,
            hiddenIds: state.hiddenIds,
            clipPlanes: state.clipPlanes,
            sectionWorkspace: state.sectionWorkspace,
            sectionBoxEnabled: state.sectionBoxEnabled,
            promise,
          };
          // Pre-resolve held clicks to warm id and property caches.
          void promise.then((res) => {
            if (disposed || generation !== clickPickGeneration) return;
            const hit = res.result;
            if (!hit) return;
            const moved = Math.hypot(lastPointerClientX - downX, lastPointerClientY - downY);
            if (moved > CLICK_DRAG_THRESHOLD_PX) return;
            const productId = modelService.resolveProductIdFromHitSync(hit.itemId, hit.localId);
            expressToLocalCacheRef.current.set(hit.itemId, hit.localId);
            expressToLocalCacheRef.current.set(productId, hit.localId);
            void modelService.getElement(productId).catch(() => {});
          });
        };

        const onPointerDown = (event: PointerEvent) => {
          // Any newer canvas interaction supersedes a pending context pick.
          // This also prevents a slow right-click raycast from opening after
          // the user has already left-clicked or begun another gesture.
          contextMenuPickGuard.invalidate();
          setContextMenuStateRef.current(null);
          if (event.button === 2) {
            rightDownX = event.clientX;
            rightDownY = event.clientY;
            return;
          }
          if (event.button !== 0) return; // left button only
          hoverGenRef.current += 1;
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          downX = event.clientX;
          downY = event.clientY;
          downTs = performance.now();
          clickPickGeneration += 1;
          lastPointerClientX = event.clientX;
          lastPointerClientY = event.clientY;
          // Defer prefetch briefly so orbit gestures avoid an unused worker raycast.
          if (prefetchTimer !== null) window.clearTimeout(prefetchTimer);
          if (wallDrawControllerRef.current?.isArmed()) {
            pendingClickPick = null;
            return;
          }
          if (furnishingMergeLifecycleRef.current?.blocksNavigationLod) {
            // Avoid an expensive speculative unmerge that may be wasted when
            // this stationary press becomes an orbit. Confirm it on up.
            pendingClickPick = null;
            return;
          }
          prefetchTimer = window.setTimeout(() => {
            prefetchTimer = null;
            if (disposed) return;
            const moved = Math.hypot(lastPointerClientX - downX, lastPointerClientY - downY);
            if (moved > CLICK_DRAG_THRESHOLD_PX) return;
            prefetchClickPick({ x: downX, y: downY });
          }, PREFETCH_DELAY_MS);
        };

        const onPointerUp = async (event: PointerEvent) => {
          if (disposed) return;
          if (event.button !== 0) return;
          if (prefetchTimer !== null) {
            // Released before the deferred prefetch fired (very fast click) -
            // the pick runs inline below via the no-prefetch fallback.
            window.clearTimeout(prefetchTimer);
            prefetchTimer = null;
          }
          const dx = event.clientX - downX;
          const dy = event.clientY - downY;
          const dragDist = Math.hypot(dx, dy);
          const elapsed = performance.now() - downTs;
          // Movement, not press duration, distinguishes navigation from a
          // click. A deliberate long stationary click is still a selection.
          if (!isClickGesture({
            distancePx: dragDist,
            elapsedMs: elapsed,
            dragThresholdPx: CLICK_DRAG_THRESHOLD_PX,
          })) {
            pendingClickPick = null;
            clickPickGeneration += 1;
            if (import.meta.env.DEV) {
              console.debug('[viewer] click ignored as drag', { dragDist, elapsed });
            }
            return;
          }

          // B5 mount point: an armed wall tool consumes non-drag left clicks
          // ahead of picking/selection (mirrors the measurement hijack below).
          if (wallDrawControllerRef.current?.isArmed()) {
            pendingClickPick = null; // drop the prefetched raycast - unused
            clickPickGeneration += 1;
            wallDrawControllerRef.current.handleClick(event.clientX, event.clientY);
            return;
          }

          // Start click-to-highlight timing after drag detection.
          pendingClickStartRef.current = null;
          const tClickStart = performance.now();

          try {
            const requestGeneration = clickPickGeneration;
            const pendingPick = pendingClickPick;
            pendingClickPick = null;
            const cameraAtRelease = world.camera.three as THREE.Camera;
            const stateAtRelease = useStore.getState();
            const canUsePrefetch = pendingPick !== null && canReusePrefetchedPick({
              requestGeneration: pendingPick.generation,
              currentGeneration: clickPickGeneration,
              distancePx: Math.hypot(
                pendingPick.x - event.clientX,
                pendingPick.y - event.clientY,
              ),
              cameraUnchanged:
                pendingPick.cameraWorld.equals(cameraAtRelease.matrixWorld)
                && pendingPick.projection.equals(cameraAtRelease.projectionMatrix),
              visibilityUnchanged:
                pendingPick.isolatedIds === stateAtRelease.isolatedIds
                && pendingPick.hiddenIds === stateAtRelease.hiddenIds
                && pendingPick.clipPlanes === stateAtRelease.clipPlanes
                && pendingPick.sectionWorkspace === stateAtRelease.sectionWorkspace
                && pendingPick.sectionBoxEnabled === stateAtRelease.sectionBoxEnabled,
              fragmentReplacementBlocked:
                !!furnishingMergeLifecycleRef.current?.blocksNavigationLod,
            });
            const tBeforeIO = import.meta.env.DEV ? performance.now() : 0;
            const { result, error: pickError } = canUsePrefetch
              ? await pendingPick.promise
              : await (() => {
                  const cached = exactHoverPickCache;
                  const camera = world.camera.three as THREE.Camera;
                  const state = useStore.getState();
                  const canReuseHover = !!cached && canReuseExactHoverPick({
                    exactHit: true,
                    distancePx: Math.hypot(
                      cached.clientX - event.clientX,
                      cached.clientY - event.clientY,
                    ),
                    ageMs: performance.now() - cached.timestamp,
                    cameraUnchanged:
                      cached.cameraWorld.equals(camera.matrixWorld)
                      && cached.projection.equals(camera.projectionMatrix),
                    visibilityUnchanged:
                      cached.isolatedIds === state.isolatedIds
                      && cached.hiddenIds === state.hiddenIds
                      && cached.clipPlanes === state.clipPlanes
                      && cached.sectionWorkspace === state.sectionWorkspace
                      && cached.sectionBoxEnabled === state.sectionBoxEnabled,
                    fragmentReplacementBlocked:
                      !!furnishingMergeLifecycleRef.current?.blocksNavigationLod,
                  });
                  return canReuseHover
                    ? Promise.resolve<ClickPickResult>({ result: cached!.result, error: null })
                    : pickElementAt({ x: event.clientX, y: event.clientY });
                })();
            if (disposed || requestGeneration !== clickPickGeneration) return;
            if (pickError) throw pickError;
            if (import.meta.env.DEV) {
              console.debug('[viewer] raycast', {
                client: { x: event.clientX, y: event.clientY },
                prefetched: canUsePrefetch,
                reusedExactHover: !canUsePrefetch && exactHoverPickCache?.result === result,
                ioMs: +(performance.now() - tBeforeIO).toFixed(1),
                hit: result ? { itemId: result.itemId, localId: result.localId } : null,
              });
            }
            // Pick-plane mode: next click on a model surface creates a clip
            // plane at the hit point, aligned to the dominant face-normal axis.
            if (useStore.getState().pickPlaneMode) {
              if (result?.point) {
                const normal = result.normal ?? new THREE.Vector3(0, 1, 0);
                const absX = Math.abs(normal.x);
                const absY = Math.abs(normal.y);
                const absZ = Math.abs(normal.z);
                const axis: import('../../store/useStore').ClipAxis =
                  absY >= absX && absY >= absZ ? 'y'
                  : absX >= absZ ? 'x'
                  : 'z';
                const { modelCenter } = viewerRef.current!;
                const axisOffset = axis === 'x'
                  ? result.point.x - modelCenter.x
                  : axis === 'y'
                  ? result.point.y - modelCenter.y
                  : result.point.z - modelCenter.z;
                useStore.getState().addClipPlaneAt(axis, axisOffset);
              } else {
                // Click in void - cancel pick mode without placing a plane
                useStore.getState().setPickPlaneMode(false);
              }
              return;
            }

            // Measurement mode hijacks clicks ahead of selection so the user
            // can drop rulers on visible geometry without first clearing
            // the currently-selected element. Requires a real hit - clicks
            // into the void in measurement mode are no-ops (keeps the UX
            // predictable and mirrors most BIM viewers).
            const measurementController = measurementControllerRef.current;
            if (measurementController && measurementController.getMode() !== 'off') {
              if (result?.point) {
                const camera = world.camera.three as THREE.Camera;
                const candidate = constructionSnapAt(
                  result,
                  event.clientX,
                  event.clientY,
                  camera,
                  event.pointerType === 'touch' ? 28 : 20,
                );
                const normal = result.normal ? result.normal.clone() : null;
                if (measurementController.getMode() === 'clearance') {
                  const pendingBefore = measurementController.snapshot().pending.length;
                  const triangle = hitTriangle(result);
                  const firstTriangle = clearanceFirstTriangleRef.current;
                  if (pendingBefore > 0 && firstTriangle && triangle) {
                    const witness = shortestDistanceBetweenTriangles(firstTriangle, triangle);
                    measurementController.cancel();
                    measurementController.addWitnessMeasurement(
                      'clearance',
                      witness.pointA,
                      witness.pointB,
                      {
                        exact: true,
                        source: 'hit-triangle-pair',
                        snapKind: 'face',
                      },
                    );
                    clearanceFirstTriangleRef.current = null;
                  } else {
                    measurementController.handleClick(result.point.clone(), normal, candidate);
                    const pendingAfter = measurementController.snapshot().pending.length;
                    clearanceFirstTriangleRef.current = pendingAfter > 0
                      ? (firstTriangle ?? triangle)
                      : null;
                  }
                } else {
                  measurementController.handleClick(result.point.clone(), normal, candidate);
                }
              }
              return;
            }

            if (result) {
              // Normalize raycast hits to the owning IfcProduct express id.
              const rawHitId = result.itemId;
              const productId = modelService.resolveProductIdFromHitSync(rawHitId, result.localId);
              // Always refresh both mappings from the authoritative click hit.
              // This must happen before the same-element repair branch: a
              // streamed residency swap can preserve the Express ID while
              // changing the local fragment that needs the amber paint.
              expressToLocalCacheRef.current.set(rawHitId, result.localId);
              expressToLocalCacheRef.current.set(productId, result.localId);
              const stateBeforeSelect = useStore.getState();
              if (isNoopSameElementClick({
                clickedExpressId: productId,
                selectedElementId: stateBeforeSelect.selectedElementId,
                selectedIds: stateBeforeSelect.selectedIds,
                shiftKey: event.shiftKey,
              })) {
                // A same-id click is a cheap visual repair opportunity after
                // a streamed tile swap or structural edit. Force a full
                // repaint instead of assuming the cached snapshot is visible.
                pendingClickStartRef.current = tClickStart;
                void renderStateCoordinatorRef.current?.invalidateAppearance(
                  [result.localId],
                  { urgency: 'visual', reason: 'highlight:tile-repair' },
                ).catch(() => {});
                rebuildSchedulerRef.current?.cancel();
                rebuildSchedulerRef.current?.schedule();
                if (event.detail >= 2) {
                  stateBeforeSelect.zoomToElement(productId);
                }
                return;
              }

              // Hover state is wiped - the rebuild will paint the click
              // highlight; we don't want the lingering soft-amber tint.
              hoveredLocalIdRef.current = null;
              hoveredExpressIdRef.current = null;
              void setCoordinatedHover('canvas', null).catch(() => {});

              // Arm the paint acknowledgement before mutating selection.
              // Zustand subscribers schedule synchronously; keeping this
              // ordering makes the latency sample belong to that exact state
              // transition even if the scheduler implementation changes.
              pendingClickStartRef.current = tClickStart;
              if (event.shiftKey) {
                // Shift+click: toggle into multi-select set
                useStore.getState().toggleSelectId(productId);
              } else {
                useStore.getState().selectElement(productId);
                if (event.detail >= 2) {
                  useStore.getState().zoomToElement(productId);
                }
              }
              // Start highlight rebuild in the same task as the click.
              rebuildSchedulerRef.current?.cancel();
              rebuildSchedulerRef.current?.schedule();

              // Warm the properties cache for the selected element.
              void modelService.getElement(productId).catch(() => {});

              // Defer activity logging until after the selection paint.
              const activitySummary = event.shiftKey
                ? `Shift-selected element #${productId}`
                : `Selected element #${productId}`;
              window.setTimeout(() => {
                useStore.getState().logActivity({
                  kind: 'select',
                  summary: activitySummary,
                });
              }, 0);
            } else if (
              !event.shiftKey
              && isConfirmedVoidPick({ exactHit: false, error: pickError })
            ) {
              // Click on empty scene clears selection (but Shift+click on void is a no-op)
              useStore.getState().selectElement(null);
              rebuildSchedulerRef.current?.cancel();
              rebuildSchedulerRef.current?.schedule();
            }
          } catch (err) {
            console.warn('Raycast failed:', err);
          }
        };

        // Pointer-move preview feeds measurement and hover from one rAF-throttled raycast.
        let pendingMovePoint: { x: number; y: number; isTouch: boolean } | null = null;
        let moveRafHandle = 0;
        let moveInFlight = false;
        let replayMoveAfterFlight = false;
        let lastTooltipLocalId: number | null = null;
        let lastTooltipScreenX = 0;
        let lastTooltipScreenY = 0;
        let lastTooltipUpdateTs = 0;

        // Soft-amber hover highlight uses shared material instances.

        const clearHoverTooltip = () => {
          lastTooltipLocalId = null;
          setHoverTooltipData(null);
        };

        const maybeUpdateHoverTooltip = (
          result: FragmentRaycastHit,
          pt: { x: number; y: number },
          force: boolean,
        ) => {
          const now = performance.now();
          const moved = Math.hypot(pt.x - lastTooltipScreenX, pt.y - lastTooltipScreenY);
          if (
            !force
            && lastTooltipLocalId === result.localId
            && moved < 10
            && now - lastTooltipUpdateTs < 80
          ) {
            return;
          }

          const tree = useStore.getState().spatialTree;
          // Resolve representation hits to product ids before tree lookup.
          const tooltipId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
          const node = getSpatialNodeIndex(tree)?.get(tooltipId) ?? null;
          const containerRect = containerRef.current?.getBoundingClientRect();
          if (!node || !containerRect) return;

          const TOOLTIP_W = 204;
          const TOOLTIP_H = 48;
          const rx = pt.x - containerRect.left;
          const ry = pt.y - containerRect.top;
          const tx = Math.min(rx + 14, containerRect.width - TOOLTIP_W);
          const ty = Math.max(4, ry - 36 - TOOLTIP_H);
          lastTooltipLocalId = result.localId;
          lastTooltipScreenX = pt.x;
          lastTooltipScreenY = pt.y;
          lastTooltipUpdateTs = now;
          setHoverTooltipData({
            x: tx,
            y: ty,
            name: node.name || node.ifc_type,
            type: node.ifc_type,
            storey: node.storey ?? null,
          });
        };

        function scheduleMovePreview() {
          if (moveInFlight) {
            replayMoveAfterFlight = true;
            return;
          }
          if (moveRafHandle) return;
          moveRafHandle = requestAnimationFrame(runMovePreview);
        }

        const runMovePreview = async () => {
          moveRafHandle = 0;
          const pt = pendingMovePoint;
          pendingMovePoint = null;
          if (!pt) return;
          const ctrl = measurementControllerRef.current;
          const measuring = !!ctrl && ctrl.getMode() !== 'off';
          const hoverOn = useStore.getState().hoverHighlightEnabled;
          // Skip raycast entirely if nothing depends on it.
          if (!shouldRunHoverRaycast({
            measuring,
            hoverHighlightEnabled: hoverOn,
            cameraNavigating: cameraNavigatingRef.current,
            hoverQualityEnabled:
              getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled,
          })) return;
          moveInFlight = true;

          // Cancel any stale in-flight raycast: bump the gen counter, and
          // bail out below if a newer pointermove has come in by the time
          // our async raycast resolves. Without this, fast mouse-moves
          // queue raycasts that finish out-of-order and "rubber-band"
          // the highlight back to a stale element.
          const myGen = hoverGenRef.current;

          const mouse2 = new THREE.Vector2(pt.x, pt.y);
          try {
            const cam = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
            const result = await trackRaycast(
              model.raycast({ camera: cam, mouse: mouse2, dom: canvas }),
            );
            // Stale: a newer pointermove fired while we were awaiting.
            if (myGen !== hoverGenRef.current) return;

            if (result) {
              const state = useStore.getState();
              exactHoverPickCache = {
                result,
                clientX: pt.x,
                clientY: pt.y,
                timestamp: performance.now(),
                cameraWorld: cam.matrixWorld.clone(),
                projection: cam.projectionMatrix.clone(),
                isolatedIds: state.isolatedIds,
                hiddenIds: state.hiddenIds,
                clipPlanes: state.clipPlanes,
                sectionWorkspace: state.sectionWorkspace,
                sectionBoxEnabled: state.sectionBoxEnabled,
              };
            } else {
              exactHoverPickCache = null;
            }

            // Cache id mappings from hover hits for later click highlights.
            if (result) {
              const productId = modelService.resolveProductIdFromHitSync(result.itemId, result.localId);
              expressToLocalCacheRef.current.set(result.itemId, result.localId);
              expressToLocalCacheRef.current.set(productId, result.localId);
            }

            if (ctrl && measuring) {
              if (result?.point) {
                const worldPt = new THREE.Vector3(result.point.x, result.point.y, result.point.z);
                // Match the click tolerance per pointer type (28 px touch,
                // 20 px mouse) so the preview never promises a snap the
                // committed point cannot reproduce - and vice versa.
                const constructionSnap = constructionSnapAt(
                  result, pt.x, pt.y, cam, pt.isTouch ? 28 : 20,
                );
                ctrl.handleMove(worldPt, constructionSnap);
              } else {
                ctrl.handleMove(null);
              }
            }

            if (hoverOn && !measuring) {
              const st = useStore.getState();
              const hoverProductId = result
                ? modelService.resolveProductIdFromHitSync(result.itemId, result.localId)
                : null;
              const resultIsSelected = result
                ? isExpressIdSelected(hoverProductId, st.selectedElementId, st.selectedIds)
                : false;
              const newHoverLocal = result && !resultIsSelected ? result.localId : null;
              const newHoverExpress = result && !resultIsSelected ? hoverProductId : null;
              const prevHoverLocal = hoveredLocalIdRef.current;
              const prevHoverExpress = hoveredExpressIdRef.current;

              // Skip work if the hover target didn't change. `decideHoverWork`
              // is a pure helper pinned by vitest to prove
              // that stationary hover produces zero material churn.
              const decision = decideHoverWork(prevHoverLocal, newHoverLocal);
              if (result) {
                maybeUpdateHoverTooltip(result, pt, !decision.skip);
              } else if (!decision.skip) {
                clearHoverTooltip();
              }
              if (decision.skip) return;

              hoveredLocalIdRef.current = newHoverLocal;
              hoveredExpressIdRef.current = newHoverExpress;

              // Publish one named hover layer. The coordinator restores the
              // durable winner (selection, AI result, or colour layer) when
              // this temporary layer moves or clears.
              void setCoordinatedHover('canvas', decision.toHighlight).catch(() => {});
            }
          } catch {
            /* preview raycast misses are non-fatal */
          } finally {
            moveInFlight = false;
            if (replayMoveAfterFlight && pendingMovePoint) {
              replayMoveAfterFlight = false;
              scheduleMovePreview();
            } else {
              replayMoveAfterFlight = false;
            }
          }
        };

        const onPointerMove = (event: PointerEvent) => {
          // Track raw pointer travel for the prefetch/pre-resolve drag guards
          // BEFORE any policy short-circuit below.
          lastPointerClientX = event.clientX;
          lastPointerClientY = event.clientY;
          // Wall preview shares this single pointer hub. Ignore button drags
          // so orbit/pan never churns editor geometry or React state.
          if (event.buttons === 0) {
            wallDrawControllerRef.current?.handlePointerMove(event.clientX, event.clientY);
          }
          // Feed the shared move-preview as long as either consumer is
          // interested (measurement mode on OR hover highlight enabled).
          const ctrl = measurementControllerRef.current;
          const measuring = !!ctrl && ctrl.getMode() !== 'off';
          const hoverOn = useStore.getState().hoverHighlightEnabled;
          const policy = {
            measuring,
            hoverHighlightEnabled: hoverOn,
            cameraNavigating: cameraNavigatingRef.current,
            hoverQualityEnabled:
              getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled,
          };
          if (!shouldRunHoverRaycast(policy)) return;
          pendingMovePoint = {
            x: event.clientX,
            y: event.clientY,
            isTouch: event.pointerType === 'touch',
          };
          hoverGenRef.current += 1;
          if (shouldDelayHoverRaycast(policy)) {
            if (hoverIntentTimer !== null) {
              window.clearTimeout(hoverIntentTimer);
            }
            hoverIntentTimer = window.setTimeout(() => {
              hoverIntentTimer = null;
              scheduleMovePreview();
            }, HOVER_INTENT_DELAY_MS);
            return;
          }
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          scheduleMovePreview();
        };

        // Clear any hover highlight and tooltip when the pointer leaves the canvas.
        const onPointerLeave = async () => {
          pendingMovePoint = null;
          replayMoveAfterFlight = false;
          hoverGenRef.current += 1;
          if (hoverIntentTimer !== null) {
            window.clearTimeout(hoverIntentTimer);
            hoverIntentTimer = null;
          }
          if (moveRafHandle) {
            cancelAnimationFrame(moveRafHandle);
            moveRafHandle = 0;
          }
          clearHoverTooltip();
          const prevHoverLocal = hoveredLocalIdRef.current;
          const prevHoverExpress = hoveredExpressIdRef.current;
          if (prevHoverLocal === null) return;
          hoveredLocalIdRef.current = null;
          hoveredExpressIdRef.current = null;
          try { await setCoordinatedHover('canvas', null); } catch { /* noop */ }
        };

        // Right-click context menu. Raycasts under the cursor; if it hits an
        // element we open the full menu keyed by that element's ifc_type,
        // otherwise we open the short "Show all" menu. preventDefault blocks
        // the browser's native menu so we don't get two stacked menus.
        const onCanvasContextMenu = async (event: MouseEvent) => {
          if (disposed) return;
          event.preventDefault();
          event.stopPropagation();
          const generation = contextMenuPickGuard.begin();
          const anchorX = event.clientX;
          const anchorY = event.clientY;
          setContextMenuStateRef.current(null);

          // Suppress menu when the right button was dragged (orbit/pan gesture).
          // A movement of >5 px between right-pointerdown and the contextmenu
          // event means the user was rotating the model, not requesting a menu.
          const rightDragDist = Math.hypot(anchorX - rightDownX, anchorY - rightDownY);
          if (rightDragDist > 5) return;

          // Skip while measuring - right-click cancels the in-flight ruler
          // (the MeasurementController already listens for Escape; we just
          // don't want a menu on top of the canceled measurement).
          const ctrl = measurementControllerRef.current;
          if (ctrl && ctrl.getMode() !== 'off') {
            ctrl.cancel();
            return;
          }

          let outcome: ContextMenuPickOutcome<FragmentRaycastHit>;
          try {
            const { result, error } = await pickElementAt({
              x: anchorX,
              y: anchorY,
            });
            outcome = error
              ? { status: 'failure', error }
              : { status: 'success', hit: result };
          } catch (err) {
            outcome = { status: 'failure', error: err };
          }

          const decision = contextMenuPickGuard.resolve(generation, outcome);
          if (decision.kind === 'ignore') {
            // Stale/disposed failures are intentionally silent. Only the
            // current request should surface a worker problem.
            if (decision.reason === 'failed') {
              console.warn('Context-menu raycast failed:', decision.error);
            }
            return;
          }

          if (decision.kind === 'empty') {
            // A successful `null` raycast is the only condition that opens
            // the generic empty-space menu. Worker failures never land here.
            setContextMenuStateRef.current({
              x: anchorX,
              y: anchorY,
              expressId: null,
              ifcType: null,
            });
            return;
          }

          let expressId: number;
          let ifcType: string | null;
          try {
            // Normalize representation/geometry-item hits to the owning
            // IfcProduct so the context menu acts on the same element the
            // user thinks they clicked, not on a sub-entity.
            expressId = modelService.resolveProductIdFromHitSync(
              decision.hit.itemId,
              decision.hit.localId,
            );
            // Look up the element's ifc_type from the in-memory spatial tree.
            ifcType = findIfcTypeForId(useStore.getState().spatialTree, expressId);
          } catch (err) {
            console.warn('Context-menu hit normalization failed:', err);
            return;
          }

          setContextMenuStateRef.current({
            x: anchorX,
            y: anchorY,
            expressId,
            ifcType,
          });
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('contextmenu', onCanvasContextMenu);
        canvas.style.cursor = 'default';

        // Dispose the storey[0] sub-model now that the full model is loaded.
        if (storeySubModel) {
          try {
            await storeySubModel.dispose();
          } catch {
            // Best-effort: the sub-model may have already been cleaned up.
          }
          storeySubModel = null;
        }
        if (disposed) return;

        updateLoadProgress({
          title: 'Viewport ready',
          detail: 'Model loaded successfully.',
          progress: 100,
          sourceHint: modelLoadSourceHint(modelLoadSource),
        });

        // Flush one final render then wait for at least 3 rendered frames
        // before signalling ready. A forced tile rebuild here can make the
        // model visibly blink after it is already mounted.
        try {
          if (fragmentUpdateScheduler) {
            await fragmentUpdateScheduler.requestAndWait({
              priority: 'visual',
              force: false,
              reason: 'manual',
            });
          } else {
            await fragmentsManager.core.update(false);
          }
        } catch { /* teardown or best-effort final flush */ }
        if (disposed) return;
        await new Promise<void>((resolve) => {
          let remaining = 3;
          let frame = 0;
          let timeout = 0;
          const finish = () => {
            if (frame) cancelAnimationFrame(frame);
            window.clearTimeout(timeout);
            resolve();
          };
          const next = () => {
            if (disposed || --remaining <= 0) {
              finish();
              return;
            }
            frame = requestAnimationFrame(next);
          };
          timeout = window.setTimeout(finish, 500);
          frame = requestAnimationFrame(next);
        });
        if (disposed) return;
        // Signal readiness after the first frames paint; fade the overlay independently.
        if (globalSlowTimer !== null) {
          window.clearTimeout(globalSlowTimer);
          globalSlowTimer = null;
        }
        setLoadingSlow(false);
        setLoadingFading(true);
        setViewerReady(true);
        window.dispatchEvent(new CustomEvent('ifc-viewer-ready', {
          detail: { fingerprint: useStore.getState().modelFingerprint },
        }));
        // Unmount the overlay after the CSS fade completes - fire-and-forget so
        // it never blocks readiness. The duration matches the
        // `transition: opacity 350ms` on `.viewer-load-overlay` in index.css.
        window.setTimeout(() => {
          setLoading(false);
          setLoadingFading(false);
        }, 350);

        // Record TTFR (init -> viewer ready), total load time (upload -> ready),
        // and rolling fragment-cache hit rate.
        const state = useStore.getState();
        const wallClockNow = Date.now();
        const readyMetrics = computeViewerReadyMetrics({
          source: modelLoadSource,
          initStartMs: initStart,
          nowMs: performance.now(),
          loadStartTs: state.loadStartTs,
          wallClockNowMs: wallClockNow,
          previousCacheHitRate: state.perfMetrics.cacheHitRate,
        });
        state.updatePerfMetrics({
          ttfrMs: readyMetrics.ttfrMs,
          loadMs: readyMetrics.loadMs,
          cacheHitRate: readyMetrics.cacheHitRate,
        });

        // Persist perf sample to localStorage for the performance dashboard.
        try {
          const existing: unknown[] = JSON.parse(localStorage.getItem(VIEWER_PERF_LOG_STORAGE_KEY) ?? '[]');
          const entry = buildViewerPerfLogEntry({
            timestampMs: wallClockNow,
            source: modelLoadSource,
            ttfrMs: readyMetrics.ttfrMs,
            ttfgMs: ttfg,
            loadMs: readyMetrics.loadMs,
          });
          localStorage.setItem(
            VIEWER_PERF_LOG_STORAGE_KEY,
            JSON.stringify(prependViewerPerfLogEntry(existing, entry)),
          );
        } catch { /* quota / parse errors are non-critical */ }

        const timingDetail = formatStageTimings(stageTimings);
        state.logActivity({
          kind: 'info',
          summary: formatViewerReadySummary(modelLoadSource, readyMetrics.ttfrMs, ttfg),
          detail: timingDetail || undefined,
        });
        if (timingDetail && import.meta.env.DEV) {
          console.info(`[ViewerPanel] Stage timings (${modelLoadSource}): ${timingDetail}`);
        }

        // Queue the post-fit refresh through the serialized scheduler. It is
        // canceled/awaited with every other model-bound update on teardown.
        fragmentUpdateScheduler?.request({
          priority: 'camera',
          force: false,
          reason: 'manual',
        });

        // Kick off performance sampling loop (FPS, memory, draw calls)
        startPerfSampling();
      } catch (err: any) {
        if (globalSlowTimer !== null) {
          window.clearTimeout(globalSlowTimer);
          globalSlowTimer = null;
        }
        if (!disposed) {
          // Surface the full stack so we can tell whether the error is
          // coming from the live IFC parse, cached-fragment inflate, post-
          // load tile update, or downstream. The raw error message alone
          // ("incorrect header check") tells us nothing about the phase.
          console.error('Viewer init error:', err, '\nstack:', err?.stack);
          setLoadError(err.message || 'Failed to initialize 3D viewer');
          setLoadingSlow(false);
          setLoading(false);
          useStore.getState().logActivity({
            kind: 'error',
            summary: 'Viewer init failed',
            detail: err.message,
          });
        }
      }
    }

    function startPerfSampling() {
      let frames = 0;
      let lastFrameTs = performance.now();
      let rafId = 0;
      let intervalId: number | null = null;

      const shouldSampleFrames = () => {
        const state = useStore.getState();
        return state.perfHudVisible || state.perfDashOpen;
      };

      const tick = () => {
        frames++;
        if (!firstFrameCaptured) {
          firstFrameCaptured = true;
        }
        rafId = shouldSampleFrames() ? requestAnimationFrame(tick) : 0;
      };

      const sampleTick = () => {
        if (disposed) return;
        const now = performance.now();
        const elapsedSec = (now - lastFrameTs) / 1000;
        const fps = elapsedSec > 0 ? frames / elapsedSec : 0;
        frames = 0;
        lastFrameTs = now;

        // Memory usage from performance.memory (Chromium only)
        let memMb: number | null = null;
        const perfAny = performance as unknown as { memory?: { usedJSHeapSize: number } };
        if (perfAny.memory) {
          memMb = perfAny.memory.usedJSHeapSize / (1024 * 1024);
        }

        // Draw calls / triangles come from the per-frame main-pass snapshot,
        // not renderer.info: the raw counters end each frame holding only
        // the passes drawn after the engine's mid-frame onBeforeUpdate
        // re-trigger (gizmo-only numbers - see the capture wiring next to
        // renderGizmo).
        const snap = getMainPassStats();
        useStore.getState().updatePerfMetrics({
          fps,
          memoryMb: memMb,
          drawCalls: snap.drawCalls,
          triangles: snap.triangles,
        });
      };

      // Sample ONLY while the perf HUD or dashboard is open. The
      // previous session-long 500 ms interval woke up forever just to learn
      // the HUD was closed, and stashed its rAF id on a DOM expando that a
      // restart could orphan. Start/stop now ride HUD-visibility transitions
      // via a transient store subscription; ids live in this closure only.
      const stopSampling = () => {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        frames = 0;
      };
      const startSampling = () => {
        if (disposed || intervalId !== null) return;
        frames = 0;
        lastFrameTs = performance.now();
        rafId = requestAnimationFrame(tick);
        intervalId = window.setInterval(sampleTick, 500);
      };

      if (shouldSampleFrames()) startSampling();
      const unsubscribe = useStore.subscribe(
        (s) => s.perfHudVisible || s.perfDashOpen,
        (sampling: boolean) => {
          if (disposed) return;
          if (sampling) startSampling();
          else stopSampling();
        },
      );
      perfSamplingCleanup = () => {
        unsubscribe();
        stopSampling();
      };
    }

    const initPromise = init();

    return () => {
      disposed = true;
      contextMenuPickGuard.dispose();
      if (import.meta.env.DEV && (window as any).__ifcPickAt === devPickAtHook) {
        delete (window as any).__ifcPickAt;
      }
      const coordinatorShutdown = renderStateCoordinatorRef.current?.shutdown()
        ?? renderStateShutdownRef.current
        ?? Promise.resolve();
      const deferredTeardown: Array<Promise<unknown>> = [
        coordinatorShutdown,
        initPromise,
        storeyCullerTransitionRef.current.catch(() => {}),
        elementCullerTransitionRef.current.catch(() => {}),
        spatialTileCullerTransitionRef.current.catch(() => {}),
      ];
      for (const scheduler of latestAsyncSchedulersRef.current) {
        deferredTeardown.push(scheduler.shutdown());
      }
      if (pendingRaycasts.size > 0) {
        const outstanding = [...pendingRaycasts];
        deferredTeardown.push(new Promise<void>((resolve) => {
          let settled = false;
          let timeout = 0;
          const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            resolve();
          };
          // Let normal worker reads finish before killing FragmentsManager.
          // A wedged worker must not leak the whole viewer forever; disposal
          // after this bound is what finally terminates that operation.
          timeout = window.setTimeout(finish, 750);
          void Promise.allSettled(outstanding).then(finish);
        }));
      }
      const pendingFurnishingShutdown = furnishingMergeShutdownRef.current;
      if (pendingFurnishingShutdown) deferredTeardown.push(pendingFurnishingShutdown);
      if (exactPickLeaseRef.current === exactPickLease) {
        exactPickLeaseRef.current = null;
      }
      renderKickRef.current = null;
      if (globalSlowTimer !== null) {
        window.clearTimeout(globalSlowTimer);
        globalSlowTimer = null;
      }
      // Abort any in-flight native geometry request and dispose preview meshes.
      nativePreviewAbort.abort();
      if (nativePreview) {
        const scene = viewerRef.current?.world?.scene?.three as THREE.Scene | undefined;
        if (scene) removeNativePreview(scene, nativePreview);
        nativePreview = null;
      }
      removePanelResizeHooks?.();
      zFightingCleanup?.();
      // Stop queued camera/idle work now, but keep the scheduler alive until
      // the coordinator has settled any already-posted worker mutation. Then
      // wait for a consumed update before disposing FragmentsManager.
      fragmentUpdateScheduler?.cancel();
      if (fragmentUpdateScheduler) {
        deferredTeardown.push(
          coordinatorShutdown.catch(() => {}).then(() => fragmentUpdateScheduler.shutdown()),
        );
      }
      fragmentUpdateSchedulerRef.current = null;
      if (hoverIntentTimer !== null) {
        window.clearTimeout(hoverIntentTimer);
        hoverIntentTimer = null;
      }
      // Tear down the interaction-quality wiring.
      interactionQualityUnsub?.();
      interactionQualityUnsub = null;
      perfSamplingCleanup?.();
      perfSamplingCleanup = null;
      setHoverTooltipData(null);
      viewHelperCleanup?.();
      pixelRatioCleanup?.();
      renderOnDemandCleanup?.();
      contextRecoveryCleanup?.();
      // Dispose storey frustum culler (restores any auto-culled visibility)
      if (storeyFrustumCullerRef.current) {
        deferredTeardown.push(storeyFrustumCullerRef.current.dispose());
        storeyFrustumCullerRef.current = null;
      }
      // Dispose element frustum culler
      if (elementFrustumCullerRef.current) {
        deferredTeardown.push(elementFrustumCullerRef.current.dispose());
        elementFrustumCullerRef.current = null;
      }
      if (spatialTileCullerRef.current) {
        deferredTeardown.push(spatialTileCullerRef.current.dispose());
        spatialTileCullerRef.current = null;
      }
      useStore.getState().updatePerfMetrics({ culledStoreys: 0, culledElements: 0 });
      // Reset clip edges before the model is torn down so stale ClipEdges
      // instances don't reference a disposed model on the next load.
      clipEdgesServiceRef.current?.reset();
      // Dispose furnishing merge before tearing down the model
      if (furnishingMergeLifecycleRef.current) {
        const lifecycle = furnishingMergeLifecycleRef.current;
        furnishingMergeLifecycleRef.current = null;
        const shutdown = lifecycle.shutdown().catch(() => {});
        furnishingMergeShutdownRef.current = shutdown;
        if (shutdown !== pendingFurnishingShutdown) deferredTeardown.push(shutdown);
        void shutdown.then(() => {
          if (furnishingMergeShutdownRef.current === shutdown) {
            furnishingMergeShutdownRef.current = null;
          }
        });
      }
      useStore.getState().setFurnishingMerged(false);
      // Dispose storey[0] preview sub-model if component unmounts mid-stream.
      if (storeySubModel) {
        void storeySubModel.dispose().catch(() => {});
        storeySubModel = null;
      }
      modelService.dispose();
      const workerBlobUrl = workerBlobUrlRef.current;
      viewerRef.current = null;
      sceneThemeTargetsRef.current = null;
      useStore.getState().setModelHalfExtents(null);
      // React cleanup cannot itself be async. Keep the fragments components
      // alive until the coordinator's current worker mutation and the two
      // replacement/culler lifecycles have settled, then dispose exactly once.
      const teardownBarrier = new Promise<void>((resolve) => {
        let settled = false;
        let timeout = 0;
        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve();
        };
        timeout = window.setTimeout(finish, 3_000);
        void Promise.allSettled(deferredTeardown).then(finish);
      });
      void teardownBarrier.finally(() => {
        try {
          components.dispose();
        } finally {
          // Revoke only after FragmentsManager is fully torn down.
          if (workerBlobUrl) {
            try { URL.revokeObjectURL(workerBlobUrl); } catch { /* best-effort */ }
            if (workerBlobUrlRef.current === workerBlobUrl) workerBlobUrlRef.current = null;
          }
        }
      });
    };
  }, [
    computeFitDistance,
    applyTheme,
    updateLoadProgress,
    applyGhostPostproduction,
    requestViewerRender,
    setCoordinatedHover,
  ]);

  // Toggle EdgeDetectionPass.xray on PostproductionRenderer for true ghost
  // edges. Fragment visibility/opacity is owned by the coalesced visibility
  // scheduler above so ghost mode has one mutation path.
  useEffect(() => {
    applyGhostPostproduction(cameraNavigatingRef.current);
  }, [applyGhostPostproduction, ghostModeOn]);

  // Reset ghost mode whenever isolation is cleared
  useEffect(() => {
    if (isolatedIds.length === 0) setGhostModeOn(false);
  }, [isolatedIds, setGhostModeOn]);

  // Camera control functions exposed to toolbar
  const setCameraView = useCallback((view: string) => {
    applyCameraPreset(view, true);
  }, [applyCameraPreset]);

  const fitToModel = useCallback(() => {
    applyCameraPreset('iso', true);
  }, [applyCameraPreset]);

  /**
   * Zoom the camera in or out by `delta` units along the line of sight.
   * Positive delta = zoom out (move away from target), negative = zoom in.
   * Uses camera-controls' dolly() which respects the min/max distance limits.
   */
  const handleViewerZoom = useCallback((delta: number) => {
    if (!viewerRef.current) return;
    try {
      type Ctrl = { dolly: (d: number, animate: boolean) => void };
      (viewerRef.current.world.camera.controls as unknown as Ctrl).dolly(delta, true);
    } catch { /* ignore if controls not ready */ }
  }, []);

  /**
   * Camera-controls' baseline transition smooth-time, captured lazily on the
   * first frame call so `frameBoxWithCamera` can restore it after each
   * travel-scaled transition. Re-reading it per call would capture our own
   * in-flight override when zooms overlap, and the value would drift.
   */
  const defaultSmoothTimeRef = useRef<number | null>(null);

  /**
   * Shared camera core for zoomToElement / frameElements: solve the landing
   * pose with `solveCameraFrame` (approach from the camera's current side,
   * elevation clamp, bounding-sphere fit, ortho zoom), then animate there
   * with a travel-scaled smooth-time.
   */
  const frameBoxWithCamera = useCallback(async (box: THREE.Box3) => {
    if (!viewerRef.current) return;
    const { world } = viewerRef.current;
    const controls = world.camera.controls;
    const camera = world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const persp = camera as THREE.PerspectiveCamera;
    const ortho = camera as THREE.OrthographicCamera;
    const isPerspective = persp.isPerspectiveCamera === true;

    const solution = solveCameraFrame({
      center: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
      cameraPos: controls.getPosition(new THREE.Vector3()),
      isPerspective,
      fovDeg: isPerspective ? persp.fov : undefined,
      aspect: isPerspective ? persp.aspect : undefined,
      orthoWidth: isPerspective ? undefined : ortho.right - ortho.left,
      orthoHeight: isPerspective ? undefined : ortho.top - ortho.bottom,
    });

    if (defaultSmoothTimeRef.current == null) {
      defaultSmoothTimeRef.current = controls.smoothTime;
    }
    controls.smoothTime = solution.smoothTime;
    // Wrap accumulated azimuth/polar angles back into the canonical range so
    // the animated setLookAt takes the shortest rotation instead of unwinding
    // whole revolutions of orbit history (see applyCameraPreset).
    controls.normalizeRotations();
    try {
      const moves = [
        controls.setLookAt(
          solution.eye.x, solution.eye.y, solution.eye.z,
          solution.target.x, solution.target.y, solution.target.z,
          true,
        ),
      ];
      if (solution.orthoZoom != null) moves.push(controls.zoomTo(solution.orthoZoom, true));
      await Promise.all(moves);
    } finally {
      controls.smoothTime = defaultSmoothTimeRef.current;
    }
  }, []);

  /**
   * Frame the camera on a single element by IFC Express id. This is the
   * "zoom icon" action the tree, viewer double-click and chat tools share.
   */
  const zoomToElement = useCallback(async (expressId: number) => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;
    try {
      const [localId] = await expressToLocalIds(model, [expressId]);
      if (localId == null) return;
      const box = await model.getMergedBox([localId]);
      if (!box) return;
      useStore.getState().logActivity({
        kind: 'view',
        summary: `Zoomed to element #${expressId}`,
      });
      await frameBoxWithCamera(box);
    } catch (e) {
      console.warn('zoomToElement failed:', e);
    }
  }, [expressToLocalIds, frameBoxWithCamera]);

  // Register zoomToElement with the store so deep components (tree rows,
  // chat tools, command palette) can trigger it without prop drilling.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setZoomToElementFn((id) => { void zoomToElement(id); });
    return () => {
      useStore.getState().setZoomToElementFn(null);
    };
  }, [viewerReady, zoomToElement]);

  /**
   * Frame the camera on N elements via their merged bounding box.
   * Used by the "F" keyboard shortcut when a selection or multi-highlight is
   * active, so framing matches the existing H / I priority order.
   * Falls back to the merged AABB so a 50-element highlight still fits.
   */
  const frameElements = useCallback(async (expressIds: number[]) => {
    if (!viewerRef.current) return;
    if (expressIds.length === 0) return;
    const { model } = viewerRef.current;
    try {
      const localIdsRaw = await expressToLocalIds(model, expressIds);
      const localIds = localIdsRaw.filter((v): v is number => v != null);
      if (localIds.length === 0) return;
      const box = await model.getMergedBox(localIds);
      if (!box) return;
      const summary = expressIds.length === 1
        ? `Framed element #${expressIds[0]}`
        : `Framed ${expressIds.length} elements`;
      useStore.getState().logActivity({ kind: 'view', summary });
      await frameBoxWithCamera(box);
    } catch (e) {
      console.warn('frameElements failed:', e);
    }
  }, [expressToLocalIds, frameBoxWithCamera]);

  // Register frameElements with the store so KeyboardShortcuts (and the
  // command palette / chat tools, in future) can drive it without prop drilling.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setFrameElementsFn((ids) => { void frameElements(ids); });
    return () => {
      useStore.getState().setFrameElementsFn(null);
    };
  }, [viewerReady, frameElements]);

  // Fit one stable section box to an arbitrary selection. Geometry remains in
  // the scene; only the six persistent clipping equations are updated.
  const clipToElements = useCallback(async (expressIds: number[], label?: string) => {
    if (!viewerRef.current) return;
    const uniqueIds = Array.from(new Set(expressIds.filter(Number.isFinite)));
    if (uniqueIds.length === 0) return;
    const { model } = viewerRef.current;
    try {
      const localIds = (await expressToLocalIds(model, uniqueIds))
        .filter((id): id is number => id != null);
      if (localIds.length === 0) return;
      const raw = await model.getMergedBox(localIds);
      if (!raw) return;
      const bounds: SectionBounds = [
        raw.min.x, raw.min.y, raw.min.z,
        raw.max.x, raw.max.y, raw.max.z,
      ];
      const name = label ?? (uniqueIds.length === 1
        ? `Element #${uniqueIds[0]}`
        : `${uniqueIds.length} selected elements`);
      setSectionWorkspace(createSelectionSectionPreset({
        id: `selection:${uniqueIds.length}:${uniqueIds.slice(0, 8).join('-')}`,
        name: `Section: ${name}`,
        bounds,
        paddingFraction: 0.1,
        minimumPadding: 0.01,
      }));
      useStore.getState().logActivity({
        kind: 'view',
        summary: `Section box fitted to ${name}`,
      });
    } catch (e) {
      console.warn('clipToElements failed:', e);
    }
  }, [expressToLocalIds, setSectionWorkspace]);

  const clipToElement = useCallback((expressId: number) => {
    void clipToElements([expressId], `element #${expressId}`);
  }, [clipToElements]);

  // Register clipToElement with the store (same pattern as zoomToElement).
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setClipToElementFn(clipToElement);
    useStore.getState().setClipToElementsFn((ids, label) => { void clipToElements(ids, label); });
    return () => {
      useStore.getState().setClipToElementFn(null);
      useStore.getState().setClipToElementsFn(null);
    };
  }, [viewerReady, clipToElement, clipToElements]);

  // Soft amber preview highlight driven by sidebar tree-row hover.
  // Reuses HOVER_HIGHLIGHT_MATERIAL semantics (amber + transparent) so the
  // preview reads the same whether the user is hovering the canvas or a row
  // in the spatial tree.  State machine lives in `treeHoverPreviewHelpers.ts`
  // (gen-counter discards stale async resolutions so a fast cursor sweep
  // never paints behind the user); we keep a parallel local-id ref because
  // the FragmentsModel API speaks in local ids, not express ids.
  const treeHoverStateRef = useRef<TreeHoverPreviewState>(INITIAL_TREE_HOVER_STATE);
  const treeHoverPaintedLocalRef = useRef<number | null>(null);
  const treeHoverPreview = useCallback(async (expressId: number | null) => {
    if (!viewerRef.current) return;
    const { model } = viewerRef.current;

    // Advance the state machine first so any concurrent call sees the new gen.
    treeHoverStateRef.current = expressId === null
      ? onTreeHoverLeave(treeHoverStateRef.current)
      : onTreeHoverEnter(treeHoverStateRef.current, expressId);
    const myGen = treeHoverStateRef.current.gen;

    // Hover-leave: drop whatever was painted, unless it's click-selected.
    if (expressId === null) {
      const prevLocal = treeHoverPaintedLocalRef.current;
      const prevExpress = treeHoverStateRef.current.paintedId;
      if (prevLocal == null) return;
      treeHoverPaintedLocalRef.current = null;
      treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, null);
      await setCoordinatedHover('tree', null).catch(() => {});
      return;
    }

    // Gate the hover-enter paint the same way the canvas hover path is gated
    // (Appendix B picking #6): don't churn highlights while the camera is
    // navigating, and respect the hoverHighlightEnabled preference so disabling
    // canvas hover also disables tree-row hover. Leave (above) still runs so a
    // stale preview clears promptly.
    if (
      cameraNavigatingRef.current
      || !useStore.getState().hoverHighlightEnabled
      || !getRuntimeQualitySettings(interactionQualityRef.current.active).hoverRaycastEnabled
    ) {
      return;
    }

    // Hover-enter: resolve express to local, then paint if still current.
    try {
      const [localId] = await expressToLocalIds(model, [expressId]);
      if (isResolutionStale(treeHoverStateRef.current, myGen)) return;
      if (localId == null) return;

      const prevLocal = treeHoverPaintedLocalRef.current;
      const prevExpress = treeHoverStateRef.current.paintedId;
      const st = useStore.getState();
      if (shouldSkipResetForSelection(expressId, st.selectedElementId, st.selectedIds)) {
        if (prevLocal != null && !shouldSkipResetForSelection(prevExpress, st.selectedElementId, st.selectedIds)) {
          await setCoordinatedHover('tree', null).catch(() => {});
        }
        treeHoverPaintedLocalRef.current = null;
        treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, null);
        return;
      }
      if (prevLocal === localId) return;  // already painted; nothing to do

      if (isResolutionStale(treeHoverStateRef.current, myGen)) return;
      treeHoverPaintedLocalRef.current = localId;
      treeHoverStateRef.current = onTreeHoverPainted(treeHoverStateRef.current, expressId);
      // Reuse the shared frozen hover material (singleton THREE.Color) instead
      // of allocating a fresh THREE.Color + options object per row hover - a
      // fast tree sweep used to leak one of each per row (Appendix B picking
      // #2). HOVER_HIGHLIGHT_MATERIAL already encodes the same amber / 0.45 /
      // transparent / RenderedFaces.ONE the canvas hover path uses.
      await setCoordinatedHover('tree', localId);
    } catch {
      // Resolution failure is non-fatal - just leave the previous paint alone.
    }
  }, [expressToLocalIds, setCoordinatedHover]);

  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setTreeHoverPreviewFn((id) => { void treeHoverPreview(id); });
    return () => {
      useStore.getState().setTreeHoverPreviewFn(null);
      // Clear any leftover paint on unmount / model swap.
      const prevLocal = treeHoverPaintedLocalRef.current;
      const prevExpress = treeHoverStateRef.current.paintedId;
      treeHoverPaintedLocalRef.current = null;
      treeHoverStateRef.current = INITIAL_TREE_HOVER_STATE;
      if (prevLocal != null && viewerRef.current) {
        void setCoordinatedHover('tree', null).catch(() => {});
      }
    };
  }, [viewerReady, treeHoverPreview, setCoordinatedHover]);

  // Keyboard zoom: + / = zoom in, - zoom out, 0 fit to model.
  // Only fires when no text input is focused (avoids hijacking form fields).
  useEffect(() => {
    if (!viewerReady) return;
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); handleViewerZoom(-3); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); handleViewerZoom(3); }
      else if (e.key === '0') { e.preventDefault(); fitToModel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [viewerReady, handleViewerZoom, fitToModel]);

  // Register getCameraStateFn + setLookAtFn so share-link can read and restore camera.
  useEffect(() => {
    if (!viewerReady) return;
    useStore.getState().setGetCameraStateFn(() => {
      if (!viewerRef.current) return null;
      try {
        const controls = viewerRef.current.world.camera.controls as {
          getPosition: (out?: THREE.Vector3) => THREE.Vector3;
          getTarget: (out?: THREE.Vector3) => THREE.Vector3;
        };
        const pos = controls.getPosition(new THREE.Vector3());
        const tgt = controls.getTarget(new THREE.Vector3());
        return {
          pos: [pos.x, pos.y, pos.z],
          target: [tgt.x, tgt.y, tgt.z],
        };
      } catch {
        return null;
      }
    });
    useStore.getState().setSetLookAtFn((pos, tgt, animate) => {
      if (!viewerRef.current) return;
      try {
        viewerRef.current.world.camera.controls.setLookAt(
          pos[0], pos[1], pos[2],
          tgt[0], tgt[1], tgt[2],
          animate,
        );
      } catch { /* ignore */ }
    });
    return () => {
      useStore.getState().setGetCameraStateFn(null);
      useStore.getState().setSetLookAtFn(null);
    };
  }, [viewerReady]);

  // Render one fresh frame into the drawing buffer for capture. When the
  // postproduction composer is active (ghost mode), a plain renderer.render
  // bypasses the edge/xray passes and the capture doesn't match the screen
  // - route through the composer in that case.
  const renderForCapture = useCallback(() => {
    if (!viewerRef.current) return null;
    const { world } = viewerRef.current;
    const renderer = world.renderer!.three;
    const pp = postproductionRef.current as unknown as {
      enabled?: boolean;
      composer?: { render: () => void };
    } | null;
    if (pp?.enabled && pp.composer?.render) {
      try {
        pp.composer.render();
        return renderer.domElement;
      } catch { /* fall through to the plain render */ }
    }
    renderer.render(world.scene.three, world.camera.three);
    return renderer.domElement;
  }, []);

  // Capture a screenshot of the current 3D viewport
  const captureScreenshot = useCallback(() => {
    if (!viewerRef.current) return;
    try {
      const canvas = renderForCapture();
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');

      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `ifc-viewer-${ts}.png`;
      a.href = dataUrl;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      useStore.getState().logActivity({
        kind: 'screenshot',
        summary: `Screenshot saved (${a.download})`,
      });
    } catch (e: any) {
      console.error('Screenshot failed:', e);
      useStore.getState().logActivity({
        kind: 'error',
        summary: 'Screenshot failed',
        detail: e?.message,
      });
    }
  }, [renderForCapture]);

  // Generate a small JPEG thumbnail data URL from the current viewport
  const captureThumbnail = useCallback((): string | null => {
    if (!viewerRef.current) return null;
    try {
      // Fresh frame in the drawing buffer - composer-aware.
      const source = renderForCapture();
      if (!source) return null;
      const w = 200;
      const h = Math.round((source.height / source.width) * w) || Math.round(w * 0.7);
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, w, h);
      return tmp.toDataURL('image/jpeg', 0.55);
    } catch {
      return null;
    }
  }, [renderForCapture]);

  // Parameterized JPEG snapshot for the viewer bridge (BCF viewpoints,
  // backend snapshot commands). Same composer-aware render + canvas-downscale
  // technique as captureThumbnail, but with a caller-chosen max width and a
  // higher quality suited to issue screenshots. captureThumbnail stays as-is:
  // its fixed 200px / 0.55 output feeds the saved-viewpoint chips.
  const captureBridgeSnapshot = useCallback((maxPx: number): string | null => {
    if (!viewerRef.current) return null;
    try {
      const source = renderForCapture();
      if (!source) return null;
      const w = Math.max(1, Math.min(Math.round(maxPx), source.width));
      const h = Math.round((source.height / source.width) * w) || Math.round(w * 0.7);
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, w, h);
      return tmp.toDataURL('image/jpeg', 0.7);
    } catch {
      return null;
    }
  }, [renderForCapture]);

  // Save current camera/visibility/selection state as a viewpoint
  const saveViewpoint = useCallback((name: string) => {
    if (!viewerRef.current) return;
    const state = useStore.getState();
    if (!state.modelLoaded) return;
    const project = state.project;
    // Synthesize a project key when project meta isn't populated yet - some
    // load paths (manifest fast-path / cache-only) don't always set
    // `project` before the user starts using the viewer.
    const projectKey = project
      ? `${project.name}|${project.schema_version}`
      : `model|${state.modelFingerprint || 'unknown'}`;

    const { world } = viewerRef.current;
    const controls = world.camera.controls as {
      getPosition: (out?: THREE.Vector3) => THREE.Vector3;
      getTarget: (out?: THREE.Vector3) => THREE.Vector3;
    };
    const pos = controls.getPosition(new THREE.Vector3());
    const target = controls.getTarget(new THREE.Vector3());

    const vp = {
      id: `vp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      projectKey,
      name: name.trim() || `Viewpoint ${state.viewpoints.length + 1}`,
      createdAt: Date.now(),
      camera: {
        pos: [pos.x, pos.y, pos.z] as [number, number, number],
        target: [target.x, target.y, target.z] as [number, number, number],
      },
      isolatedIds: [...state.isolatedIds],
      hiddenIds: [...state.hiddenIds],
      selectedId: state.selectedElementId,
      highlightedIds: [...state.highlightedIds],
      sectionWorkspace: state.sectionWorkspace,
      sectionBoxEnabled: state.sectionBoxEnabled,
      thumbnail: captureThumbnail(),
    };

    state.saveViewpoint(vp);
    state.logActivity({
      kind: 'view',
      summary: `Saved viewpoint "${vp.name}"`,
    });
  }, [captureThumbnail]);

  // Restore a saved viewpoint: camera, visibility, selection, highlights
  const restoreViewpoint = useCallback((id: string) => {
    if (!viewerRef.current) return;
    const state = useStore.getState();
    const vp = state.viewpoints.find((v) => v.id === id);
    if (!vp) return;

    const { world } = viewerRef.current;
    const [px, py, pz] = vp.camera.pos;
    const [tx, ty, tz] = vp.camera.target;
    world.camera.controls.setLookAt(px, py, pz, tx, ty, tz, true);

    // Apply visibility first, then selection/highlights. The viewer's store
    // subscribers already handle the side effects.
    if (vp.isolatedIds.length > 0) {
      state.setIsolatedIds(vp.isolatedIds);
    } else if (vp.hiddenIds.length > 0) {
      state.setHiddenIds(vp.hiddenIds);
    } else {
      state.clearVisibility();
    }

    state.setHighlightedIds(vp.highlightedIds);
    state.selectElement(vp.selectedId);

    // Viewpoints saved before the section workspace existed lack these fields
    // and must leave the current section state untouched.
    if (vp.sectionWorkspace !== undefined || vp.sectionBoxEnabled !== undefined) {
      // Persisted payloads are untrusted; parse validates and returns null on
      // schema drift so a corrupt workspace clears instead of throwing.
      const workspace = vp.sectionWorkspace ? parseSectionWorkspace(vp.sectionWorkspace) : null;
      state.setSectionWorkspace(workspace);
      // setSectionWorkspace derives enabled from the box; a workspace kept
      // while temporarily disabled needs the saved flag re-applied after it.
      if (typeof vp.sectionBoxEnabled === 'boolean') {
        state.setSectionBoxEnabled(vp.sectionBoxEnabled);
      }
    }

    state.logActivity({
      kind: 'view',
      summary: `Restored viewpoint "${vp.name}"`,
    });
  }, []);

  // Register the viewer bridge so non-viewer code (BCF topics, the viewer
  // command executor, the viewer state reporter) can capture or apply 3D view
  // state without importing ViewerPanel. Same lifecycle pattern as the
  // zoomToElement / frameElements store registrations above: register once
  // the world is ready, unregister on dispose. Every capability guards
  // against "model not loaded / world disposed" by returning null / no-op.
  useEffect(() => {
    if (!viewerReady) return;
    const caps: ViewerBridgeCapabilities = {
      // Same camera read as saveViewpoint; visibility/selection from the
      // store. The canvas is only touched when a snapshot is requested -
      // the no-snapshot path runs on every viewer state report.
      captureViewState: async (opts) => {
        if (!viewerRef.current) return null;
        try {
          const { world } = viewerRef.current;
          const controls = world.camera.controls as {
            getPosition: (out?: THREE.Vector3) => THREE.Vector3;
            getTarget: (out?: THREE.Vector3) => THREE.Vector3;
          };
          const pos = controls.getPosition(new THREE.Vector3());
          const target = controls.getTarget(new THREE.Vector3());
          const state = useStore.getState();
          return {
            camera: {
              pos: [pos.x, pos.y, pos.z] as [number, number, number],
              target: [target.x, target.y, target.z] as [number, number, number],
            },
            isolatedIds: [...state.isolatedIds],
            hiddenIds: [...state.hiddenIds],
            selectedId: state.selectedElementId,
            highlightedIds: [...state.highlightedIds],
            snapshotDataUrl: opts?.snapshotMaxPx != null
              ? captureBridgeSnapshot(opts.snapshotMaxPx)
              : null,
          };
        } catch {
          return null;
        }
      },
      // Mirrors restoreViewpoint's order and smoothness: camera (smooth
      // setLookAt) first, then visibility, then highlights and selection.
      // Fields absent from the request leave the current state untouched.
      applyViewState: async (req) => {
        if (!viewerRef.current) return;
        try {
          const state = useStore.getState();
          if (req.camera) {
            const [px, py, pz] = req.camera.pos;
            const [tx, ty, tz] = req.camera.target;
            viewerRef.current.world.camera.controls.setLookAt(px, py, pz, tx, ty, tz, true);
          }
          if (req.isolatedIds !== undefined || req.hiddenIds !== undefined) {
            if (req.isolatedIds && req.isolatedIds.length > 0) {
              state.setIsolatedIds(req.isolatedIds);
            } else if (req.hiddenIds && req.hiddenIds.length > 0) {
              state.setHiddenIds(req.hiddenIds);
            } else {
              state.clearVisibility();
            }
          }
          if (req.highlightedIds !== undefined) {
            state.setHighlightedIds(req.highlightedIds);
          }
          if (req.selectedId !== undefined) {
            state.selectElement(req.selectedId);
          }
        } catch {
          // World disposed mid-apply - leave the viewer as it is.
        }
      },
      // Reuses the existing preset machinery: 'fit' takes the whole-model
      // fit path, the directional names map 1:1 onto the local
      // applyCameraPreset vectors (front/back/left/right/top/iso).
      applyCameraPreset: async (preset) => {
        if (!viewerRef.current) return;
        if (preset === 'fit') {
          fitToModel();
          return;
        }
        applyCameraPreset(preset, true);
      },
    };
    registerViewerBridge(caps);
    return () => {
      unregisterViewerBridge(caps);
    };
  }, [viewerReady, captureBridgeSnapshot, fitToModel, applyCameraPreset]);

  // Expose controls to parent via refs
  useEffect(() => {
    if (onCameraViewRef) onCameraViewRef.current = setCameraView;
    if (onFitModelRef) onFitModelRef.current = fitToModel;
    if (onScreenshotRef) onScreenshotRef.current = captureScreenshot;
    if (onSaveViewpointRef) onSaveViewpointRef.current = saveViewpoint;
    if (onRestoreViewpointRef) onRestoreViewpointRef.current = restoreViewpoint;
    return () => {
      if (onCameraViewRef) onCameraViewRef.current = null;
      if (onFitModelRef) onFitModelRef.current = null;
      if (onScreenshotRef) onScreenshotRef.current = null;
      if (onSaveViewpointRef) onSaveViewpointRef.current = null;
      if (onRestoreViewpointRef) onRestoreViewpointRef.current = null;
    };
  }, [
    setCameraView, fitToModel, captureScreenshot, saveViewpoint, restoreViewpoint,
    onCameraViewRef, onFitModelRef, onScreenshotRef,
    onSaveViewpointRef, onRestoreViewpointRef,
  ]);

  // Tick elapsed seconds for the whole load. Feeds the overlay's time line
  // (elapsed always, a remaining estimate when history backs it) instead of
  // only waking up after the slow-load threshold.
  useEffect(() => {
    if (!loading) {
      setLoadElapsedSec(null);
      return;
    }
    const startedAt = Date.now();
    setLoadElapsedSec(0);
    const id = window.setInterval(() => {
      setLoadElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [loading]);

  // Display progress runs through the pace model in loadProgressPresenter:
  // monotonic (raw checkpoints can regress on fallback paths, the bar never
  // does), never frozen (asymptotic drift toward the next checkpoint), and
  // time-weighted so long phases creep honestly instead of stalling. The
  // expected total comes from this machine's perf-log history with fixed
  // priors as fallback.
  const [displayProgress, setDisplayProgress] = useState<number>(loadProgress.progress);
  const paceRef = useRef<PaceState | null>(null);
  const targetProgressRef = useRef<number>(loadProgress.progress);
  targetProgressRef.current = loadProgress.progress;
  const expectedTotalRef = useRef<{ kind: LoadPathKind; ms: number; fromHistory: boolean }>({
    kind: 'unknown',
    ms: 25_000,
    fromHistory: false,
  });
  const loadPathKind = pathKindForSourceHint(loadProgress.sourceHint);
  useEffect(() => {
    if (loadPathKind === 'unknown' || expectedTotalRef.current.kind === loadPathKind) return;
    let history: ViewerPerfLogEntry[] | null = null;
    try {
      history = JSON.parse(
        localStorage.getItem(VIEWER_PERF_LOG_STORAGE_KEY) ?? '[]',
      ) as ViewerPerfLogEntry[];
    } catch {
      history = null;
    }
    const estimate = estimateExpectedTotal(loadPathKind, history);
    expectedTotalRef.current = { kind: loadPathKind, ...estimate };
    if (paceRef.current) {
      paceRef.current = { ...paceRef.current, expectedTotalMs: estimate.ms };
    }
  }, [loadPathKind]);
  // The pacing loop only runs while the overlay is visible: it spins up per
  // load and shuts down once the overlay is gone (no idle-loop tax).
  useEffect(() => {
    if (!loading) {
      paceRef.current = null;
      return;
    }
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, now - lastTs);
      lastTs = now;
      const previous = paceRef.current
        ?? createPaceState(targetProgressRef.current, expectedTotalRef.current.ms);
      const next = advancePace(previous, targetProgressRef.current, dt);
      paceRef.current = next;
      // Re-render at 0.1 pct granularity - finer is sub-pixel on the bar.
      if (Math.round(next.display * 10) !== Math.round(previous.display * 10)) {
        setDisplayProgress(next.display);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [loading]);
  // Snap to 100 without easing so completion lands cleanly. (No snap on low
  // values: fallback branches re-report low checkpoints and the bar must
  // never jump backwards.)
  useEffect(() => {
    if (loadProgress.progress >= 100) {
      paceRef.current = paceRef.current
        ? { ...paceRef.current, anchor: 100, display: 100 }
        : createPaceState(100, expectedTotalRef.current.ms);
      setDisplayProgress(100);
    }
  }, [loadProgress.progress]);

  const projectName = useStore((s) => s.project?.name ?? null);
  const serverCachePref = useStore((s) => s.useServerCache);
  const loadPresentation = useMemo(() => {
    const bytes = useStore.getState().ifcFileBytes;
    return presentLoadProgress(loadProgress, {
      fileName: projectName,
      fileSizeMB: bytes ? bytes.byteLength / (1024 * 1024) : null,
      cachesEnabled: serverCachePref,
    });
  }, [loadProgress, projectName, serverCachePref]);
  const loadEta = loadElapsedSec == null
    ? { text: null, overrun: false }
    : formatEta(
      loadElapsedSec * 1000,
      expectedTotalRef.current.ms,
      expectedTotalRef.current.fromHistory,
    );

  const loadPercent = Math.round(Math.max(0, Math.min(100, displayProgress)));
  const loadBarPercent = Math.max(6, loadPercent);
  // Once the first frame is on screen (96+), collapse the pill to a compact
  // one-row chip so the user watches their model, not the loader.
  const loadCompact = loadProgress.progress >= 96;

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {loading && (
        <div className={`viewer-load-overlay${loadingFading ? ' fading' : ''}`}>
          <div
            className="viewer-load-bar-track"
            role="progressbar"
            aria-label="Model loading progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loadPercent}
          >
            <div className="viewer-load-bar-fill" style={{ width: `${loadBarPercent}%` }} />
          </div>
          {/* Screen-reader channel: announces stage transitions only. The
              visible pill must NOT be a live region - its percent, elapsed
              seconds, and detail mutate continuously and would drown the
              reader. The percent itself is exposed via the progressbar. */}
          <span className="sr-only" role="status">
            {loadingSlow ? 'Still working. Large models take longest on their first open.' : loadPresentation.title}
          </span>
          <div
            className={`viewer-load-status${loadingSlow ? ' slow' : ''}${loadCompact ? ' compact' : ''}`}
          >
            {loadPresentation.chip && (
              <span className="viewer-load-chip">{loadPresentation.chip}</span>
            )}
            <div className="viewer-load-steps" aria-hidden="true">
              {LOAD_STAGES.map((s) => (
                <span
                  key={s.id}
                  className={`viewer-load-step${
                    s.index < loadPresentation.stage.index
                      ? ' done'
                      : s.index === loadPresentation.stage.index
                        ? ' active'
                        : ''
                  }`}
                />
              ))}
            </div>
            <div className="viewer-load-headline">
              <span className="viewer-load-title">{loadPresentation.title}</span>
              <span className="viewer-load-pct">{loadPercent}%</span>
              {loadEta.text && <span className="viewer-load-eta">{loadEta.text}</span>}
            </div>
            <span className="viewer-load-detail">{loadPresentation.detail}</span>
            {loadingSlow ? (
              <span className="viewer-load-slowline">
                Still working. Large models take longest on their first open.
              </span>
            ) : loadPresentation.caption ? (
              <span className="viewer-load-caption">{loadPresentation.caption}</span>
            ) : null}
            {loadPresentation.techDetail && (
              <span className="viewer-load-tech">{loadPresentation.techDetail}</span>
            )}
          </div>
        </div>
      )}
      {loadError && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'var(--s-2)',
          padding: 20,
          borderRadius: 6,
          border: '1px solid var(--danger)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 10,
          maxWidth: 400,
          textAlign: 'center',
        }}>
          <p style={{ color: 'var(--danger)', marginBottom: 8, fontSize: 13, fontWeight: 600 }}>
            3D loading error
          </p>
          <p style={{ fontSize: 12, color: 'var(--f-1)' }}>{loadError}</p>
          <p style={{ fontSize: 11, color: 'var(--f-2)', marginTop: 8 }}>
            The model data is still accessible via the tree and properties panels.
          </p>
        </div>
      )}
      {viewerReady && !BROWSER_ONLY && <FloatingChatDock />}
      <HighlightBadge />
      {viewerReady && <SelectionSummaryChip />}
      {/* Bottom-center tool row: nav/visibility pill + ghost-mode toggle
          (ghost appears only when elements are isolated) */}
      {viewerReady && (
        <div style={{
          position: 'absolute',
          bottom: 56,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <ViewportNavControls onFitModel={() => fitToModel()} />
          {isolatedIds.length > 0 && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: ghostModeOn ? 'var(--accent, #3b82f6)' : 'var(--s-2, #1e2535)',
              border: `1px solid ${ghostModeOn ? 'var(--accent, #3b82f6)' : 'var(--b-2, #374151)'}`,
              borderRadius: 20,
              padding: '5px 12px 5px 10px',
              cursor: 'pointer',
              boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.4))',
              userSelect: 'none',
              transition: 'background 0.15s, border-color 0.15s',
            }}
              onClick={() => setGhostModeOn(!ghostModeOn)}
              title={ghostModeOn ? 'Click to hide non-isolated elements (Shift+G)' : 'Click to show ghosted view with xray edges (Shift+G)'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke={ghostModeOn ? '#fff' : 'var(--f-2, #9ca3af)'}
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
                {ghostModeOn && <line x1="1" y1="1" x2="23" y2="23"/>}
              </svg>
              <span style={{
                fontSize: 11,
                fontWeight: 500,
                color: ghostModeOn ? '#fff' : 'var(--f-2, #9ca3af)',
                letterSpacing: '0.02em',
              }}>
                {ghostModeOn ? 'Ghost on' : 'Ghost off'}
              </span>
            </div>
          )}
        </div>
      )}
      <PerformanceHud />
      {perfDashOpen && (
        <PerformanceDashboard onClose={() => setPerfDashOpen(false)} />
      )}
      {/* Element name tooltip on hover - leaf component fed by hoverTooltipBridge */}
      <ViewerHoverTooltip />
      {/* Touch-friendly zoom controls (+/- buttons) */}
      {viewerReady && (
        <div className="viewer-zoom-controls" aria-label="Zoom controls">
          <button
            className="viewer-zoom-btn"
            onClick={() => handleViewerZoom(-3)}
            title="Zoom in"
            aria-label="Zoom in"
          >+</button>
          <button
            className="viewer-zoom-btn"
            onClick={() => fitToModel()}
            title="Fit to view"
            aria-label="Fit to view"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
              <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
            </svg>
          </button>
          <button
            className="viewer-zoom-btn"
            onClick={() => handleViewerZoom(3)}
            title="Zoom out"
            aria-label="Zoom out"
          >-</button>
        </div>
      )}
      {/* B5 mount point: edit-mode drawing toolbar (gates itself on editMode). */}
      {wallDrawController && <EditToolbar controller={wallDrawController} />}
      <MeasurementControls
        snapshot={measurementSnapshot}
        onFinish={() => measurementControllerRef.current?.commit()}
        onCancel={() => {
          clearanceFirstTriangleRef.current = null;
          measurementControllerRef.current?.cancel();
        }}
        onClear={() => {
          clearanceFirstTriangleRef.current = null;
          measurementControllerRef.current?.clear();
        }}
        onRemove={(id) => measurementControllerRef.current?.remove(id)}
      />
      <MeasurementLabels
        snapshot={measurementSnapshot}
        viewerRef={viewerRef}
        containerRef={containerRef}
      />
      <MeasurementPanel
        measurements={measurementSnapshot?.committed ?? []}
        unit={measurementUnit}
        onRemove={(id) => measurementControllerRef.current?.remove(id)}
        onClearAll={() => {
          clearanceFirstTriangleRef.current = null;
          measurementControllerRef.current?.clear();
        }}
      />
      <ErrorBoundary label="ViewerContextMenu" fallback={null}>
        <ViewerContextMenu
          state={contextMenuState}
          onClose={() => setContextMenuState(null)}
        />
      </ErrorBoundary>
    </div>
  );
}
