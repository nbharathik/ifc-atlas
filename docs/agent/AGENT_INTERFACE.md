# Agent Interface

The AI chat panel lives in the right sidebar. It opens a WebSocket to the backend and streams LLM responses, tool calls, and viewer actions in real time.

## Chat panel

Open or close the chat panel with `Ctrl+/` (or click the **Chat** tab in the right sidebar). Press `C` to focus it when the right sidebar is already open.

### AI readiness chip

A small chip below the toolbar shows the warm-up state of the backend after an upload:

| Chip | Meaning |
|---|---|
| **AI warming up…** (amber, pulsing) | IfcOpenShell is still loading. Deep tools (search, properties, IDS) return `{warming: true, retry_after_ms: 2000}` if called now. |
| **AI ready · 480 ms** (emerald) | Both backends ready. The number is how long the semantic backend took to warm. |
| **AI ready (native index off)** (yellow) | IfcOpenShell is up; the optional native metadata sidecar didn't build. Deep tools still work. |
| **AI unavailable** (red) | IfcOpenShell errored on load. Hover for the error message. |

The chip is push-driven over the model-sync WebSocket (`type: "readiness_changed"`). While pre-ready, a 10-second safety-net poll hits `GET /api/ifc/readiness`. Both signals stop once the backend settles.

For agents: if a tool returns `{warming: true, …}`, pause for `retry_after_ms` and re-issue the call. Viewer-only tools (`highlight_elements`, `isolate_elements`, `select_element`, `show_all_elements`, `clip_section_box_to_element`) are exempt and run immediately.

### Mode

The chat panel runs in **Ask** mode: the agent can search, inspect, and highlight, but write tools are blocked at the API layer. An experimental **Edit** mode (sandboxed writes with Diff Preview) exists behind the `EDIT_MODE_ENABLED` flag and is disabled in this release, so the Edit pill is hidden.

### Model dropdown

Next to the mode pill, a dropdown lists every enabled entry from the Model Registry, grouped by provider (OpenAI, Anthropic, OpenRouter). Manage the list in Chat Manager → **Models**.

### Input box

| Action | Key |
|---|---|
| Send | `Enter` |
| Newline | `Shift+Enter` |
| Cancel a streaming response | `Esc` (same as the Stop button) |
| Slash-command palette | `/` at the start of an empty input |

Drag a file onto the input to attach it (PDF, CSV, IDS XML).

### Slash commands

| Command | Effect |
|---|---|
| `/help` | Show every available slash command. |
| `/clear` | Clear the conversation. |
| `/agent <id>` | Switch the active agent (or list agents when no id is given). |
| `/model <provider:id>` | Switch the LLM model (or show the current one). |
| `/find <query>` | Search elements by name or type. |
| `/isolate <express ids>` | Isolate the matching elements. |
| `/ids` | Validate the attached IDS file against the model. |

### Tool-call blocks

Every tool call appears as a collapsible block in the thread:

- Tool name and arguments (collapsed by default; expand to inspect).
- Result summary or error.
- **Cache badge** for results served from per-turn memoisation.
- **Lock banner** for write calls blocked in this release.
- **`_source: native_index`** tag when the answer came from the native metadata index.
- **Edit staged** chip (only when writes are enabled): the result is a pending edit; click it to open the Diff Preview panel.

## Chat Manager

`Ctrl+Shift+M` opens the Chat Manager, the single configuration surface for agents, models, skills, tools, the document index, MCP servers, and provider settings. See the [user guide](../user/FEATURES.md#chat-manager-ctrlshiftm) for the full tab list.

## Performance Dashboard

Press `Shift+M` for a sparkline of the last 50 model loads, coloured by load source (live parse, local cache, server convert, server cache). Hover a dot for exact source and TTFR; the summary row shows average, best, worst, and sample count.
