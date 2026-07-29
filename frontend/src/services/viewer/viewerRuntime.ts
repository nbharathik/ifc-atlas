import * as THREE from 'three';
import * as OBC from '@thatopen/components';
import * as OBCF from '@thatopen/components-front';
import { RENDER_ON_DEMAND } from '../../config/featureFlags';
import { installBVH } from './bvhSetup';
import { createInvalidationRenderLoop } from './invalidationRenderLoop';
import type { ViewerSessionStartContext } from './viewerSession';
import {
  createFragmentRuntime,
  type FragmentRuntime,
  type FragmentRuntimeOptions,
} from './fragmentRuntime';

export type ViewerWorld = OBC.SimpleWorld<
  OBC.SimpleScene,
  OBC.SimpleCamera,
  OBC.SimpleRenderer
>;

export interface ViewerRendererFlags {
  readonly antialias: boolean;
  readonly logarithmicDepthBuffer: boolean;
}

export interface ViewerRuntimeOptions {
  readonly container: HTMLElement;
  readonly rendererFlags: ViewerRendererFlags;
  readonly getRestoredPixelRatioCap: () => number;
  readonly subscribeVisualChanges?: (kick: (milliseconds?: number) => void) => () => void;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
  readonly fragments?: Omit<FragmentRuntimeOptions, 'renderKick'>;
}

export interface InteractionPixelRatioController {
  readonly activeCap: number;
  setCap(cap: number): void;
  restoreCap(): void;
  noteCameraUpdate(): void;
  cancelDeferredDrop(): void;
  applyQualityCap(
    cap: number,
    options: {
      readonly navigating: boolean;
      readonly isCameraNavigating: () => boolean;
    },
  ): void;
}

export interface ViewerRuntime {
  readonly world: ViewerWorld;
  readonly grid: ReturnType<OBC.Grids['create']>;
  readonly renderKick: (milliseconds?: number) => void;
  readonly pixelRatio: InteractionPixelRatioController;
  readonly navigationPixelRatioCap: number;
  readonly cameraSettleDelayMs: number;
  readonly cullerShowPassMinIntervalMs: number;
  readonly postproduction: OBCF.PostproductionRenderer['postproduction'] | null;
  readonly fragments: FragmentRuntime;
}

const HARD_PIXEL_RATIO_CAP = 2;
const NAVIGATION_PIXEL_RATIO_CAP = 1;
const CAMERA_SETTLE_DELAY_MS = 320;
const CULLER_SHOW_PASS_MIN_INTERVAL_MS = 220;
const DPR_DROP_DELAY_MS = 180;
const WHEEL_GESTURE_WINDOW_MS = 300;
const DPR_DROP_RECENT_MOTION_MS = 120;

/**
 * Creates the browser renderer runtime and registers every browser resource
 * with the owning ViewerSession before returning it to React.
 */
