/**
 * Plugins API client + pure form helpers for the Plugins panel.
 *
 * Backend contract:
 *   GET    /api/plugins                  -> {"plugins": [manifest + builtin]}
 *   GET    /api/plugins/{id}             -> {"manifest", "script", "builtin"}
 *   POST   /api/plugins                  -> 201 manifest (409 when id exists)
 *   POST   /api/plugins/install-zip      -> installed manifest (multipart "file")
 *   PUT    /api/plugins/{id}             -> updated (403 for builtins)
 *   DELETE /api/plugins/{id}             -> {"deleted": true} (403 for builtins)
 *   POST   /api/plugins/{id}/run         -> sandbox result passthrough
 */
import { apiUrl } from '../../lib/platform';

export type PluginParamType = 'string' | 'number' | 'boolean';

export interface PluginParam {
  name: string;
  label: string;
  type: PluginParamType;
  default?: string | number | boolean;
  required: boolean;
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  params: PluginParam[];
  requires_write: boolean;
}

export interface PluginListItem extends PluginManifest {
  builtin: boolean;
}

export interface PluginDetail {
  manifest: PluginManifest;
  script: string;
  builtin: boolean;
}

interface PluginRunBase {
  plugin_id: string;
  plugin_name: string;
}

/** Read-only script finished: captured stdout + repr of the `result` variable. */
export interface PluginExecuteResult extends PluginRunBase {
  action: 'execute_result';
  stdout: string;
  result_repr: string;
  elapsed_ms: number;
}

/** Script raised: the sandbox reports the error text in-band (HTTP 200). */
export interface PluginExecuteError extends PluginRunBase {
  action: 'execute_error';
  error: string;
}

/**
 * Write plugin staged an edit. The edit itself flows through the existing
 * pending-edit preview/apply UI; the panel only announces it.
 */
export interface PluginPendingEdit extends PluginRunBase {
  action: 'pending_edit';
  edit_id: string;
  summary: string;
  counts: Record<string, number>;
  changes: unknown[];
}

/**
 * A read-only plugin tried to modify the model: the sandbox rejects the
 * change and reports what it would have touched.
 */
export interface PluginExecuteRejected extends PluginRunBase {
  action: 'execute_rejected';
  error: string;
  stdout?: string;
  elapsed_ms?: number;
}

/** Write plugin ran but produced no structural change - nothing to stage. */
export interface PluginPendingNoop extends PluginRunBase {
  action: 'pending_noop';
  stdout?: string;
  result_repr?: string;
  elapsed_ms?: number;
}

export type PluginRunResult =
  | PluginExecuteResult
  | PluginExecuteError
  | PluginPendingEdit
  | PluginExecuteRejected
  | PluginPendingNoop;

/**
 * Error thrown for non-2xx plugin API responses. Carries the HTTP status so
 * callers can branch (e.g. retry a 409 id collision with the next copy id)
 * while the message keeps the same "API error <status>: <body>" shape used
 * across the app's services.
 */
export class PluginApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = 'PluginApiError';
    this.status = status;
  }
}

/**
 * Human-readable message for a plugin API failure. Validation errors (422)
 * arrive as {"detail": ["param 'x': expected number", ...]} - join them into
 * one line instead of surfacing raw JSON.
 */
