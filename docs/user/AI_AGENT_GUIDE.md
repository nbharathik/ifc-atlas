# AI Agent Guide

Every chat message in IFC Atlas is handled by an **agent**: a named persona with a system prompt, a model, and a tool allowlist. This guide explains the agents that ship in the box, how a request flows through the system, and how to write prompts that get useful answers back.

---

## Ask mode

The chat panel runs in **Ask** mode: read-only questions and viewer commands. The agent can search, inspect, and highlight, but it cannot mutate the model. The backend rejects any write attempt at the API layer, so a prompt cannot trick a read-only conversation into making edits.

!!! note "Edit mode is approval-driven"
    **Ask** mode is always read-only. **Edit** mode is available by default and stages agent writes through a sandboxed diff-preview loop where you **Apply** or **Discard** every change. Administrators can set `EDIT_MODE_ENABLED=0` for a read-only deployment.

---

## Built-in agents

| Agent | Mode | When to use |
|---|---|---|
| **Default** | Ask | General-purpose, all read tools enabled. Answers model questions, runs quantity summaries, drives the viewer (highlight, isolate, select). |
| **Edit Assistant** | Edit | Semantic and beta geometry edits, with every agent write staged through an inline approval preview. |

Each agent has its own system prompt, model, temperature, and tool allowlist. To specialise the assistant for a task (quantity take-off, model audit, IDS review), activate a system prompt from Chat Manager (`Ctrl+Shift+M`) → **Skills**: built-in prompts are read-only, and editing one forks it into your own editable copy that persists server-side. Custom agents can also be managed through the [REST API](../agent/CUSTOM_AGENTS.md).

---

## How a request flows

1. **You type a message.** The agent sees it together with the chat history, its system prompt, and a compact summary of the loaded model (project name, schema, element counts, storeys, materials).
2. **The agent decides which tools to call.** Most questions run one to three search tools (`get_model_stats`, `search_elements`, `search_by_property`, and so on).
3. **Each tool call reaches the backend.** It is routed to the appropriate service (the IFC service, the IDS validator, the native metadata index, the script sandbox) or back to the frontend for viewer operations such as `highlight_elements` or `isolate_elements`.
4. **The result streams back.** Every tool call and its result appear in the per-message tool-call log for inspection.
5. **The agent writes the answer.** Text streams token by token.

---

## Example prompts

### Model questions

- *"What is the gross floor area of this model?"*
- *"List every storey and its elevation in metres."*
- *"Which walls are fire-rated at 60 minutes or higher?"*
- *"How many IfcDoor instances are there?"*

### Quantities and take-offs

- *"Sum the net area of every IfcSlab on storey 1."*
- *"Volume of all exterior walls, grouped by material."*
- *"Count each structural element type."*

### IDS validation

- *"Validate the attached IDS against the model and report failures by spec."* (attach the IDS file to the message)
- *"Which elements fail the IDS compliance check?"*

### Data quality

- *"Score this model for data completeness on a 1 to 5 scale."*
- *"Which element types are missing their standard property sets?"*
- *"Find all elements with no name."*

### Viewer commands

- *"Highlight all doors and windows."*
- *"Isolate the ground floor."*
- *"Show everything again."*

---

## Choosing a model

The model dropdown in the chat toolbar is populated from the **Model Registry** (Chat Manager → **Models** tab), a fully editable catalogue of OpenAI, Anthropic, and OpenRouter models. You can add, edit, enable, or reorder entries and tune per-model sampling parameters. Reasoning models automatically omit `temperature` and `top_p`, since those providers reject them. Switch models mid-conversation with the dropdown or the `/model provider:model_id` slash command.

---

## Per-agent tool allowlist

Every agent's tool allowlist is enforced server-side. A call to a tool outside the allowlist is rejected with `tool_not_allowed` before it reaches the model data. Write tools are additionally blocked at the API layer in this release, regardless of which agent is active.

---

## Cost telemetry and budgets

A chip below each assistant message shows total tokens and approximate USD cost; hover for a per-call breakdown by provider and model. Each agent can carry a monthly USD spending cap with an optional fallback model. Press `Shift+B` for the **Budget Dashboard**.

---

## MCP: bringing your own tools and exposing the viewer

- **MCP client.** Register external MCP servers under Chat Manager → **MCP Servers**. Their tools become available to agents whose allowlist includes them.
- **MCP server.** The viewer exposes its own toolset over MCP at `/mcp` (SSE) so Claude Desktop, Cursor, or any MCP-compatible client can query the loaded model. Set `MCP_SERVER_TOKEN` to require bearer-token auth. Write tools are hidden unless the backend is started with `MCP_ALLOW_WRITES=1`; external writes then use a two-call diff-preview pattern (stage, then apply or discard). See [MCP Clients](../agent/MCP_CLIENTS.md).

---

## See also

- [Features](FEATURES.md): the complete catalogue.
- [Keyboard Shortcuts](KEYBOARD_SHORTCUTS.md): full key reference.
- [Troubleshooting](TROUBLESHOOTING.md): common chat issues.