export async function createViewerRuntime(
  session: ViewerSessionStartContext<OBC.Components>,
  options: ViewerRuntimeOptions,
): Promise<ViewerRuntime> {
  const { engine: components, signal } = session;
  const { container } = options;

  installBVH();

  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<
    OBC.SimpleScene,
    OBC.SimpleCamera,
    OBC.SimpleRenderer
  >();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBCF.PostproductionRenderer(components, container, {
    antialias: options.rendererFlags.antialias,
    logarithmicDepthBuffer: options.rendererFlags.logarithmicDepthBuffer,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: false,
  });
  world.renderer.showLogo = false;

  try {
    const renderer = world.renderer as unknown as OBCF.PostproductionRenderer;
    renderer.turnOffOnManualMode = false;
    renderer.manualModeDelay = 120;
  } catch {
    // Older @thatopen/components-front versions may not expose these knobs.
  }

  let renderKick: (milliseconds?: number) => void = () => {};
  if (RENDER_ON_DEMAND) {
    try {
      const renderer = world.renderer as unknown as {
        mode: OBC.RendererMode;
        needsUpdate: boolean;
      };
      renderer.mode = OBC.RendererMode.MANUAL;
      const invalidationLoop = createInvalidationRenderLoop({
        now: () => performance.now(),
        raf: (callback) => window.requestAnimationFrame(callback),
        cancelRaf: (handle) => window.cancelAnimationFrame(handle),
        invalidate: () => {
          renderer.needsUpdate = true;
        },
        initialWindowMs: 1_500,
      });
      renderKick = (milliseconds = 300) => invalidationLoop.kick(milliseconds);

      const kickOnPointer = (event: PointerEvent) => {
        if (event.buttons !== 0) renderKick(200);
      };
      const kickOnWheel = () => renderKick(400);
      container.addEventListener('pointermove', kickOnPointer, { passive: true });
      container.addEventListener('pointerdown', kickOnPointer, { passive: true });
      container.addEventListener('wheel', kickOnWheel, { passive: true });
      const unsubscribeVisualChanges = options.subscribeVisualChanges?.(renderKick);

      session.addCleanup(() => {
        container.removeEventListener('pointermove', kickOnPointer);
        container.removeEventListener('pointerdown', kickOnPointer);
        container.removeEventListener('wheel', kickOnWheel);
        unsubscribeVisualChanges?.();
        invalidationLoop.stop();
        try {
          renderer.mode = OBC.RendererMode.AUTO;
        } catch {
          // The renderer may already be partially disposed.
        }
      });
    } catch {
      // Manual rendering is best-effort; an incompatible engine stays in AUTO.
    }
  }

  const rendererCanvas = world.renderer.three.domElement;
  const onContextLost = () => options.onContextLost?.();
  const onContextRestored = () => {
    renderKick(600);
    options.onContextRestored?.();
  };
  rendererCanvas.addEventListener('webglcontextlost', onContextLost);
  rendererCanvas.addEventListener('webglcontextrestored', onContextRestored);
  session.addCleanup(() => {
    rendererCanvas.removeEventListener('webglcontextlost', onContextLost);
    rendererCanvas.removeEventListener('webglcontextrestored', onContextRestored);
  });

  let postproduction: OBCF.PostproductionRenderer['postproduction'] | null = null;
  try {
    postproduction = (
      world.renderer as unknown as OBCF.PostproductionRenderer
    ).postproduction;
    postproduction.enabled = false;
    postproduction.edgesPass.mode = OBCF.EdgeDetectionPassMode.GLOBAL;
  } catch {
    postproduction = null;
  }

  try {
    const rendererWith2D = world.renderer as unknown as {
      three2D?: { render: (...args: unknown[]) => void };
    };
    if (rendererWith2D.three2D) rendererWith2D.three2D.render = () => {};
  } catch {
    // The engine's optional CSS2D internals may change shape.
  }

  world.camera = new OBC.SimpleCamera(components);
  try {
    const controls = world.camera.controls;
    controls.smoothTime = 0.12;
    controls.draggingSmoothTime = 0.05;
    controls.minDistance = 0.5;
  } catch {
    // camera-controls API varies by version.
  }
  try {
    const camera = world.camera.three;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.near = 0.05;
      camera.far = 5_000;
      camera.updateProjectionMatrix();
    }
  } catch {
    // Best-effort camera precision setup.
  }

  const targetPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  let activePixelRatioCap = targetPixelRatio;
  let deferredDrop: number | null = null;
  let lastCameraUpdate = -Infinity;
  let lastWheel = -Infinity;

  // canvas.setSize resets the drawing buffer to transparent black, and
  // ResizeObserver callbacks are delivered after the frame's rAF render but
  // before paint. Without an immediate repaint every divider-drag tick paints
  // a cleared canvas: visible flicker in AUTO mode, and a viewport that stays
  // blank for the whole drag in on-demand mode once the kick window expires.
  // renderer.update() (not raw three.render) keeps the gizmo overlay and the
  // render-stats hooks on onBeforeUpdate/onAfterUpdate consistent.
  const renderNow = () => {
    try {
      world.camera.updateAspect();
      const renderer = world.renderer as unknown as {
        needsUpdate: boolean;
        update: () => void;
      };
      renderer.needsUpdate = true;
      renderer.update();
    } catch {
      // The renderer can be incomplete while the component is unmounting.
    }
  };
  // The engine's own ResizeObserver calls three.setSize on every container
  // resize and fires onResize immediately after, still before paint.
  world.renderer.onResize.add(renderNow);
  session.addCleanup(() => {
    try {
      world.renderer?.onResize.remove(renderNow);
    } catch {
      // Renderer already disposed.
    }
  });

  const applyPixelRatio = () => {
    try {
      const renderer = world.renderer!.three;
      const next = Math.min(window.devicePixelRatio || 1, activePixelRatioCap);
      const width = Math.floor(container.clientWidth * next);
      const height = Math.floor(container.clientHeight * next);
      const canvas = renderer.domElement;
      if (
        renderer.getPixelRatio() === next
        && canvas.width === width
        && canvas.height === height
      ) {
        return;
      }
      if (renderer.getPixelRatio() !== next) renderer.setPixelRatio(next);
      renderer.setSize(container.clientWidth, container.clientHeight, true);
      // Direct three.setSize does not raise the engine onResize event, so the
      // synchronous repaint must happen here too.
      renderNow();
      renderKick(250);
    } catch {
      // The renderer can be incomplete while the component is unmounting.
    }
  };
  const setCap = (cap: number) => {
    activePixelRatioCap = Math.min(HARD_PIXEL_RATIO_CAP, Math.max(1, cap));
    applyPixelRatio();
  };
  const cancelDeferredDrop = () => {
    if (deferredDrop === null) return;
    window.clearTimeout(deferredDrop);
    deferredDrop = null;
  };
  const isWheelGesture = () => performance.now() - lastWheel < WHEEL_GESTURE_WINDOW_MS;

  const trackWheel = () => {
    lastWheel = performance.now();
  };
  rendererCanvas.addEventListener('wheel', trackWheel, { passive: true });
  session.addCleanup(() => {
    rendererCanvas.removeEventListener('wheel', trackWheel);
    cancelDeferredDrop();
  });

  const pixelRatio: InteractionPixelRatioController = {
    get activeCap() {
      return activePixelRatioCap;
    },
    setCap,
    restoreCap: () => setCap(options.getRestoredPixelRatioCap()),
    noteCameraUpdate: () => {
      lastCameraUpdate = performance.now();
    },
    cancelDeferredDrop,
    applyQualityCap: (cap, qualityOptions) => {
      cancelDeferredDrop();
      const droppingForNavigation =
        qualityOptions.navigating && cap < activePixelRatioCap;
      if (!droppingForNavigation) {
        setCap(cap);
        return;
      }
      if (isWheelGesture()) return;
      deferredDrop = window.setTimeout(() => {
        deferredDrop = null;
        if (signal.aborted || !qualityOptions.isCameraNavigating() || isWheelGesture()) {
          return;
        }
        if (performance.now() - lastCameraUpdate > DPR_DROP_RECENT_MOTION_MS) return;
        setCap(cap);
      }, DPR_DROP_DELAY_MS);
    },
  };

  applyPixelRatio();
  const pixelRatioObserver = new ResizeObserver(applyPixelRatio);
  pixelRatioObserver.observe(container);
  session.addCleanup(() => pixelRatioObserver.disconnect());

  try {
    const renderer = world.renderer.three;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
  } catch {
    // Best-effort explicit color management.
  }

  components.init();
  world.scene.setup({
    backgroundColor: new THREE.Color(0x0a0a1a),
  });
  try {
    const scene = world.scene.three as THREE.Scene;
    for (const child of scene.children) {
      if (child instanceof THREE.AmbientLight) child.intensity = 0.4;
      else if (child instanceof THREE.DirectionalLight) child.intensity = 2;
    }
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x6b7280, 0.75);
    hemisphere.name = 'hemi-fill';
    scene.add(hemisphere);
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    ambient.name = 'ambient-fill';
    scene.add(ambient);
    const counterKey = new THREE.DirectionalLight(0xffffff, 0.6);
    counterKey.position.set(-30, 40, -30);
    counterKey.name = 'counter-key';
    scene.add(counterKey);
  } catch {
    // Lighting fallback is not critical to engine startup.
  }
  world.camera.controls.setLookAt(15, 15, 15, 0, 0, 0);
  const grid = components.get(OBC.Grids).create(world);
  const fragments = await createFragmentRuntime(session, {
    renderKick,
    ...options.fragments,
  });

  return {
    world,
    grid,
    renderKick,
    pixelRatio,
    navigationPixelRatioCap: NAVIGATION_PIXEL_RATIO_CAP,
    cameraSettleDelayMs: CAMERA_SETTLE_DELAY_MS,
    cullerShowPassMinIntervalMs: CULLER_SHOW_PASS_MIN_INTERVAL_MS,
    postproduction,
    fragments,
  };
}
