/**
 * Static reference list of keyboard shortcuts surfaced in the ? help modal.
 *
 * Kept in its own module (not exported from `KeyboardShortcuts.tsx`) because
 * Vite Fast Refresh requires component files to export only React components;
 * mixing in a const export would convert the file into a full-reload
 * boundary, which can trigger an IFC-loading hot-reload loop in development.
 */

export interface ShortcutEntry {
  key: string;
  label: string;
  description: string;
  category: string;
}

export const SHORTCUTS: ShortcutEntry[] = [
  // Camera
  { key: '1', label: '1', description: 'Front view', category: 'Camera' },
  { key: '2', label: '2', description: 'Back view', category: 'Camera' },
  { key: '3', label: '3', description: 'Left view', category: 'Camera' },
  { key: '4', label: '4', description: 'Right view', category: 'Camera' },
  { key: '5', label: '5', description: 'Top view', category: 'Camera' },
  { key: '6', label: '6', description: 'Isometric view', category: 'Camera' },
  { key: 'f', label: 'F', description: 'Frame selection (falls back to fit model)', category: 'Camera' },
  // Selection
  { key: 'Escape', label: 'Esc', description: 'Deselect / close modal', category: 'Selection' },
  { key: 'Alt+[', label: 'Alt+[', description: 'Previous selection (back through history)', category: 'Selection' },
  { key: 'Alt+]', label: 'Alt+]', description: 'Next selection (forward through history)', category: 'Selection' },
  // Visibility
  { key: 'i', label: 'I', description: 'Isolate selected/highlighted elements', category: 'Visibility' },
  { key: 'h', label: 'H', description: 'Hide selected/highlighted elements', category: 'Visibility' },
  { key: 'a', label: 'A', description: 'Show all elements', category: 'Visibility' },
  { key: 'x', label: 'X', description: 'Toggle section / clip plane', category: 'Visibility' },
  { key: 'Shift+X', label: 'Shift+X', description: 'Pick surface to place section plane', category: 'Visibility' },
  { key: 'Alt+X', label: 'Alt+X', description: 'Fit section box to current selection', category: 'Visibility' },
  { key: 'Shift+1-9', label: 'Shift+1…9', description: 'Isolate / navigate to storey 1-9', category: 'Visibility' },
  // Panels
  { key: 't', label: 'T', description: 'Focus model tree', category: 'Panels' },
  { key: '/', label: '/', description: 'Focus search', category: 'Panels' },
  { key: 'Ctrl/Cmd+F', label: 'Ctrl+F', description: 'Search the model (opens and focuses the search pane)', category: 'Panels' },
  { key: 'g', label: 'G', description: 'Focus classifications pane', category: 'Panels' },
  { key: 'Shift+G', label: 'Shift+G', description: 'Toggle ghost mode (xray isolate)', category: 'Visibility' },
  { key: 'p', label: 'P', description: 'Focus properties tab', category: 'Panels' },
  { key: 'c', label: 'C', description: 'Focus AI chat tab', category: 'Panels' },
  { key: 'b', label: 'B', description: 'Focus viewpoints tab', category: 'Panels' },
  { key: 'l', label: 'L', description: 'Focus activity log tab', category: 'Panels' },
  { key: 'm', label: 'M', description: 'Toggle performance HUD', category: 'Panels' },
  { key: 'Ctrl+B', label: 'Ctrl+B', description: 'Toggle outliner (left sidebar)', category: 'Panels' },
  { key: '\\', label: '\\', description: 'Toggle right sidebar', category: 'Panels' },
  { key: 'Shift+\\', label: 'Shift+\\', description: 'Expand right sidebar to full width', category: 'Panels' },
  { key: 'Shift+M', label: 'Shift+M', description: 'Performance history dashboard', category: 'Panels' },
  { key: 'Shift+Q', label: 'Shift+Q', description: 'Model health check panel', category: 'Panels' },
  { key: 'Shift+H', label: 'Shift+H', description: 'IFC edit checkpoints panel', category: 'Panels' },
  { key: 'Shift+P', label: 'Shift+P', description: 'Open Chat Manager on the Skills tab', category: 'Panels' },
  { key: 'Shift+B', label: 'Shift+B', description: 'AI cost budget dashboard', category: 'Panels' },
  { key: 'Shift+F', label: 'Shift+F', description: 'Element property filter panel', category: 'Panels' },
  { key: 'Shift+S', label: 'Shift+S', description: 'Model statistics panel', category: 'Panels' },
  // Measurement
  { key: 'r', label: 'R', description: 'Start or stop measuring', category: 'Measurement' },
  { key: 'n', label: 'N', description: 'Toggle angle measurement mode', category: 'Measurement' },
  { key: 'l', label: 'L', description: 'Toggle measurement labels (while measurements exist; otherwise focuses activity log)', category: 'Measurement' },
  // Capture
  { key: 's', label: 'S', description: 'Capture screenshot', category: 'Capture' },
  { key: 'v', label: 'V', description: 'Save current view as viewpoint', category: 'Capture' },
  { key: 'Shift+L', label: 'Shift+L', description: 'Copy share link (camera + highlights)', category: 'Capture' },
  // Edit
  { key: 'Ctrl+Z', label: 'Ctrl+Z', description: 'Undo last committed edit', category: 'Edit' },
  { key: 'Ctrl+Y', label: 'Ctrl+Y', description: 'Redo the most recently undone edit (also Ctrl+Shift+Z)', category: 'Edit' },
  { key: 'Ctrl+Shift+C', label: 'Ctrl+Shift+C', description: 'Copy selected element details (type, name, Express ID, GlobalId, storey)', category: 'Edit' },
  // General
  { key: 'Ctrl/Cmd+K', label: 'Ctrl+K', description: 'Open command palette', category: 'General' },
  { key: 'Ctrl/Cmd+/', label: 'Ctrl+/', description: 'Open AI assistant', category: 'General' },
  { key: 'Ctrl/Cmd+,', label: 'Ctrl+,', description: 'Open settings', category: 'General' },
  { key: 'Ctrl/Cmd+Shift+M', label: 'Ctrl+Shift+M', description: 'Open Chat Manager', category: 'General' },
  { key: '?', label: '?', description: 'Show this keyboard shortcut reference', category: 'General' },
];
