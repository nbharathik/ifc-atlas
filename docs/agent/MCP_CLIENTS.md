# MCP Clients: Connecting External LLMs

IFC Atlas exposes its toolset as an [MCP](https://modelcontextprotocol.io/) server, so external LLM clients (Claude Desktop, Cursor, Continue, the Claude.ai connector, or any custom script) can query (and optionally edit) the loaded IFC model.

By default the server exposes the **read** tier (every query / inspection tool plus the IDS validators). Setting `MCP_ALLOW_WRITES=1` additionally exposes the write tier (five write tools plus three pending-edit management tools) using a two-call diff-preview pattern: every write is staged first, then applied or discarded.

---

## Architecture

```
External LLM client
    │
    │  HTTP/SSE (Claude Desktop via mcp-remote, Cursor, custom scripts)
    ▼
backend/app/mcp_server/   (mounted at /mcp inside the FastAPI backend)
    │
    │  delegates to the shared execute_tool()
    ▼
ifc_service  (loaded model)
```

The MCP server is mounted inside the running FastAPI backend, so HTTP/SSE clients share live model state with the viewer: load a model in the browser and the external client immediately sees that same model.

---

## Transports

### HTTP / SSE (recommended)

Mounted at `/mcp/sse` on the FastAPI server (port 8000 by default):

```
http://localhost:8000/mcp/sse
```

This is the right transport for every client below. The viewer backend must be running, and a model must be loaded in the viewer for model-query tools to return data.

### stdio (development only)

`python -m app.mcp_server` runs a standalone server over stdio, in its own process with its own empty model state. It can **not** see the model loaded in the viewer, and there is no MCP tool for loading one, so model-query tools answer `No IFC model loaded`. Use it only for protocol-level development of the MCP server itself; for everything else, use HTTP/SSE.

---

## Claude Desktop

Claude Desktop launches local processes, so connect it to the backend's SSE endpoint through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge. Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ifc-atlas": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8000/mcp/sse"]
    }
  }
}
```

If the backend sets `MCP_SERVER_TOKEN`, pass it through:

```json
      "args": [
        "-y", "mcp-remote", "http://localhost:8000/mcp/sse",
        "--header", "Authorization: Bearer your-token-here"
      ]
```

Start the viewer backend, then restart Claude Desktop; "ifc-atlas" should appear in the connected servers list.

---

## Cursor

Cursor supports SSE servers directly. Add to `.cursor/mcp.json` in your project root (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "ifc-atlas": {
      "url": "http://localhost:8000/mcp/sse"
    }
  }
}
```

---

## Custom Python client

```python
import asyncio
from mcp import ClientSession
from mcp.client.sse import sse_client

async def main():
    async with sse_client("http://localhost:8000/mcp/sse") as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            print([t.name for t in tools.tools])
            result = await session.call_tool("get_project_info", {})
            print(result.content[0].text)

asyncio.run(main())
```

If `MCP_SERVER_TOKEN` is set, pass `headers={"Authorization": "Bearer your-token-here"}` to `sse_client`.

---

## Authentication (HTTP / SSE)

If `MCP_SERVER_TOKEN` is set in the backend environment, every HTTP / SSE request must carry a matching bearer token:

```
Authorization: Bearer your-token-here
```

Without the env var the endpoint is unauthenticated, which is only suitable for local development.

!!! warning "Do not expose `/mcp/*` publicly without a token"
    The MCP server has full read access to the loaded model. With `MCP_ALLOW_WRITES=1` it can mutate the model. Always set `MCP_SERVER_TOKEN` when the backend is reachable from the internet.

---

## Enabling write tools

Write tools are disabled by default. Set `MCP_ALLOW_WRITES=1` in the backend environment to expose them:

```bash
MCP_ALLOW_WRITES=1 python run.py
```

When the variable is unset (or `0`), every write tool and management tool returns `{"error": "not permitted … require MCP_ALLOW_WRITES=1"}`, and they are hidden from `list_tools`.

### Write tools

| Tool | Effect |
|---|---|
| `rename_element` | Rename an element by Express ID. |
| `update_property_value` | Update a property in a property set. |
| `create_wall_from_ends` | Build an `IfcWall` between two XY endpoints at a given height. |
| `delete_element` | Delete an element by Express ID. |
| `execute_ifc_code` | Run arbitrary Python in a sandboxed copy of the model. |

### Pending-edit management

| Tool | Effect |
|---|---|
| `list_pending_edits` | List every staged edit awaiting approval. |
| `apply_pending_edit` | Commit a staged edit to the live model. |
| `discard_pending_edit` | Abandon a staged edit (sandbox is dropped). |

### Two-call diff-preview pattern

Every write tool produces a **staged edit** rather than an immediate change.

1. **Stage**: call a write tool, e.g.:

    ```json
    {"tool": "rename_element", "arguments": {"express_id": 123, "new_name": "Wall A"}}
    ```

    Returns a `pending_edit` envelope:

    ```json
    {
      "action": "pending_edit",
      "edit_id": "uuid-...",
      "summary": "renamed 1 element",
      "diff": { "changed": [...] }
    }
    ```

2. **Commit**:

    ```json
    {"tool": "apply_pending_edit", "arguments": {"edit_id": "uuid-..."}}
    ```

3. **Or discard**:

    ```json
    {"tool": "discard_pending_edit", "arguments": {"edit_id": "uuid-..."}}
    ```

Any open viewer session receives the `pending_edit` event over the model-sync WebSocket the moment step 1 completes, so the **Diff Preview** panel lights up and the human can override the external client's decision in real time. `apply_pending_edit` from the external client and **Apply** in the viewer race; whichever fires first wins.

---

## Available tools

See [Tools Reference](TOOLS_REFERENCE.md) for the full catalogue with parameters and return shapes.

---

## Troubleshooting

**`No IFC model loaded`**: load a model in the viewer first, and make sure your client connects over HTTP/SSE to the running backend. A stdio-launched server is a separate process that never sees the viewer's model.

**Connection refused / server not found**: the viewer backend must be running (`python run.py` in `backend/`, or the desktop app); the SSE endpoint lives on its port (8000 by default).

**`401 Unauthorized` on HTTP / SSE**: set `Authorization: Bearer <token>` matching the `MCP_SERVER_TOKEN` env var.

**`Tool not found`**: write tools are hidden unless `MCP_ALLOW_WRITES=1`. Check the server's `list_tools` response to confirm what is exposed.
