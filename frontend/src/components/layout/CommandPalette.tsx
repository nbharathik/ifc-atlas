import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import {
  canGoBack as historyCanGoBack,
  canGoForward as historyCanGoForward,
} from '../../services/viewer/selectionHistoryHelpers';
import { findNodeById } from '../../services/viewer/spatialTreeHelpers';
import { BROWSER_ONLY } from '../../config/featureFlags';
import {
  copyNodeToClipboard,
  spatialNodeToClipboardNode,
  type ClipboardFormat,
} from '../../services/viewer/selectionClipboardHelpers';
import { resolveViewerActionTargets } from '../../services/viewer/viewerActionTargetHelpers';

// Commands whose surfaces need the backend - filtered out of the static
// viewer-only build (chat, edits, checkpoints, budget, health, property
// filter, document index, CSV export via /api/ifc/export).
const BACKEND_ONLY_COMMAND_IDS = new Set([
  'panel.chat.focus', 'panel.chat', 'ui.health', 'ui.checkpoints',
  'ui.budget', 'ui.filter', 'ui.snippets', 'agent.manager', 'docs.index',
  'edit.reopen_pending', 'export.properties.csv', 'export.properties.csv.qty',
  'session.clearchat',
  // panel.tools stays available in the viewer-only build (the Tools tab exists
  // there with the client-side Model statistics). The feature.* commands are
  // backend-driven, so they're filtered out.
  'feature.qto', 'feature.ids', 'feature.bcf', 'feature.plugins', 'feature.cost', 'feature.carbon',
  'feature.cobie', 'feature.diff',
]);

interface Command {
  id: string;
  label: string;
  keywords?: string;
  section: string;
  disabled?: boolean;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  onCameraView?: (view: string) => void;
  onFitModel?: () => void;
  onScreenshot?: () => void;
  onSaveViewpoint?: (name: string) => void;
  onRestoreViewpoint?: (id: string) => void;
}

