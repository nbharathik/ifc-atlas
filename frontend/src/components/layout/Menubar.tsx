import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../../store/useStore';
import { useIfcUpload } from '../../hooks/useIfcUpload';
import { saveIfcAs } from '../../services/ifc/saveAs';
import { getEditState } from '../../services/api';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { useNewProject, type NewProjectTemplate } from '../../hooks/useNewProject';
import { apiUrl, invokeCommand, isDesktop } from '../../lib/platform';
import Icon from '../ui/Icon';

interface MenubarProps {
  onCameraView: (view: string) => void;
  onFitModel: () => void;
  onScreenshot: () => void;
  onSaveViewpoint: (name: string) => void;
}

type MenuId = 'file' | 'edit' | 'view' | 'panels' | 'ai' | 'help';

interface MenuItem {
  label: string;
  kbd?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

/**
 * Top-level application menubar - File / Edit / View / Panels / AI / Help.
 * Every menu item is wired to an action (or disabled when it depends on
 * model state), and every kbd hint must match a binding that actually
 * fires in KeyboardShortcuts.tsx. The right side carries the
 * command-palette launcher, theme toggle, and settings.
 */
export default function Menubar({
  onCameraView,
  onFitModel,
  onScreenshot,
  onSaveViewpoint,
}: MenubarProps) {
  const project = useStore((s) => s.project);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const editMode = useStore((s) => s.editMode);
  const modelDirty = useStore((s) => s.modelDirty);
  const refreshEditState = useStore((s) => s.refreshEditState);
  const toggleEditMode = useStore((s) => s.toggleEditMode);
  const undoLastEdit = useStore((s) => s.undoLastEdit);
  const redoLastEdit = useStore((s) => s.redoLastEdit);
  const reset = useStore((s) => s.reset);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAgentManagerOpen = useStore((s) => s.setAgentManagerOpen);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const setShortcutsHelpOpen = useStore((s) => s.setShortcutsHelpOpen);
  const rightSidebarMode = useStore((s) => s.rightSidebarMode);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const leftSidebarOpen = useStore((s) => s.leftSidebarOpen);
  const setLeftSidebarOpen = useStore((s) => s.setLeftSidebarOpen);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const setRightSidebarOpen = useStore((s) => s.setRightSidebarOpen);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const selectElement = useStore((s) => s.selectElement);
  const setPerfHudVisible = useStore((s) => s.setPerfHudVisible);
  const perfHudVisible = useStore((s) => s.perfHudVisible);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const clipPlaneEnabled = useStore((s) => s.clipPlanes.some(p => p.enabled));
  const toggleClipPlane = useStore((s) => s.toggleClipPlane);
  const openTool = useStore((s) => s.openTool);

  const upload = useIfcUpload();
  const createProject = useNewProject();
  const addToast = useStore((s) => s.addToast);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Linux desktop only: current state of the WebKitGTK "safe graphics mode"
  // marker (~/.ifc-atlas/safe-graphics). The Rust command returns null on
  // non-Linux platforms (and invokeCommand returns null on web), so null
  // doubles as "hide the menu item".
  const [safeGraphics, setSafeGraphics] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    invokeCommand<boolean | null>('get_safe_graphics')
      .then((res) => {
        if (!cancelled && typeof res === 'boolean') setSafeGraphics(res);
      })
      .catch(() => { /* older shell without the command - keep hidden */ });
    return () => { cancelled = true; };
  }, []);

  // Close dropdowns on outside click or Escape
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const close = useCallback(() => setOpenMenu(null), []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
    close();
  }, [close]);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    const dirty = useStore.getState().modelDirty;
    if (!dirty) return true;
    return window.confirm(
      'You have unsaved changes. Discard them?\n\n'
      + 'Use File → Save (or Save as IFC…) first to keep your edits.',
    );
  }, []);

  const startNewProject = useCallback(async (template: NewProjectTemplate) => {
    close();
    if (!confirmDiscardIfDirty()) return;
    const result = await createProject(template);
    if (result.ok === false) addToast(result.error, 'error');
  }, [close, createProject, addToast, confirmDiscardIfDirty]);

  const runSave = useCallback(async () => {
    close();
    try {
      const { saveModel } = await import('../../services/api');
      const out = await saveModel();
      addToast(`Saved ${out.filename}`, 'success');
      refreshEditState();
    } catch (err) {
      addToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [close, addToast, refreshEditState]);

  const promptSaveView = useCallback(() => {
    const name = window.prompt('Name this view');
    if (name) onSaveViewpoint(name);
  }, [onSaveViewpoint]);

  const downloadBcfExport = useCallback(() => {
    // Temporary-anchor download, same pattern as the screenshot / CSV
    // export flows. The backend answers with a Content-Disposition
    // attachment, so the browser saves the .bcfzip under the
    // server-provided filename instead of navigating.
    const a = document.createElement('a');
    a.href = apiUrl('/api/bcf/export');
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    close();
  }, [close]);

  const runSaveAs = useCallback(async (closeAfter: boolean) => {
    close();
    // Prefer the upload's actual filename (from the backend) over the
    // IfcProject's display name - those are often boilerplate like
    // "Default Project" and make for ugly Save-As defaults.
    let sourceName: string | undefined;
    try {
      const state = await getEditState();
      sourceName = state.original_filename ?? undefined;
    } catch {
      sourceName = project?.name ? `${project.name}.ifc` : undefined;
    }
    const outcome = await saveIfcAs({ originalFilename: sourceName });
    if (outcome.status === 'saved') {
      if (closeAfter) reset();
    } else if (outcome.status === 'error') {
      window.alert(`Save As failed: ${outcome.message}`);
    }
  }, [close, project, reset]);

  const fileItems: MenuItem[] = [
    { label: 'Open IFC…', onClick: openFilePicker },
    // Create a fresh IFC project (plan A3). Editor feature, needs a backend
    // with editing enabled (runtime /edit-state probe). All three backend
    // templates are reachable, not just the single-storey default.
    ...(editModeAvailable && !BROWSER_ONLY ? [
      { label: 'New project (single storey)…', onClick: () => { void startNewProject('single_storey'); } },
      { label: 'New project (two storeys)…', onClick: () => { void startNewProject('two_storey'); } },
      { label: 'New project (empty)…', onClick: () => { void startNewProject('empty'); } },
    ] satisfies MenuItem[] : []),
    // Save-As round-trips the edited model through the backend - not
    // available in the static viewer-only build (which also has no edits).
    ...(BROWSER_ONLY ? [] : [
      // In-place Save (A7): working copy → the loaded file. Only offered when
      // the backend has editing on (there is nothing to save otherwise).
      ...(editModeAvailable ? [
        {
          label: modelDirty ? 'Save (unsaved changes)' : 'Save',
          onClick: () => { void runSave(); },
          disabled: !modelLoaded || !modelDirty,
        },
      ] satisfies MenuItem[] : []),
      { label: 'Save as IFC…', onClick: () => { void runSaveAs(false); }, disabled: !modelLoaded },
      { label: 'Save as and close…', onClick: () => { void runSaveAs(true); }, disabled: !modelLoaded },
      // BCF topics live on the backend, keyed by the loaded model.
      { label: 'Import BCF topics…', onClick: () => { openTool('bcf'); close(); }, disabled: !modelLoaded },
      { label: 'Export BCF topics', onClick: downloadBcfExport, disabled: !modelLoaded },
    ] satisfies MenuItem[]),
    {
      label: 'Close model',
      onClick: () => {
        close();
        if (!confirmDiscardIfDirty()) return;
        reset();
      },
      disabled: !modelLoaded,
    },
    { separator: true, label: '' },
    { label: 'Screenshot', kbd: 'S', onClick: () => { onScreenshot(); close(); }, disabled: !modelLoaded },
    { label: 'Save viewpoint…', kbd: 'V', onClick: () => { promptSaveView(); close(); }, disabled: !modelLoaded },
  ];

  const editItems: MenuItem[] = [
    // Edit-mode entry points (B2 discoverability): mode toggle + undo/redo,
    // shown only when the backend reports editing enabled.
    ...(editModeAvailable && !BROWSER_ONLY ? [
      {
        label: editMode ? 'Exit Edit mode' : 'Enter Edit mode',
        onClick: () => { toggleEditMode(); close(); },
        disabled: !modelLoaded,
      },
      { label: 'Undo', kbd: 'Ctrl+Z', onClick: () => { void undoLastEdit(); close(); }, disabled: !modelLoaded },
      { label: 'Redo', kbd: 'Ctrl+Y', onClick: () => { void redoLastEdit(); close(); }, disabled: !modelLoaded },
      { separator: true, label: '' },
    ] satisfies MenuItem[] : []),
    { label: 'Clear selection', kbd: 'Esc', onClick: () => { selectElement(null); close(); }, disabled: !modelLoaded },
    { label: 'Clear highlights', onClick: () => { setHighlightedIds([]); close(); }, disabled: !modelLoaded },
    { label: 'Show all elements', kbd: 'A', onClick: () => { clearVisibility(); close(); }, disabled: !modelLoaded },
  ];

  const viewItems: MenuItem[] = [
    { label: 'Frame model', kbd: 'F', onClick: () => { onFitModel(); close(); }, disabled: !modelLoaded },
    { separator: true, label: '' },
    { label: 'Front',     kbd: '1', onClick: () => { onCameraView('front'); close(); }, disabled: !modelLoaded },
    { label: 'Back',      kbd: '2', onClick: () => { onCameraView('back'); close(); },  disabled: !modelLoaded },
    { label: 'Left',      kbd: '3', onClick: () => { onCameraView('left'); close(); },  disabled: !modelLoaded },
    { label: 'Right',     kbd: '4', onClick: () => { onCameraView('right'); close(); }, disabled: !modelLoaded },
    { label: 'Top',       kbd: '5', onClick: () => { onCameraView('top'); close(); },   disabled: !modelLoaded },
    { label: 'Isometric', kbd: '6', onClick: () => { onCameraView('iso'); close(); },   disabled: !modelLoaded },
    { separator: true, label: '' },
    {
      label: clipPlaneEnabled ? 'Disable clip plane' : 'Enable clip plane',
      kbd: 'X',
      onClick: () => { toggleClipPlane(); close(); },
      disabled: !modelLoaded,
    },
    {
      label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      onClick: () => { setTheme(theme === 'dark' ? 'light' : 'dark'); close(); },
    },
  ];

  const panelsItems: MenuItem[] = [
    {
      label: leftSidebarOpen ? 'Hide outliner' : 'Show outliner',
      kbd: 'Ctrl+B',
      onClick: () => { setLeftSidebarOpen(!leftSidebarOpen); close(); },
    },
    {
      label: rightSidebarOpen ? 'Hide inspector' : 'Show inspector',
      // The \ binding only exists in tabs mode; don't advertise it in the
      // legacy stacked layout.
      kbd: rightSidebarMode === 'tabs' ? '\\' : undefined,
      onClick: () => { setRightSidebarOpen(!rightSidebarOpen); close(); },
    },
    { separator: true, label: '' },
    { label: 'Properties', kbd: 'P', onClick: () => { focusRightTab('props'); close(); }, disabled: !modelLoaded },
    // The Tools tab launches the feature panels + model tools. Present in every
    // build (the viewer-only demo keeps the client-side Model statistics).
    { label: 'Tools', onClick: () => { focusRightTab('tools'); close(); } },
    { label: 'Viewpoints', kbd: 'B', onClick: () => { focusRightTab('views'); close(); }, disabled: !modelLoaded },
    { label: 'Activity log', kbd: 'L', onClick: () => { focusRightTab('log'); close(); }, disabled: !modelLoaded },
    { separator: true, label: '' },
    {
      label: perfHudVisible ? 'Hide performance HUD' : 'Show performance HUD',
      kbd: 'M',
      onClick: () => { setPerfHudVisible(!perfHudVisible); close(); },
    },
    // Floating feature panels (one shared overlay slot - opening one closes
    // the others). All of them talk to the backend, hence the gate.
    ...(BROWSER_ONLY ? [] : [
      { separator: true, label: '' },
      { label: 'Quantity takeoff', onClick: () => { openTool('qto'); close(); } },
      { label: 'Cost takeoff (5D)', onClick: () => { openTool('cost'); close(); } },
      { label: 'Embodied carbon', onClick: () => { openTool('carbon'); close(); } },
      { label: 'Changes since upload', onClick: () => { openTool('diff'); close(); } },
      { label: 'IDS validation', onClick: () => { openTool('ids'); close(); } },
      { label: 'BCF topics', onClick: () => { openTool('bcf'); close(); } },
      { label: 'Data handover (COBie)', onClick: () => { openTool('cobie'); close(); } },
      { label: 'Plugins', onClick: () => { openTool('plugins'); close(); } },
    ] satisfies MenuItem[]),
  ];

  const aiItems: MenuItem[] = [
    { label: 'Open AI chat', kbd: 'C', onClick: () => { focusRightTab('chat'); close(); } },
    { label: 'Chat Manager…', kbd: 'Ctrl+Shift+M', onClick: () => { setAgentManagerOpen(true); close(); } },
  ];

  // Desktop-only: signed auto-update check against GitHub Releases (see
  // src-tauri check_for_updates/install_update) + the reveal-logs affordance.
  // window.confirm is fine here - it renders as a native webview dialog.
  const checkForUpdates = async () => {
    close();
    let res: { available: boolean; version?: string | null } | null = null;
    try {
      res = await invokeCommand<{ available: boolean; version?: string | null }>(
        'check_for_updates',
      );
    } catch (err) {
      window.alert(`Update check failed: ${String(err)}`);
      return;
    }
    if (!res) return;
    if (!res.available) {
      window.alert('IFC Atlas is up to date.');
      return;
    }
    const go = window.confirm(
      `Version ${res.version ?? ''} is available. Download and install now? `
        + 'The app restarts when the update finishes.',
    );
    if (go) {
      try {
        await invokeCommand('install_update');
      } catch (err) {
        window.alert(`Update failed: ${String(err)}`);
      }
    }
  };

  // Linux desktop only (safeGraphics stays null everywhere else): toggle the
  // safe-graphics marker file and restart. The confirm is mandatory - the
  // Rust side restarts the whole app because the WebKitGTK workaround env
  // vars only apply when the webview is created.
  const toggleSafeGraphics = async () => {
    close();
    if (safeGraphics === null) return;
    const next = !safeGraphics;
    const go = window.confirm(
      next
        ? 'Turn on safe graphics mode? This disables GPU compositing in the '
          + 'embedded browser to work around blank or garbled windows on some '
          + 'Linux graphics setups (NVIDIA, Wayland). 3D performance will be '
          + 'lower. IFC Atlas will restart now.'
        : 'Turn off safe graphics mode and restore GPU compositing? '
          + 'IFC Atlas will restart now.',
    );
    if (!go) return;
    try {
      await invokeCommand('set_safe_graphics', { enabled: next });
    } catch (err) {
      window.alert(`Could not change safe graphics mode: ${String(err)}`);
    }
  };

  const helpItems: MenuItem[] = [
    { label: 'Keyboard shortcuts', kbd: '?', onClick: () => { setShortcutsHelpOpen(true); close(); } },
    { label: 'Command palette', kbd: 'Ctrl+K', onClick: () => { setCommandPaletteOpen(true); close(); } },
    ...(isDesktop
      ? [
          { label: '', separator: true },
          { label: 'Check for updates…', onClick: () => { void checkForUpdates(); } },
          { label: 'Open logs folder', onClick: () => { void invokeCommand('open_logs_dir'); close(); } },
          ...(safeGraphics !== null
            ? [{
                label: `Safe graphics mode: ${safeGraphics ? 'on' : 'off'}`,
                onClick: () => { void toggleSafeGraphics(); },
              }]
            : []),
        ]
      : []),
  ];

  const menus: Partial<Record<MenuId, { label: string; items: MenuItem[] }>> = {
    file:   { label: 'File',   items: fileItems },
    edit:   { label: 'Edit',   items: editItems },
    view:   { label: 'View',   items: viewItems },
    panels: { label: 'Panels', items: panelsItems },
    // The whole AI surface needs the backend - drop the menu in the demo.
    ...(BROWSER_ONLY ? {} : { ai: { label: 'AI', items: aiItems } }),
    help:   { label: 'Help',   items: helpItems },
  };

  const renderDropdown = (id: MenuId) => {
    const m = menus[id];
    if (!m) return null;
    return (
      <div className="menubar-dropdown" role="menu">
        {m.items.map((item, idx) => {
          if (item.separator) return <div key={`sep-${idx}`} className="menubar-dropdown-sep" />;
          return (
            <button
              key={item.label}
              className="menubar-dropdown-item"
              onClick={item.onClick}
              disabled={item.disabled}
              role="menuitem"
            >
              <span>{item.label}</span>
              {item.kbd && <kbd>{item.kbd}</kbd>}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="menubar" ref={wrapRef}>
      <div className="menubar-items" role="menubar">
        {(Object.keys(menus) as MenuId[]).map((id) => {
          const m = menus[id];
          if (!m) return null;
          const expanded = openMenu === id;
          return (
            <div key={id} style={{ position: 'relative' }}>
              <button
                className={`menubar-item ${expanded ? 'active' : ''}`}
                onClick={() => setOpenMenu(expanded ? null : id)}
                onMouseEnter={() => { if (openMenu && openMenu !== id) setOpenMenu(id); }}
                aria-haspopup="menu"
                aria-expanded={expanded}
              >
                {m.label}
              </button>
              {expanded && renderDropdown(id)}
            </div>
          );
        })}
      </div>

      <div className="menubar-spacer" />

      {project && (
        <div className="menubar-project" title={project.name}>
          {project.name}
          {project.schema_version && (
            <span className="menubar-project-schema">{project.schema_version}</span>
          )}
        </div>
      )}

      <div className="menubar-right">
        <button
          className="menubar-btn"
          onClick={() => setCommandPaletteOpen(true)}
          title="Command palette (Ctrl+K)"
          aria-label="Open command palette"
        >
          <Icon name="command" size={13} />
          <kbd>K</kbd>
        </button>
        <button
          className="menubar-btn"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label="Toggle theme"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={13} />
        </button>
        <button
          className="menubar-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings (Ctrl+,)"
          aria-label="Open settings"
        >
          <Icon name="settings" size={13} />
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ifc"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          // Reset so choosing the same file twice still triggers onChange
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
