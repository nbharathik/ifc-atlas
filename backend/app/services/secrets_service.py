"""
Per-user API-key store at ``~/.ifc-atlas/secrets.json``.

Resolution order for ``get_api_key(provider)``:

    1. Shell / ``.env`` environment variable (e.g. ``OPENAI_API_KEY``).
       This is the developer fallback - anything set there wins.
    2. ``secrets.json`` in the user data dir.
       This is what the in-app "AI Keys" UI writes to.
    3. Empty string ("not configured").

Why a separate JSON file instead of writing to ``~/.ifc-atlas/.env``:
``.env`` is hand-edited by developers; clobbering it on every UI save would
be rude. ``secrets.json`` is owned by the UI and safe to rewrite atomically.

Atomic writes (tmpfile + ``os.replace``) so a crashed write never leaves a
half-written file. File permissions tightened to ``0o600`` on POSIX; on
Windows the user profile is already user-scoped.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Iterable

from app.core.config import BASE_DIR

logger = logging.getLogger(__name__)


SECRETS_PATH: Path = BASE_DIR / "secrets.json"

# Providers managed by the UI. Order = the order shown in the modal.
SUPPORTED_PROVIDERS: tuple[str, ...] = ("openai", "anthropic", "openrouter")

_ENV_VAR: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}


def _env_var_for(provider: str) -> str:
    return _ENV_VAR.get(provider, "")


# ── File I/O ────────────────────────────────────────────────────────────────


def _read_file() -> dict[str, str]:
    """Return the on-disk secret map, or ``{}`` if missing / malformed."""
    if not SECRETS_PATH.exists():
        return {}
    try:
        with SECRETS_PATH.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("secrets.json unreadable (%s); treating as empty.", exc)
        return {}
    if not isinstance(data, dict):
        logger.warning("secrets.json root is %s, expected object; ignoring.", type(data).__name__)
        return {}
    cleaned: dict[str, str] = {}
    for provider, value in data.items():
        if provider in SUPPORTED_PROVIDERS and isinstance(value, str) and value.strip():
            cleaned[provider] = value.strip()
    return cleaned


def _write_file(data: dict[str, str]) -> None:
    """Atomically write ``data`` to ``SECRETS_PATH`` with 0o600 on POSIX."""
    SECRETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    # tempfile in same dir so os.replace is atomic on the same volume
    fd, tmp_path = tempfile.mkstemp(
        prefix=".secrets.", suffix=".tmp", dir=str(SECRETS_PATH.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
        if os.name == "posix":
            try:
                os.chmod(tmp_path, 0o600)
            except OSError:  # pragma: no cover - best-effort
                pass
        os.replace(tmp_path, SECRETS_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Public API ──────────────────────────────────────────────────────────────


def get_api_key(provider: str) -> str:
    """Return the active key for ``provider``, or ``""`` if none.

    Always evaluated fresh - never cached at module scope, so UI edits take
    effect on the very next LLM call without restarting the backend.
    """
    env_name = _env_var_for(provider)
    if env_name:
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            return env_value
    return _read_file().get(provider, "")


def get_source(provider: str) -> str | None:
    """Return ``"env"``, ``"file"``, or ``None`` for where the key resolves."""
    env_name = _env_var_for(provider)
    if env_name and os.environ.get(env_name, "").strip():
        return "env"
    if _read_file().get(provider):
        return "file"
    return None


def _mask(value: str) -> str:
    """Return ``"sk-12…wxyz"`` style mask. Never returns the raw key."""
    if not value:
        return ""
    if len(value) <= 8:
        return "…" + value[-2:]
    return f"{value[:4]}…{value[-4:]}"


def status_payload() -> dict[str, dict]:
    """Per-provider status the UI consumes - never includes raw values."""
    out: dict[str, dict] = {}
    file_data = _read_file()
    for provider in SUPPORTED_PROVIDERS:
        env_name = _env_var_for(provider)
        env_value = os.environ.get(env_name, "").strip() if env_name else ""
        file_value = file_data.get(provider, "")
        active = env_value or file_value
        if env_value:
            source: str | None = "env"
        elif file_value:
            source = "file"
        else:
            source = None
        out[provider] = {
            "configured": bool(active),
            "source": source,
            "env_var": env_name,
            "masked": _mask(active),
        }
    return out


def set_api_keys(updates: dict[str, str]) -> None:
    """Merge ``updates`` into ``secrets.json``.

    Only entries whose value is a non-empty string update; empty strings are
    ignored (use :func:`delete_api_key` to remove). Unsupported providers
    are silently skipped.
    """
    current = _read_file()
    changed = False
    for provider, value in updates.items():
        if provider not in SUPPORTED_PROVIDERS:
            continue
        if not isinstance(value, str):
            continue
        v = value.strip()
        if not v:
            continue
        if current.get(provider) != v:
            current[provider] = v
            changed = True
    if changed:
        _write_file(current)


def delete_api_key(provider: str) -> bool:
    """Remove a single provider's stored key. Returns ``True`` if removed."""
    if provider not in SUPPORTED_PROVIDERS:
        return False
    current = _read_file()
    if provider not in current:
        return False
    del current[provider]
    if current:
        _write_file(current)
    else:
        # Clean up the empty file so the dir stays tidy.
        try:
            SECRETS_PATH.unlink()
        except FileNotFoundError:
            pass
    return True


def delete_all(providers: Iterable[str] | None = None) -> list[str]:
    """Remove keys for ``providers`` (or every supported provider).

    Returns the list of providers that actually had a stored key removed.
    Env-var keys are never touched - they live outside this store.
    """
    targets = list(providers) if providers else list(SUPPORTED_PROVIDERS)
    removed: list[str] = []
    current = _read_file()
    for provider in targets:
        if provider in current:
            del current[provider]
            removed.append(provider)
    if removed:
        if current:
            _write_file(current)
        else:
            try:
                SECRETS_PATH.unlink()
            except FileNotFoundError:
                pass
    return removed
