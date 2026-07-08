# API Reference

IFC Atlas exposes a REST API and two WebSocket protocols for scripting and custom-client integration.

## Pages

| Page | Coverage |
|---|---|
| [REST API](REST.md) | Every HTTP endpoint (auto-generated from the FastAPI OpenAPI spec). |
| [WebSocket Protocol](WEBSOCKET.md) | Event schema for the chat streaming interface (auto-generated). |

The two generated pages are refreshed by `python scripts/generate_api_doc.py`. Add a new endpoint by registering it in `backend/app/api/`; the generator picks it up on the next run.

## Endpoint groups

| Prefix | Module | Purpose |
|---|---|---|
| `/api/health` | [`main.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/main.py) | Liveness probe. |
| `/api/ifc/*` | [`ifc_routes.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/api/ifc_routes.py) | IFC upload, geometry, edit-preview / apply / discard, IDS validation, checkpoints. |
| `/api/chat/*` | [`chat_routes.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/api/chat_routes.py) | Agents, tools, prompts, snippets, budgets, document index, WebSocket chat. |
| `/api/settings/*` | [`settings_routes.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/api/settings_routes.py) | Provider info and the secrets store (`~/.ifc-atlas/secrets.json`). |
| `/api/system/*` | [`system_routes.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/api/system_routes.py) | User-data folder paths and cache flush controls. |
| `/api/mcp/*` | [`mcp_routes.py`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/api/mcp_routes.py) | Read-only registry for **external** MCP servers. |
| `/mcp/*` | [`mcp_server/`](https://github.com/nbharathik/ifc-atlas/blob/main/backend/app/mcp_server/) | MCP server SSE endpoint that exposes the viewer toolset to external clients. |

## WebSocket endpoints

| Path | Purpose |
|---|---|
| `/api/chat/ws` | Main chat streaming (agent responses, tool calls, viewer commands, usage and budget telemetry). |
| `/api/ifc/sync/ws` | Live model-sync broadcasts (pending edits, applied patches, rebuild notices). |

## Base URLs

| Environment | Base |
|---|---|
| Local dev | `http://localhost:8000` |
| Docker Compose | `http://backend:8000` (internal) |
| Production | Whatever you point Caddy at. |

## Authentication

The REST API has no built-in auth. In production, terminate auth at the reverse proxy (basic auth, JWT middleware in Caddyfile, etc.).

The MCP server at `/mcp/*` honours an optional bearer token via the `MCP_SERVER_TOKEN` environment variable. Without it set, the endpoint is unauthenticated. See [MCP Clients](../agent/MCP_CLIENTS.md) for connection samples.

## OpenAPI and Swagger UI

When the backend is running:

- Swagger UI: <http://localhost:8000/docs>
- ReDoc: <http://localhost:8000/redoc>
- Raw OpenAPI JSON: <http://localhost:8000/openapi.json>
