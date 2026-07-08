# Custom Agents

Built-in agents are read-only. There are two ways to customise the assistant: fork a system prompt from the Chat Manager, or manage full custom agents through the REST API.

## Customising in the app: the Skills tab

1. Press `Ctrl+Shift+M` to open the **Chat Manager**.
2. Switch to the **Skills** tab. It lists every system prompt and snippet.
3. Click **Edit** on a built-in skill. Built-ins cannot be mutated, so saving creates your own editable copy (fork-on-edit). Or click **New** to write a prompt from scratch.
4. Click **Use** to make that prompt the active system prompt for the chat.

Custom skills persist server-side in your user data folder (`~/.ifc-atlas/data/system_prompts.json`), so they survive restarts and are shared by every browser session against the same backend.

The **Agents** tab of the Chat Manager shows the built-in agents and their tool allowlists. In-app creation of full custom agents is planned for a later release; until then, use the REST API below.

---

## Programmatic API

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
  "allowed_tools": ["get_quantities_summary", "search_elements", "execute_ifc_query_code"],
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

---

## Persistence

Custom agents persist to `~/.ifc-atlas/data/custom_agents.json` (see [Data Storage](../user/DATA_STORAGE.md)), so they survive backend restarts.

Back up the file before upgrading the backend if you maintain a curated agent library.
