import * as OBC from '@thatopen/components';
import * as FRAGS from '@thatopen/fragments';

import { useStore } from '../../store/useStore';
import type {
  ClassificationGroup,
  ElementDetail,
  ModelStats,
  ProjectInfo,
  SearchResult,
  SpatialNode,
} from '../../types/ifc';
import { apiUrl } from '../../lib/platform';
import { BROWSER_ONLY } from '../../config/featureFlags';
import {
  BackendMetadataIndex,
  fetchBackendMetadataIndex,
} from './backendMetadataIndex';
import { composeIdBridge } from './composeIdBridge';
import { registerElementDetailInvalidator } from './elementDetailInvalidation';
import { getClientIfcFlag } from './featureFlags';
import { MetadataWorkerClient } from './metadataWorker';
import { resolveHitProductId } from './resolveHitProductId';
import { SearchIndex } from './searchIndex';

// Singleton facade over the loaded FragmentsModel. Panels and LLM tools
// read from here instead of hitting the Python backend.
//
// It registers the model and exposes a lazy expressID <-> localID mapping,
// plus project info, stats, and storeys computed client-side (Classifier-free
// variants using FragmentsModel's native getCategories / getItemsOfCategories
// / getItemsData APIs).

export interface RegisterArgs {
  model: FRAGS.FragmentsModel;
  fileBytes: Uint8Array;
  components: OBC.Components;
}

// IFC categories that are structural containers, not "elements" in the
// sense most BIM viewers count. Excluded from total / by-type counts.
const SPATIAL_CATEGORIES = new Set([
  'IFCPROJECT',
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCSPACE',
]);

// Openings are not visible elements and confuse users if included in
// the stats, so the backend's element counts exclude them too.
const OPENING_PREFIXES = ['IFCOPENING'];

class ModelServiceImpl {
  fragmentsModel: FRAGS.FragmentsModel | null = null;
  rawBytes: Uint8Array | null = null;
  components: OBC.Components | null = null;
  classifier: OBC.Classifier | null = null;

  // Resolves when register() completes so consumers (e.g. useIfcUpload)
  // can wait for the service to be usable.
  private _readyResolve: (() => void) | null = null;
  readyPromise: Promise<void> = new Promise((res) => { this._readyResolve = res; });

  // Cached express->local lookups. Populated lazily on demand.
  private readonly expressToLocalCache = new Map<number, number>();

  // Cached data derived from the FragmentsModel. Computed once per
  // register() and reused by every consumer. Populated on demand.
  private _storeyCache: { id: number; globalId: string; name: string }[] | null = null;
  private _statsCache: ModelStats | null = null;
  private _projectCache: ProjectInfo | null = null;
  private _treeCache: SpatialNode | null = null;

  // Background web-ifc pass for psets + materials + quantities.
  // Runs in a Worker so the React thread stays responsive; initialized
  // lazily on the first getElement() call to avoid paying the cost on
  // upload for models the user never inspects.
  private readonly metadataWorker = new MetadataWorkerClient();
  private metadataWorkerInit: Promise<void> | null = null;
  private readonly elementDetailCache = new Map<number, ElementDetail>();
  // In-flight dedupe for getElement: the viewer prefetches on
  // pointer-down/up and the PropertiesPanel fetches on selection commit -
  // all callers join one resolution instead of issuing duplicate I/O.
  private readonly elementDetailInFlight = new Map<number, Promise<ElementDetail | null>>();
  // Ids invalidated by an edit: pristine local sources (server-built index /
  // metadata worker) are stale for these, so getElement must wait for the
  // authoritative backend instead of racing locals.
  private readonly authoritativeOnlyIds = new Set<number>();

  // Inverted index over Name / IFC type / GlobalId.
  private readonly searchIndex = new SearchIndex();

  // Classification cache (populated lazily on first getClassifications call).
  private _classificationCache: ClassificationGroup[] | null = null;

  // Selection ID normalization (viewer <-> tree sync)
  //
  // Built off the critical path by hydrateOwnerMap() once the metadata
  // worker finishes init. Lets the viewer click handler synchronously
  // resolve raycast.itemId - which may point at an IfcShapeRepresentation
  // or IfcRepresentationItem - to the owning IfcProduct's Express ID,
  // BEFORE the id lands in selectedElementId. Without this, viewer clicks
  // briefly hold the wrong-tier id and the panel / tree row / context
  // menu all read the wrong product (or worse, a representation that
  // doesn't exist as a tree node at all).
  private ownerByExpressId = new Map<number, number>();
  private _ownerMapReady = false;
  private readonly recentRaycastLocalByItemId = new Map<number, number>();
  private readonly recentLocalByProductId = new Map<number, number>();

  // Composed at hydrate time from worker and fragment id tables.
  private expressIdByLocalId = new Map<number, number>();
  private _idBridgeReady = false;

  // Backend metadata mode uses the server-built index instead of the browser worker.
  private backendIndex: BackendMetadataIndex | null = null;
  private backendIndexInit: Promise<void> | null = null;

  private get backendMode(): boolean {
    return getClientIfcFlag('backendMetadata');
  }

  get ready(): boolean {
    return this.fragmentsModel !== null;
  }

  async register({ model, fileBytes, components }: RegisterArgs): Promise<void> {
    // Nothing starts a metadata worker for the current model before
    // register(), so the worker is always freshly disposed and restarted here.
    this.dispose();

    this.fragmentsModel = model;
    this.rawBytes = fileBytes;
    this.components = components;

    try {
      const Cls = (OBC as unknown as { Classifier?: new (c: OBC.Components) => OBC.Classifier })
        .Classifier;
      if (Cls) {
        this.classifier = components.get(Cls);
      }
    } catch (err) {
      console.warn('[ModelService] Classifier unavailable', err);
      this.classifier = null;
    }

    const startupMode = useStore.getState().startupMode;
    const eagerStartup = startupMode === 'full_upfront';
    const modelRef = model;

    // Hydrate panels from client-derived stats/tree when enabled.
    if (getClientIfcFlag('statsClient') || getClientIfcFlag('treeClient')) {
      if (eagerStartup) {
        void this.hydrateStoreFromModel();
      } else {
        queueWhenIdle(() => {
          if (this.fragmentsModel !== modelRef) return;
          void this.hydrateStoreFromModel();
        }, 1800);
      }
    }

    // Build the search index in the background from the spatial tree.
    if (eagerStartup && getClientIfcFlag('searchClient')) {
      void this.buildSearchIndex();
    }

    // Prefer the backend metadata index; start the browser worker only as fallback.
    if (this.backendMode) {
      this.backendIndexInit = this.hydrateFromBackendIndex(modelRef);
    } else if (this.metadataWorkerInit) {
      this.releaseRawBytesAfterWorkerReady(modelRef);
    } else if (this.rawBytes && !this.metadataWorker.failed) {
      if (eagerStartup) {
        this.startMetadataWorker(this.rawBytes, 'init', modelRef);
      } else {
        // The viewer conversion worker just finished parsing the same IFC.
        // Starting a second web-ifc pass (and copying the entire source buffer)
        // before first paint competes for CPU and memory at exactly the wrong
        // time. Property access still starts this worker immediately on demand;
        // otherwise wait for browser idle after the viewport is interactive.
        queueWhenIdle(() => {
          if (
            this.fragmentsModel !== modelRef
            || this.metadataWorkerInit
            || this.metadataWorker.ready
            || this.metadataWorker.failed
            || !this.rawBytes
          ) return;
          this.startMetadataWorker(this.rawBytes, 'init', modelRef);
        }, 2_500);
      }
    }

    this._readyResolve?.();
  }

