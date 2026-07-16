import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

export interface RenderStateSnapshot {
  generation: number;
  appliedGeneration: number;
  renderedGeneration: number;
  inFlight: boolean;
  scheduled: boolean;
  visibilityLayers: Record<string, number>;
  opacityLayers: Record<string, { count: number; opacity: number }>;
  highlightLayers: Record<string, { count: number; priority: number }>;
  effectiveHiddenCount: number;
  effectiveOpacityCount: number;
  effectiveHighlightCount: number;
  lastReason: string | null;
  lastError: unknown | null;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number | null;
  jsHeapMB: number | null;
}

export interface OrbitStats extends RenderStats {
  frames: number;
  durationMs: number;
  fps: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  framesOver33Ms: number;
}

export interface FrameProbeSummary {
  frames: number;
  durationMs: number;
  p50Ms: number;
  p95Ms: number;
  worstMs: number;
  framesOver33Ms: number;
  zeroGeometryFrames: number;
  contextLostFrames: number;
  minDrawCalls: number | null;
  minTriangles: number | null;
}

interface ReadyEventRecord {
  atMs: number;
  fingerprint: string | null;
}

interface WorkerProtocolEvent {
  atMs: number;
  workerId: number;
  workerUrl: string;
  direction: 'create' | 'to-worker' | 'from-worker' | 'error' | 'message-error';
  type: string | null;
  id: string | null;
  stage: string | null;
  pct: number | null;
  profile: string | null;
  byteLength: number | null;
  detail: string | null;
}

interface LoadProgressEvent {
  atMs: number;
  percent: number | null;
  title: string | null;
  detail: string | null;
  tech: string | null;
}

interface LongTaskRecord {
  atMs: number;
  durationMs: number;
}

interface BrowserProbe {
  uploadStartedAtMs: number | null;
  readyEvents: ReadyEventRecord[];
  webglContextLosses: number;
  unhandledRejections: string[];
  workerEvents: WorkerProtocolEvent[];
  loadProgressEvents: LoadProgressEvent[];
  longTasks: LongTaskRecord[];
  frameProbe?: {
    done: boolean;
    stopRequested: boolean;
    summary: FrameProbeSummary | null;
  };
}

export interface ViewerStoreState {
  modelLoaded: boolean;
  modelFingerprint: string | null;
  project: { name?: string; schema_version?: string } | null;
  stats: { total_elements: number; storeys: unknown[] } | null;
  spatialTree: unknown | null;
  selectedElementId: number | null;
  selectedIds: number[];
  highlightedIds: number[];
  hiddenIds: number[];
  isolatedIds: number[];
  ghostModeOn: boolean;
  graphicsProfile: string;
  perfMetrics: {
    fps: number;
    memoryMb: number | null;
    ttfrMs: number | null;
    ttfgMs: number | null;
    loadMs: number | null;
    drawCalls: number;
    triangles: number;
    clickToHighlightMs: number | null;
    clickToHighlightMedianMs: number | null;
    clickToHighlightP95Ms: number | null;
    clickToHighlightMaxMs: number | null;
  };
}

interface ViewerDebugWindow extends Window {
  __ifcE2EProbe?: BrowserProbe;
  __ifcRenderState?: () => RenderStateSnapshot;
  __ifcRenderStats?: () => RenderStats;
  __ifcOrbitBench?: (seconds?: number, degrees?: number) => Promise<OrbitStats>;
  __ifcPickAt?: (
    x: number,
    y: number,
  ) => Promise<{ expressId: number; localId: number } | null>;
  __ifcStore?: { getState: () => ViewerStoreState };
  __ifcViewer?: {
    world?: {
      renderer?: {
        three?: {
          getContext?: () => WebGLRenderingContext | WebGL2RenderingContext;
        };
      };
    };
  };
  __ifcWasmVariant?: string;
}

