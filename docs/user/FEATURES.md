# Features

A complete reference of the user-visible features that ship in IFC Atlas today. Each section names the surface, the keyboard shortcut where one exists, and the underlying behaviour.

For the dated history of changes, see the [GitHub Releases page](https://github.com/nbharathik/ifc-atlas/releases).

---

## Viewer

### Loading

| Feature | Description |
|---|---|
| **Drag-and-drop upload** | Drop an `.ifc` file on the viewer to load it. The file is uploaded to the backend, converted to optimised fragment binaries, and streamed back to the browser. Browser-side `web-ifc` parsing remains as a fallback. |
| **Multi-threaded WASM parsing** | COOP and COEP headers establish a cross-origin-isolated context so the fallback parser can spawn worker threads. |
| **Native metadata index** | A TypeScript sidecar parses IFC metadata on the backend. Repeat uploads of the same file (matched by SHA-256) are served from cache. Many Ask-mode queries are answered directly from this index, tagged `_source: "native_index"` in the tool-call log. |
| **Per-storey progressive reveal** | Multi-storey models reveal one storey at a time, ground floor first. Can be disabled from Settings → Performance. |
| **Sample model** | `data/fixtures/BasicHouse.ifc` (IFC2X3, ≈ 50 MB, two storeys, 149 elements) for first-run testing. If it is missing from your clone, download it with `scripts/fetch-sample.ps1` or `scripts/fetch-sample.sh`. |

### Selection and visibility

| Shortcut | Feature |
|---|---|
| Click | Select an element. The right-hand Properties panel shows attributes, Psets, and Qtos with unit-aware formatting. |
| Shift+Click | Add to a multi-selection. Selected elements highlight in amber; aggregate totals (ΣArea, ΣVolume, material histogram, type histogram) appear in Properties and can be exported as CSV. |
| `Alt+[` / `Alt+]` | Step backward / forward through selection history. Position indicator overlays at the top-right of the viewport. |
| `I` | Isolate selection. |
| `H` | Hide selection. |
| `A` | Show all (clear isolation and hidden sets). |
| `Shift+G` | Toggle ghost mode: non-isolated elements render semi-transparent rather than hidden. |
| `Shift+1` … `Shift+9` | Isolate the storey from the bottom-left Storey Navigator Bar. |
| `F` | Frame the current selection, or the whole model when nothing is selected. |
| `Esc` | Clear selection. |

A compact chip at the top-left of the viewport summarises the current selection: total count plus the top three IFC types.

### Search, classification, and structure

| Surface | Description |
|---|---|
| **Model Tree** (`T`, left sidebar) | Spatial-tree outliner. Auto-scrolls to the selected element. Type-frequency chips filter the tree to a single IFC type. Hover any row to preview-highlight the geometry (requires hover highlight, off by default). |
| **Search panel** (`/` or `Ctrl/Cmd+F`, left sidebar) | Multi-field query syntax: bare words fuzzy-match name, IFC class, type, and GlobalId (every word must match), plus `type:IfcWall`, `storey:"Ground Floor"`, `pset:Pset_WallCommon.IsExternal=true` (or `pset:FireRating` for a presence check), and `class:Uniclass` for classification codes. Results are grouped by IFC class; rows offer zoom and isolate actions plus a one-click **Isolate all**. Property and classification filters use an index built on demand, with progress shown while it builds. |
| **IDS validation panel** (Panels → IDS validation) | Drag buildingSMART `.ids` specification files into a saved library and validate the loaded model against them. Per-spec pass / fail cards list the failing elements: click one to select it, or highlight / isolate every failure at once. Failures export as CSV, and the last run is restored when you reopen the panel with the same model. |
| **Property Filter panel** (`Shift+F`) | Pick a property, operator (`eq`, `neq`, `contains`, `startswith`, `gt`, `lt`, `gte`, `lte`), and value. Scope by IFC type, storey, or property set. Matches highlight in 3D with a count badge. |
| **Classification browser** (`G`, left sidebar) | Lists every `IfcClassification` system. Filter by class code or name; click to highlight all members. |
| **Model Statistics** (`Shift+S`) | Overlay panel showing element counts by IFC type and by storey. Click any row to isolate those elements. |
| **Storey Navigator Bar** | Floating bar at the bottom-left listing each storey as a clickable pill. |

### Measurement

| Shortcut | Action |
|---|---|
| Toolbar ruler / `R` | Toggle the measurement history panel. |
| Click two points | Linear measurement. |
| Click N points + Enter | Polygon area (Newell-normal projected shoelace). |
| `N`, then three clicks | Angle measurement (vertex → arm 1 → arm 2). |

While drawing, the cursor snaps to the nearest mesh vertex within 20 pixels (blue dot) or to a committed measurement endpoint within 10 cm (white dot). Committed measurements pin a value label at the midpoint or centroid in the 3D view. Export every measurement as CSV from the panel.

### Quantity takeoff

**Panels → Quantity takeoff** opens a floating takeoff panel. Group the model by any combination of IFC class, storey, material, type, and classification (toggle chips, order preserved) and read per-group counts plus summed volume (m³), area (m²), and length (m) in a sortable table. Values come from each element's `IfcElementQuantity` sets, scaled by the project's declared units; a `-` cell means the group carries no quantity data. Click a row to highlight its elements in 3D, isolate a group with its row action, copy the table as TSV, or download it as CSV.

### Section and clipping

| Shortcut | Action |
|---|---|
| `X` | Toggle a clip plane. |
| `Shift+X` | Click a surface to place a plane aligned to that face's normal. |
| `Alt+X` | Crop the section box to the currently selected element. |

Up to three independent clip planes can stack. The cut surface renders as a solid grey cap rather than a transparent void, so the interior structure stays readable.

### Appearance

| Surface | Description |
|---|---|
| **Colour by** (bottom-left dropdown) | Recolour every element by IFC type, storey, or material. A legend shows up to ten groups with swatch and count. Selection amber and AI-highlight cyan always render on top. |
| **Native mesh highlighting** | Selected and highlighted elements render their exact geometry in colour through `FragmentsModel.highlight()`, with no bounding-box overlays. |
| **Hover highlight** | Preview-highlights the element under the cursor and shows a compact tooltip with its name, IFC type, and storey. Off by default; toggle it on the toolbar or in Settings → Viewer. |
| **Camera presets** | `1`-`6` jump to front, back, left, right, top, isometric. |

### Capture and share

| Shortcut | Action |
|---|---|
| `S` | Capture the current view as a PNG. |
| `V` | Save the current camera as a named viewpoint with a thumbnail. The Viewpoints tab in the right sidebar lists them. |
| `Shift+L` | Copy a share link that encodes the camera, isolation state, highlights, and active panel into a URL hash. Open it elsewhere to restore the exact view. |

All CSV, Markdown, and PNG exports land in your downloads folder with an ISO timestamp suffix.

### BCF topics

**Panels → BCF topics** (or **File → Import BCF topics… / Export BCF topics**) tracks issues directly on the model. Creating a topic captures the current view: camera, isolation and hidden sets, selection, and a viewport snapshot. Each topic carries a status (Open / In Progress / Resolved / Closed), priority, assignee, and a comment thread, and a topic with a saved viewpoint can fly the camera back to it. Topics import and export as BCF 2.1 `.bcfzip` archives that round-trip with other BIM tools, and are stored per model under `~/.ifc-atlas/bcf/`.

---

## AI Chat

### Ask mode

The chat panel runs in **Ask** mode by default: read-only questions and viewer commands. In Ask mode write tools are blocked at the API layer regardless of the active agent, so a prompt cannot trick a conversation into making edits.

Switch the chat to **Edit** mode to stage model changes - every AI write is sandboxed and diff-previewed before you apply it. See [Model editing](#model-editing-native-ifc-on-by-default) below.

### Built-in agents

| Agent | Mode | Purpose |
|---|---|---|
| Default | Ask | General-purpose assistant, all read tools enabled. |
| Edit Assistant | Edit | Semantic and beta geometry changes, with agent writes staged through inline approval. Set `EDIT_MODE_ENABLED=0` for read-only deployments. |

Each agent has its own system prompt, model, temperature, and tool allowlist. Specialise the assistant by activating a system prompt from the **Skills** tab: editing a built-in prompt forks it into your own editable copy.

### Chat Manager (`Ctrl+Shift+M`)

The Chat Manager is the single configuration surface. Tabs:

- **Agents**: the built-in agents with their tool allowlists.
- **Models**: the editable model catalogue (add, edit, enable, reorder entries).
- **Skills**: system prompts and reusable prompt snippets, with fork-on-edit for built-ins.
- **Tools**: every tool the backend exposes, with per-tool enable / disable.
- **Documents**: the Document Index (PDF / Markdown / text uploads).
- **MCP Servers**: register external MCP servers; their tools become available to agents.
- **Settings**: provider keys, base URLs, default model and temperature.

`Ctrl+Shift+I` opens the Chat Manager directly on the **Documents** tab.

### Providers and the Model Registry

Three providers are supported: **OpenAI**, **Anthropic**, and **OpenRouter**. The model list is not hardcoded: the **Model Registry** (Chat Manager → **Models** tab) ships with a seeded catalogue that you can extend and edit in the UI, including per-model sampling parameters, cost tier, and speed hints. Reasoning models automatically omit `temperature` and `top_p`, which those endpoints reject. The chat toolbar's model dropdown is populated from the enabled registry entries.

Configure keys per provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) via the AI Keys modal on first launch, the Chat Manager → Settings tab (keys persist to `~/.ifc-atlas/secrets.json`), or environment variables (shell or `~/.ifc-atlas/.env`). An environment variable overrides a stored key.

### Cost telemetry and budget guardrails

A chip below each assistant message shows total tokens and approximate USD cost. Hover for a per-call breakdown by provider, model, input tokens, and output tokens. For Anthropic, a green `⚡N%` badge shows the percentage of input tokens served from the prompt cache.

Each agent can have a monthly USD spending cap and a fallback model. When the cap is near, the chat panel shows an amber banner; when it is reached, the backend either stops or switches to the fallback. Press `Shift+B` for the **Budget Dashboard**.

### Context and memory

Every agent receives a compact summary of the loaded model (project name, schema, element counts, storeys, materials) prepended to its system prompt. From the second turn on, facts gathered through tool calls are injected so the agent does not re-query the same data.

### Chat input

- **Quick-actions menu** aggregating upload PDF, attach file, mention selection, and paste properties.
- **Slash commands**: `/help`, `/clear`, `/agent`, `/model`, `/find`, `/isolate`, `/ids`.
- **Mention selection** inserts the current element's id and name (or a formatted Pset block) into the textarea.
- **Stop generation**: the Stop button or the `Escape` key aborts a streaming response.

### Tool-call audit

Every tool call is visible in the per-message tool-call log. Each row has a hover-visible copy button that places a pretty-printed `{ tool, arguments, result }` payload on the clipboard. A cache badge marks read-only calls served from per-turn memoisation. A lock banner marks write calls blocked by Ask mode. A provenance tag marks results served from the native metadata index.

### Persistence

The chat thread survives a page refresh. The viewer assigns a stable thread id per browser session and replays checkpointed turns from the backend store on reconnect. **+ New Chat** in the chat toolbar starts a fresh thread. Export the current thread as Markdown or JSON from the overflow menu.

### Document Index

Open Chat Manager → **Documents** (or press `Ctrl+Shift+I`). Drag a PDF, Markdown, or text file (up to 20 MB) and it is chunked and indexed locally. Any agent can search it through the `search_document_index` tool. When `fastembed` and `hnswlib` are installed, the index uses hybrid BM25 + semantic search; otherwise it falls back to plain BM25.

---

## Model editing (native IFC — on by default)

IFC Atlas edits **native IFC** through one audited operation layer shared by
the editor UI, the AI assistant, and MCP clients. See the full guide:
[Editing models](EDITING.md). Set `EDIT_MODE_ENABLED=0` on the backend for a
read-only deployment (the whole edit surface — UI, AI write tools, MCP direct
ops — disappears together; the frontend probes the flag at runtime).

| Feature | Description |
|---|---|
| **Edit mode** | View/Edit toggle in the top bar. Inline-editable Name, Description, ObjectType, Tag, and existing property values in the Properties panel, with validation and instant refresh. |
| **Operation layer** | Every mutation — human, AI, or MCP — is a named, validated, actor-attributed, logged, undoable operation over `ifcopenshell.api` (ADR 003). |
| **Creation ops** | `create_wall` (two-point, storey work plane), `create_slab` (polygon), `create_storey`, `assign_to_storey`, `set_storey_elevation`, `delete_element` — available from the UI, the AI, the REST API, and MCP. |
| **Wall drawing** | In Edit mode, draw walls with two clicks on the storey work plane: live preview line, length label, grid snap, height/thickness/storey controls. |
| **Undo / redo** | `Ctrl+Z` / `Ctrl+Y` (also status-bar buttons and the Edit menu), backed by the operation log. Creation undo removes the created elements; deletion undo restores an exact pre-delete snapshot (express IDs preserved). |
| **Save** | File → Save writes edits back to the loaded file with stable IDs; unsaved-changes badge, close guards, and a browser warning protect against data loss. Save-As still downloads a copy. |
| **AI edits stay previewed** | Every AI write is staged in a sandbox and presented as a before/after diff with **Apply** / **Discard** — plus an automatic **verifier verdict** (model health delta + geometry sanity) so broken proposals are flagged before you apply them. |
| **Bulk operations** | `rename_elements_batch` and `update_properties_batch` change N elements in one atomic, one-undo step. |
| **Script sandbox** | In Ask mode, `execute_ifc_query_code` runs read-only IfcOpenShell analyses. In Edit mode, `execute_ifc_code` produces edit-capable diffs that flow through Diff Preview — with docs-grounded codegen (the agent consults `get_docs` before writing `ifcopenshell.api` code). |
| **Timeline** | `Shift+H` opens the Timeline: every operation with its actor (you / AI / MCP) merged with automatic git checkpoints; two-point semantic compare (ifcdiff, including property changes); restore any checkpoint. |
| **Live sync** | Applied changes broadcast to every open viewer: metadata patches update in place; structural changes trigger a debounced, camera-preserving model refresh. |

---

## Plugins

**Panels → Plugins** runs, writes, and manages Python batch scripts against the loaded model.

| Feature | Description |
|---|---|
| **Built-in plugins** | Set Storey Elevations (update storey elevations from a JSON map of name to elevation), Merge Duplicate Walls (remove walls that share a name and a placement origin within a tolerance), Assign Classification (attach a classification system + code to every element whose IFC type matches a pattern). |
| **Script editor** | Write new plugins in the built-in editor: Python syntax highlighting, line numbers, and typed parameters (string / number / boolean) declared in the plugin manifest, rendered as a form at run time. Built-ins are read-only; saving changes to one creates an editable copy. |
| **Install from zip** | Install a plugin from a `.zip` holding `manifest.json` + `script.py` (1 MB cap). Your plugins live under `~/.ifc-atlas/plugins/`. |
| **Sandboxed execution** | Scripts run with exactly the same safety envelope as AI-authored code: a separate process working on a copy of the model, with no file or network access. |
| **Review before apply** | Write-capable plugins stage a pending edit that opens in the Diff Preview panel with **Apply** and **Discard** buttons. Nothing touches the live model until you approve. |

---

## Integrations

### IDS 1.0 validation

Full buildingSMART IDS 1.0 support through the `ifctester` reference engine. All five facet types (Property, Attribute, Classification, Material, PartOf) are evaluated. The `ids_validate` tool returns failing elements grouped by specification, with `facet_type`, applicability, and requirement summaries. After validation, failing elements auto-highlight in the 3D view. A download button exports all failures as CSV. The `POST /api/ifc/ids-validate` route accepts an IDS document (base64) and returns JSON or CSV for automation. The same engine also powers the in-app IDS validation panel (Panels → IDS validation, with a saved spec library) and the `validate` CLI subcommand, which exits non-zero on failures for use in scripts and CI.

### MCP client

Agents can call tools exposed by external MCP servers (filesystem, shell, browser, custom scripts). Register them under Chat Manager → MCP Servers. Each agent's allowlist still applies.

### MCP server

The viewer exposes its own toolset over MCP at `/mcp` (SSE). External clients (Claude Desktop, Cursor, custom scripts) can connect and query or edit the loaded model.

| Variable | Effect |
|---|---|
| `MCP_SERVER_TOKEN` | Bearer-token auth (set to require it). |
| `MCP_ALLOW_WRITES=1` | Exposes the write tier: `rename_element`, `update_property_value`, `create_wall_from_ends`, `delete_element`, `execute_ifc_code` plus pending-edit management. |

Eleven viewer-control tools are always exposed: `get_viewer_state`, `viewer_select_elements`, `viewer_isolate_elements`, `viewer_highlight_elements`, `viewer_show_all`, `viewer_set_camera`, `get_viewer_snapshot` (returns an image of the live viewport), `viewer_clip_to_element` and `viewer_set_section_box` (cut the view open around an element), and `viewer_colour_elements` / `viewer_clear_colours` (paint element groups in distinct colours with legend labels, e.g. AI-driven heatmaps). An MCP client can read what you are looking at, drive selection, isolation, highlights, colours, sections, and the camera, and verify the result visually. These tools change presentation only; the model is never modified.

Every external write uses the same two-call diff-preview pattern as the in-app Edit Assistant.

### Command line

The backend doubles as a headless CLI: `python -m app.cli` (or the `ifc-atlas` command when the backend package is pip-installed) summarises models, validates IDS, exports quantity takeoffs, diffs two files, remote-controls a running viewer, and serves MCP over stdio. See [Command Line](CLI.md).

---

## Performance

| Feature | Description |
|---|---|
| **Server fragment convert** | When the backend is running, the viewer treats `/api/ifc/convert` as the first attempt on cold load. Optimised fragment binaries are produced server-side and streamed to the browser, bypassing in-browser WASM parsing. |
| **Fragment manifest fast-path** | On a remount, the viewer queries `/api/ifc/fragment-manifest` with the stored fingerprint. If the server has the fragments cached, they download directly with no re-upload. |
| **IndexedDB fragment cache** | Cached fragments live in IndexedDB as raw `Uint8Array`, LRU-evicted at 500 MB, and survive hard refreshes. Settings → Storage shows live cache size and entry count. |
| **Persistent storage opt-in** | On first load, the viewer asks the browser to mark the fragment cache as persistent so it cannot be silently evicted. A badge in Settings shows the grant state (Persistent / Best-effort / Unavailable). |
| **WASM service-worker cache** | On HTTPS and localhost, the web-ifc WASM binaries are pre-cached by a service worker. |
| **Per-storey BVH frustum cull** | Each storey gets a bounding box; storeys outside the camera frustum are hidden before the render tick. |
| **Element-level AABB frustum cull** | Capped at 1500 elements, hides individual elements outside the frustum after the camera settles. Per-element AABBs come from a backend warm-up that runs `ifcopenshell.geom.create_shape` and caches results to disk. |
| **Tool result memoisation** | Read-only tool calls are cached within a single LLM turn. Write tools invalidate the cache. |
| **Performance HUD** (`M`) | FPS, draw calls, TTFR, total load time, click-to-highlight latency (current and rolling median of last 10), culled element count. Each row colour-coded against its budget. |
| **Performance Dashboard** (`Shift+M`) | Per-load history. A sparkline shows TTFR for the last 50 loads coloured by load source (live parse, local cache, server convert, server cache). Hover for exact source and TTFR; avg, best, worst, sample count summarise the trend. |
| **Renderer mode** | Settings → Performance: Auto, WebGL 2, or WebGPU. A live WebGPU availability badge probes `navigator.gpu.requestAdapter()`. |
| **Simplify furnishings** | Topbar toggle. Merges all `IfcFurnishingElement` geometry into one static draw call. |

---

## UX

| Feature | Description |
|---|---|
| **Atlas design system** | AMOLED-black token vocabulary, 4 px grid, near-white primary text with blue accents for interactive highlights. |
| **Theme** | Dark and light variants with system-theme auto-detection. |
| **Command palette** (`Ctrl+K`) | Fuzzy search across every command, panel toggle, and shortcut. |
| **Keyboard shortcuts overlay** (`?`) | Interactive reference of every shortcut. Full reference: [`KEYBOARD_SHORTCUTS.md`](KEYBOARD_SHORTCUTS.md). |
| **Right-click context menu** | Select, Isolate, Hide, Isolate all of this type, Hide all of this type, Isolate storey, Zoom to element, Clip section box to element, Copy Express ID, Copy GlobalId, Copy details. Count badges show how many siblings each action will affect. |
| **Copy element identifiers** | Express ID, GlobalId, and multi-line details block (`Ctrl+Shift+C` for the current selection) for clean round-trips into Solibri, Navisworks, BCF, Revit, or spreadsheets. |
| **Activity Log** | Right-sidebar panel listing every selection, edit, and tool call. A 12-chip filter bar mutes kinds (`SEL`, `HL`, `ISO`, `HIDE`, `SHOW`, `TOOL`, `CHAT`, `SHOT`, `VIEW`, `EDIT`, `INFO`, `ERR`). Mute state persists across reloads. |
| **Touch-friendly zoom** | A vertical +/fit/− stack at the bottom-right of the viewport. `+`, `−`, and `0` are equivalent. |
| **Element Relations** | The bottom of the Properties sidebar shows material layers with per-layer thicknesses, connected walls, and hosted doors or windows for the current selection. Click any related element to navigate to it. |
| **Model Health** (`Shift+Q`) | Panel summarising data-quality issues found by `run_model_health_check`. |
| **Settings modal** | One modal for appearance, viewer behaviour, performance, storage, integrations, and AI defaults. Open from the gear icon or `Ctrl+,`. |

---

## See also

- [Getting Started](GETTING_STARTED.md): first-run setup.
- [Keyboard Shortcuts](KEYBOARD_SHORTCUTS.md): full key reference.
- [AI Agent Guide](AI_AGENT_GUIDE.md): the built-in agents and how to prompt them.
- [Command Line](CLI.md): headless checks, takeoffs, viewer control, and MCP from the terminal.
- [Troubleshooting](TROUBLESHOOTING.md): COOP/COEP, WASM, large models, chat reconnects.
- [Deploy Your Own](DEPLOY_YOUR_OWN.md): Docker, Caddy, GitHub Pages, Tauri builds.