  // Backend-metadata mode

  // Fetch the server-built metadata index; fall back to the browser worker if needed.
  private async hydrateFromBackendIndex(modelRef: FRAGS.FragmentsModel): Promise<void> {
    const DEADLINE_MS = 120_000;
    const FAST_WINDOW_MS = 10_000; // poll every 500 ms for the first 10 s...
    const FAST_RETRY_MS = 500;
    const SLOW_RETRY_MS = 2_000;   // ...then every 2 s for the rest
    const SLEEP_SLICE_MS = 250;    // wake granularity for the ready short-circuit
    const MAX_NETWORK_FAILURES = 3;
    const startedAt = performance.now();
    let idx: BackendMetadataIndex | null = null;
    let networkFailures = 0;
    // Re-fetch immediately when the native-index ready event changes.
    let readyFlagSeen = useStore.getState().nativeIndexReady;
    while (performance.now() - startedAt < DEADLINE_MS) {
      if (this.fragmentsModel !== modelRef) return; // model swapped under us
      // Pin the fetch to this model's SHA-256 so model switches cannot reuse a stale index.
      const storeFp = useStore.getState().modelFingerprint;
      const expectedSha =
        typeof storeFp === 'string' && /^[0-9a-f]{64}$/i.test(storeFp)
          ? storeFp
          : undefined;
      const result = await fetchBackendMetadataIndex(expectedSha);
      if (result.kind === 'ready') {
        idx = result.view;
        break;
      }
      if (result.kind === 'failed') {
        // Terminal: the backend parse errored and no index will arrive for
        // this model. Stop burning the 120 s deadline and fall back to the
        // in-browser worker right away so properties still work.
        break;
      }
      if (result.kind === 'unreachable') {
        networkFailures += 1;
        if (networkFailures >= MAX_NETWORK_FAILURES) break; // backend is down
      } else {
        networkFailures = 0;
      }
      const retryMs =
        performance.now() - startedAt < FAST_WINDOW_MS ? FAST_RETRY_MS : SLOW_RETRY_MS;
      const sleepStart = performance.now();
      while (performance.now() - sleepStart < retryMs) {
        await new Promise((res) => window.setTimeout(res, SLEEP_SLICE_MS));
        if (this.fragmentsModel !== modelRef) return;
        const readyFlag = useStore.getState().nativeIndexReady;
        if (readyFlag && readyFlag !== readyFlagSeen) break; // ready event landed mid-sleep
      }
      readyFlagSeen = useStore.getState().nativeIndexReady;
    }
    if (this.fragmentsModel !== modelRef) return;

    if (idx) {
      this.backendIndex = idx;
      this._ownerMapReady = true; // resolveOwnerSync now answers via the index
      this.rawBytes = null;       // free the ~50 MB buffer - the memory win
      // Compose the click bridge from index GUIDs and the fragment GUID table.
      await this.composeBridgeFromIndexGuids(modelRef);
      // Tree-based composition remains as a redundant fallback.
      if (!this._idBridgeReady) this.composeBridgeFromTree();
      if (import.meta.env?.DEV) {
        console.info(
          `[ModelService] backend metadata index active (${idx.elementCount} ` +
            'elements) - web-ifc worker skipped',
        );
      }
    } else {
      console.warn(
        '[ModelService] backend metadata index unavailable - falling back to ' +
          'the web-ifc worker',
      );
      this.backendIndexInit = null;
      if (this.rawBytes && !this.metadataWorker.failed) {
        this.startMetadataWorker(this.rawBytes, 'init', modelRef);
      }
    }
  }

  // Compose expressIdByLocalId from the index GUID map and fragment GUID table.
  private async composeBridgeFromIndexGuids(
    modelRef: FRAGS.FragmentsModel,
  ): Promise<void> {
    const index = this.backendIndex;
    const model = this.fragmentsModel;
    if (!index || !model || model !== modelRef) return;
    const entries = [...index.expressIdByGlobalId];
    if (entries.length === 0) return;
    let localIds: (number | null)[];
    try {
      localIds = await model.getLocalIdsByGuids(entries.map(([guid]) => guid));
    } catch (err) {
      console.warn('[ModelService] guid-to-localId bridge lookup failed', err);
      return;
    }
    if (this.fragmentsModel !== modelRef) return;
    const bridge = composeIdBridge(entries, localIds);
    if (bridge.size === 0) {
      console.warn(
        `[ModelService] id bridge empty: ${entries.length} index guids matched 0 fragment items`,
      );
      return;
    }
    this.expressIdByLocalId = bridge;
    this._idBridgeReady = true;
    if (import.meta.env?.DEV) {
      const unmatched = entries.length - bridge.size;
      console.info(
        `[ModelService] id bridge composed from index guids: ${bridge.size}/${entries.length} entries`
          + (unmatched > 0
            ? ` (${unmatched} index entities have no fragment geometry - expected)`
            : ''),
      );
    }
    this.publishBridgedTree(bridge);
  }