export interface ViewerDiagnostics {
  capturedAt: string;
  load: {
    modelLoaded: boolean | null;
    overlayVisible: boolean;
    percent: number | null;
    title: string | null;
    detail: string | null;
    tech: string | null;
    timeline: LoadProgressEvent[];
  };
  hardware: {
    userAgent: string;
    platform: string;
    hardwareConcurrency: number;
    deviceMemoryGB: number | null;
    screen: { width: number; height: number; devicePixelRatio: number };
    crossOriginIsolated: boolean;
    wasmVariant: string | null;
    webgl: {
      version: string | null;
      vendor: string | null;
      renderer: string | null;
      unmaskedVendor: string | null;
      unmaskedRenderer: string | null;
      contextLost: boolean | null;
      antialias: boolean | null;
    };
    jsHeapLimitMB: number | null;
  };
  model: {
    name: string | null;
    schemaVersion: string | null;
    fingerprint: string | null;
    elementCount: number | null;
    storeyCount: number | null;
    graphicsProfile: string | null;
  };
  selection: {
    primary: number | null;
    selectedIds: number[];
    highlightedIds: number[];
  };
  visibility: {
    hiddenIds: number[];
    isolatedIds: number[];
    ghostModeOn: boolean;
  };
  perfMetrics: ViewerStoreState['perfMetrics'] | null;
  renderStats: RenderStats | null;
  renderState: RenderStateSnapshot | null;
  ready: {
    uploadStartedAtMs: number | null;
    uploadToReadyMs: number | null;
    events: ReadyEventRecord[];
  };
  browserErrors: {
    webglContextLosses: number;
    unhandledRejections: string[];
  };
  workerProtocol: WorkerProtocolEvent[];
  performance: {
    longTasks: LongTaskRecord[];
    resources: Array<{
      name: string;
      initiatorType: string;
      startTimeMs: number;
      durationMs: number;
      transferSize: number;
      encodedBodySize: number;
      decodedBodySize: number;
    }>;
  };
}

