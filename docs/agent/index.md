# AI Agent Reference

IFC Atlas ships an AI chat workspace that lets you query and inspect IFC models in plain English. The agent runs against your choice of LLM provider (OpenAI, Anthropic, or OpenRouter) and calls structured tools that the backend routes to the loaded model.

## What the agent can do

- **Answer questions** about the loaded model: element counts, storeys, materials, property sets, quantities, and relationships.
- **Drive the viewer** in response to chat queries: highlight, select, isolate, clip the section box.
- **Validate against IDS**: full buildingSMART IDS 1.0 validation with per-specification failure reports.
- **Run IfcOpenShell code** in a read-only sandbox via `execute_ifc_query_code` for custom analyses.

The **Edit Assistant** stages model edits (names, safe text attributes, existing property values, and beta geometry operations) through a sandboxed approval loop. Ask mode cannot write, and deployments can disable editing globally with `EDIT_MODE_ENABLED=0`.

## Pages in this section

| Page | Coverage |
|---|---|
| [Agent Interface](AGENT_INTERFACE.md) | Chat panel layout, readiness chip, tool-call blocks, slash commands. |
| [Agent Presets](AGENT_PRESETS.md) | The built-in agents with their allowed tools and example prompts. |
| [Custom Agents](CUSTOM_AGENTS.md) | Customising prompts from the Chat Manager and managing agents via the REST API. |
| [Tools Reference](TOOLS_REFERENCE.md) | Every tool the agent can call (auto-generated from the tool registry). |
| [MCP Clients](MCP_CLIENTS.md) | Connecting Claude Desktop, Cursor, or custom scripts to the viewer's MCP server. |

## Quick start

1. Drag an `.ifc` file onto the viewer.
2. Open the chat panel (right sidebar, or `Ctrl+/`).
3. Ask a question:

   > *"How many walls are on the ground floor?"*
   > *"List all windows with a U-value property set."*
   > *"Highlight every element missing a FireRating property."*

The agent calls the appropriate tools, streams its answer, and highlights or isolates elements in the viewer when relevant.
