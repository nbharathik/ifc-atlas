"""
Read-only REST for the MCP server registry.

The settings UI renders the catalogue so operators can see which
external tool servers are configured, whether they are enabled, and
what transport they use. Writes/reloads arrive in a later phase once
the live client is in place.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.services.mcp_registry import mcp_registry

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


@router.get("/servers")
async def list_servers() -> dict:
    return {
        "source": mcp_registry.source,
        "enabled": mcp_registry.enabled_server_names(),
        "servers": mcp_registry.list_servers(),
    }


@router.post("/reload")
async def reload() -> dict:
    """Re-read the config file without restarting the backend.

    Useful after the operator hand-edits mcp_servers.json - saves the
    Uvicorn reload cycle. Idempotent and safe to spam.
    """
    mcp_registry.reload()
    return {
        "source": mcp_registry.source,
        "count": len(mcp_registry.list_servers()),
    }