export async function installBrowserProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Click/culling metrics are intentionally gated when no performance UI is
    // observing them. The renderer regression is itself a performance
    // observer, so opt in before the Zustand store reads persisted prefs.
    // Browser contexts are isolated per test run; this never changes a real
    // user's preference.
    try {
      localStorage.setItem('pref.perfHudVisible', 'true');
    } catch {
      // Storage may be unavailable on an initial opaque document. The app
      // remains testable; the metric assertion will explain a missing opt-in.
    }
    const win = window as ViewerDebugWindow;
    const probe: BrowserProbe = {
      uploadStartedAtMs: null,
      readyEvents: [],
      webglContextLosses: 0,
      unhandledRejections: [],
      workerEvents: [],
      loadProgressEvents: [],
      longTasks: [],
    };
    win.__ifcE2EProbe = probe;

    const messageSummary = (value: unknown) => {
      if (!value || typeof value !== 'object') {
        return {
          type: null,
          id: null,
          stage: null,
          pct: null,
          profile: null,
          byteLength: null,
        };
      }
      const data = value as Record<string, unknown>;
      const bytes = data.bytes;
      const buffer = data.buffer;
      const byteLength = bytes instanceof ArrayBuffer
        ? bytes.byteLength
        : ArrayBuffer.isView(bytes)
          ? bytes.byteLength
          : buffer instanceof ArrayBuffer
            ? buffer.byteLength
            : null;
      return {
        type: typeof data.type === 'string' ? data.type : null,
        id: typeof data.id === 'string' ? data.id : null,
        stage: typeof data.stage === 'string' ? data.stage : null,
        pct: typeof data.pct === 'number' ? data.pct : null,
        profile: typeof data.profile === 'string' ? data.profile : null,
        byteLength,
      };
    };
    const relevantWorkerMessage = (summary: ReturnType<typeof messageSummary>) => (
      summary.type === 'convert'
      || summary.type === 'progress'
      || summary.type === 'done'
      || summary.type === 'error'
    );
    const NativeWorker = window.Worker;
    let nextWorkerId = 0;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args) {
        const worker = Reflect.construct(Target, args) as Worker;
        const workerId = nextWorkerId++;
        const workerUrl = String(args[0] ?? 'unknown');
        const record = (
          direction: WorkerProtocolEvent['direction'],
          value?: unknown,
          detail: string | null = null,
        ) => {
          if (probe.workerEvents.length >= 1_000) return;
          const summary = messageSummary(value);
          if (
            direction !== 'create'
            && direction !== 'error'
            && direction !== 'message-error'
            && !relevantWorkerMessage(summary)
          ) return;
          probe.workerEvents.push({
            atMs: performance.now(),
            workerId,
            workerUrl,
            direction,
            ...summary,
            detail,
          });
        };
        record('create');
        const nativePostMessage = worker.postMessage.bind(worker);
        worker.postMessage = ((message: unknown, transferOrOptions?: unknown) => {
          record('to-worker', message);
          if (transferOrOptions === undefined) nativePostMessage(message);
          else nativePostMessage(message, transferOrOptions as StructuredSerializeOptions);
        }) as Worker['postMessage'];
        worker.addEventListener('message', (event) => record('from-worker', event.data));
        worker.addEventListener('error', (event) => record('error', undefined, event.message));
        worker.addEventListener('messageerror', () => record('message-error'));
        return worker;
      },
    });

    const recordLoadProgress = () => {
      const progress = document.querySelector<HTMLElement>(
        '[role="progressbar"][aria-label="Model loading progress"]',
      );
      const rawPercent = progress?.getAttribute('aria-valuenow') ?? null;
      const parsedPercent = rawPercent == null ? null : Number(rawPercent);
      const event: LoadProgressEvent = {
        atMs: performance.now(),
        percent: parsedPercent != null && Number.isFinite(parsedPercent) ? parsedPercent : null,
        title: document.querySelector<HTMLElement>('.viewer-load-title')?.innerText ?? null,
        detail: document.querySelector<HTMLElement>('.viewer-load-detail')?.innerText ?? null,
        tech: document.querySelector<HTMLElement>('.viewer-load-tech')?.innerText ?? null,
      };
      const previous = probe.loadProgressEvents.at(-1);
      if (
        previous?.percent === event.percent
        && previous.title === event.title
        && previous.detail === event.detail
        && previous.tech === event.tech
      ) return;
      if (probe.loadProgressEvents.length < 1_000) probe.loadProgressEvents.push(event);
    };
    const startProgressObserver = () => {
      recordLoadProgress();
      new MutationObserver(recordLoadProgress).observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-valuenow'],
      });
    };
    if (document.documentElement) startProgressObserver();
    else window.addEventListener('DOMContentLoaded', startProgressObserver, { once: true });

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (probe.longTasks.length >= 500) break;
          probe.longTasks.push({
            atMs: entry.startTime,
            durationMs: Math.round(entry.duration * 10) / 10,
          });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Tasks API is unavailable in some headless/browser builds.
    }
    window.addEventListener('ifc-viewer-ready', (event) => {
      const detail = (event as CustomEvent<{ fingerprint?: string | null }>).detail;
      probe.readyEvents.push({
        atMs: performance.now(),
        fingerprint: detail?.fingerprint ?? null,
      });
    });
    window.addEventListener('webglcontextlost', () => {
      probe.webglContextLosses += 1;
    }, true);
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      probe.unhandledRejections.push(
        reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      );
    });
  });
}

