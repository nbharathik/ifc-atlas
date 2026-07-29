// Registry of the client-side handlers for the 4 merged LLM tools the
// backend routes to the browser: describe_model (part project|stats|storeys),
// query_elements (mode text|type|storey), get_element (details only) and
// viewer_control (all actions). The backend's router_tool_executor sends
// tool_call_request messages over the chat WS; ChatPanel dispatches them here
// and ships the result back as tool_result. Return shapes mirror the
// backend's execute_tool() so the LLM sees identical payloads regardless of
// where the tool ran.

import { modelService } from './ModelService';
import { useStore } from '../../store/useStore';
import type {
  ElementDetail,
  ElementSummary,
  ModelStats,
  ProjectInfo,
  SearchResult,
  SpatialNode,
} from '../../types/ifc';

export type ToolArgs = Record<string, unknown>;
// The LLM doesn't care about our strict domain types; any JSON-ish
// object is fine. We use `unknown` here so handlers can return their
// native types (ProjectInfo, ModelStats, etc.) without ceremonial casts.
export type ToolResult = unknown;
export type ClientToolHandler = (args: ToolArgs) => Promise<ToolResult> | ToolResult;

const MAX_ELEMENTS_PER_RESULT = 100;

// ---------- data tools ----------

async function getProjectInfo(): Promise<ProjectInfo> {
  return modelService.getProjectInfo();
}

async function getModelStats(): Promise<ModelStats> {
  return modelService.getModelStats();
}

async function searchElements(args: ToolArgs): Promise<SearchResult> {
  const query = String(args.query ?? '');
  return modelService.search(query, {
    ifcType: typeof args.ifc_type === 'string' ? args.ifc_type : undefined,
    storey: typeof args.storey === 'string' ? args.storey : undefined,
    limit: typeof args.limit === 'number' ? args.limit : undefined,
  });
}

async function getElementDetails(args: ToolArgs): Promise<ElementDetail | { error: string }> {
  const id = toInt(args.element_id);
  if (id == null) return { error: 'element_id must be an integer' };
  const detail = await modelService.getElement(id);
  if (!detail) return { error: `Element #${id} not found in the model.` };
  return detail;
}

async function getElementsByType(args: ToolArgs): Promise<ToolResult> {
  const ifcType = String(args.ifc_type ?? '').trim();
  if (!ifcType) return { error: 'ifc_type is required' };
  const result = await modelService.search('', { ifcType });
  const elements = result.elements.slice(0, MAX_ELEMENTS_PER_RESULT);
  // If the inverted-index path returns 0 (empty query), fall back to
  // matching from the spatial tree directly - search() short-circuits
  // on empty queries.
  const ensured = elements.length > 0 ? elements : await elementsByTypeFromTree(ifcType);
  return {
    ifc_type: ifcType,
    count: ensured.length,
    elements: ensured.slice(0, MAX_ELEMENTS_PER_RESULT),
  };
}

async function getElementsByStorey(args: ToolArgs): Promise<ToolResult> {
  const storeyId = toInt(args.storey_id);
  if (storeyId == null) return { error: 'storey_id must be an integer' };
  const tree = await modelService.getSpatialTree();
  if (!tree) return { error: 'No spatial tree available' };
  const storey = findNodeById(tree, storeyId);
  if (!storey) return { error: `Storey #${storeyId} not found.` };
  const out: ElementSummary[] = [];
  const storeyName = storey.name;
  const walk = (node: SpatialNode) => {
    for (const c of node.children) {
      if (isLeafElement(c)) {
        out.push({
          id: c.id,
          global_id: c.global_id,
          name: c.name,
          ifc_type: c.ifc_type,
          storey: storeyName,
        });
      }
      walk(c);
    }
  };
  walk(storey);
  return {
    storey_id: storeyId,
    count: out.length,
    elements: out.slice(0, MAX_ELEMENTS_PER_RESULT),
  };
}

async function getStoreys(): Promise<ToolResult> {
  const storeys = await modelService.getStoreys();
  return {
    storeys: storeys.map((s) => ({
      id: s.id,
      global_id: s.globalId,
      name: s.name,
      ifc_type: 'IfcBuildingStorey',
    })),
  };
}

// ---------- UI action tools ----------

function highlightElements(args: ToolArgs): ToolResult {
  const ids = extractIdArray(args.element_ids);
  useStore.getState().setHighlightedIds(ids);
  useStore.getState().logActivity({
    kind: 'tool',
    summary: `Highlighted ${ids.length} element${ids.length === 1 ? '' : 's'} (via AI)`,
  });
  return { action: 'highlight', element_ids: ids, count: ids.length };
}

function selectElementTool(args: ToolArgs): ToolResult {
  const id = toInt(args.element_id);
  if (id == null) return { error: 'element_id must be an integer' };
  const store = useStore.getState();
  store.selectElement(id);
  // Open the Properties tab so the user can see the result of the AI's
  // focus immediately; no-op if the sidebar is already there.
  store.setRightActiveTab('props');
  store.setRightSidebarOpen(true);
  store.logActivity({ kind: 'tool', summary: `Selected element #${id} (via AI)` });
  return { action: 'select', element_id: id };
}

function isolateElements(args: ToolArgs): ToolResult {
  const ids = extractIdArray(args.element_ids);
  useStore.getState().setIsolatedIds(ids);
  useStore.getState().logActivity({
    kind: 'tool',
    summary: ids.length === 0
      ? 'Cleared isolation (via AI)'
      : `Isolated ${ids.length} element${ids.length === 1 ? '' : 's'} (via AI)`,
  });
  return { action: 'isolate', element_ids: ids, count: ids.length };
}

