"""
Settings API routes - provider status, configuration, and per-user secrets.

Keys are resolved fresh on every request via
:func:`app.services.secrets_service.get_api_key` so an edit through the UI
takes effect on the very next LLM call (no restart needed).
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import secrets_service

router = APIRouter(prefix="/api/settings", tags=["settings"])


def provider_status_payload() -> dict:
    """Per-provider configuration status, embedded in /chat/manager/bootstrap.

    The frontend never sees the actual key value, only whether one resolves,
    where it comes from (``env`` vs ``file``), and a short mask for display.
    """
    secrets_status = secrets_service.status_payload()

    def _entry(provider: str, name: str, base_url: Optional[str], default_model: str) -> dict:
        s = secrets_status.get(provider, {})
        return {
            "name": name,
            "configured": bool(s.get("configured")),
            "source": s.get("source"),
            "masked": s.get("masked", ""),
            "env_var": s.get("env_var", ""),
            "base_url": base_url,
            "default_model": default_model,
        }

    return {
        "openai": _entry("openai", "OpenAI", None, "gpt-4o"),
        "anthropic": _entry("anthropic", "Anthropic", None, "claude-sonnet-4-6"),
        "openrouter": _entry(
            "openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter/auto"
        ),
    }


# ── Per-user secrets (writable) ─────────────────────────────────────────────


class SecretsUpdateRequest(BaseModel):
    """All fields optional - only the keys present in the payload are written."""

    openai: Optional[str] = Field(default=None)
    anthropic: Optional[str] = Field(default=None)
    openrouter: Optional[str] = Field(default=None)


@router.get("/secrets")
async def get_secrets_status() -> dict:
    """Status-only view of the per-user secrets file. No raw keys."""
    return {"providers": secrets_service.status_payload()}


@router.put("/secrets")
async def update_secrets(payload: SecretsUpdateRequest) -> dict:
    """Merge non-empty values from ``payload`` into ``secrets.json``.

    Empty / missing fields are ignored - to remove a key use DELETE.
    Returns the refreshed status so the UI can re-render in one round trip.
    """
    updates = {k: v for k, v in payload.model_dump().items() if v}
    if updates:
        secrets_service.set_api_keys(updates)
    return {"providers": secrets_service.status_payload()}


@router.delete("/secrets/{provider}")
async def delete_secret(provider: str) -> dict:
    """Remove a stored key for ``provider``, or ``provider="all"``.

    Env-var keys are never touched - they live outside this store. If the
    user wants to remove an env-var key they must edit ``.env`` / their
    shell themselves.
    """
    if provider == "all":
        removed = secrets_service.delete_all()
        return {"removed": removed, "providers": secrets_service.status_payload()}
    if provider not in secrets_service.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")
    removed_ok = secrets_service.delete_api_key(provider)
    return {
        "removed": [provider] if removed_ok else [],
        "providers": secrets_service.status_payload(),
    }