  // Build expressIdByLocalId from the cached spatial tree (each node carries a
  // GlobalId + its localId) composed with the index GlobalId-to-ExpressId map.
  // Fallback for fragment files whose guids table can't serve the primary
  // composition above.
  private composeBridgeFromTree(): void {
    if (!this.backendIndex || !this._treeCache) return;
    const bridge = new Map<number, number>();
    const walk = (node: SpatialNode): void => {
      if (node.global_id) {
        const eid = this.backendIndex!.expressIdByGlobalId.get(node.global_id);
        if (typeof eid === 'number') bridge.set(node.id, eid);
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(this._treeCache);
    if (bridge.size === 0) return;
    this.expressIdByLocalId = bridge;
    this._idBridgeReady = true;
    this.publishBridgedTree(bridge);
  }

  // If the spatial tree was already built (and pushed to the store) before
  // the bridge composed, patch in the expressId for every node and re-publish
  // so the sidebar comparator can match against express-id selections.
  private publishBridgedTree(bridge: Map<number, number>): void {
    if (!this._treeCache) return;
    const patched = patchTreeWithExpressIds(this._treeCache, bridge);
    // Reference equality means every bridged node already carried its
    // expressId - skip the redundant store emit (and the sidebar re-render).
    if (patched === this._treeCache) return;
    this._treeCache = patched;
    const state = useStore.getState();
    if (state.spatialTree) state.setSpatialTree(patched);
  }

  /** Returns owner-resolution telemetry for the backend-metadata experiment,
   *  or null when that mode is inactive. A high `rate` means raycast already
   *  returns product ids (no owner-map rewrite needed); a low rate means it
   *  would help. Read it from the console during a session. */
  getBackendResolveStats(): { hits: number; misses: number; rate: number } | null {
    return this.backendIndex ? this.backendIndex.resolveStats() : null;
  }

  releaseRawBytes(): void {
    if (this.metadataWorkerInit || this.metadataWorker.ready || !getClientIfcFlag('propsClient')) {
      this.rawBytes = null;
    }
  }

  get metadataInitializing(): boolean {
    return this.metadataWorker.initializing;
  }

  get metadataReady(): boolean {
    return this.metadataWorker.ready;
  }

  get metadataFailed(): boolean {
    return this.metadataWorker.failed;
  }

  private startMetadataWorker(
    bytes: Uint8Array,
    label: 'init',
    modelRef?: FRAGS.FragmentsModel,
  ): void {
    const initStart = performance.now();
    const initPromise = this.metadataWorker.init(bytes.slice(0));
    this.metadataWorkerInit = initPromise;
    void initPromise
      .then(() => {
        if (!modelRef || this.fragmentsModel === modelRef) {
          this.rawBytes = null;
        }
        useStore.getState().logActivity({
          kind: 'info',
          summary: `Property data ready in ${((performance.now() - initStart) / 1000).toFixed(1)} s (in-browser web-ifc pass: psets, materials, quantities).`,
        });
        // Fetch the forward-walk owner index off the critical path. Sub-10 ms
        // on BasicHouse, runs in parallel with first paint. The viewer click
        // handler degrades gracefully (resolveOwnerSync returns the raw id)
        // for any click that races this hydration.
        void this.hydrateOwnerMap(modelRef);
      })
      .catch((err) => {
        console.warn(`[ModelService] metadata worker ${label} failed`, err);
        if (this.metadataWorkerInit === initPromise) {
          this.metadataWorkerInit = null;
        }
        const msg = err instanceof Error ? err.message : String(err);
        useStore.getState().logActivity({
          kind: 'error',
          summary: 'Property extraction failed - element properties will be unavailable.',
          detail: `In-browser web-ifc metadata pass failed (${msg}). Large models can exceed the browser's memory; the desktop app handles these.`,
        });
      });
  }

  private async hydrateOwnerMap(modelRef?: FRAGS.FragmentsModel): Promise<void> {
    if (!this.metadataWorker.ready) return;
    try {
      const flat = await this.metadataWorker.getOwnerMap();
      if (modelRef && this.fragmentsModel !== modelRef) return;
      const next = new Map<number, number>();
      for (let i = 0; i + 1 < flat.length; i += 2) next.set(flat[i], flat[i + 1]);
      this.ownerByExpressId = next;
      this._ownerMapReady = true;
    } catch (err) {
      console.warn('[ModelService] owner map hydration failed', err);
    }
  }

  // Composes worker globalId-to-expressId entries with the fragment localId-to-guid table.
  // Result: a sync localId-to-expressId map the sidebar can read at click time.
  private async hydrateIdBridge(
    guidByLocal: Map<number, string>,
    modelRef: FRAGS.FragmentsModel,
  ): Promise<void> {
    let entries: Array<{ expressId: number; globalId: string }> = [];
    if (this.backendMode) {
      // Backend mode: GlobalId-to-ExpressId comes from the server-built index,
      // not the worker. Wait for the index to (try to) resolve first.
      if (this.backendIndexInit) {
        try { await this.backendIndexInit; } catch { return; }
      }
      if (this.fragmentsModel !== modelRef) return;
      if (!this.backendIndex) return; // index fetch failed; worker path took over
      entries = [...this.backendIndex.expressIdByGlobalId].map(
        ([globalId, expressId]) => ({ expressId, globalId }),
      );
    } else {
      if (!this.metadataWorkerInit) return;
      try { await this.metadataWorkerInit; } catch { return; }
      if (this.fragmentsModel !== modelRef) return;
      if (!this.metadataWorker.ready) return;
      try {
        entries = await this.metadataWorker.getGlobalIdMap();
      } catch (err) {
        console.warn('[ModelService] global-id map fetch failed', err);
        return;
      }
    }
    if (this.fragmentsModel !== modelRef) return;
    const expressIdByGuid = new Map<string, number>();
    for (const e of entries) expressIdByGuid.set(e.globalId, e.expressId);
    const bridge = new Map<number, number>();
    for (const [localId, guid] of guidByLocal) {
      const eid = expressIdByGuid.get(guid);
      if (typeof eid === 'number') bridge.set(localId, eid);
    }
    // Never clobber a populated bridge with an empty composition (e.g. a
    // tree pass whose rows carried no usable GUIDs).
    if (bridge.size === 0) {
      if (this.expressIdByLocalId.size === 0 && guidByLocal.size > 0) {
        console.warn(
          `[ModelService] id bridge empty: ${guidByLocal.size} tree guids matched 0 index entries`,
        );
      }
      return;
    }
    // Merge with any earlier composition (composeBridgeFromIndexGuids covers
    // all index products; this tree pass covers tree nodes) - both are
    // GUID-anchored so overlapping keys agree, and the union has the best
    // coverage.
    const treeMatched = bridge.size;
    let addedByTree = 0;
    if (import.meta.env?.DEV) {
      // Net-new contribution of the tree pass, counted before the merge
      // fills the bridge with the prior composition's entries.
      for (const localId of bridge.keys()) {
        if (!this.expressIdByLocalId.has(localId)) addedByTree += 1;
      }
    }
    for (const [localId, eid] of this.expressIdByLocalId) {
      if (!bridge.has(localId)) bridge.set(localId, eid);
    }
    this.expressIdByLocalId = bridge;
    this._idBridgeReady = true;
    if (import.meta.env?.DEV) {
      console.info(
        `[ModelService] id bridge: tree pass matched ${treeMatched}/${guidByLocal.size} `
          + `tree guids, +${addedByTree} new (${bridge.size} total)`,
      );
    }
    this.publishBridgedTree(bridge);
  }

  private releaseRawBytesAfterWorkerReady(modelRef: FRAGS.FragmentsModel): void {
    const initPromise = this.metadataWorkerInit;
    if (!initPromise) return;
    void initPromise
      .then(() => {
        if (this.fragmentsModel === modelRef) {
          this.rawBytes = null;
        }
      })
      .catch(() => {
        // Keep rawBytes so a later property request can retry worker init.
      });
  }

  dispose(): void {
    this.fragmentsModel = null;
    this.rawBytes = null;
    this.components = null;
    this.classifier = null;
    this.expressToLocalCache.clear();
    this._storeyCache = null;
    this._statsCache = null;
    this._projectCache = null;
    this._treeCache = null;
    this._classificationCache = null;
    this.elementDetailCache.clear();
    this.elementDetailInFlight.clear();
    this.authoritativeOnlyIds.clear();
    this.searchIndex.clear();
    this.ownerByExpressId.clear();
    this.recentRaycastLocalByItemId.clear();
    this.recentLocalByProductId.clear();
    this.expressIdByLocalId.clear();
    this._ownerMapReady = false;
    this._idBridgeReady = false;
    this.backendIndex = null;
    this.backendIndexInit = null;
    this.readyPromise = new Promise((res) => { this._readyResolve = res; });
    this.metadataWorker.dispose();
    this.metadataWorkerInit = null;
  }

  // Synchronous click-path resolver. Given the express id raycast returned
  // (which may be a representation/geometry-item, not an IfcProduct),
  // returns the owning IfcProduct express id. Falls back to the input id
  // when (a) the owner map hasn't hydrated yet (the first ~tens of ms
  // after model load), or (b) the input is not known to the worker - both
  // degrade gracefully to today's behavior.
  resolveOwnerSync(expressId: number): number {
    if (this.backendMode && this.backendIndex) {
      // No geometry-to-product owner map in this mode: resolve by product-set
      // membership and count hits/misses (the experiment that tells us whether
      // a real owner walk is needed). Returns the input unchanged on a miss -
      // identical graceful fallback to the worker path.
      return this.backendIndex.resolveOwner(expressId);
    }
    const owner = this.ownerByExpressId.get(expressId);
    return typeof owner === 'number' ? owner : expressId;
  }

  rememberRaycastHit(itemId: number, localId: number): void {
    this.recentRaycastLocalByItemId.set(itemId, localId);
    if (this.recentRaycastLocalByItemId.size > 256) {
      const first = this.recentRaycastLocalByItemId.keys().next().value;
      if (typeof first === 'number') this.recentRaycastLocalByItemId.delete(first);
    }
  }

  getRememberedLocalId(expressId: number): number | null {
    return this.recentLocalByProductId.get(expressId) ?? null;
  }

  resolveProductIdFromHitSync(itemId: number, localId: number): number {
    this.rememberRaycastHit(itemId, localId);
    // Dispatch the SAME id the model tree dispatches: the GlobalId-anchored
    // localId -> express bridge. raycast.itemId is a fragment-space id that, for
    // server-converted models, is NOT the IfcOpenShell express id the backend
    // expects - sending it yields a coincidental wrong entity or 404. See
    // ./resolveHitProductId for the full rationale.
    const { productId, viaBridge } = resolveHitProductId(
      this.expressIdByLocalId,
      (id) => this.resolveOwnerSync(id),
      itemId,
      localId,
    );
    if (viaBridge) {
      // Keep the express -> local highlight fast-path warm for the rebuild so the
      // amber selection paints without an extra getItem() round-trip.
      this.recentLocalByProductId.set(productId, localId);
    } else if (import.meta.env?.DEV) {
      // The only failure mode: the bridge had no entry for this localId, so we
      // fell back to the (fragment-space) itemId. If the user sees wrong/missing
      // properties on a viewer click, this log fires - compare `localId` here to
      // the tree row's badge (#localId) to confirm the bridge gap.
      console.debug('[viewer] id-bridge miss on click', { itemId, localId, productId });
    }
    return productId;
  }

  // Clear cached element details for the given express-ids and, in backend
  // mode, mark them so the next getElement fetches authoritative data from
  // IfcOpenShell instead of the (now-stale) pristine index. Called by the
  // store's invalidateElementDetails action after every edit (metadata_changed
  // / entity_delta). This also fixes a latent staleness in the worker path:
  // the store previously cleared only `selectedElement`, never this cache.
  invalidateElementDetails(expressIds: number[]): void {
    for (const id of expressIds) {
      this.elementDetailCache.delete(id);
      // Post-edit, pristine local sources (index / worker) are stale for
      // these ids - getElement must wait for the authoritative backend
      // instead of racing locals.
      this.authoritativeOnlyIds.add(id);
    }
    this.backendIndex?.invalidate(expressIds);
  }

  // Synchronous localId-to-expressId resolver used by the sidebar tree click
  // path so the dispatched selection lives in the same ID-space as viewer
  // clicks. Falls back to the input when the bridge hasn't hydrated.
  resolveExpressIdFromLocalSync(localId: number): number {
    const eid = this.expressIdByLocalId.get(localId);
    return typeof eid === 'number' ? eid : localId;
  }

  get ownerMapReady(): boolean { return this._ownerMapReady; }
  get idBridgeReady(): boolean { return this._idBridgeReady; }

  // -------- ID translation --------

  async toLocalId(expressId: number): Promise<number | null> {
    if (!this.fragmentsModel) return null;
    const cached = this.expressToLocalCache.get(expressId);
    if (typeof cached === 'number') return cached;
    try {
      const item = this.fragmentsModel.getItem(expressId);
      const localId = await item.getLocalId();
      if (typeof localId === 'number') {
        this.expressToLocalCache.set(expressId, localId);
        return localId;
      }
    } catch {
      // fall through
    }
    return null;
  }

  async toLocalIds(expressIds: number[]): Promise<number[]> {
    const out: number[] = [];
    for (const id of expressIds) {
      const local = await this.toLocalId(id);
      if (local != null) out.push(local);
    }
    return out;
  }

  // -------- stats / storeys / project --------

  async getProjectInfo(): Promise<ProjectInfo> {
    if (this._projectCache) return this._projectCache;
    const model = this.fragmentsModel;
    if (!model) return emptyProjectInfo();

    const byCat = await model.getItemsOfCategories([/^IFCPROJECT$/]);
    const projectIds = byCat['IFCPROJECT'] ?? [];
    let info: ProjectInfo = emptyProjectInfo();
    if (projectIds.length > 0) {
      const rows = await model.getItemsData(projectIds.slice(0, 1), {
        attributesDefault: true,
      });
      const row = rows[0];
      info = {
        name: readStringAttr(row, 'Name') ?? readStringAttr(row, 'LongName') ?? '',
        description: readStringAttr(row, 'Description'),
        schema_version: '',
        author: null,
        organization: null,
      };
    }

    // Try to pull schema version from the model metadata bag.
    try {
      const meta = await (model as unknown as {
        getMetadata?: () => Promise<Record<string, unknown>>;
      }).getMetadata?.();
      if (meta) {
        const schema = pickString(meta, ['schema', 'schemaVersion', 'ifcSchema', 'schema_version']);
        if (schema) info = { ...info, schema_version: schema };
      }
    } catch {
      /* ignore */
    }

    this._projectCache = info;
    return info;
  }

  async getStoreys(): Promise<{ id: number; globalId: string; name: string }[]> {
    if (this._storeyCache) return this._storeyCache;
    const model = this.fragmentsModel;
    if (!model) return [];
    const byCat = await model.getItemsOfCategories([/^IFCBUILDINGSTOREY$/]);
    const ids = byCat['IFCBUILDINGSTOREY'] ?? [];
    if (ids.length === 0) {
      this._storeyCache = [];
      return this._storeyCache;
    }
    const rows = await model.getItemsData(ids, { attributesDefault: true });
    // GUIDs come from the fragment's guids table, not item attributes -
    // see getSpatialTree. Attribute read kept as legacy fallback.
    let guids: (string | null)[] = [];
    try {
      guids = await model.getGuidsByLocalIds(ids);
    } catch {
      /* guids table unavailable - attribute fallback below */
    }
    const storeys = ids.map((localId, i) => {
      const row = rows[i];
      const name =
        readStringAttr(row, 'Name') ??
        readStringAttr(row, 'LongName') ??
        `Storey ${localId}`;
      const globalId =
        (typeof guids[i] === 'string' && guids[i] ? (guids[i] as string) : null) ??
        readStringAttr(row, '_guid') ??
        readStringAttr(row, 'GlobalId') ??
        '';
      return { id: localId, globalId, name };
    });
    this._storeyCache = storeys;
    return storeys;
  }

  async getModelStats(): Promise<ModelStats> {
    if (this._statsCache) return this._statsCache;
    const model = this.fragmentsModel;
    if (!model) return { total_elements: 0, by_type: {}, storeys: [], materials: [] };

    // Only count categories that actually produce geometry in the scene.
    // This matches what users think of as "elements" - walls, doors,
    // windows, slabs, furniture - and excludes schema plumbing like
    // IfcSiunit, IfcUnitAssignment, IfcMaterialLayer, IfcPropertySet, etc.
    let geometryCategories: string[] = [];
    try {
      const rawCats = await model.getItemsWithGeometryCategories();
      const seen = new Set<string>();
      for (const c of rawCats) {
        if (typeof c === 'string' && c.length > 0 && !seen.has(c)) {
          seen.add(c);
          geometryCategories.push(c);
        }
      }
    } catch {
      // Fallback: use every category minus spatial + openings.
      const all = await model.getCategories();
      geometryCategories = all.filter((c) => {
        const u = c.toUpperCase();
        return !SPATIAL_CATEGORIES.has(u) && !OPENING_PREFIXES.some((p) => u.startsWith(p));
      });
    }

    // Exclude spatial containers + openings even if they somehow appear.
    geometryCategories = geometryCategories.filter((c) => {
      const u = c.toUpperCase();
      return !SPATIAL_CATEGORIES.has(u) && !OPENING_PREFIXES.some((p) => u.startsWith(p));
    });

    const by_type: Record<string, number> = {};
    let total = 0;
    if (geometryCategories.length > 0) {
      const regexes = geometryCategories.map((c) => new RegExp(`^${escapeRegExp(c)}$`));
      const buckets = await model.getItemsOfCategories(regexes);
      for (const [cat, ids] of Object.entries(buckets)) {
        const displayName = ifcTypeDisplayName(cat);
        by_type[displayName] = (by_type[displayName] ?? 0) + ids.length;
        total += ids.length;
      }
    }

    const storeys = (await this.getStoreys()).map((s) => s.name);

    const materialBuckets = await model.getItemsOfCategories([/^IFCMATERIAL$/]);
    const materialIds = materialBuckets['IFCMATERIAL'] ?? [];
    let materials: string[] = [];
    if (materialIds.length > 0) {
      const rows = await model.getItemsData(materialIds, { attributesDefault: true });
      const seen = new Set<string>();
      for (const row of rows) {
        const name = readStringAttr(row, 'Name');
        if (name && !seen.has(name)) {
          seen.add(name);
          materials.push(name);
        }
      }
    }

    const stats: ModelStats = { total_elements: total, by_type, storeys, materials };
    this._statsCache = stats;
    return stats;
  }

  // -------- element details (psets, material, quantities) --------

  /** Synchronous cache peek for UI paths that want to avoid a loading flash
   *  on repeat selections. Never triggers I/O. */
  peekElement(expressId: number): ElementDetail | null {
    return this.elementDetailCache.get(expressId) ?? null;
  }

  /** True when a getElement() resolution for this id is already in flight.
   *  Lets UI consumers attach to that promise immediately
   *  instead of paying their rapid-selection debounce - the viewer's
   *  pointer-down prefetch usually has the fetch running before the
   *  PropertiesPanel even commits. Never triggers I/O. */
  hasElementInFlight(expressId: number): boolean {
    return this.elementDetailInFlight.has(expressId);
  }

  async getElement(expressId: number): Promise<ElementDetail | null> {
    const cached = this.elementDetailCache.get(expressId);
    if (cached) return cached;

    const inFlight = this.elementDetailInFlight.get(expressId);
    if (inFlight) return inFlight;

    const promise = this.resolveElementDetail(expressId);
    this.elementDetailInFlight.set(expressId, promise);
    void promise.finally(() => {
      if (this.elementDetailInFlight.get(expressId) === promise) {
        this.elementDetailInFlight.delete(expressId);
      }
    });
    return promise;
  }

  // First-paint strategy: the authoritative backend fetch
  // ALWAYS starts immediately, and its result overwrites the caches whenever
  // it lands (fetchAuthoritativeElement writes them) - but the caller gets
  // whichever source answers first. The local sources (server-built index,
  // metadata worker) answer in single-digit ms once warm, so a first click
  // no longer stalls the Properties panel on an HTTP round-trip. Ids
  // invalidated by an edit skip the local race entirely: the pristine index
  // / worker would serve pre-edit values (backend stays authoritative).
  private async resolveElementDetail(expressId: number): Promise<ElementDetail | null> {
    // Browser-only build: the metadata worker is the only properties source -
    // never open the authoritative backend fetch (there is no backend).
    if (BROWSER_ONLY) {
      return this.resolveElementDetailLocal(expressId);
    }

    const backendChain = (async (): Promise<ElementDetail | null> => {
      const direct = await this.fetchAuthoritativeElement(expressId);
      if (direct) return direct;
      return this.fetchElementFromRecentRaycastHit(expressId);
    })();

    if (this.authoritativeOnlyIds.has(expressId)) {
      const fromBackend = await backendChain;
      if (fromBackend) this.authoritativeOnlyIds.delete(expressId);
      return fromBackend;
    }

    const localChain = this.resolveElementDetailLocal(expressId);
    return new Promise<ElementDetail | null>((resolve) => {
      let pending = 2;
      const settle = (detail: ElementDetail | null) => {
        if (detail) {
          resolve(detail); // first non-null wins; later resolves are no-ops
        } else if (--pending === 0) {
          resolve(null);
        }
      };
      backendChain.then(settle, () => settle(null));
      localChain.then(settle, () => settle(null));
    });
  }

  // Local (non-network) detail sources, raced against the backend above:
  // the server-built metadata index when hydrated, else the in-browser
  // metadata worker. Returns null when neither can serve - the backend
  // chain is then the only remaining source, exactly as before.
  private async resolveElementDetailLocal(expressId: number): Promise<ElementDetail | null> {
    if (this.backendIndexInit) {
      try { await this.backendIndexInit; } catch { /* index unavailable */ }
    }
    const fromIndex = this.backendIndex?.getElementDetail(expressId) ?? null;
    if (fromIndex) {
      this.elementDetailCache.set(expressId, fromIndex);
      return fromIndex;
    }
    if (this.backendMode) return null;

    // Ensure the worker is alive + has the bytes loaded.
    if (!this.metadataWorkerInit && this.rawBytes && !this.metadataWorker.failed) {
      this.startMetadataWorker(this.rawBytes, 'init', this.fragmentsModel ?? undefined);
    }
    if (this.metadataWorkerInit) {
      try { await this.metadataWorkerInit; } catch { /* already logged */ }
    }
    // The in-browser metadata worker can be unavailable: large models can
    // exceed its parse budget (web-ifc OOM / 60 s init timeout), and models
    // loaded without raw IFC bytes never start a worker at all. If it cannot
    // serve, the backend chain decides the outcome.
    if (!this.metadataWorker.ready) return null;

    try {
      const detail = await this.metadataWorker.getElement(expressId);
      if (detail) {
        this.elementDetailCache.set(expressId, detail);
        // Worker walks up to the owning IfcProduct when the requested id is a
        // representation / geometry node. Cache the payload under the resolved
        // id too - PropertiesPanel resyncs `selectedElementId` to that id and
        // immediately re-fetches; without this entry the re-fetch is another
        // worker round-trip and the user sees a brief "Loading..." flash.
        if (detail.id !== expressId) {
          this.elementDetailCache.set(detail.id, detail);
        }
        return detail;
      }
      // Worker is alive but has no record of this id.
      return null;
    } catch (err) {
      console.warn(`[ModelService] getElement(${expressId}) failed`, err);
      return null;
    }
  }

  // Fetch one element's detail from the authoritative backend route
  // (IfcOpenShell). This is the primary properties source; the backend also
  // resolves geometry/property internals to their owning product when possible.
  private async fetchAuthoritativeElement(expressId: number): Promise<ElementDetail | null> {
    try {
      const resp = await fetch(apiUrl(`/api/ifc/elements/${expressId}`), {
        headers: { Accept: 'application/json' },
      });
      if (!resp.ok) return null;
      const detail = (await resp.json()) as ElementDetail;
      if (detail && typeof detail.id === 'number') {
        this.elementDetailCache.set(expressId, detail);
        if (detail.id !== expressId) {
          this.elementDetailCache.set(detail.id, detail);
          const localId = this.recentRaycastLocalByItemId.get(expressId);
          if (typeof localId === 'number') this.recentLocalByProductId.set(detail.id, localId);
        }
        return detail;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchElementFromRecentRaycastHit(itemId: number): Promise<ElementDetail | null> {
    const localId = this.recentRaycastLocalByItemId.get(itemId);
    const model = this.fragmentsModel;
    if (typeof localId !== 'number' || !model) return null;

    if (this.backendIndexInit) {
      try { await this.backendIndexInit; } catch { /* fallback below */ }
    }
    const backendIndex = this.backendIndex;
    if (!backendIndex) return null;

    try {
      // GUIDs come from the fragment's guids table, not item attributes -
      // see getSpatialTree. Attribute read kept as legacy fallback.
      let guid: string | null = null;
      try {
        const guids = await model.getGuidsByLocalIds([localId]);
        guid = typeof guids[0] === 'string' && guids[0].length > 0 ? guids[0] : null;
      } catch {
        /* guids table unavailable - attribute fallback below */
      }
      if (!guid) {
        const rows = await model.getItemsData([localId], { attributesDefault: true });
        guid = readStringAttr(rows[0], '_guid') ?? readStringAttr(rows[0], 'GlobalId');
      }
      if (!guid) return null;
      const expressId = backendIndex.expressIdByGlobalId.get(guid);
      if (typeof expressId !== 'number' || expressId === itemId) return null;
      const detail = await this.fetchAuthoritativeElement(expressId);
      if (detail) {
        this.elementDetailCache.set(itemId, detail);
        this.elementDetailCache.set(detail.id, detail);
        this.recentLocalByProductId.set(detail.id, localId);
      }
      return detail;
    } catch {
      return null;
    }
  }

  /**
   * Bulk variant of `getElement`. Populates the per-element cache for every
   * non-null result so subsequent single-id calls are O(1) cache hits.
   *
   * Use this for batch operations (e.g. multi-select aggregate views,
   * tree-leaf prefetch, CSV export) - it pipelines all the misses through
   * one worker round-trip instead of N serial round-trips.
   */
  async getElements(expressIds: number[]): Promise<(ElementDetail | null)[]> {
    if (expressIds.length === 0) return [];

    // First pass: fill from cache.
    const out: (ElementDetail | null)[] = new Array(expressIds.length).fill(null);
    const missIndices: number[] = [];
    const missIds: number[] = [];
    for (let i = 0; i < expressIds.length; i++) {
      const cached = this.elementDetailCache.get(expressIds[i]);
      if (cached) {
        out[i] = cached;
      } else {
        missIndices.push(i);
        missIds.push(expressIds[i]);
      }
    }
    if (missIds.length === 0) return out;

    if (this.backendMode) {
      // getElement handles index lookup + authoritative fallback + caching.
      const fetched = await Promise.all(missIds.map((id) => this.getElement(id)));
      for (let i = 0; i < missIds.length; i++) out[missIndices[i]] = fetched[i];
      return out;
    }

    // Ensure worker is alive (same lazy-init pattern as getElement).
    if (!this.metadataWorkerInit && this.rawBytes && !this.metadataWorker.failed) {
      this.startMetadataWorker(this.rawBytes, 'init', this.fragmentsModel ?? undefined);
    }
    if (this.metadataWorkerInit) {
      try { await this.metadataWorkerInit; } catch { /* already logged */ }
    }
    if (!this.metadataWorker.ready) {
      if (BROWSER_ONLY) return out; // no backend to fall back to
      // Worker unavailable - resolve each miss through the authoritative
      // backend route (same fallback getElement uses) so bulk/multi-select
      // views also degrade gracefully instead of returning all-null.
      const fetched = await Promise.all(
        missIds.map((id) => this.fetchAuthoritativeElement(id)),
      );
      for (let i = 0; i < missIds.length; i++) out[missIndices[i]] = fetched[i];
      return out;
    }

    try {
      const fetched = await this.metadataWorker.getElements(missIds);
      for (let i = 0; i < missIds.length; i++) {
        const detail = fetched[i];
        if (detail) {
          this.elementDetailCache.set(missIds[i], detail);
          out[missIndices[i]] = detail;
        }
      }
    } catch (err) {
      console.warn('[ModelService] getElements bulk fetch failed', err);
    }
    return out;
  }

  // -------- Classifications (via metadata worker) --------

  async getClassifications(): Promise<ClassificationGroup[]> {
    if (this._classificationCache) return this._classificationCache;

    // Backend-metadata mode does not (yet) carry classification groups in the
    // index - documented gap. Return empty so the panel shows its empty state
    // rather than spinning up the worker we deliberately skipped.
    if (this.backendMode && this.backendIndex) return [];

    if (!this.metadataWorkerInit && this.rawBytes && !this.metadataWorker.failed) {
      this.startMetadataWorker(this.rawBytes, 'init', this.fragmentsModel ?? undefined);
    }
    if (this.metadataWorkerInit) {
      try { await this.metadataWorkerInit; } catch { /* already logged */ }
    }
    if (!this.metadataWorker.ready) return [];

    try {
      const groups = await this.metadataWorker.getClassifications();
      this._classificationCache = groups;
      return groups;
    } catch (err) {
      console.warn('[ModelService] getClassifications failed', err);
      return [];
    }
  }

  // -------- client-side full-text search --------

  async search(query: string, options: { ifcType?: string; storey?: string; limit?: number } = {}): Promise<SearchResult> {
    if (this.searchIndex.size === 0) {
      await this.buildSearchIndex();
    }
    return this.searchIndex.search(query, options);
  }

  private async buildSearchIndex(): Promise<void> {
    if (this.searchIndex.size > 0) return;
    const tree = await this.getSpatialTree();
    if (!tree) return;
    const storeys = await this.getStoreys();
    const storeyNameById = new Map<number, string>();
    for (const s of storeys) storeyNameById.set(s.id, s.name);

    const walk = (node: SpatialNode, currentStorey: string | null) => {
      const type = node.ifc_type.toLowerCase();
      const myStorey = type === 'ifcbuildingstorey'
        ? (storeyNameById.get(node.id) ?? node.name)
        : currentStorey;
      const isSpatialContainer =
        type === 'ifcproject' || type === 'ifcsite' || type === 'ifcbuilding' || type === 'ifcbuildingstorey';
      // Skip synthetic roots (id < 0) and spatial containers - users
      // search for leaf elements, not containers.
      if (node.id > 0 && !isSpatialContainer) {
        this.searchIndex.add({
          id: node.id,
          globalId: node.global_id,
          name: node.name,
          ifcType: node.ifc_type,
          storey: myStorey,
        });
      }
      for (const c of node.children) walk(c, myStorey);
    };
    walk(tree, null);
  }

  async getSpatialTree(): Promise<SpatialNode | null> {
    if (this._treeCache) return this._treeCache;
    const model = this.fragmentsModel;
    if (!model) return null;

    type TreeItem = {
      category: string | null;
      localId: number | null;
      children?: TreeItem[];
    };

    let raw: TreeItem | null = null;
    try {
      raw = (await model.getSpatialStructure()) as TreeItem;
    } catch (err) {
      console.warn('[ModelService] getSpatialStructure failed', err);
      return null;
    }
    if (!raw) return null;

    // Collect every local ID in the tree so we can batch-fetch names /
    // GlobalIds in one pass instead of N per-item queries.
    const collected: number[] = [];
    const walk = (node: TreeItem) => {
      if (typeof node.localId === 'number') collected.push(node.localId);
      for (const c of node.children ?? []) walk(c);
    };
    walk(raw);

    const nameByLocal = new Map<number, string>();
    const guidByLocal = new Map<number, string>();
    const categoryByLocal = new Map<number, string>();

    // getSpatialStructure often returns category: null for any node -
    // spatial containers and leaf elements alike. Build a full
    // localId -> category map so every tree node gets a real IFC type
    // in the UI. One `getCategories()` + one bulk `getItemsOfCategories()`
    // is cheaper than resolving each node individually.
    try {
      const allCats = await model.getCategories();
      const regexes = allCats.map((c) => new RegExp(`^${escapeRegExp(c)}$`));
      const buckets = await model.getItemsOfCategories(regexes);
      for (const [cat, ids] of Object.entries(buckets)) {
        for (const id of ids) categoryByLocal.set(id, cat);
      }
    } catch {
      /* ignore - names still come through as fallback */
    }

    if (collected.length > 0) {
      // GUIDs live in the fragment's dedicated guids table - they are NOT
      // item attributes ('GlobalId' never appears in getItemsData rows for
      // fragments 3.x and newer), so read the table directly. The attribute read in
      // the loop below stays as a fallback for older fragment files.
      try {
        const guids = await model.getGuidsByLocalIds(collected);
        for (let i = 0; i < collected.length; i++) {
          const guid = guids[i];
          if (typeof guid === 'string' && guid.length > 0) {
            guidByLocal.set(collected[i], guid);
          }
        }
      } catch {
        /* guids table unavailable - attribute fallback below */
      }

      const CHUNK = 2048;
      for (let i = 0; i < collected.length; i += CHUNK) {
        const chunk = collected.slice(i, i + CHUNK);
        let rows: unknown[] = [];
        try {
          rows = (await model.getItemsData(chunk, {
            attributesDefault: true,
          })) as unknown[];
        } catch {
          continue;
        }
        for (let j = 0; j < chunk.length; j++) {
          const localId = chunk[j];
          const row = rows[j];
          const name = readStringAttr(row, 'Name');
          if (name) nameByLocal.set(localId, name);
          if (!guidByLocal.has(localId)) {
            const guid = readStringAttr(row, '_guid') ?? readStringAttr(row, 'GlobalId');
            if (guid) guidByLocal.set(localId, guid);
          }
        }
      }
    }

    // Kick off the id-bridge hydration in parallel - the metadata worker
    // is the only source of localId-to-expressId mappings, and the sidebar
    // tree comparator wants this synchronously available. Fire-and-forget;
    // the SpatialNode.expressId field will be filled in on a re-emit when
    // the bridge hydrates if the tree is built before the worker resolves
    // its GlobalId map. For BasicHouse the worker init is sub-second so
    // the first tree build almost always sees the populated bridge.
    void this.hydrateIdBridge(guidByLocal, model);

    // If the bridge already hydrated (re-builds, prewarmed worker), grab
    // a snapshot now so the synchronous toNode walk below can attach
    // expressId to every SpatialNode immediately.
    const bridgeSnapshot = this._idBridgeReady ? this.expressIdByLocalId : null;

    const toNode = (item: TreeItem): SpatialNode | null => {
      if (typeof item.localId !== 'number') {
        // The root returned by FragmentsModel can be a synthetic container
        // with no localId; fold its children up.
        const children = (item.children ?? [])
          .map(toNode)
          .filter((n): n is SpatialNode => n !== null);
        if (children.length === 1) return children[0];
        // Emit a synthetic root so the UI always has a single tree root.
        return {
          id: -1,
          global_id: '',
          name: 'Project',
          ifc_type: 'IfcProject',
          children,
        };
      }
      const cat = item.category ?? categoryByLocal.get(item.localId) ?? '';
      const ifcType = cat ? ifcTypeDisplayName(cat) : 'Element';
      const name =
        nameByLocal.get(item.localId) ??
        `${ifcType} #${item.localId}`;
      const global_id = guidByLocal.get(item.localId) ?? '';
      const expressId = bridgeSnapshot?.get(item.localId);
      const children = (item.children ?? [])
        .map(toNode)
        .filter((n): n is SpatialNode => n !== null);
      return {
        id: item.localId,
        ...(typeof expressId === 'number' ? { expressId } : {}),
        global_id,
        name,
        ifc_type: ifcType,
        children,
      };
    };

    const tree = toNode(raw);
    this._treeCache = tree;
    return tree;
  }

  // -------- Store hydration --------

  private async hydrateStoreFromModel(): Promise<void> {
    const model = this.fragmentsModel;
    if (!model) return;

    const wantStats = getClientIfcFlag('statsClient');
    const wantTree = getClientIfcFlag('treeClient');

    try {
      const tasks: Promise<unknown>[] = [];
      if (wantStats) {
        tasks.push(this.getProjectInfo());
        tasks.push(this.getModelStats());
      }
      if (wantTree) tasks.push(this.getSpatialTree());
      await Promise.all(tasks);

      const state = useStore.getState();

      if (wantStats) {
        const project = this._projectCache ?? emptyProjectInfo();
        const stats = this._statsCache ?? {
          total_elements: 0,
          by_type: {},
          storeys: [],
          materials: [],
        };
        const existing = state.project;
        const mergedProject: ProjectInfo = {
          ...project,
          schema_version:
            project.schema_version || existing?.schema_version || '',
          author: project.author ?? existing?.author ?? null,
          organization: project.organization ?? existing?.organization ?? null,
        };
        state.setProject(mergedProject);
        state.setStats(stats);
        state.logActivity({
          kind: 'info',
          summary: `Client metadata ready: ${stats.total_elements} elements, ${stats.storeys.length} storeys, ${stats.materials.length} materials`,
        });
      }

      if (wantTree && this._treeCache) {
        // Backend-metadata mode: wait briefly for the id bridge so the
        // sidebar mounts ONCE with expressIds already patched in, instead of
        // a full O(N) mount now plus a second full mount when the bridge
        // composes (a bridged republish allocates a new root). Bounded: if
        // the index is slow or unavailable, publish unpatched - the bridged
        // republish corrects it later exactly as before.
        if (this.backendMode && this.backendIndexInit && !this._idBridgeReady) {
          await Promise.race([
            this.backendIndexInit.catch(() => {}),
            new Promise<void>((res) => setTimeout(res, 4000)),
          ]);
          if (this.fragmentsModel !== model) return;
        }
        useStore.getState().setSpatialTree(this._treeCache);
      }
    } catch (err) {
      console.warn('[ModelService] hydrateStoreFromModel failed', err);
    }
  }

  /**
   * Snapshot of the composed localId-to-expressId bridge (backend-metadata
   * mode), or null while no bridge has composed. Consumers invert it to
   * bulk-seed express-to-local caches without the per-id worker round-trips
   * the prewarm loop would otherwise pay.
   */
  getIdBridgeEntries(): Array<[number, number]> | null {
    if (!this._idBridgeReady || this.expressIdByLocalId.size === 0) return null;
    return [...this.expressIdByLocalId];
  }
}

// ---------- helpers ----------

function queueWhenIdle(task: () => void, timeoutMs = 1500): void {
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

function emptyProjectInfo(): ProjectInfo {
  return { name: '', description: null, schema_version: '', author: null, organization: null };
}

function readStringAttr(row: unknown, key: string): string | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const v = r[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'value' in v) {
    const inner = (v as { value: unknown }).value;
    return typeof inner === 'string' ? inner : null;
  }
  return null;
}

function pickString(bag: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Identity-preserving: returns the ORIGINAL node when neither it nor any
// descendant needs a new expressId, so a republish with no new information
// can be detected by reference equality and skipped (same changed-flag walk
// as patchTreeNames in App.tsx).
function patchTreeWithExpressIds(
  node: SpatialNode,
  bridge: ReadonlyMap<number, number>,
): SpatialNode {
  const eid = bridge.get(node.id);
  const needsEid = typeof eid === 'number' && node.expressId !== eid;
  let childChanged = false;
  let children = node.children;
  if (node.children.length > 0) {
    const mapped = node.children.map((c) => {
      const patched = patchTreeWithExpressIds(c, bridge);
      if (patched !== c) childChanged = true;
      return patched;
    });
    if (childChanged) children = mapped;
  }
  if (needsEid || childChanged) {
    return {
      ...node,
      ...(typeof eid === 'number' ? { expressId: eid } : {}),
      children,
    };
  }
  return node;
}

// Convert IFCWALLSTANDARDCASE -> IfcWallStandardCase. Matches the casing
// the Python backend produces (and what SummaryPanel / chat tools expect).
// The registered compound entries preserve internal capitalization that
// would otherwise be lost when tail-lowercasing. Extend as new types
// show up in the wild.
const IFC_TYPE_CANON: Record<string, string> = {
  IFCPROJECT: 'IfcProject',
  IFCSITE: 'IfcSite',
  IFCBUILDING: 'IfcBuilding',
  IFCBUILDINGSTOREY: 'IfcBuildingStorey',
  IFCSPACE: 'IfcSpace',
  IFCWALL: 'IfcWall',
  IFCWALLSTANDARDCASE: 'IfcWallStandardCase',
  IFCCURTAINWALL: 'IfcCurtainWall',
  IFCSLAB: 'IfcSlab',
  IFCROOF: 'IfcRoof',
  IFCDOOR: 'IfcDoor',
  IFCWINDOW: 'IfcWindow',
  IFCSTAIR: 'IfcStair',
  IFCSTAIRFLIGHT: 'IfcStairFlight',
  IFCRAILING: 'IfcRailing',
  IFCRAMP: 'IfcRamp',
  IFCBEAM: 'IfcBeam',
  IFCCOLUMN: 'IfcColumn',
  IFCPLATE: 'IfcPlate',
  IFCMEMBER: 'IfcMember',
  IFCCOVERING: 'IfcCovering',
  IFCFOOTING: 'IfcFooting',
  IFCPILE: 'IfcPile',
  IFCOPENINGELEMENT: 'IfcOpeningElement',
  IFCFURNISHINGELEMENT: 'IfcFurnishingElement',
  IFCFURNITURE: 'IfcFurniture',
  IFCBUILDINGELEMENTPROXY: 'IfcBuildingElementProxy',
  IFCFLOWTERMINAL: 'IfcFlowTerminal',
  IFCFLOWSEGMENT: 'IfcFlowSegment',
  IFCFLOWFITTING: 'IfcFlowFitting',
  IFCFLOWCONTROLLER: 'IfcFlowController',
  IFCDISTRIBUTIONCONTROLELEMENT: 'IfcDistributionControlElement',
  IFCDUCTSEGMENT: 'IfcDuctSegment',
  IFCDUCTFITTING: 'IfcDuctFitting',
  IFCACTUATOR: 'IfcActuator',
  IFCSENSOR: 'IfcSensor',
  IFCAIRTERMINAL: 'IfcAirTerminal',
  IFCLIGHTFIXTURE: 'IfcLightFixture',
  IFCELECTRICAPPLIANCE: 'IfcElectricAppliance',
  IFCMATERIAL: 'IfcMaterial',
  IFCMATERIALLAYER: 'IfcMaterialLayer',
  IFCMATERIALLAYERSET: 'IfcMaterialLayerSet',
  IFCMATERIALLAYERSETUSAGE: 'IfcMaterialLayerSetUsage',
  IFCMATERIALLIST: 'IfcMaterialList',
  IFCSIUNIT: 'IfcSIUnit',
  IFCUNITASSIGNMENT: 'IfcUnitAssignment',
  IFCPROPERTYSET: 'IfcPropertySet',
  IFCELEMENTQUANTITY: 'IfcElementQuantity',
};

function ifcTypeDisplayName(raw: string): string {
  if (!raw) return '';
  const u = raw.toUpperCase();
  if (!u.startsWith('IFC')) return raw;
  const canon = IFC_TYPE_CANON[u];
  if (canon) return canon;
  const tail = raw.slice(3);
  return 'Ifc' + tail.charAt(0).toUpperCase() + tail.slice(1).toLowerCase();
}

export const modelService = new ModelServiceImpl();

// Keep the store/viewer bundle boundary intact while making post-edit cache
// invalidation synchronous once ModelService is loaded.
registerElementDetailInvalidator((expressIds) => {
  modelService.invalidateElementDetails([...expressIds]);
});
export type ModelService = ModelServiceImpl;
