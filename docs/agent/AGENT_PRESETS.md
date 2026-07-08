# Agent Presets

IFC Atlas ships two built-in agents. An agent defines the system prompt, the LLM provider and model, the temperature, the allowed tools, and the quick-prompt chips shown above the chat input.

Built-in agents are read-only: they cannot be deleted or renamed. To specialise the assistant for a task, activate (or fork) a system prompt from Chat Manager → **Skills**, or manage [custom agents](CUSTOM_AGENTS.md) through the REST API.

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

## Edit Assistant (experimental, disabled by default)

- **Role:** BIM authoring assistant that proposes and applies edits in small, reviewable steps. The only agent with write tools.
- **Status:** Disabled in this release. The `EDIT_MODE_ENABLED` flag (backend environment variable plus frontend constant, both off by default) hides the Edit mode and hard-blocks every write tool at the API layer.
- **Allowed tools:** Read-tier query tools (`get_project_info`, `get_model_stats`, `search_elements`, `get_element_details`, `get_elements_by_type`, `get_elements_by_storey`, `get_storeys`, `search_by_property`, `get_all_property_names`, `execute_ifc_query_code`), viewer tools (`highlight_elements`, `select_element`), and the write tier (`rename_element`, `update_property_value`, `execute_ifc_code`, `undo_last_edit`, `get_edit_history`).
- **When enabled, use for:** Bulk renames, property standardisation, data cleanup, scripted edits.
- **Examples:**
  - *"Rename all walls on Ground Floor to 'Exterior Wall'."*
  - *"Add IsExternal=true to the Pset_WallCommon of all IfcWall elements."*
  - *"Show the edit history for this session."*

Every write tool stages a diff to the **Diff Preview** panel; nothing touches the live model until you click **Apply**.

---

## Specialising with Skills

Earlier releases shipped a roster of specialist presets (analyst, quantity surveyor, auditor, and so on). Those have been replaced by **Skills**: detailed system prompts you activate from Chat Manager → **Skills**. Built-in skills are read-only; editing one forks it into your own copy, which persists server-side in your user data folder. This keeps one agent surface while still letting you tune the assistant's focus per task.