export default function CommandPalette({
  onCameraView,
  onFitModel,
  onScreenshot,
  onSaveViewpoint,
  onRestoreViewpoint,
}: CommandPaletteProps) {
  const open = useStore((s) => s.commandPaletteOpen);
  const setOpen = useStore((s) => s.setCommandPaletteOpen);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const toggleTree = useStore((s) => s.toggleTree);
  const toggleProps = useStore((s) => s.toggleProps);
  const toggleChat = useStore((s) => s.toggleChat);
  const toggleActivity = useStore((s) => s.toggleActivity);
  const toggleViewpoints = useStore((s) => s.toggleViewpoints);
  const viewpoints = useStore((s) => s.viewpoints);
  const deleteViewpoint = useStore((s) => s.deleteViewpoint);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const reset = useStore((s) => s.reset);
  const rightSidebarMode = useStore((s) => s.rightSidebarMode);
  const setRightSidebarMode = useStore((s) => s.setRightSidebarMode);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const focusLeftPane = useStore((s) => s.focusLeftPane);
  const setLeftSidebarOpen = useStore((s) => s.setLeftSidebarOpen);
  const setRightSidebarOpen = useStore((s) => s.setRightSidebarOpen);
  const toggleRightSidebarExpanded = useStore((s) => s.toggleRightSidebarExpanded);
  const leftSidebarOpen = useStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const rightSidebarExpanded = useStore((s) => s.rightSidebarExpanded);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const perfHudVisible = useStore((s) => s.perfHudVisible);
  const setPerfHudVisible = useStore((s) => s.setPerfHudVisible);
  const perfDashOpen = useStore((s) => s.perfDashOpen);
  const setPerfDashOpen = useStore((s) => s.setPerfDashOpen);
  const healthPanelOpen = useStore((s) => s.healthPanelOpen);
  const checkpointPanelOpen = useStore((s) => s.checkpointPanelOpen);
  const setCheckpointPanelOpen = useStore((s) => s.setCheckpointPanelOpen);
  const budgetPanelOpen = useStore((s) => s.budgetPanelOpen);
  const setBudgetPanelOpen = useStore((s) => s.setBudgetPanelOpen);
  const filterPanelOpen = useStore((s) => s.filterPanelOpen);
  const snippetPanelOpen = useStore((s) => s.snippetPanelOpen);
  const setSnippetPanelOpen = useStore((s) => s.setSnippetPanelOpen);
  const statsPanelOpen = useStore((s) => s.statsPanelOpen);
  const activeFeaturePanel = useStore((s) => s.activeFeaturePanel);
  // Tools dock into the Tools tab now (no floating windows), so palette
  // commands route through the unified toggle action.
  const toggleTool = useStore((s) => s.toggleTool);
  const measurementPanelOpen = useStore((s) => s.measurementPanelOpen);
  const setMeasurementPanelOpen = useStore((s) => s.setMeasurementPanelOpen);
  const setAgentManagerOpen = useStore((s) => s.setAgentManagerOpen);
  const selectElement = useStore((s) => s.selectElement);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const addHiddenIds = useStore((s) => s.addHiddenIds);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);
  const highlightedIds = useStore((s) => s.highlightedIds);
  const frameElements = useStore((s) => s.frameElements);
  const clearChat = useStore((s) => s.clearChat);
  const clearActivity = useStore((s) => s.clearActivity);
  const pendingEdits = useStore((s) => s.pendingEdits);
  const activePendingEditId = useStore((s) => s.activePendingEditId);
  const setActivePendingEditId = useStore((s) => s.setActivePendingEditId);
  const copyShareLink = useStore((s) => s.copyShareLink);
  const setColourBy = useStore((s) => s.setColourBy);
  const measurementLabelsVisible = useStore((s) => s.measurementLabelsVisible);
  const setMeasurementLabelsVisible = useStore((s) => s.setMeasurementLabelsVisible);
  const measurement = useStore((s) => s.measurement);
  const sectionBoxEnabled = useStore((s) => s.sectionBoxEnabled);
  const toggleSectionBox = useStore((s) => s.toggleSectionBox);
  const clipToElement = useStore((s) => s.clipToElement);
  const clipToElementFn = useStore((s) => s.clipToElementFn);
  const clipToElements = useStore((s) => s.clipToElements);
  const clipToElementsFn = useStore((s) => s.clipToElementsFn);
  const ghostModeOn = useStore((s) => s.ghostModeOn);
  const setGhostModeOn = useStore((s) => s.setGhostModeOn);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const selectionHistory = useStore((s) => s.selectionHistory);
  const navigateSelectionHistory = useStore((s) => s.navigateSelectionHistory);
  const spatialTree = useStore((s) => s.spatialTree);
  const logActivity = useStore((s) => s.logActivity);

  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands: Command[] = useMemo(() => {
    const target = resolveViewerActionTargets({
      selectedIds,
      selectedElementId,
      highlightedIds,
    });
    const canVis = target.length > 0;
    // Copy commands work on whichever element is "current" - selected first,
    // single-highlighted as fallback. The two-state surface keeps parity with
    // the I / H / Ctrl+Shift+C shortcuts.
    const copyTargetId =
      selectedElementId != null
        ? selectedElementId
        : highlightedIds.length === 1
          ? highlightedIds[0]
          : null;
    const copyTargetNode =
      copyTargetId != null ? findNodeById(spatialTree, copyTargetId) : null;
    const copyTargetHasGuid = !!copyTargetNode?.global_id;
    const runCopy = (format: ClipboardFormat) => () => {
      if (copyTargetId == null) return;
      const node =
        spatialNodeToClipboardNode(copyTargetNode) ?? { id: copyTargetId };
      void copyNodeToClipboard(format, node).then((result) => {
        if (result) logActivity({ kind: 'info', summary: result.summary });
      });
    };
    const all: Command[] = [
      // Camera
      { id: 'view.front',  label: 'View: Front',      section: 'Camera', shortcut: '1', disabled: !modelLoaded, run: () => onCameraView?.('front') },
      { id: 'view.back',   label: 'View: Back',       section: 'Camera', shortcut: '2', disabled: !modelLoaded, run: () => onCameraView?.('back') },
      { id: 'view.left',   label: 'View: Left',       section: 'Camera', shortcut: '3', disabled: !modelLoaded, run: () => onCameraView?.('left') },
      { id: 'view.right',  label: 'View: Right',      section: 'Camera', shortcut: '4', disabled: !modelLoaded, run: () => onCameraView?.('right') },
      { id: 'view.top',    label: 'View: Top',        section: 'Camera', shortcut: '5', disabled: !modelLoaded, run: () => onCameraView?.('top') },
      { id: 'view.iso',    label: 'View: Isometric',  section: 'Camera', shortcut: '6', disabled: !modelLoaded, run: () => onCameraView?.('iso') },
      {
        id: 'view.fit',
        label: canVis ? 'Frame selected/highlighted elements' : 'Fit model to view',
        section: 'Camera',
        shortcut: 'F',
        disabled: !modelLoaded,
        run: () => canVis ? frameElements(target) : onFitModel?.(),
      },

      // Visibility
      { id: 'vis.isolate', label: 'Isolate selected/highlighted', section: 'Visibility', shortcut: 'I', disabled: !canVis, run: () => setIsolatedIds(target) },
      { id: 'vis.hide',    label: 'Hide selected/highlighted',    section: 'Visibility', shortcut: 'H', disabled: !canVis, run: () => addHiddenIds(target) },
      { id: 'vis.all',     label: 'Show all elements',            section: 'Visibility', shortcut: 'A', disabled: !modelLoaded, run: () => clearVisibility() },
      { id: 'vis.ghost',   label: ghostModeOn ? 'Ghost xray: OFF (restore normal isolate)' : 'Ghost xray: ON (show non-isolated as transparent)', keywords: 'ghost xray isolate transparency opacity edges', section: 'Visibility', shortcut: 'Shift+G', disabled: isolatedIds.length === 0, run: () => { setGhostModeOn(!ghostModeOn); setOpen(false); } },
      { id: 'vis.colour.type',   label: 'Color by IFC type',   keywords: 'colour color type category', section: 'Visibility', disabled: !modelLoaded, run: () => { setColourBy('type'); setOpen(false); } },
      { id: 'vis.colour.storey', label: 'Color by storey',     keywords: 'colour color level floor storey', section: 'Visibility', disabled: !modelLoaded, run: () => { setColourBy('storey'); setOpen(false); } },
      { id: 'vis.colour.off',    label: 'Color: default colors', keywords: 'colour color off clear reset', section: 'Visibility', disabled: !modelLoaded, run: () => { setColourBy('off'); setOpen(false); } },
      { id: 'vis.deselect',label: 'Deselect / clear highlights',  section: 'Visibility', shortcut: 'Esc', run: () => { selectElement(null); setHighlightedIds([]); } },
      { id: 'selection.history.back',    label: 'Previous selection (back through history)', keywords: 'selection history back previous undo', section: 'Selection', shortcut: 'Alt+[', disabled: !modelLoaded || !historyCanGoBack(selectionHistory),    run: () => { navigateSelectionHistory('back');    setOpen(false); } },
      { id: 'selection.history.forward', label: 'Next selection (forward through history)',  keywords: 'selection history forward next redo',    section: 'Selection', shortcut: 'Alt+]', disabled: !modelLoaded || !historyCanGoForward(selectionHistory), run: () => { navigateSelectionHistory('forward'); setOpen(false); } },
      { id: 'viewer.sectionbox', label: sectionBoxEnabled ? 'Disable section box' : 'Enable section box (AABB crop)', keywords: 'section box clip crop cut aabb bounding', section: 'Visibility', shortcut: 'Alt+B', disabled: !modelLoaded, run: () => { toggleSectionBox(); setOpen(false); } },
      {
        id: 'view.clip.element',
        label: selectedIds.length > 1
          ? `Clip section box to ${selectedIds.length} selected elements`
          : 'Clip section box to selection',
        keywords: 'section box clip crop element selection zoom cut aabb',
        section: 'Visibility',
        shortcut: 'Alt+X',
        disabled: selectedIds.length > 0
          ? !clipToElementsFn
          : !clipToElementFn || selectedElementId == null,
        run: () => {
          if (selectedIds.length > 0) {
            clipToElements(selectedIds, `${selectedIds.length} selected elements`);
          } else if (selectedElementId != null) {
            clipToElement(selectedElementId);
          }
          setOpen(false);
        },
      },

      // Clipboard - round-trip element IDs into Solibri / Navisworks / BCF /
      // Revit / spreadsheets. Mirror of the right-click viewer context menu
      // entries; live in Selection so they sit next to the history nav.
      { id: 'element.copy.id', label: 'Copy: Express ID of selected element', keywords: 'copy clipboard express id integer paste', section: 'Selection', disabled: copyTargetId == null, run: runCopy('express-id') },
      { id: 'element.copy.guid', label: 'Copy: GlobalId of selected element', keywords: 'copy clipboard global id guid ifc cross-tool paste', section: 'Selection', disabled: copyTargetId == null || !copyTargetHasGuid, run: runCopy('global-id') },
      { id: 'element.copy.details', label: 'Copy: Element details (type, name, IDs, storey)', keywords: 'copy clipboard details summary multi-line paste bcf issue', section: 'Selection', shortcut: 'Ctrl+Shift+C', disabled: copyTargetId == null, run: runCopy('details') },

      // Capture
      { id: 'cap.shot',    label: 'Capture screenshot',           section: 'Capture', shortcut: 'S', disabled: !modelLoaded, run: () => onScreenshot?.() },
      { id: 'vp.save',     label: 'Save current view as viewpoint', section: 'Capture', shortcut: 'V', disabled: !modelLoaded || !onSaveViewpoint, run: () => {
        const def = `Viewpoint ${viewpoints.length + 1}`;
        const name = window.prompt('Name this viewpoint', def);
        if (name === null) return;
        onSaveViewpoint?.(name || def);
      } },

      // Saved viewpoints (one entry per saved view)
      ...viewpoints.slice(0, 12).map((vp) => ({
        id: `vp.restore.${vp.id}`,
        label: `Restore: ${vp.name}`,
        keywords: 'viewpoint view bookmark restore',
        section: 'Saved Viewpoints',
        run: () => onRestoreViewpoint?.(vp.id),
      })),
      ...(viewpoints.length > 0 && onRestoreViewpoint ? [{
        id: 'vp.deleteall',
        label: 'Delete all saved viewpoints',
        keywords: 'clear remove viewpoints',
        section: 'Saved Viewpoints',
        run: () => {
          if (window.confirm(`Delete all ${viewpoints.length} saved viewpoint(s) for this project?`)) {
            viewpoints.forEach((v) => deleteViewpoint(v.id));
          }
        },
      }] : []),

      // Panels - tabs mode (new)
      ...(rightSidebarMode === 'tabs' ? [
        { id: 'panel.tree.focus',     label: 'Focus tree pane',            section: 'Panels', shortcut: 'T', run: () => { setLeftSidebarOpen(true); focusLeftPane('tree'); } },
        { id: 'panel.search.focus',   label: 'Focus search pane',          section: 'Panels', shortcut: '/', run: () => { setLeftSidebarOpen(true); focusLeftPane('search'); } },
        { id: 'panel.classify.focus', label: 'Focus classifications pane', section: 'Panels', shortcut: 'G', run: () => { setLeftSidebarOpen(true); focusLeftPane('classify'); } },
        { id: 'panel.props.focus', label: 'Focus properties tab',section: 'Panels', shortcut: 'P', run: () => focusRightTab('props') },
        { id: 'panel.views.focus', label: 'Focus viewpoints tab',section: 'Panels', shortcut: 'B', run: () => focusRightTab('views') },
        { id: 'panel.chat.focus',  label: 'Focus AI chat tab',   section: 'Panels', shortcut: 'C', run: () => focusRightTab('chat') },
        { id: 'panel.log.focus',   label: 'Focus activity tab',  section: 'Panels', shortcut: 'L', run: () => focusRightTab('log') },
        { id: 'panel.left.toggle', label: leftSidebarOpen ? 'Hide left sidebar' : 'Show left sidebar', section: 'Panels', run: () => setLeftSidebarOpen(!leftSidebarOpen) },
        { id: 'panel.right.toggle',label: rightSidebarOpen ? 'Hide right sidebar' : 'Show right sidebar', section: 'Panels', shortcut: '\\', run: () => setRightSidebarOpen(!rightSidebarOpen) },
        { id: 'panel.right.expand',label: rightSidebarExpanded ? 'Collapse right sidebar from full width' : 'Expand right sidebar to full width', section: 'Panels', shortcut: 'Shift+\\', run: () => toggleRightSidebarExpanded() },
      ] : [
        // Stacked-mode legacy commands
        { id: 'panel.tree',  label: 'Toggle model tree',   section: 'Panels', shortcut: 'T', run: () => toggleTree() },
        { id: 'panel.props', label: 'Toggle properties',   section: 'Panels', shortcut: 'P', run: () => toggleProps() },
        { id: 'panel.views', label: 'Toggle viewpoints panel', section: 'Panels', shortcut: 'B', run: () => toggleViewpoints() },
        { id: 'panel.chat',  label: 'Toggle AI chat',      section: 'Panels', shortcut: 'C', run: () => toggleChat() },
        { id: 'panel.log',   label: 'Toggle activity log', section: 'Panels', shortcut: 'L', run: () => toggleActivity() },
      ]),
      { id: 'panel.mode',     label: rightSidebarMode === 'tabs' ? 'Layout: switch to stacked panels' : 'Layout: switch to tabbed panels', section: 'Panels', run: () => setRightSidebarMode(rightSidebarMode === 'tabs' ? 'stacked' : 'tabs') },
      { id: 'panel.settings', label: 'Open settings',    section: 'Panels', shortcut: 'Ctrl+,', run: () => setSettingsOpen(true) },
      { id: 'panel.shortcuts', label: 'Show keyboard shortcuts', keywords: 'keyboard shortcuts help keys bindings reference', section: 'Panels', shortcut: '?', run: () => { useStore.getState().setShortcutsHelpOpen(true); } },

      // View options
      { id: 'ui.theme',    label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', section: 'Appearance', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
      { id: 'measure.labels', label: measurementLabelsVisible ? 'Hide measurement labels' : 'Show measurement labels', keywords: 'measurement labels dimension show hide toggle', section: 'Appearance', shortcut: 'L', disabled: measurement.mode === 'off', run: () => setMeasurementLabelsVisible(!measurementLabelsVisible) },
      { id: 'ui.perf',     label: perfHudVisible ? 'Hide performance HUD' : 'Show performance HUD', section: 'Appearance', shortcut: 'M', run: () => setPerfHudVisible(!perfHudVisible) },
      { id: 'ui.perfhist', label: perfDashOpen ? 'Close load-time history' : 'Show load-time history', keywords: 'performance history load time ttfr ttfg dashboard', section: 'Appearance', shortcut: 'Shift+M', run: () => setPerfDashOpen(!perfDashOpen) },
      { id: 'ui.health', label: healthPanelOpen ? 'Close model health check' : 'Open model health check', keywords: 'health quality check audit QA QC bim issues errors warnings', section: 'Model', shortcut: 'Shift+Q', disabled: !modelLoaded, run: () => toggleTool('health') },
      { id: 'ui.checkpoints', label: checkpointPanelOpen ? 'Close timeline' : 'Open timeline', keywords: 'timeline checkpoints git history rollback restore undo snapshot version control operations diff ifc', section: 'Model', shortcut: 'Shift+H', disabled: !modelLoaded, run: () => setCheckpointPanelOpen(!checkpointPanelOpen) },
      { id: 'ui.budget', label: budgetPanelOpen ? 'Close budget dashboard' : 'Open budget dashboard', keywords: 'budget cost spend usage llm tokens money cap limit agent', section: 'Model', shortcut: 'Shift+B', run: () => setBudgetPanelOpen(!budgetPanelOpen) },
      { id: 'ui.filter', label: filterPanelOpen ? 'Close property filter' : 'Open property filter', keywords: 'filter property search element ifc query condition equals contains value pset', section: 'Model', shortcut: 'Shift+F', disabled: !modelLoaded, run: () => toggleTool('filter') },
      { id: 'ui.snippets', label: 'Open Skills (Chat Manager)', keywords: 'skills snippets prompts templates reusable chat message quick insert library', section: 'AI', shortcut: 'Shift+P', run: () => {
        useStore.getState().setChatManagerInitialSection('skills');
        useStore.getState().setAgentManagerOpen(true);
      } },
      { id: 'ui.stats', label: statsPanelOpen ? 'Close model statistics' : 'Open model statistics', keywords: 'statistics stats elements count type storey quantity summary overview', section: 'Model', shortcut: 'Shift+S', disabled: !modelLoaded, run: () => toggleTool('stats') },
      // Tools - all dock into the Tools tab (no floating windows). Backend-driven,
      // so they're filtered out of the viewer-only build.
      { id: 'panel.tools', label: 'Open Tools tab', keywords: 'tools features launcher panels quantity ids bcf plugins statistics hub', section: 'Panels', run: () => focusRightTab('tools') },
      { id: 'feature.qto', label: activeFeaturePanel === 'qto' ? 'Close quantity takeoff' : 'Open quantity takeoff', keywords: 'quantity takeoff qto count area volume measure schedule boq csv', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('qto') },
      { id: 'feature.ids', label: activeFeaturePanel === 'ids' ? 'Close IDS validation' : 'Open IDS validation', keywords: 'ids validation specification requirement check compliance buildingsmart audit', section: 'Model', run: () => toggleTool('ids') },
      { id: 'feature.bcf', label: activeFeaturePanel === 'bcf' ? 'Close BCF topics' : 'Open BCF topics', keywords: 'bcf topic issue comment markup coordination viewpoint collaboration', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('bcf') },
      { id: 'feature.plugins', label: activeFeaturePanel === 'plugins' ? 'Close plugins' : 'Open plugins', keywords: 'plugins scripts python automation custom run extension macro', section: 'Model', run: () => toggleTool('plugins') },
      { id: 'feature.cost', label: activeFeaturePanel === 'cost' ? 'Close cost takeoff' : 'Open cost takeoff', keywords: 'cost 5d bill of quantities boq estimate price rate budget money', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('cost') },
      { id: 'feature.carbon', label: activeFeaturePanel === 'carbon' ? 'Close embodied carbon' : 'Open embodied carbon', keywords: 'carbon embodied co2 sustainability lca epd emissions material green', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('carbon') },
      { id: 'feature.cobie', label: activeFeaturePanel === 'cobie' ? 'Close data handover (COBie)' : 'Open data handover (COBie)', keywords: 'cobie handover fm facility management asset export csv excel data exchange', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('cobie') },
      { id: 'feature.diff', label: activeFeaturePanel === 'diff' ? 'Close changes since upload' : 'Open changes since upload', keywords: 'diff compare changes added removed modified version revision original working', section: 'Model', disabled: !modelLoaded, run: () => toggleTool('diff') },
      { id: 'ui.measurepanel', label: measurementPanelOpen ? 'Close measurement history' : 'Open measurement history', section: 'Measurement', shortcut: 'R', run: () => setMeasurementPanelOpen(!measurementPanelOpen) },
      { id: 'agent.manager', label: 'Open Chat Manager', keywords: 'agent chat llm manager configure tools prompt model temperature keys', section: 'AI', shortcut: 'Ctrl+Shift+M', run: () => setAgentManagerOpen(true) },
      { id: 'docs.index', label: 'Open Document Index (Chat Manager)', keywords: 'document index search pdf markdown spec standard bim upload knowledge', section: 'AI', shortcut: 'Ctrl+Shift+I', run: () => {
        useStore.getState().setChatManagerInitialSection('docs');
        useStore.getState().setAgentManagerOpen(true);
      } },
      // Edit - re-open a pending edit that the user dismissed (Esc /
      // click-outside keeps the envelope in the store so this is always
      // the newest, non-active one). Command only surfaces when there's
      // something to reopen.
      ...(pendingEdits.length > 0 && activePendingEditId === null ? [{
        id: 'edit.reopen_pending',
        label: pendingEdits.length === 1
          ? `Reopen pending edit: ${pendingEdits[0].summary || pendingEdits[0].edit_id.slice(0, 8)}`
          : `Reopen last pending edit (${pendingEdits.length} queued)`,
        keywords: 'pending edit diff preview sandbox apply discard review',
        section: 'Edit',
        shortcut: 'E',
        run: () => setActivePendingEditId(pendingEdits[0].edit_id),
      }] : []),

      // Share
      { id: 'share.link', label: 'Copy share link (camera + highlights)', keywords: 'share link url copy permalink', section: 'Share', shortcut: 'Shift+L', disabled: !modelLoaded, run: () => { void copyShareLink(); } },

      // Export
      {
        id: 'export.properties.csv',
        label: 'Export all properties as CSV',
        keywords: 'export download csv properties pset spreadsheet excel',
        section: 'Export',
        disabled: !modelLoaded,
        run: () => {
          import('../../services/api').then(({ exportModelProperties }) => {
            void exportModelProperties({ format: 'csv' }).catch((e: unknown) => {
              console.error('CSV export failed', e);
            });
          });
        },
      },
      {
        id: 'export.properties.csv.qty',
        label: 'Export all properties + quantities as CSV',
        keywords: 'export download csv properties quantities area volume',
        section: 'Export',
        disabled: !modelLoaded,
        run: () => {
          import('../../services/api').then(({ exportModelProperties }) => {
            void exportModelProperties({ format: 'csv', includeQuantities: true }).catch((e: unknown) => {
              console.error('CSV export failed', e);
            });
          });
        },
      },

      // Session
      { id: 'session.new',        label: 'Close model / open new file', section: 'Session', disabled: !modelLoaded, run: () => reset() },
      { id: 'session.clearchat',  label: 'Clear chat history',          section: 'Session', run: () => clearChat() },
      { id: 'session.clearlog',   label: 'Clear activity log',          section: 'Session', run: () => clearActivity() },
    ];
    return BROWSER_ONLY ? all.filter((c) => !BACKEND_ONLY_COMMAND_IDS.has(c.id)) : all;
  }, [
    modelLoaded, theme, perfHudVisible, selectedElementId, selectedIds, highlightedIds,
    onCameraView, onFitModel, onScreenshot, onSaveViewpoint, onRestoreViewpoint,
    viewpoints, deleteViewpoint,
    setIsolatedIds, addHiddenIds, clearVisibility, selectElement, setHighlightedIds, frameElements,
    toggleTree, toggleProps, toggleChat, toggleActivity, toggleViewpoints, setSettingsOpen,
    setTheme, setPerfHudVisible, reset, clearChat, clearActivity,
    rightSidebarMode, setRightSidebarMode, focusRightTab, focusLeftPane,
    setLeftSidebarOpen, setRightSidebarOpen, toggleRightSidebarExpanded,
    leftSidebarOpen, rightSidebarOpen, rightSidebarExpanded,
    pendingEdits, activePendingEditId, setActivePendingEditId,
    perfDashOpen, setPerfDashOpen, setAgentManagerOpen,
    healthPanelOpen,
    checkpointPanelOpen, setCheckpointPanelOpen,
    budgetPanelOpen, setBudgetPanelOpen,
    filterPanelOpen,
    snippetPanelOpen, setSnippetPanelOpen,
    statsPanelOpen,
    activeFeaturePanel, toggleTool, setOpen,
    measurementPanelOpen, setMeasurementPanelOpen,
    copyShareLink,
    sectionBoxEnabled, toggleSectionBox, clipToElement, clipToElementFn,
    clipToElements, clipToElementsFn,
    measurementLabelsVisible, setMeasurementLabelsVisible, measurement,
    ghostModeOn, setGhostModeOn, isolatedIds,
    selectionHistory, navigateSelectionHistory,
    spatialTree, logActivity,
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return commands.filter((c) => !c.disabled);
    const q = query.toLowerCase();
    return commands
      .filter((c) => !c.disabled)
      .filter((c) =>
        c.label.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q) ||
        (c.keywords || '').toLowerCase().includes(q),
      );
  }, [query, commands]);

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Clamp active index to filtered list
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered, activeIdx]);

  // Scroll active item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, open]);

  if (!open) return null;

  const runCommand = (cmd: Command | undefined) => {
    if (!cmd || cmd.disabled) return;
    setOpen(false);
    // Defer to allow panel to close before side effects
    setTimeout(() => cmd.run(), 0);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCommand(filtered[activeIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Group filtered commands by section while keeping order
  const grouped = new Map<string, { cmd: Command; globalIdx: number }[]>();
  filtered.forEach((cmd, idx) => {
    if (!grouped.has(cmd.section)) grouped.set(cmd.section, []);
    grouped.get(cmd.section)!.push({ cmd, globalIdx: idx });
  });

  return (
    <div className="cmdpal-overlay" onClick={() => setOpen(false)}>
      <div className="cmdpal" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdpal-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
          onKeyDown={handleKey}
        />
        <div className="cmdpal-list" ref={listRef}>
          {filtered.length === 0 ? (
            <p className="cmdpal-empty">No matching commands</p>
          ) : (
            Array.from(grouped.entries()).map(([section, items]) => (
              <div key={section} className="cmdpal-section">
                <div className="cmdpal-section-title">{section}</div>
                {items.map(({ cmd, globalIdx }) => (
                  <div
                    key={cmd.id}
                    data-idx={globalIdx}
                    className={`cmdpal-item ${globalIdx === activeIdx ? 'active' : ''}`}
                    onMouseEnter={() => setActiveIdx(globalIdx)}
                    onClick={() => runCommand(cmd)}
                  >
                    <span className="cmdpal-label">{cmd.label}</span>
                    {cmd.shortcut && <kbd className="cmdpal-kbd">{cmd.shortcut}</kbd>}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="cmdpal-footer">
          <span><kbd>&#x2191;</kbd><kbd>&#x2193;</kbd> navigate</span>
          <span><kbd>Enter</kbd> select</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
