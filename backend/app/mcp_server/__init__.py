"""
MCP server package - viewer-as-server.

Read-only tools and the viewer bridge tools (observe/drive the 3D viewer,
including live snapshots) are exposed via HTTP/SSE and stdio transports.
Write tools + management tools are gated behind MCP_ALLOW_WRITES=1.
"""

from app.mcp_server.server import (
    build_sse_app,
    list_all_tool_names,
    list_exposed_mgmt_tools,
    list_exposed_tools,
    list_exposed_viewer_tools,
    list_exposed_write_tools,
    server,
)

__all__ = [
    "build_sse_app",
    "list_all_tool_names",
    "list_exposed_mgmt_tools",
    "list_exposed_tools",
    "list_exposed_viewer_tools",
    "list_exposed_write_tools",
    "server",
]
