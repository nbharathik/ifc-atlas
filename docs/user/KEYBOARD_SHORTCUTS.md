# Keyboard Shortcuts

Press **`?`** anywhere in the viewer to open the interactive shortcut overlay. Shortcuts are inactive while the cursor is inside a text input, textarea, or select field. On macOS, `Cmd` is interchangeable with `Ctrl` for every multi-key shortcut.

---

## Camera

| Key | Action |
|---|---|
| `1` | Front view |
| `2` | Back view |
| `3` | Left view |
| `4` | Right view |
| `5` | Top-down (plan) view |
| `6` | Isometric view |
| `F` | Frame the current selection; falls back to fit-model when nothing is selected |
| `+` / `-` / `0` | Zoom in / out / reset (also available on the bottom-right control stack) |

---

## Selection and visibility

| Key | Action |
|---|---|
| Click | Select an element |
| Shift+Click | Add to a multi-selection |
| Right-Click | Context menu (select, isolate, hide, zoom, copy ID, …) |
| `Esc` / `Escape` | Deselect (or close the open modal) |
| `Alt+[` | Previous selection (browser-style history) |
| `Alt+]` | Next selection |
| `I` | Isolate the selected or highlighted elements |
| `H` | Hide the selected or highlighted elements |
| `A` | Show all (clear isolation and hidden sets) |
| `Shift+G` | Toggle ghost mode (unselected elements render semi-transparent rather than hidden) |
| `Shift+1` … `Shift+9` | Isolate storey 1 to 9 (driven by the Storey Navigator Bar) |

### Section and clipping

| Key | Action |
|---|---|
| `X` | Toggle a clip plane |
| `Shift+X` | Click a surface to place a clip plane aligned to that face |
| `Alt+X` | Crop the section box to the currently selected element |

---

## Panels

| Key | Panel |
|---|---|
| `T` | Focus the Model Tree (left sidebar) |
| `/` | Focus the Search pane (left sidebar) |
| `Ctrl/Cmd+F` | Search the model (opens and focuses the search pane) |
| `G` | Focus the Classifications pane (left sidebar) |
| `P` | Focus the Properties tab (right sidebar) |
| `C` | Focus the AI Chat tab |
| `B` | Focus the Viewpoints tab |
| `L` | Focus the Activity Log tab |
| `R` | Toggle the Measurement history panel |
| `M` | Toggle the Performance HUD |
| `Shift+M` | Toggle the Performance Dashboard |
| `Shift+Q` | Toggle the Model Health panel |
| `Shift+H` | Toggle the Checkpoints panel |
| `Shift+S` | Toggle the Model Statistics panel |
| `Shift+F` | Toggle the Property Filter panel |
| `Shift+B` | Toggle the Budget Dashboard |
| `Shift+P` | Open the Chat Manager on the Skills tab |
| `Ctrl+B` | Toggle the outliner (left sidebar) |
| `\` | Toggle the right sidebar |
| `Shift+\` | Expand the right sidebar to full width |

---

## Measurement

Start a measurement from the toolbar ruler icon, the command palette, or the shortcuts below.

| Key | Action |
|---|---|
| Click | Add a vertex point |
| Double-click / Enter | Commit a linear or polygon measurement |
| `R` | Toggle the measurement history panel |
| `N` | Toggle angle-measurement mode (vertex → arm 1 → arm 2) |
| `Esc` | Cancel a pending measurement |

---

## Edit

| Key | Action |
|---|---|
| `Ctrl+Z` | Undo the most recent committed IFC edit |
| `Ctrl+Shift+C` | Copy details (type, name, Express ID, GlobalId, storey) for the current selection |

---

## Capture and share

| Key | Action |
|---|---|
| `S` | Capture the current view as a PNG |
| `V` | Save the current camera as a named viewpoint |
| `Shift+L` | Copy a share link encoding camera, isolation, highlights, and active panel |

---

## AI Chat

| Key | Action |
|---|---|
| `Enter` | Send the message |
| `Shift+Enter` | Insert a newline |
| `/` at start of empty input | Open the slash-command menu |
| `Esc` (while streaming) | Abort the streaming response |
| `Ctrl+/` | Open / focus the chat panel |
| `Ctrl+Shift+M` | Open the Chat Manager |
| `Ctrl+Shift+I` | Open the Chat Manager on the **Docs** tab |

---

## General

| Key | Action |
|---|---|
| `Ctrl+K` | Open the command palette (fuzzy search across every action) |
| `Ctrl+,` | Open the Settings modal |
| `?` | Show this keyboard-shortcut reference |

---

## Notes

- `Alt+X` requires an element to be selected first.
- `Shift+1` … `Shift+9` requires a model with at least two storeys; the Storey Navigator Bar at the bottom-left shows the storey list.
- The command palette (`Ctrl+K`) provides fuzzy-search access to every viewer action, panel toggle, agent preset, and shortcut.
