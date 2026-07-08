"""
MCP (Model Context Protocol) server registry - scaffold only.

Goal: let operators point the chat LLM at external MCP servers without
code changes, by editing `backend/mcp_servers.json`. At runtime the
registry parses that file into a stable dataclass and exposes:

  list_servers()            -> JSON-safe catalogue for the settings UI
  get_server(name)          -> lookup a single entry
  enabled_server_names()    -> names of servers with enabled=true
  reload()                  -> re-read the file (for a future hot-reload)

This file intentionally does NOT open transports, spawn subprocesses,
or make HTTP calls yet - that's the "live" phase. Landing the config
surface + UI read model first lets us ship the settings screen and
iterate on the runtime in a second pass without churning the frontend.

When live MCP lands, only `McpToolSource.list_tools()` and
`McpToolSource.call(name, args)` need to be added; the registry entries
already carry enough transport detail (stdio command/args, or http url)
to construct a client per server.

Why a separate registry from TOOL_DEFINITIONS:
  Local tools are hot-path and read the loaded IFC model directly. MCP
  tools are optional, remote, and slow. Keeping the catalogues separate
  means a missing or broken MCP server never blocks core chat.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

from app.core.config import BASE_DIR

logger = logging.getLogger(__name__)

# Priority order: explicit live config only.
# Do not preload example entries in the UI - operators should see zero
# servers until they intentionally configure one.
_LIVE_CONFIG_PATH = Path(BASE_DIR) / "mcp_servers.json"


@dataclass
class McpServerConfig:
    name: str
    enabled: bool = False
    transport: str = "stdio"  # "stdio" | "http"
    command: Optional[str] = None
    args: list[str] = field(default_factory=list)
    url: Optional[str] = None
    description: str = ""
    # Future fields (headers, auth_token, timeout) plug in here.

    def to_dict(self) -> dict:
        d = asdict(self)
        # Never leak tokens; placeholder for when auth arrives.
        d.pop("auth_token", None)
        return d


class McpRegistry:
    """Read-only view over the MCP config file.

    Reload is manual on purpose: the config is tiny, the reload path is
    the one the settings UI will call after writes.
    """

    def __init__(self, live_path: Path = _LIVE_CONFIG_PATH):
        self._live_path = live_path
        self._servers: list[McpServerConfig] = []
        self._source: str = "none"
        self.reload()

    def reload(self) -> None:
        path, source = self._resolve_config_path()
        if path is None:
            self._servers = []
            self._source = "none"
            return

        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            logger.warning("MCP registry: failed to parse %s: %s", path, exc)
            self._servers = []
            self._source = "error"
            return

        raw_servers = data.get("servers") if isinstance(data, dict) else data
        if not isinstance(raw_servers, list):
            logger.warning("MCP registry: unexpected shape in %s", path)
            self._servers = []
            self._source = "error"
            return

        parsed: list[McpServerConfig] = []
        for entry in raw_servers:
            if not isinstance(entry, dict) or "name" not in entry:
                continue
            enabled_flag = bool(entry.get("enabled", False))
            parsed.append(McpServerConfig(
                name=str(entry["name"]),
                enabled=enabled_flag,
                transport=str(entry.get("transport", "stdio")),
                command=entry.get("command"),
                args=list(entry.get("args") or []),
                url=entry.get("url"),
                description=str(entry.get("description", "")),
            ))
        self._servers = parsed
        self._source = source
        logger.info("MCP registry loaded %d servers from %s (%s)", len(parsed), path, source)

    def _resolve_config_path(self) -> tuple[Optional[Path], str]:
        if self._live_path.exists():
            return self._live_path, "live"
        return None, "none"

    # -- Query API -----------------------------------------------------

    def list_servers(self) -> list[dict]:
        return [s.to_dict() for s in self._servers]

    def get_server(self, name: str) -> Optional[McpServerConfig]:
        for s in self._servers:
            if s.name == name:
                return s
        return None

    def enabled_server_names(self) -> list[str]:
        return [s.name for s in self._servers if s.enabled]

    @property
    def source(self) -> str:
        """'live' if mcp_servers.json is present, 'none' if missing,
        'error' on parse failure."""
        return self._source


mcp_registry = McpRegistry()