export function pluginErrorMessage(err: unknown): string {
  if (err instanceof PluginApiError) {
    const body = err.message.replace(/^API error \d+: /, '');
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (Array.isArray(parsed.detail)) return parsed.detail.join('; ');
      if (typeof parsed.detail === 'string') return parsed.detail;
    } catch {
      // not JSON - fall through to the raw message
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init);
  if (!res.ok) {
    const body = await res.text();
    throw new PluginApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

function jsonInit(method: string, payload: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function fetchPlugins(): Promise<PluginListItem[]> {
  const data = await requestJson<{ plugins: PluginListItem[] }>('/api/plugins');
  return data.plugins;
}

export async function fetchPlugin(id: string): Promise<PluginDetail> {
  return requestJson<PluginDetail>(`/api/plugins/${encodeURIComponent(id)}`);
}

export async function createPlugin(
  manifest: PluginManifest,
  script: string,
): Promise<PluginListItem> {
  return requestJson<PluginListItem>('/api/plugins', jsonInit('POST', { manifest, script }));
}

export async function updatePlugin(
  id: string,
  body: { manifest?: PluginManifest; script?: string },
): Promise<PluginManifest> {
  return requestJson<PluginManifest>(
    `/api/plugins/${encodeURIComponent(id)}`,
    jsonInit('PUT', body),
  );
}

export async function deletePlugin(id: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(`/api/plugins/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function installPluginZip(file: File): Promise<PluginManifest> {
  const form = new FormData();
  form.append('file', file);
  return requestJson<PluginManifest>('/api/plugins/install-zip', {
    method: 'POST',
    body: form,
  });
}

export async function runPlugin(
  id: string,
  params: Record<string, string | number | boolean>,
): Promise<PluginRunResult> {
  return requestJson<PluginRunResult>(
    `/api/plugins/${encodeURIComponent(id)}/run`,
    jsonInit('POST', { params }),
  );
}

/**
 * Next id to try when saving a copy of a plugin:
 *   "wall-report" -> "wall-report-copy" -> "wall-report-copy-2" -> ...
 * Feed it the id that just collided (409) to get the next candidate.
 */
export function nextCopyPluginId(id: string): string {
  const numbered = /^(.*-copy)-(\d+)$/.exec(id);
  if (numbered) {
    return `${numbered[1]}-${Number(numbered[2]) + 1}`;
  }
  if (id.endsWith('-copy')) {
    return `${id}-2`;
  }
  return `${id}-copy`;
}

/**
 * Save an editable copy of a built-in plugin: starts at "<builtinId>-copy" and
 * keeps incrementing the suffix while the backend answers 409 (id taken).
 */
export async function createPluginCopy(
  manifest: Omit<PluginManifest, 'id'>,
  script: string,
  builtinId: string,
): Promise<PluginListItem> {
  let id = nextCopyPluginId(builtinId);
  // 50 collisions means something else is wrong; bail with the final 409.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await createPlugin({ ...manifest, id }, script);
    } catch (e) {
      if (e instanceof PluginApiError && e.status === 409 && attempt < 49) {
        id = nextCopyPluginId(id);
        continue;
      }
      throw e;
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new PluginApiError(409, 'Could not find a free copy id');
}

/** Derive a slug id ("slug-like-this") from a display name; never empty. */
export function slugifyPluginId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'plugin';
}

/**
 * Raw form values for the Run dialog, prefilled from manifest defaults.
 * Booleans stay booleans (checkbox); string/number inputs hold text.
 */
export function defaultParamRawValues(
  params: readonly PluginParam[],
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const param of params) {
    if (param.type === 'boolean') {
      values[param.name] = param.default === true;
    } else {
      values[param.name] = param.default != null ? String(param.default) : '';
    }
  }
  return values;
}

export type ParamCoercion =
  | { ok: true; value: string | number | boolean | undefined }
  | { ok: false; error: string };

/**
 * Coerce one raw form value to its manifest type.
 * `value: undefined` means "omit the param" (empty optional input), letting
 * the script's own `params.get(name, fallback)` default apply.
 */
export function coerceParamValue(
  param: PluginParam,
  raw: string | boolean,
): ParamCoercion {
  if (param.type === 'boolean') {
    return { ok: true, value: raw === true || raw === 'true' };
  }
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text === '') {
    if (param.required) {
      return { ok: false, error: `param '${param.name}': required` };
    }
    return { ok: true, value: undefined };
  }
  if (param.type === 'number') {
    const num = Number(text);
    if (!Number.isFinite(num)) {
      return { ok: false, error: `param '${param.name}': expected number` };
    }
    return { ok: true, value: num };
  }
  return { ok: true, value: typeof raw === 'string' ? raw : text };
}

export type RunParamsBuild =
  | { ok: true; values: Record<string, string | number | boolean> }
  | { ok: false; errors: string[] };

/** Validate and coerce the whole Run form; collects every error at once. */
export function buildRunParams(
  params: readonly PluginParam[],
  rawValues: Record<string, string | boolean>,
): RunParamsBuild {
  const values: Record<string, string | number | boolean> = {};
  const errors: string[] = [];
  for (const param of params) {
    const coerced = coerceParamValue(param, rawValues[param.name] ?? '');
    // `=== false` (not `!ok`) so the union narrows even without strictNullChecks.
    if (coerced.ok === false) {
      errors.push(coerced.error);
    } else if (coerced.value !== undefined) {
      values[param.name] = coerced.value;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}

/** Starter script preloaded by the panel's "New script" action. */
export const NEW_PLUGIN_SCRIPT_TEMPLATE = `# Plugin scripts run in a sandbox with two globals:
#   model  - the loaded IFC model (an ifcopenshell file object)
#   params - the values entered in the Run dialog (a dict)
#
# print() output is captured; assign to \`result\` to return a value.

prefix = params.get("prefix", "")

walls = model.by_type("IfcWall")
print(f"Found {len(walls)} walls")

for wall in walls:
    name = wall.Name or "(unnamed)"
    if name.startswith(prefix):
        print(f"#{wall.id()}  {name}")

result = f"{len(walls)} walls inspected"
`;