export async function loadIfcFixture(
  page: Page,
  fixturePath: string,
  timeoutMs: number,
  options: { requireMetadata?: boolean } = {},
): Promise<Locator> {
  await page.goto('/');
  const input = page.locator('.upload-overlay input[type="file"][accept=".ifc"]');
  await expect(input).toHaveCount(1);
  await page.evaluate(() => {
    const probe = (window as ViewerDebugWindow).__ifcE2EProbe;
    if (probe) probe.uploadStartedAtMs = performance.now();
  });
  await input.setInputFiles(fixturePath);

  try {
    await page.waitForFunction(() => {
      const probe = (window as ViewerDebugWindow).__ifcE2EProbe;
      return (probe?.readyEvents.length ?? 0) > 0;
    }, undefined, { timeout: timeoutMs });
  } catch (error) {
    const loadState = await page.evaluate(() => {
      const progress = document.querySelector<HTMLElement>(
        '[role="progressbar"][aria-label="Model loading progress"]',
      );
      return {
        percent: progress?.getAttribute('aria-valuenow') ?? 'unknown',
        title: document.querySelector<HTMLElement>('.viewer-load-title')?.innerText ?? 'unknown',
        detail: document.querySelector<HTMLElement>('.viewer-load-detail')?.innerText ?? 'unknown',
        tech: document.querySelector<HTMLElement>('.viewer-load-tech')?.innerText ?? 'unknown',
      };
    });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Viewer did not emit a painted-ready event within ${timeoutMs} ms `
      + `(progress ${loadState.percent}%, ${loadState.title}; ${loadState.detail}; ${loadState.tech}). `
      + message,
    );
  }

  await expect(page.getByRole('progressbar', { name: 'Model loading progress' }))
    .toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('.stats-bar')).toContainText('Ready');
  await expect(page.getByText('3D loading error', { exact: true })).toHaveCount(0);

  await page.waitForFunction((requireMetadata) => {
    const win = window as ViewerDebugWindow;
    const state = win.__ifcStore?.getState();
    const render = win.__ifcRenderStats?.();
    return Boolean(
      state?.modelLoaded
      && (
        !requireMetadata
        || (
          state.spatialTree
          && state.stats
          && state.stats.total_elements > 0
        )
      )
      && render
      && render.drawCalls > 0
      && render.triangles > 0,
    );
  }, options.requireMetadata !== false, { timeout: 20_000 });

  const canvas = page.locator('.viewer-area canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((node) => {
    const element = node as HTMLCanvasElement;
    return element.width > 0 && element.height > 0;
  })).toBe(true);
  const size = await canvas.evaluate((node) => {
    const element = node as HTMLCanvasElement;
    return {
      width: element.width,
      height: element.height,
      cssWidth: element.getBoundingClientRect().width,
      cssHeight: element.getBoundingClientRect().height,
    };
  });
  expect(size.width).toBeGreaterThan(100);
  expect(size.height).toBeGreaterThan(100);
  expect(size.cssWidth).toBeGreaterThan(100);
  expect(size.cssHeight).toBeGreaterThan(100);

  await waitForRenderStateIdle(page);
  return canvas;
}

export async function waitForRenderStateIdle(
  page: Page,
  timeoutMs = 15_000,
  options: { baselineGeneration?: number } = {},
): Promise<void> {
  // The visibility scheduler is rAF-deferred and awaits a worker translation
  // before it bumps the coordinator generation, so "idle" can be observed on
  // the PREVIOUS generation right after a store mutation. When the caller
  // knows the mutation must schedule a coordinator update, it passes the
  // generation captured BEFORE the mutation and idle additionally requires
  // the coordinator to have moved past it.
  const baselineGeneration = options.baselineGeneration ?? null;
  await page.waitForFunction((baseline) => {
    const snapshot = (window as ViewerDebugWindow).__ifcRenderState?.();
    return Boolean(
      snapshot
      && (baseline == null || snapshot.generation > baseline)
      && !snapshot.inFlight
      && !snapshot.scheduled
      && snapshot.lastError == null
      && snapshot.appliedGeneration === snapshot.generation
      && snapshot.renderedGeneration === snapshot.generation,
    );
  }, baselineGeneration, { timeout: timeoutMs });
}

export async function readViewerState(page: Page): Promise<ViewerStoreState> {
  return page.evaluate(() => {
    const state = (window as ViewerDebugWindow).__ifcStore?.getState();
    if (!state) throw new Error('__ifcStore is unavailable; run the Vite development build');
    return {
      modelLoaded: state.modelLoaded,
      modelFingerprint: state.modelFingerprint,
      project: state.project,
      stats: state.stats,
      spatialTree: state.spatialTree,
      selectedElementId: state.selectedElementId,
      selectedIds: [...state.selectedIds],
      highlightedIds: [...state.highlightedIds],
      hiddenIds: [...state.hiddenIds],
      isolatedIds: [...state.isolatedIds],
      ghostModeOn: state.ghostModeOn,
      graphicsProfile: state.graphicsProfile,
      perfMetrics: { ...state.perfMetrics },
    };
  });
}

export async function readRenderState(page: Page): Promise<RenderStateSnapshot> {
  return page.evaluate(() => {
    const snapshot = (window as ViewerDebugWindow).__ifcRenderState?.();
    if (!snapshot) throw new Error('__ifcRenderState is unavailable');
    return snapshot;
  });
}

export async function readRenderStats(page: Page): Promise<RenderStats> {
  return page.evaluate(() => {
    const snapshot = (window as ViewerDebugWindow).__ifcRenderStats?.();
    if (!snapshot) throw new Error('__ifcRenderStats is unavailable');
    return snapshot;
  });
}

export async function runOrbitBench(
  page: Page,
  seconds = 2,
  degrees = 180,
): Promise<OrbitStats> {
  return page.evaluate(async ({ seconds: runSeconds, degrees: runDegrees }) => {
    const bench = (window as ViewerDebugWindow).__ifcOrbitBench;
    if (!bench) throw new Error('__ifcOrbitBench is unavailable; run the Vite development build');
    return bench(runSeconds, runDegrees);
  }, { seconds, degrees });
}

export async function findGeometryHit(page: Page, canvas: Locator): Promise<{
  x: number;
  y: number;
  expressId: number;
}> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Viewer canvas has no bounding box');
  const ratios: Array<[number, number]> = [
    [0.50, 0.50], [0.42, 0.50], [0.58, 0.50],
    [0.50, 0.42], [0.50, 0.58], [0.35, 0.45],
    [0.65, 0.45], [0.35, 0.60], [0.65, 0.60],
    [0.25, 0.40], [0.75, 0.40], [0.25, 0.65],
    [0.75, 0.65], [0.50, 0.30], [0.50, 0.70],
  ];
  for (const [rx, ry] of ratios) {
    const x = box.x + box.width * rx;
    const y = box.y + box.height * ry;
    const hit = await page.evaluate(async ({ clientX, clientY }) => {
      const pickAt = (window as ViewerDebugWindow).__ifcPickAt;
      if (!pickAt) throw new Error('__ifcPickAt is unavailable');
      return pickAt(clientX, clientY);
    }, { clientX: x, clientY: y });
    if (hit) return { x, y, expressId: hit.expressId };
  }
  throw new Error('No selectable BasicHouse geometry found in the bounded canvas scan');
}

export async function startFrameProbe(page: Page, safetyCapMs = 60_000): Promise<void> {
  await page.evaluate((capMs) => {
    const win = window as ViewerDebugWindow;
    const probe = win.__ifcE2EProbe;
    if (!probe) throw new Error('Browser probe is not installed');
    // The probe samples until finishFrameProbe() requests an explicit stop.
    // The duration is only a generous safety cap so an abandoned probe cannot
    // leak a rAF loop forever; it must never race the sequence it polices.
    const state: NonNullable<BrowserProbe['frameProbe']> = {
      done: false,
      stopRequested: false,
      summary: null,
    };
    probe.frameProbe = state;
    const samples: Array<{
      delta: number;
      drawCalls: number;
      triangles: number;
      contextLost: boolean;
    }> = [];
    const startedAt = performance.now();
    let previous = startedAt;

    const finish = (now: number) => {
      const validDeltas = samples.map((sample) => sample.delta).filter((delta) => delta > 0);
      const sorted = [...validDeltas].sort((a, b) => a - b);
      const percentile = (p: number) => {
        if (sorted.length === 0) return 0;
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
        return Math.round(sorted[index] * 10) / 10;
      };
      const drawCalls = samples.map((sample) => sample.drawCalls).filter(Number.isFinite);
      const triangles = samples.map((sample) => sample.triangles).filter(Number.isFinite);
      state.summary = {
        frames: samples.length,
        durationMs: Math.round(now - startedAt),
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        worstMs: percentile(1),
        framesOver33Ms: validDeltas.filter((delta) => delta > 33.4).length,
        zeroGeometryFrames: samples.filter((sample) => sample.triangles <= 0).length,
        contextLostFrames: samples.filter((sample) => sample.contextLost).length,
        minDrawCalls: drawCalls.length > 0 ? Math.min(...drawCalls) : null,
        minTriangles: triangles.length > 0 ? Math.min(...triangles) : null,
      };
      state.done = true;
    };

    const step = (now: number) => {
      const stats = win.__ifcRenderStats?.();
      const gl = win.__ifcViewer?.world?.renderer?.three?.getContext?.();
      if (stats) {
        samples.push({
          delta: now - previous,
          drawCalls: stats.drawCalls,
          triangles: stats.triangles,
          contextLost: gl?.isContextLost() ?? false,
        });
      }
      previous = now;
      if (state.stopRequested || now - startedAt >= capMs) finish(now);
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, safetyCapMs);
}

export async function finishFrameProbe(page: Page, timeoutMs = 10_000): Promise<FrameProbeSummary> {
  await page.evaluate(() => {
    const frameProbe = (window as ViewerDebugWindow).__ifcE2EProbe?.frameProbe;
    if (!frameProbe) throw new Error('Frame probe was never started');
    frameProbe.stopRequested = true;
  });
  await page.waitForFunction(() => {
    return (window as ViewerDebugWindow).__ifcE2EProbe?.frameProbe?.done === true;
  }, undefined, { timeout: timeoutMs });
  const result = await page.evaluate(() => {
    return (window as ViewerDebugWindow).__ifcE2EProbe?.frameProbe?.summary ?? null;
  });
  if (!result) throw new Error('Frame probe finished without a summary');
  return result;
}

export async function captureDiagnostics(page: Page): Promise<ViewerDiagnostics> {
  return page.evaluate(() => {
    const win = window as ViewerDebugWindow;
    const state = win.__ifcStore?.getState();
    const probe = win.__ifcE2EProbe;
    const canvas = document.querySelector<HTMLCanvasElement>('.viewer-area canvas');
    const gl = win.__ifcViewer?.world?.renderer?.three?.getContext?.()
      ?? canvas?.getContext('webgl2')
      ?? canvas?.getContext('webgl')
      ?? null;
    const debugInfo = gl?.getExtension('WEBGL_debug_renderer_info') as {
      UNMASKED_VENDOR_WEBGL: number;
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const memory = performance as Performance & {
      memory?: { jsHeapSizeLimit?: number };
    };
    const nav = navigator as Navigator & { deviceMemory?: number };
    const attrs = gl?.getContextAttributes() ?? null;
    const uploadToReadyMs = probe?.uploadStartedAtMs != null && probe.readyEvents.length > 0
      ? Math.round(probe.readyEvents[0].atMs - probe.uploadStartedAtMs)
      : null;

    return {
      capturedAt: new Date().toISOString(),
      load: {
        modelLoaded: state?.modelLoaded ?? null,
        overlayVisible: document.querySelector('.viewer-load-overlay') != null,
        percent: (() => {
          const value = document.querySelector<HTMLElement>(
            '[role="progressbar"][aria-label="Model loading progress"]',
          )?.getAttribute('aria-valuenow');
          if (value == null) return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        })(),
        title: document.querySelector<HTMLElement>('.viewer-load-title')?.innerText ?? null,
        detail: document.querySelector<HTMLElement>('.viewer-load-detail')?.innerText ?? null,
        tech: document.querySelector<HTMLElement>('.viewer-load-tech')?.innerText ?? null,
        timeline: probe?.loadProgressEvents ?? [],
      },
      hardware: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGB: nav.deviceMemory ?? null,
        screen: {
          width: screen.width,
          height: screen.height,
          devicePixelRatio: devicePixelRatio,
        },
        crossOriginIsolated: self.crossOriginIsolated === true,
        wasmVariant: win.__ifcWasmVariant ?? null,
        webgl: {
          version: gl ? String(gl.getParameter(gl.VERSION)) : null,
          vendor: gl ? String(gl.getParameter(gl.VENDOR)) : null,
          renderer: gl ? String(gl.getParameter(gl.RENDERER)) : null,
          unmaskedVendor: gl && debugInfo
            ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
            : null,
          unmaskedRenderer: gl && debugInfo
            ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
            : null,
          contextLost: gl?.isContextLost() ?? null,
          antialias: attrs?.antialias ?? null,
        },
        jsHeapLimitMB: memory.memory?.jsHeapSizeLimit
          ? Math.round(memory.memory.jsHeapSizeLimit / 1048576)
          : null,
      },
      model: {
        name: state?.project?.name ?? null,
        schemaVersion: state?.project?.schema_version ?? null,
        fingerprint: state?.modelFingerprint ?? null,
        elementCount: state?.stats?.total_elements ?? null,
        storeyCount: state?.stats?.storeys.length ?? null,
        graphicsProfile: state?.graphicsProfile ?? null,
      },
      selection: {
        primary: state?.selectedElementId ?? null,
        selectedIds: state?.selectedIds ?? [],
        highlightedIds: state?.highlightedIds ?? [],
      },
      visibility: {
        hiddenIds: state?.hiddenIds ?? [],
        isolatedIds: state?.isolatedIds ?? [],
        ghostModeOn: state?.ghostModeOn ?? false,
      },
      perfMetrics: state?.perfMetrics ?? null,
      renderStats: win.__ifcRenderStats?.() ?? null,
      renderState: win.__ifcRenderState?.() ?? null,
      ready: {
        uploadStartedAtMs: probe?.uploadStartedAtMs ?? null,
        uploadToReadyMs,
        events: probe?.readyEvents ?? [],
      },
      browserErrors: {
        webglContextLosses: probe?.webglContextLosses ?? 0,
        unhandledRejections: probe?.unhandledRejections ?? [],
      },
      workerProtocol: probe?.workerEvents ?? [],
      performance: {
        longTasks: probe?.longTasks ?? [],
        resources: performance.getEntriesByType('resource')
          .filter((entry) => /(?:worker|ifc|wasm|frag)/i.test(entry.name))
          .map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            return {
              name: resource.name,
              initiatorType: resource.initiatorType,
              startTimeMs: Math.round(resource.startTime * 10) / 10,
              durationMs: Math.round(resource.duration * 10) / 10,
              transferSize: resource.transferSize,
              encodedBodySize: resource.encodedBodySize,
              decodedBodySize: resource.decodedBodySize,
            };
          }),
      },
    } satisfies ViewerDiagnostics;
  });
}

export async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const artifactPath = testInfo.outputPath(`${name}.json`);
  await writeFile(artifactPath, body, 'utf8');
  await testInfo.attach(name, {
    path: artifactPath,
    contentType: 'application/json',
  });
}