function showAllElements(): ToolResult {
  const store = useStore.getState();
  store.setIsolatedIds([]);
  store.setHiddenIds([]);
  store.logActivity({ kind: 'tool', summary: 'Cleared visibility filters (via AI)' });
  return { action: 'show_all' };
}

function clipSectionBoxToElement(args: ToolArgs): ToolResult {
  const id = toInt(args.element_id);
  if (id == null) return { error: 'element_id must be an integer' };
  const store = useStore.getState();
  // Fits the section box to the element's AABB via the ViewerPanel-registered
  // bridge - the same path the legacy `clip_section_box` WS event used.
  store.clipToElement(id);
  store.logActivity({ kind: 'view', summary: `Clipped section box to element #${id} (via AI)` });
  return { action: 'clip_section_box', element_id: id };
}

// ---------- merged-tool dispatchers ----------
// The backend routes a merged tool to the browser only for the mode/part
// combinations the metadata worker can serve (see _CLIENT_ROUTING in
// backend/app/services/tools.py). The `unsupported` branches are defensive:
// they surface a clear error if a non-client-capable call ever lands here.

function unsupported(tool: string, detail: string): ToolResult {
  return { error: `Client tool '${tool}' cannot run in the browser: ${detail}` };
}

async function describeModel(args: ToolArgs): Promise<ToolResult> {
  const part = String(args.part ?? '').trim();
  switch (part) {
    case 'project': return getProjectInfo();
    case 'stats': return getModelStats();
    case 'storeys': return getStoreys();
    default:
      return unsupported('describe_model', `part '${part}' is server-only (use project, stats, or storeys client-side)`);
  }
}

async function queryElements(args: ToolArgs): Promise<ToolResult> {
  const mode = String(args.mode ?? '').trim();
  switch (mode) {
    case 'text': return searchElements(args);       // query / ifc_type / storey / limit
    case 'type': return getElementsByType(args);    // ifc_type
    case 'storey': return getElementsByStorey(args); // storey_id
    default:
      return unsupported('query_elements', `mode '${mode}' is server-only (use text, type, or storey client-side)`);
  }
}

async function getElement(args: ToolArgs): Promise<ToolResult> {
  const include = args.include;
  const aspects = Array.isArray(include)
    ? include.map((a) => String(a))
    : include == null
      ? []
      : [String(include)];
  if (aspects.length === 0 || (aspects.length === 1 && aspects[0] === 'details')) {
    return getElementDetails(args);
  }
  return unsupported('get_element', `include [${aspects.join(', ')}] is server-only (only ['details'] runs client-side)`);
}

function viewerControl(args: ToolArgs): ToolResult {
  const action = String(args.action ?? '').trim();
  switch (action) {
    case 'highlight': return highlightElements(args);
    case 'select': return selectElementTool(args);
    case 'isolate': return isolateElements(args);
    case 'show_all': return showAllElements();
    case 'clip_section_box': return clipSectionBoxToElement(args);
    default:
      return { error: `viewer_control: unknown action '${action}'. Use one of: highlight, select, isolate, show_all, clip_section_box.` };
  }
}

// ---------- registry + dispatcher ----------

const HANDLERS: Record<string, ClientToolHandler> = {
  describe_model: describeModel,
  query_elements: queryElements,
  get_element: getElement,
  viewer_control: viewerControl,
};

export const CLIENT_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(HANDLERS));

export function hasClientHandler(name: string): boolean {
  return name in HANDLERS;
}

export async function runClientTool(name: string, args: ToolArgs): Promise<ToolResult> {
  const handler = HANDLERS[name];
  if (!handler) {
    return { error: `Unknown client tool: ${name}` };
  }
  if (!modelService.ready) {
    return { error: 'No IFC model is currently loaded.' };
  }
  try {
    const result = await handler(args ?? {});
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Client tool '${name}' failed: ${msg}` };
  }
}

// ---------- helpers ----------

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function extractIdArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const item of v) {
    const id = toInt(item);
    if (id != null) out.push(id);
  }
  return out;
}

function findNodeById(node: SpatialNode, id: number): SpatialNode | null {
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findNodeById(c, id);
    if (hit) return hit;
  }
  return null;
}

function isLeafElement(node: SpatialNode): boolean {
  const t = node.ifc_type.toLowerCase();
  // Containers don't count as leaf elements.
  if (t === 'ifcproject' || t === 'ifcsite' || t === 'ifcbuilding' || t === 'ifcbuildingstorey' || t === 'ifcspace') {
    return false;
  }
  return node.id > 0;
}

async function elementsByTypeFromTree(ifcType: string): Promise<ElementSummary[]> {
  const tree = await modelService.getSpatialTree();
  if (!tree) return [];
  const target = ifcType.toLowerCase();
  const out: ElementSummary[] = [];
  const walk = (node: SpatialNode, storey: string | null) => {
    const isStorey = node.ifc_type.toLowerCase() === 'ifcbuildingstorey';
    const nextStorey = isStorey ? node.name : storey;
    if (isLeafElement(node) && node.ifc_type.toLowerCase() === target) {
      out.push({
        id: node.id,
        global_id: node.global_id,
        name: node.name,
        ifc_type: node.ifc_type,
        storey: nextStorey,
      });
    }
    for (const c of node.children) walk(c, nextStorey);
  };
  walk(tree, null);
  return out;
}
