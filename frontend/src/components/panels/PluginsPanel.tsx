import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import Icon from '../ui/Icon';
import CodeEditor from '../common/CodeEditor';
import {
  NEW_PLUGIN_SCRIPT_TEMPLATE,
  buildRunParams,
  coerceParamValue,
  createPlugin,
  createPluginCopy,
  defaultParamRawValues,
  deletePlugin,
  fetchPlugin,
  fetchPlugins,
  installPluginZip,
  pluginErrorMessage,
  runPlugin,
  slugifyPluginId,
  updatePlugin,
  type PluginListItem,
  type PluginManifest,
  type PluginParam,
  type PluginParamType,
  type PluginRunResult,
} from '../../services/features/plugins';
import './pluginsPanel.css';

// ─── Editor draft model ───────────────────────────────────────────────────────

interface ParamDraft {
  name: string;
  label: string;
  type: PluginParamType;
  /** Raw default text for string/number params. */
  defaultText: string;
  /** Default checkbox state for boolean params. */
  defaultBool: boolean;
  required: boolean;
}

interface EditorState {
  source: 'new' | 'user' | 'builtin';
  /** Id being edited (user plugins) or the built-in id a copy derives from. */
  originalId: string | null;
  name: string;
  description: string;
  version: string;
  requiresWrite: boolean;
  params: ParamDraft[];
  script: string;
}

interface RunState {
  plugin: PluginListItem;
  values: Record<string, string | boolean>;
  fieldErrors: string[] | null;
  running: boolean;
  result: PluginRunResult | null;
  error: string | null;
}

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function draftFromParam(param: PluginParam): ParamDraft {
  return {
    name: param.name,
    label: param.label,
    type: param.type,
    defaultText:
      param.type !== 'boolean' && param.default != null ? String(param.default) : '',
    defaultBool: param.type === 'boolean' && param.default === true,
    required: param.required,
  };
}

function emptyParamDraft(): ParamDraft {
  return {
    name: '',
    label: '',
    type: 'string',
    defaultText: '',
    defaultBool: false,
    required: false,
  };
}

function newScriptEditor(): EditorState {
  return {
    source: 'new',
    originalId: null,
    name: '',
    description: '',
    version: '1.0.0',
    requiresWrite: false,
    params: [
      {
        name: 'prefix',
        label: 'Name prefix',
        type: 'string',
        defaultText: '',
        defaultBool: false,
        required: false,
      },
    ],
    script: NEW_PLUGIN_SCRIPT_TEMPLATE,
  };
}

type ManifestBuild =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

/** Validate the editor form and assemble a contract-shaped manifest. */
function buildManifestFromEditor(editor: EditorState): ManifestBuild {
  const name = editor.name.trim();
  if (!name) return { ok: false, error: 'Name is required' };
  const version = editor.version.trim();
  if (!version) return { ok: false, error: 'Version is required' };

  const params: PluginParam[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < editor.params.length; i++) {
    const draft = editor.params[i];
    const paramName = draft.name.trim();
    if (!paramName) {
      return { ok: false, error: `Parameter ${i + 1}: name is required` };
    }
    if (!PARAM_NAME_RE.test(paramName)) {
      return {
        ok: false,
        error: `Parameter '${paramName}': name must be a valid identifier (letters, digits, _)`,
      };
    }
    if (seen.has(paramName)) {
      return { ok: false, error: `Parameter '${paramName}': duplicate name` };
    }
    seen.add(paramName);

    const param: PluginParam = {
      name: paramName,
      label: draft.label.trim() || paramName,
      type: draft.type,
      required: draft.required,
    };
    if (draft.type === 'boolean') {
      param.default = draft.defaultBool;
    } else {
      // Reuse the run-form coercion (required:false so empty means "no default").
      const coerced = coerceParamValue({ ...param, required: false }, draft.defaultText);
      if (!coerced.ok) {
        return { ok: false, error: `Parameter '${paramName}': default must be a number` };
      }
      if (coerced.value !== undefined) param.default = coerced.value;
    }
    params.push(param);
  }

  const id =
    editor.source === 'user' && editor.originalId
      ? editor.originalId
      : slugifyPluginId(name);
  return {
    ok: true,
    manifest: {
      id,
      name,
      description: editor.description.trim(),
      version,
      params,
      requires_write: editor.requiresWrite,
    },
  };
}

