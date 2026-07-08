"""
stdio entry point for the MCP server.

Usage (from the backend/ directory):
    python -m app.mcp_server

For Claude Desktop add to claude_desktop_config.json:
    {
      "mcpServers": {
        "ifc-viewer": {
          "command": "python",
          "args": ["-m", "app.mcp_server"],
          "cwd": "/absolute/path/to/backend",
          "env": { "PYTHONPATH": "/absolute/path/to/backend" }
        }
      }
    }

Optional: set MCP_SERVER_TOKEN env var to enable bearer-token auth on
the HTTP/SSE transport (stdio transport inherits process-level trust and
does not need a token).
"""

import asyncio
import sys

from mcp import stdio_server

from app.mcp_server.server import server


async def _run() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


def main() -> None:
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(0)
    asyncio.run(_run())


if __name__ == "__main__":
    main()
