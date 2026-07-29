# Agents

IFC Atlas ships two built-in agents. An agent defines the system prompt, the LLM provider and model, the temperature, the allowed tools, and the quick-prompt chips shown above the chat input.

Built-in agents are read-only: they cannot be deleted or renamed. To specialise the assistant for a task, activate (or fork) a system prompt from Chat Manager → **Skills**, or manage [custom agents](#custom-agents) through the REST API.

---

## Default

- **Role:** General-purpose BIM assistant. Powers the **Ask** mode of the chat panel.
- **Allowed tools:** All registered tools. Write tools are still blocked at the API layer, so the agent is read-only in practice.
- **When to use:** Anything: model questions, quantity summaries, property searches, IDS validation, viewer commands.
- **Examples:**
  - *"Summarise this IFC model."*
  - *"How many elements are on each storey?"*
  - *"Highlight all doors and windows."*
  - *"Sum the net area of every IfcSlab on storey 1."*
  - *"Find all elements with no name."*

---

## Edit Assistant

- **Role:** BIM authoring assistant that proposes and applies edits in small, reviewable steps. The only agent with write tools.
- **Status:** Available by default. `EDIT_MODE_ENABLED=0` hides Edit mode and hard-blocks every write tool for read-only deployments.
- **Allowed tools:** Read tools (`describe_model`, `query_elements`, `get_element`, `execute_ifc_query_code`, `get_docs`), the viewer tool (`viewer_control`), and the write tier (`edit_semantic`, `edit_structural`, `execute_ifc_code`, `undo_last_edit`, `get_edit_history`). See the [Tools Reference](TOOLS_REFERENCE.md) for each tool's parameters.
- **Use for:** Bulk renames, safe text attributes, property standardisation, data cleanup, and reviewed scripted edits.
- **Examples:**
  - *"Rename all walls on Ground Floor to 'Exterior Wall'."*
  - *"Add IsExternal=true to the Pset_WallCommon of all IfcWall elements."*
  - *"Show the edit history for this session."*

Every write tool stages a diff to the **Diff Preview** panel; nothing touches the live model until you click **Apply**.

---

## Specialising with Skills

Earlier releases shipped a roster of specialist presets (analyst, quantity surveyor, auditor, and so on). Those have been replaced by **Skills**: detailed system prompts you activate from Chat Manager → **Skills**.

1. Press `Ctrl+Shift+M` to open the **Chat Manager**.
2. Switch to the **Skills** tab. It lists every system prompt and snippet.
3. Click **Edit** on a built-in skill. Built-ins cannot be mutated, so saving creates your own editable copy (fork-on-edit). Or click **New** to write a prompt from scratch.
4. Click **Use** to make that prompt the active system prompt for the chat.

Custom skills persist server-side in your user data folder (`~/.ifc-atlas/data/system_prompts.json`), so they survive restarts and are shared by every browser session against the same backend. This keeps one agent surface while still letting you tune the assistant's focus per task.

The **Agents** tab of the Chat Manager shows the built-in agents and their tool allowlists. In-app creation of full custom agents is planned for a later release; until then, use the REST API below.

---

## Custom agents

Custom agents (name, system prompt, model, tool allowlist, budget) can be created and managed through the REST API. A custom agent appears in `GET /api/chat/agents` and can be activated in chat with the `/agent <id>` slash command. See the full schema in [`REST API → /api/chat/agents`](../api/REST.md).

### List

```http
GET /api/chat/agents
```

Returns a JSON array of every agent (built-in plus custom).

### Create

```http
POST /api/chat/agents
Content-Type: application/json

{
  "label": "Cost Estimator",
  "description": "Extracts quantities and estimates costs using a rate card.",
  "system_prompt": "You are a cost estimator…",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "temperature": 0.2,
  "allowed_tools": ["quantity_summary", "query_elements", "execute_ifc_query_code"],
  "quick_prompts": ["Estimate total wall cost", "Show slab quantities"],
  "monthly_budget_usd": 10.0,
  "fallback_model": "claude-haiku-4-5-20251001"
}
```

### Update

```http
PUT /api/chat/agents/{agent_id}
Content-Type: application/json

{ "label": "Updated Name", … }
```

### Delete

```http
DELETE /api/chat/agents/{agent_id}
```

Returns `{"deleted": "<agent_id>"}` on success. Built-in agents cannot be deleted and return `403 Forbidden`; an unknown id returns `404 Not Found`.

### Persistence

Custom agents persist to `~/.ifc-atlas/data/custom_agents.json` (see [Data Storage](../user/DATA_STORAGE.md)), so they survive backend restarts.

Back up the file before upgrading the backend if you maintain a curated agent library.