function errorMessage(e: unknown): string {
  return pluginErrorMessage(e);
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function PluginsPanel({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const modelLoaded = useStore((s) => s.modelLoaded);

  const [plugins, setPlugins] = useState<PluginListItem[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic counter so a slow list response never overwrites a newer one.
  const requestSeq = useRef(0);
  // Pending disarm timer for the two-click delete confirm.
  const confirmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const refresh = useCallback(async () => {
    if (BROWSER_ONLY) return;
    const seq = ++requestSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const items = await fetchPlugins();
      if (seq !== requestSeq.current) return;
      setPlugins(items);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setListError(errorMessage(e));
    } finally {
      if (seq === requestSeq.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── List actions ──────────────────────────────────────────────────────────

  const handleInstallPicked = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // allow picking the same file again
      if (!file) return;
      setInstalling(true);
      setListError(null);
      try {
        await installPluginZip(file);
        await refresh();
      } catch (err) {
        setListError(errorMessage(err));
      } finally {
        setInstalling(false);
      }
    },
    [refresh],
  );

  const openEdit = useCallback(async (plugin: PluginListItem) => {
    setOpeningId(plugin.id);
    setListError(null);
    try {
      const detail = await fetchPlugin(plugin.id);
      setSaveError(null);
      setEditor({
        source: detail.builtin ? 'builtin' : 'user',
        originalId: detail.manifest.id,
        name: detail.manifest.name,
        description: detail.manifest.description,
        version: detail.manifest.version,
        requiresWrite: detail.manifest.requires_write,
        params: detail.manifest.params.map(draftFromParam),
        script: detail.script,
      });
    } catch (e) {
      setListError(errorMessage(e));
    } finally {
      setOpeningId(null);
    }
  }, []);

  const handleDelete = useCallback(
    async (plugin: PluginListItem) => {
      if (confirmDeleteId !== plugin.id) {
        // Arm the two-click confirm and disarm it after a beat. A timer is
        // sturdier than onBlur: re-renders or focus shifts cannot silently
        // drop the "Confirm?" state from under the user's pointer.
        setConfirmDeleteId(plugin.id);
        if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = window.setTimeout(() => {
          setConfirmDeleteId((id) => (id === plugin.id ? null : id));
          confirmTimerRef.current = null;
        }, 4000);
        return;
      }
      if (confirmTimerRef.current !== null) {
        window.clearTimeout(confirmTimerRef.current);
        confirmTimerRef.current = null;
      }
      setConfirmDeleteId(null);
      setListError(null);
      try {
        await deletePlugin(plugin.id);
        await refresh();
      } catch (e) {
        setListError(errorMessage(e));
      }
    },
    [confirmDeleteId, refresh],
  );

  const openRun = useCallback((plugin: PluginListItem) => {
    setRun({
      plugin,
      values: defaultParamRawValues(plugin.params),
      fieldErrors: null,
      running: false,
      result: null,
      error: null,
    });
  }, []);

  // ── Editor actions ────────────────────────────────────────────────────────

  const updateParam = useCallback((index: number, patch: Partial<ParamDraft>) => {
    setEditor((ed) => {
      if (!ed) return ed;
      const params = ed.params.map((p, i) => (i === index ? { ...p, ...patch } : p));
      return { ...ed, params };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!editor) return;
    const built = buildManifestFromEditor(editor);
    if (built.ok === false) {
      setSaveError(built.error);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (editor.source === 'user' && editor.originalId) {
        await updatePlugin(editor.originalId, {
          manifest: built.manifest,
          script: editor.script,
        });
      } else if (editor.source === 'builtin' && editor.originalId) {
        const { id: _replacedByCopyId, ...manifestNoId } = built.manifest;
        await createPluginCopy(manifestNoId, editor.script, editor.originalId);
      } else {
        await createPlugin(built.manifest, editor.script);
      }
      setEditor(null);
      await refresh();
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [editor, refresh]);

  // Run from the editor targets the last SAVED version on the server.
  const savedPluginForEditor =
    editor?.originalId != null
      ? plugins?.find((p) => p.id === editor.originalId) ?? null
      : null;

  const handleEditorRun = useCallback(() => {
    if (savedPluginForEditor) openRun(savedPluginForEditor);
  }, [savedPluginForEditor, openRun]);

  // ── Run actions ───────────────────────────────────────────────────────────

  const handleRunSubmit = useCallback(async () => {
    if (!run || run.running || !modelLoaded) return;
    const built = buildRunParams(run.plugin.params, run.values);
    if (built.ok === false) {
      setRun((r) => (r ? { ...r, fieldErrors: built.errors, result: null } : r));
      return;
    }
    setRun((r) =>
      r ? { ...r, running: true, fieldErrors: null, error: null, result: null } : r,
    );
    try {
      const result = await runPlugin(run.plugin.id, built.values);
      setRun((r) => (r ? { ...r, running: false, result } : r));
    } catch (e) {
      setRun((r) => (r ? { ...r, running: false, error: errorMessage(e) } : r));
    }
  }, [run, modelLoaded]);

  const setRunValue = useCallback((name: string, value: string | boolean) => {
    setRun((r) => (r ? { ...r, values: { ...r.values, [name]: value } } : r));
  }, []);

  // ── Render helpers ────────────────────────────────────────────────────────

  const renderBadges = (plugin: PluginListItem) => (
    <>
      {plugin.builtin && (
        <span className="plugins-panel-badge plugins-panel-badge--builtin">built-in</span>
      )}
      {plugin.requires_write && (
        <span className="plugins-panel-badge plugins-panel-badge--write">edits model</span>
      )}
    </>
  );

  const renderList = () => (
    <>
      {!modelLoaded && (
        <p className="plugins-panel-hint">
          Load an IFC model first - plugins need one to run.
        </p>
      )}

      {listError && (
        <div className="plugins-panel-error" role="alert">
          <span className="plugins-panel-error-msg">{listError}</span>
          <button className="plugins-panel-btn" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}

      {plugins === null && listLoading && (
        <div className="plugins-panel-skeleton" aria-label="Loading plugins">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="plugins-panel-skeleton-row" />
          ))}
        </div>
      )}

      {plugins !== null && plugins.length === 0 && !listLoading && (
        <p className="plugins-panel-empty">
          No plugins yet. Create one with New script, or install a plugin .zip.
        </p>
      )}

      {plugins !== null && plugins.length > 0 && (
        <ul className="plugins-panel-list" aria-label="Installed plugins">
          {plugins.map((plugin) => (
            <li key={plugin.id} className="plugins-panel-row">
              <div className="plugins-panel-row-main">
                <div className="plugins-panel-row-title">
                  <span className="plugins-panel-name">{plugin.name}</span>
                  <span className="plugins-panel-version">v{plugin.version}</span>
                  {renderBadges(plugin)}
                </div>
                {plugin.description && (
                  <p className="plugins-panel-desc">{plugin.description}</p>
                )}
              </div>
              <div className="plugins-panel-row-actions">
                <button
                  className="plugins-panel-btn plugins-panel-btn--accent"
                  onClick={() => openRun(plugin)}
                  disabled={!modelLoaded}
                  title={modelLoaded ? `Run ${plugin.name}` : 'Load an IFC model first'}
                >
                  Run
                </button>
                <button
                  className="plugins-panel-btn"
                  onClick={() => void openEdit(plugin)}
                  disabled={openingId === plugin.id}
                  title={plugin.builtin ? 'View (read-only, saving creates a copy)' : 'Edit'}
                >
                  {openingId === plugin.id ? '...' : 'Edit'}
                </button>
                {!plugin.builtin && (
                  <button
                    className={`plugins-panel-btn${
                      confirmDeleteId === plugin.id ? ' plugins-panel-btn--danger' : ''
                    }`}
                    onClick={() => void handleDelete(plugin)}
                    title={
                      confirmDeleteId === plugin.id
                        ? 'Click again to delete permanently'
                        : `Delete ${plugin.name}`
                    }
                  >
                    {confirmDeleteId === plugin.id ? 'Confirm?' : 'Delete'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const renderParamDefaultInput = (draft: ParamDraft, index: number) => {
    if (draft.type === 'boolean') {
      return (
        <label className="plugins-panel-check plugins-panel-check--cell">
          <input
            type="checkbox"
            checked={draft.defaultBool}
            onChange={(e) => updateParam(index, { defaultBool: e.target.checked })}
          />
          on
        </label>
      );
    }
    return (
      <input
        className="plugins-panel-input"
        type={draft.type === 'number' ? 'number' : 'text'}
        step={draft.type === 'number' ? 'any' : undefined}
        placeholder="default"
        aria-label={`Default for ${draft.name || `parameter ${index + 1}`}`}
        value={draft.defaultText}
        onChange={(e) => updateParam(index, { defaultText: e.target.value })}
      />
    );
  };

  const renderEditor = (ed: EditorState) => (
    <div className="plugins-panel-editor">
      {ed.source === 'builtin' && (
        <p className="plugins-panel-banner" role="note">
          Built-in plugins are read-only - saving creates an editable copy.
        </p>
      )}

      <div className="plugins-panel-form">
        <div className="plugins-panel-field-row">
          <label className="plugins-panel-field plugins-panel-field--grow">
            <span className="plugins-panel-field-label">Name</span>
            <input
              className="plugins-panel-input"
              value={ed.name}
              placeholder="Wall report"
              onChange={(e) => setEditor((s) => (s ? { ...s, name: e.target.value } : s))}
            />
          </label>
          <label className="plugins-panel-field plugins-panel-field--version">
            <span className="plugins-panel-field-label">Version</span>
            <input
              className="plugins-panel-input"
              value={ed.version}
              placeholder="1.0.0"
              onChange={(e) =>
                setEditor((s) => (s ? { ...s, version: e.target.value } : s))
              }
            />
          </label>
        </div>
        {ed.source !== 'user' && ed.name.trim() !== '' && (
          <p className="plugins-panel-id-hint">
            id: {slugifyPluginId(ed.name)}
            {ed.source === 'builtin' ? ' (saved as a -copy id)' : ''}
          </p>
        )}
        <label className="plugins-panel-field">
          <span className="plugins-panel-field-label">Description</span>
          <input
            className="plugins-panel-input"
            value={ed.description}
            placeholder="What does this script do?"
            onChange={(e) =>
              setEditor((s) => (s ? { ...s, description: e.target.value } : s))
            }
          />
        </label>
        <label className="plugins-panel-check">
          <input
            type="checkbox"
            checked={ed.requiresWrite}
            onChange={(e) =>
              setEditor((s) => (s ? { ...s, requiresWrite: e.target.checked } : s))
            }
          />
          Edits the model (each run stages a pending edit for review)
        </label>

        <div className="plugins-panel-params-head">
          <span className="plugins-panel-section-label">Parameters</span>
          <button
            className="plugins-panel-btn"
            onClick={() =>
              setEditor((s) =>
                s ? { ...s, params: [...s.params, emptyParamDraft()] } : s,
              )
            }
          >
            + Add
          </button>
        </div>
        {ed.params.length === 0 && (
          <p className="plugins-panel-hint">No parameters - the script runs as-is.</p>
        )}
        {ed.params.map((draft, index) => (
          <div className="plugins-panel-param-row" key={index}>
            <input
              className="plugins-panel-input"
              placeholder="name"
              aria-label={`Parameter ${index + 1} name`}
              value={draft.name}
              onChange={(e) => updateParam(index, { name: e.target.value })}
            />
            <input
              className="plugins-panel-input"
              placeholder="Label"
              aria-label={`Parameter ${index + 1} label`}
              value={draft.label}
              onChange={(e) => updateParam(index, { label: e.target.value })}
            />
            <select
              className="plugins-panel-input plugins-panel-select"
              aria-label={`Parameter ${index + 1} type`}
              value={draft.type}
              onChange={(e) =>
                updateParam(index, { type: e.target.value as PluginParamType })
              }
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            {renderParamDefaultInput(draft, index)}
            <label className="plugins-panel-check plugins-panel-check--cell">
              <input
                type="checkbox"
                checked={draft.required}
                onChange={(e) => updateParam(index, { required: e.target.checked })}
              />
              req
            </label>
            <button
              className="plugins-panel-icon-btn fpanel-icon-btn"
              aria-label={`Remove parameter ${index + 1}`}
              title="Remove parameter"
              onClick={() =>
                setEditor((s) =>
                  s ? { ...s, params: s.params.filter((_, i) => i !== index) } : s,
                )
              }
            >
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}

        <div className="plugins-panel-params-head">
          <span className="plugins-panel-section-label">script.py</span>
        </div>
        <CodeEditor
          value={ed.script}
          onChange={(script) => setEditor((s) => (s ? { ...s, script } : s))}
          language="python"
          minLines={14}
          placeholder="# Write your plugin script here"
          onSubmit={handleEditorRun}
          ariaLabel="Plugin script"
        />
      </div>

      {saveError && (
        <div className="plugins-panel-error" role="alert">
          <span className="plugins-panel-error-msg">{saveError}</span>
        </div>
      )}

      <div className="plugins-panel-footer">
        <button
          className="plugins-panel-btn plugins-panel-btn--accent"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving
            ? 'Saving...'
            : ed.source === 'builtin'
              ? 'Save as copy'
              : 'Save'}
        </button>
        <button
          className="plugins-panel-btn"
          onClick={() => {
            setEditor(null);
            setSaveError(null);
          }}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          className="plugins-panel-btn"
          onClick={handleEditorRun}
          disabled={!savedPluginForEditor || !modelLoaded}
          title={
            !savedPluginForEditor
              ? 'Save the script first'
              : !modelLoaded
                ? 'Load an IFC model first'
                : 'Run the last saved version (Ctrl+Enter)'
          }
        >
          Run
        </button>
      </div>
    </div>
  );

  const renderRunResult = (result: PluginRunResult) => {
    if (result.action === 'execute_error') {
      return (
        <div className="plugins-panel-result plugins-panel-result--error" role="alert">
          <span className="plugins-panel-result-title">Script error</span>
          <pre className="plugins-panel-stdout plugins-panel-stdout--error">
            {result.error}
          </pre>
        </div>
      );
    }
    if (result.action === 'execute_rejected') {
      return (
        <div className="plugins-panel-result plugins-panel-result--error" role="alert">
          <span className="plugins-panel-result-title">Change rejected</span>
          <pre className="plugins-panel-stdout plugins-panel-stdout--error">
            {result.error ||
              'This plugin is read-only but its script tried to modify the model.'}
          </pre>
        </div>
      );
    }
    if (result.action === 'pending_edit') {
      return (
        <div className="plugins-panel-staged" role="status">
          <span className="plugins-panel-staged-title">Edit staged: {result.summary}</span>
          {Object.keys(result.counts).length > 0 && (
            <div className="plugins-panel-staged-counts">
              {Object.entries(result.counts).map(([key, count]) => (
                <span key={key} className="plugins-panel-badge plugins-panel-badge--count">
                  {key}: {count}
                </span>
              ))}
            </div>
          )}
          <p className="plugins-panel-staged-note">
            Review it in the edit preview to apply or discard.
          </p>
        </div>
      );
    }
    if (result.action === 'pending_noop') {
      return (
        <div className="plugins-panel-result">
          <div className="plugins-panel-result-head">
            <span className="plugins-panel-result-title">Finished - no changes</span>
            {typeof result.elapsed_ms === 'number' && (
              <span className="plugins-panel-elapsed">{result.elapsed_ms.toFixed(1)} ms</span>
            )}
          </div>
          <pre className="plugins-panel-stdout">
            {result.stdout ? result.stdout : 'The script ran but changed nothing to stage.'}
          </pre>
        </div>
      );
    }
    return (
      <div className="plugins-panel-result">
        <div className="plugins-panel-result-head">
          <span className="plugins-panel-result-title">Finished</span>
          <span className="plugins-panel-elapsed">{result.elapsed_ms.toFixed(1)} ms</span>
        </div>
        <pre className="plugins-panel-stdout">
          {result.stdout !== '' ? result.stdout : '(no output)'}
        </pre>
        {result.result_repr !== '' && (
          <p className="plugins-panel-result-repr">
            result = <code>{result.result_repr}</code>
          </p>
        )}
      </div>
    );
  };

  const renderRun = (state: RunState) => (
    <div className="plugins-panel-run">
      <div className="plugins-panel-run-head">
        <span className="plugins-panel-name">{state.plugin.name}</span>
        <span className="plugins-panel-version">v{state.plugin.version}</span>
        {renderBadges(state.plugin)}
      </div>
      {state.plugin.description && (
        <p className="plugins-panel-desc">{state.plugin.description}</p>
      )}

      {!modelLoaded && (
        <p className="plugins-panel-hint">Load an IFC model first to run this plugin.</p>
      )}

      {state.plugin.params.length === 0 ? (
        <p className="plugins-panel-hint">This plugin takes no parameters.</p>
      ) : (
        <div className="plugins-panel-run-form">
          {state.plugin.params.map((param) => (
            <label className="plugins-panel-field" key={param.name}>
              <span className="plugins-panel-field-label">
                {param.label || param.name}
                {param.required && <span className="plugins-panel-req-star"> *</span>}
              </span>
              {param.type === 'boolean' ? (
                <span className="plugins-panel-check plugins-panel-check--cell">
                  <input
                    type="checkbox"
                    checked={state.values[param.name] === true}
                    disabled={state.running}
                    onChange={(e) => setRunValue(param.name, e.target.checked)}
                  />
                </span>
              ) : (
                <input
                  className="plugins-panel-input"
                  type={param.type === 'number' ? 'number' : 'text'}
                  step={param.type === 'number' ? 'any' : undefined}
                  value={
                    typeof state.values[param.name] === 'string'
                      ? (state.values[param.name] as string)
                      : ''
                  }
                  disabled={state.running}
                  onChange={(e) => setRunValue(param.name, e.target.value)}
                />
              )}
            </label>
          ))}
        </div>
      )}

      {state.fieldErrors && (
        <div className="plugins-panel-error" role="alert">
          <ul className="plugins-panel-error-list">
            {state.fieldErrors.map((err) => (
              <li key={err} className="plugins-panel-error-msg">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.error && (
        <div className="plugins-panel-error" role="alert">
          <span className="plugins-panel-error-msg">{state.error}</span>
        </div>
      )}

      <div className="plugins-panel-footer">
        <button
          className="plugins-panel-btn plugins-panel-btn--accent"
          onClick={() => void handleRunSubmit()}
          disabled={state.running || !modelLoaded}
          title={modelLoaded ? `Run ${state.plugin.name}` : 'Load an IFC model first'}
        >
          {state.running ? 'Running...' : 'Run'}
        </button>
        <button className="plugins-panel-btn" onClick={() => setRun(null)}>
          Back
        </button>
      </div>

      {state.result && renderRunResult(state.result)}
    </div>
  );

  // ── Shell ─────────────────────────────────────────────────────────────────

  const inSubView = run !== null || editor !== null;

  return (
    <div className="plugins-panel-overlay">
      <div className="plugins-panel" role="region" aria-label="Plugins">
        <div className="plugins-panel-header">
          {/* Docked, the breadcrumb says "Plugins" - so drop the icon + word but
              keep the subtitle (which script / run) for subview context. */}
          {(!embedded || editor || run) && (
            <span className="plugins-panel-title fpanel-title">
              {!embedded && (
                <>
                  <span className="fpanel-title-icon">
                    <Icon name="plug" size={14} />
                  </span>
                  Plugins
                </>
              )}
              {editor && (
                <span className="plugins-panel-subtitle">
                  {editor.source === 'new' ? 'new script' : editor.name || editor.originalId}
                </span>
              )}
              {run && <span className="plugins-panel-subtitle">run</span>}
            </span>
          )}
          <div className="plugins-panel-actions">
            {inSubView ? (
              <button
                className="plugins-panel-btn fpanel-icon-btn"
                onClick={() => {
                  if (run) setRun(null);
                  else {
                    setEditor(null);
                    setSaveError(null);
                  }
                }}
                aria-label="Back to plugin list"
              >
                <Icon name="chevron-left" size={13} />
                Back
              </button>
            ) : (
              !BROWSER_ONLY && (
                <>
                  <button
                    className="plugins-panel-btn plugins-panel-btn--accent"
                    onClick={() => {
                      setSaveError(null);
                      setEditor(newScriptEditor());
                    }}
                  >
                    New script
                  </button>
                  <button
                    className="plugins-panel-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={installing}
                    title="Install a plugin .zip (manifest.json + script.py)"
                  >
                    {installing ? 'Installing...' : 'Install'}
                  </button>
                  <button
                    className="plugins-panel-btn fpanel-icon-btn"
                    onClick={() => void refresh()}
                    disabled={listLoading}
                    title="Reload the plugin list"
                    aria-label="Reload the plugin list"
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                </>
              )
            )}
            {!embedded && (
              <button
                className="plugins-panel-btn fpanel-icon-btn"
                onClick={onClose}
                aria-label="Close plugins panel"
              >
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className="plugins-panel-file-input"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => void handleInstallPicked(e)}
        />

        <div className="plugins-panel-body">
          {BROWSER_ONLY ? (
            <p className="plugins-panel-empty">This feature needs the desktop backend.</p>
          ) : run ? (
            renderRun(run)
          ) : editor ? (
            renderEditor(editor)
          ) : (
            renderList()
          )}
        </div>
      </div>
    </div>
  );
}
