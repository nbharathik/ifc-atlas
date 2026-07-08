import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from '../ui/Icon';
import {
  deleteSecret,
  getSecretsStatus,
  updateSecrets,
  type SecretsStatusResponse,
  type SecretStatusEntry,
} from '../../services/api';

type ProviderId = 'openai' | 'anthropic' | 'openrouter';

interface ProviderMeta {
  id: ProviderId;
  name: string;
  hint: string;
  placeholder: string;
  signupUrl: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    hint: 'Keys start with sk-…  Project keys recommended.',
    placeholder: 'sk-…',
    signupUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    hint: 'Keys start with sk-ant-…',
    placeholder: 'sk-ant-…',
    signupUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'Keys start with sk-or-…  One key, many models.',
    placeholder: 'sk-or-…',
    signupUrl: 'https://openrouter.ai/keys',
  },
];

interface Props {
  /**
   * "onboarding" - first-run prompt; intro copy & no provider rows when keys
   *   are missing across the board.
   * "manage" - opened from settings; allow edit + delete per row.
   */
  mode: 'onboarding' | 'manage';
  onClose: () => void;
  /** Fires after a successful save / delete so the caller can refresh status. */
  onChanged?: (status: SecretsStatusResponse) => void;
}

function statusBadge(entry: SecretStatusEntry | undefined): {
  text: string;
  tone: 'idle' | 'saved' | 'env';
} {
  if (!entry?.configured) return { text: 'not set', tone: 'idle' };
  if (entry.source === 'env') return { text: `env · ${entry.masked}`, tone: 'env' };
  return { text: `saved · ${entry.masked}`, tone: 'saved' };
}

export default function AiKeysModal({ mode, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<Record<string, SecretStatusEntry>>({});
  const [drafts, setDrafts] = useState<Record<ProviderId, string>>({
    openai: '',
    anthropic: '',
    openrouter: '',
  });
  const [reveal, setReveal] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    openrouter: false,
  });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // ESC closes only this modal. Capture phase + stopPropagation so the
  // parent Chat Manager's own ESC listener (bubble phase on window) never
  // sees the event - otherwise ESC here would close the outer panel too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    getSecretsStatus()
      .then((r) => {
        if (!cancelled) {
          setStatus(r.providers);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!savedFlash) return;
    const t = window.setTimeout(() => setSavedFlash(null), 2400);
    return () => window.clearTimeout(t);
  }, [savedFlash]);

  const draftCount = useMemo(
    () => PROVIDERS.filter((p) => drafts[p.id].trim().length > 0).length,
    [drafts],
  );
  const hasAnyConfigured = useMemo(
    () => PROVIDERS.some((p) => status[p.id]?.configured),
    [status],
  );
  const configuredCount = useMemo(
    () => PROVIDERS.filter((p) => status[p.id]?.configured).length,
    [status],
  );

  async function handleSave() {
    setActionError(null);
    const payload: Record<string, string> = {};
    for (const p of PROVIDERS) {
      const v = drafts[p.id].trim();
      if (v) payload[p.id] = v;
    }
    const savedKeys = Object.keys(payload);
    if (savedKeys.length === 0) {
      setActionError('Enter at least one key, or press Close.');
      return;
    }
    setBusy(true);
    try {
      const res = await updateSecrets(payload);
      setStatus(res.providers);
      // Only clear the inputs we just persisted - leave any in-progress
      // typing on other rows alone.
      setDrafts((d) => {
        const next = { ...d };
        for (const id of savedKeys) next[id as ProviderId] = '';
        return next;
      });
      onChanged?.(res);
      setSavedFlash(
        `Saved ${savedKeys.length} key${savedKeys.length === 1 ? '' : 's'} · effective on the next chat message.`,
      );
      // Onboarding mode: users came here to unblock chat, not to admire
      // the modal - close on first successful save.
      if (mode === 'onboarding') onClose();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(provider: ProviderId) {
    const entry = status[provider];
    if (!entry?.configured) return;
    if (entry.source === 'env') {
      setActionError(
        `${provider} is set by an environment variable (${entry.env_var}). ` +
          'Edit your .env file or shell to remove it - the in-app store cannot override it.',
      );
      return;
    }
    if (!window.confirm(`Delete the saved ${provider} key? You can paste a new one any time.`)) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await deleteSecret(provider);
      setStatus(res.providers);
      onChanged?.(res);
      setSavedFlash(`Removed ${provider} key.`);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteAll() {
    if (!window.confirm('Delete all saved AI keys from ~/.ifc-atlas/secrets.json?')) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await deleteSecret('all');
      setStatus(res.providers);
      onChanged?.(res);
      setSavedFlash('All saved keys removed.');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const saveLabel = busy
    ? 'Saving…'
    : draftCount > 0
    ? `Save ${draftCount} key${draftCount === 1 ? '' : 's'}`
    : 'Save keys';

  const dialog = (
    <div
      className="agent-editor-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="agent-editor-modal ai-keys-modal" role="dialog" aria-labelledby="ai-keys-title">
        <div className="agent-editor-header ai-keys-header">
          <span className="agent-editor-title ai-keys-title" id="ai-keys-title">
            <Icon name="lock" size={14} />
            {mode === 'onboarding' ? 'Connect an AI provider' : 'AI provider keys'}
          </span>
          <button className="btn-icon" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="agent-editor-body ai-keys-body">
          <div className="ai-keys-summary">
            <Icon name={mode === 'onboarding' && !hasAnyConfigured ? 'zap' : 'shield'} size={15} />
            <p>
              {mode === 'onboarding' && !hasAnyConfigured ? (
                <>
                  Add a hosted provider key to use AI chat. Keys are written to{' '}
                  <code>~/.ifc-atlas/secrets.json</code> on this machine - never
                  uploaded - and take effect on the next message.
                </>
              ) : (
                <>
                  <strong>
                    {loadError
                      ? "Couldn't reach the backend yet."
                      : loaded
                      ? `${configuredCount} of ${PROVIDERS.length} providers configured.`
                      : 'Checking provider configuration…'}
                  </strong>{' '}
                  Stored at <code>~/.ifc-atlas/secrets.json</code>. A key in your{' '}
                  <code>.env</code> or shell wins over the saved one.
                </>
              )}
            </p>
          </div>

          {!loaded ? (
            <div className="ai-keys-state">
              <Icon name="loader" size={16} />
              <span>Checking provider keys…</span>
            </div>
          ) : loadError ? (
            <div className="ai-keys-state ai-keys-state--error">
              <Icon name="alert-circle" size={16} />
              <div className="ai-keys-state-copy">
                <strong>Couldn't reach the backend</strong>
                <span>{loadError}</span>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="ai-keys-provider-list">
              {PROVIDERS.map((p) => {
                const entry = status[p.id];
                const configured = !!entry?.configured;
                const fromEnv = entry?.source === 'env';
                const badge = statusBadge(entry);
                const isRevealed = reveal[p.id];
                return (
                  <section
                    key={p.id}
                    className={`ai-key-provider ai-key-provider--${badge.tone}`}
                  >
                    <header className="ai-key-provider-header">
                      <div className="ai-key-provider-copy">
                        <strong>{p.name}</strong>
                        <span>{p.hint}</span>
                      </div>
                      <span
                        className={`ai-key-status ai-key-status--${badge.tone}`}
                        title={badge.text}
                      >
                        {badge.text}
                      </span>
                    </header>

                    <div className="ai-key-input-row">
                      <input
                        type={isRevealed ? 'text' : 'password'}
                        autoComplete="off"
                        spellCheck={false}
                        className="agent-editor-input ai-key-input"
                        value={drafts[p.id]}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                        placeholder={
                          fromEnv
                            ? `Override ${entry?.env_var} with a saved key`
                            : configured
                            ? `Replace saved key (${entry?.masked})`
                            : p.placeholder
                        }
                        disabled={busy}
                        aria-label={`${p.name} API key`}
                      />
                      <button
                        type="button"
                        className="btn-secondary ai-key-icon-button"
                        onClick={() => setReveal((r) => ({ ...r, [p.id]: !r[p.id] }))}
                        title={isRevealed ? 'Hide key' : 'Show key'}
                        aria-label={isRevealed ? 'Hide key' : 'Show key'}
                        disabled={!drafts[p.id]}
                      >
                        <Icon name={isRevealed ? 'eye-off' : 'eye'} size={14} />
                      </button>
                      {mode === 'manage' && configured && !fromEnv && (
                        <button
                          type="button"
                          className="btn-secondary ai-key-icon-button ai-key-danger-button"
                          onClick={() => handleDelete(p.id)}
                          disabled={busy}
                          title={`Delete saved ${p.name} key`}
                          aria-label={`Delete saved ${p.name} key`}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>

                    <div className="ai-key-provider-meta">
                      <a href={p.signupUrl} target="_blank" rel="noreferrer">
                        Get a key
                        <Icon name="external-link" size={11} />
                      </a>
                      {fromEnv && (
                        <span>
                          Active from <code>{entry?.env_var}</code> - a saved key
                          here is ignored until the env var is unset.
                        </span>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}

          {savedFlash && !actionError && (
            <div className="ai-keys-flash" role="status">
              <Icon name="check" size={14} />
              <span>{savedFlash}</span>
            </div>
          )}

          {actionError && (
            <div className="ai-keys-alert" role="alert">
              <Icon name="alert-circle" size={14} />
              <span>{actionError}</span>
            </div>
          )}
        </div>

        <div className="ai-keys-footer">
          <div>
            {mode === 'manage' && hasAnyConfigured && !loadError && (
              <button
                type="button"
                className="btn-secondary ai-key-danger-button"
                onClick={handleDeleteAll}
                disabled={busy}
              >
                Delete all saved keys
              </button>
            )}
          </div>
          <div className="ai-keys-footer-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              {mode === 'onboarding' ? 'Skip for now' : 'Close'}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={busy || !loaded || !!loadError || draftCount === 0}
            >
              {saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}
