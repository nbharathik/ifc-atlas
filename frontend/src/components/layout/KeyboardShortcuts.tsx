import { useEffect, useCallback } from 'react';
import { useStore, activeToolOf } from '../../store/useStore';
import { collectLeavesUnder, findNodeById } from '../../services/viewer/spatialTreeHelpers';
import {
  copyNodeToClipboard,
  spatialNodeToClipboardNode,
  type ClipboardNodeLike,
} from '../../services/viewer/selectionClipboardHelpers';
import { SHORTCUTS } from './shortcutsList';
import { resolveViewerActionTargets } from '../../services/viewer/viewerActionTargetHelpers';
import { BROWSER_ONLY } from '../../config/featureFlags';

const VIEW_MAP: Record<string, string> = {
  '1': 'front',
  '2': 'back',
  '3': 'left',
  '4': 'right',
  '5': 'top',
  '6': 'iso',
};

interface KeyboardShortcutsProps {
  onCameraView?: (view: string) => void;
  onFitModel?: () => void;
  onScreenshot?: () => void;
  onSaveViewpoint?: (name: string) => void;
}

export default function KeyboardShortcuts({
  onCameraView,
  onFitModel,
  onScreenshot,
  onSaveViewpoint,
}: KeyboardShortcutsProps) {
  const showHelp = useStore((s) => s.shortcutsHelpOpen);
  const setShowHelp = useStore((s) => s.setShortcutsHelpOpen);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const toggleTree = useStore((s) => s.toggleTree);
  const toggleProps = useStore((s) => s.toggleProps);
  const toggleChat = useStore((s) => s.toggleChat);
  const toggleActivity = useStore((s) => s.toggleActivity);
  const toggleViewpoints = useStore((s) => s.toggleViewpoints);
  const focusLeftPane = useStore((s) => s.focusLeftPane);
  const focusRightTab = useStore((s) => s.focusRightTab);
  const setLeftSidebarOpen = useStore((s) => s.setLeftSidebarOpen);
  const setRightSidebarOpen = useStore((s) => s.setRightSidebarOpen);
  const toggleRightSidebarExpanded = useStore((s) => s.toggleRightSidebarExpanded);
  const rightSidebarMode = useStore((s) => s.rightSidebarMode);
  const rightSidebarOpen = useStore((s) => s.rightSidebarOpen);
  const leftSidebarOpen = useStore((s) => s.leftSidebarOpen);
  const selectElement = useStore((s) => s.selectElement);
  const setHighlightedIds = useStore((s) => s.setHighlightedIds);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const addHiddenIds = useStore((s) => s.addHiddenIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const setCommandPaletteOpen = useStore((s) => s.setCommandPaletteOpen);
  const commandPaletteOpen = useStore((s) => s.commandPaletteOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const perfHudVisible = useStore((s) => s.perfHudVisible);
  const setPerfHudVisible = useStore((s) => s.setPerfHudVisible);
  const toggleClipPlane = useStore((s) => s.toggleClipPlane);
  const floatingChatMinimized = useStore((s) => s.floatingChatMinimized);
  const rightActiveTab = useStore((s) => s.rightActiveTab);
  const setFloatingChatMinimized = useStore((s) => s.setFloatingChatMinimized);
  const measurementPanelOpen = useStore((s) => s.measurementPanelOpen);
  const setMeasurementPanelOpen = useStore((s) => s.setMeasurementPanelOpen);
  const undoLastEdit = useStore((s) => s.undoLastEdit);
  const redoLastEdit = useStore((s) => s.redoLastEdit);
  const isUndoing = useStore((s) => s.isUndoing);
  const navigateSelectionHistory = useStore((s) => s.navigateSelectionHistory);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Cmd/Ctrl+K opens command palette (works even without a model)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      // Ctrl+/ - open / focus AI assistant (backend-only surface)
      if ((e.ctrlKey || e.metaKey) && e.key === '/' && !BROWSER_ONLY) {
        e.preventDefault();
        if (rightSidebarOpen && rightActiveTab === 'chat') {
          // Already in sidebar chat - focus the textarea
          const ta = document.querySelector<HTMLTextAreaElement>('.chat-input textarea');
          ta?.focus();
        } else {
          setFloatingChatMinimized(false);
          // Focus the floating dock textarea on next frame
          requestAnimationFrame(() => {
            const ta = document.querySelector<HTMLTextAreaElement>('.floating-chat-body textarea');
            ta?.focus();
          });
        }
        return;
      }

      // Ctrl+Z - undo last committed edit (guard: not already in-flight).
      // Edits only exist with a backend; skip in the viewer-only build.
      // Routes through the operation layer when the backend reports editing
      // enabled (arming redo), else the legacy inverse-delta undo.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !BROWSER_ONLY) {
        e.preventDefault();
        if (modelLoaded && !isUndoing) void undoLastEdit();
        return;
      }

      // Ctrl+Y / Ctrl+Shift+Z - redo the most recently undone operation.
      if (
        (e.ctrlKey || e.metaKey) && !BROWSER_ONLY &&
        ((e.key === 'y' || e.key === 'Y') || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))
      ) {
        e.preventDefault();
        if (modelLoaded && !isUndoing) void redoLastEdit();
        return;
      }

      // Ctrl+Shift+C - copy details for the currently selected (or only
      // highlighted) element. Distinct from Ctrl+C (browser-native copy) so
      // a user mid-text-select isn't surprised. Routes selectedElementId
      // first, falls back to the single highlighted id if nothing is
      // selected - matches the I/H shortcut convention.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        if (!modelLoaded) return;
        const stateC = useStore.getState();
        const targetId =
          stateC.selectedElementId != null
            ? stateC.selectedElementId
            : stateC.highlightedIds.length === 1
              ? stateC.highlightedIds[0]
              : null;
        if (targetId == null) return;
        const treeNode = findNodeById(stateC.spatialTree, targetId);
        const node: ClipboardNodeLike =
          spatialNodeToClipboardNode(treeNode) ?? { id: targetId };
        void copyNodeToClipboard('details', node).then((result) => {
          if (result) {
            useStore.getState().logActivity({ kind: 'info', summary: result.summary });
          }
        });
        return;
      }

      // Ctrl+, - open settings (the conventional preferences shortcut; the
      // Menubar advertises it, so it must actually fire).
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // Ctrl+B - toggle the outliner (left sidebar), VS Code-style.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setLeftSidebarOpen(!leftSidebarOpen);
        return;
      }

      // Ctrl+F - open the model search pane and focus its input.
      // focusLeftPane is a toggle (re-focusing the active pane collapses it),
      // so only call it when search is not already the front pane - Ctrl+F
      // must never close the search. Without a model the pane is not mounted;
      // bail before preventDefault so the browser's native find still works.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        if (!modelLoaded) return;
        e.preventDefault();
        const sSearch = useStore.getState();
        if (!sSearch.leftSidebarOpen || sSearch.leftActivePane !== 'search') {
          focusLeftPane('search');
        }
        // Focus the search input on the next frame, once the pane has
        // rendered (same pattern as the Ctrl+/ chat-textarea focus above).
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>('.outliner-body .search-bar input');
          input?.focus();
          input?.select();
        });
        return;
      }

      // Alt+[ / Alt+] step through selection history (browser-style).
      // Tested on US/EU layouts: `e.code` is keyboard-position-based, so it
      // works even when Alt remaps the produced character (e.g. macOS Option+[).
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.code === 'BracketLeft' || e.key === '[') {
          e.preventDefault();
          if (modelLoaded) navigateSelectionHistory('back');
          return;
        }
        if (e.code === 'BracketRight' || e.key === ']') {
          e.preventDefault();
          if (modelLoaded) navigateSelectionHistory('forward');
          return;
        }
      }

      // Don't trigger single-letter shortcuts when modifier keys are pressed
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (!modelLoaded && e.key !== '?' && e.key !== 'Escape') return;

      // Helpers that route shortcut key behavior based on right sidebar mode
      const focusOrToggleRight = (tab: 'props' | 'views' | 'log' | 'chat',
                                   stackedToggle: () => void) => {
        if (rightSidebarMode === 'tabs') focusRightTab(tab);
        else stackedToggle();
      };

      switch (e.key) {
        case '?':
          e.preventDefault();
          setShowHelp(!showHelp);
          break;
        case 'Escape':
          if (useStore.getState().pickPlaneMode) {
            // Highest priority: cancel surface-pick mode without side effects.
            useStore.getState().setPickPlaneMode(false);
          } else if (showHelp) {
            setShowHelp(false);
          } else if (commandPaletteOpen) {
            setCommandPaletteOpen(false);
          } else if (settingsOpen) {
            setSettingsOpen(false);
          } else if (
            activeToolOf(useStore.getState()) !== null &&
            useStore.getState().rightActiveTab === 'tools' &&
            useStore.getState().rightSidebarOpen
          ) {
            // A tool is docked AND visible in the Tools tab - Esc returns to its
            // launcher. Gated on the tab being shown so Esc on another tab still
            // falls through to deselect. (stats/filter/health also pre-empt this
            // via their own capture-phase Esc handlers; this covers the four
            // feature panels, which have none.)
            useStore.getState().closeTool();
          } else {
            selectElement(null);
            setHighlightedIds([]);
          }
          break;
        case 't':
        case 'T':
          e.preventDefault();
          if (rightSidebarMode === 'tabs') {
            // Tabs mode: T focuses the tree pane in the left sidebar.
            if (!leftSidebarOpen) setLeftSidebarOpen(true);
            focusLeftPane('tree');
          } else {
            toggleTree();
          }
          break;
        case '/':
          e.preventDefault();
          if (rightSidebarMode === 'tabs') {
            if (!leftSidebarOpen) setLeftSidebarOpen(true);
            focusLeftPane('search');
          }
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+G: toggle ghost mode (xray isolate). Only useful when
            // elements are isolated; ignored otherwise.
            const stateG = useStore.getState();
            if (stateG.isolatedIds.length > 0) {
              stateG.setGhostModeOn(!stateG.ghostModeOn);
            }
          } else if (rightSidebarMode === 'tabs') {
            if (!leftSidebarOpen) setLeftSidebarOpen(true);
            focusLeftPane('classify');
          }
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+P opens the Chat Manager on the Skills tab.
            useStore.getState().setChatManagerInitialSection('skills');
            useStore.getState().setAgentManagerOpen(true);
          } else {
            focusOrToggleRight('props', toggleProps);
          }
          break;
        case 'c':
        case 'C':
          if (BROWSER_ONLY) break; // chat tab absent in viewer-only build
          e.preventDefault();
          focusOrToggleRight('chat', toggleChat);
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          if (e.shiftKey) {
            void useStore.getState().copyShareLink();
          } else {
            focusOrToggleRight('log', toggleActivity);
          }
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          setMeasurementPanelOpen(!measurementPanelOpen);
          break;
        case 'n':
        case 'N': {
          e.preventDefault();
          const curMode = useStore.getState().measurement.mode;
          const nextMode = curMode === 'angle' ? 'off' : 'angle';
          useStore.getState().setMeasurementMode(nextMode);
          if (nextMode === 'angle') useStore.getState().setMeasurementPanelOpen(true);
          break;
        }
        case 'b':
        case 'B':
          e.preventDefault();
          if (e.shiftKey) {
            useStore.getState().setBudgetPanelOpen(!useStore.getState().budgetPanelOpen);
          } else {
            focusOrToggleRight('views', toggleViewpoints);
          }
          break;
        case '\\':
          e.preventDefault();
          if (rightSidebarMode === 'tabs') {
            if (e.shiftKey) {
              toggleRightSidebarExpanded();
            } else {
              setRightSidebarOpen(!rightSidebarOpen);
            }
          }
          break;
        case 'v':
        case 'V': {
          e.preventDefault();
          if (!onSaveViewpoint) break;
          const project = useStore.getState().project;
          if (!project) break;
          const count = useStore.getState().viewpoints.length;
          const def = `Viewpoint ${count + 1}`;
          const name = window.prompt('Name this viewpoint', def);
          if (name === null) break;
          onSaveViewpoint(name || def);
          break;
        }
        case 'm':
        case 'M':
          e.preventDefault();
          if (e.shiftKey) {
            useStore.getState().setPerfDashOpen(!useStore.getState().perfDashOpen);
          } else {
            setPerfHudVisible(!perfHudVisible);
          }
          break;
        case 'q':
        case 'Q':
          if (e.shiftKey && !BROWSER_ONLY) {
            e.preventDefault();
            useStore.getState().toggleTool('health');
          }
          break;
        case 'h':
        case 'H':
          e.preventDefault();
          if (e.shiftKey) {
            useStore.getState().setCheckpointPanelOpen(!useStore.getState().checkpointPanelOpen);
          } else {
            const targets = resolveViewerActionTargets(useStore.getState());
            if (targets.length > 0) addHiddenIds(targets);
          }
          break;
        case 'f':
        case 'F':
          if (e.shiftKey) {
            if (!BROWSER_ONLY) {
              e.preventDefault();
              useStore.getState().toggleTool('filter');
            }
          } else {
            e.preventDefault();
            // Frame the active selection if there is one (matches
            // H / I priority). Empty target list falls through to fit-model so
            // a fresh model with no selection still frames the whole scene.
            const state = useStore.getState();
            const targets = resolveViewerActionTargets(state);
            const frameFn = state.frameElementsFn;
            if (targets.length > 0 && frameFn) {
              frameFn(targets);
            } else {
              onFitModel?.();
            }
          }
          break;
        case 's':
        case 'S':
          e.preventDefault();
          if (e.shiftKey) {
            useStore.getState().toggleTool('stats');
          } else {
            onScreenshot?.();
          }
          break;
        case 'i':
        case 'I': {
          e.preventDefault();
          const targets = resolveViewerActionTargets(useStore.getState());
          if (targets.length > 0) setIsolatedIds(targets);
          break;
        }
        case 'a':
        case 'A':
          e.preventDefault();
          clearVisibility();
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          if (e.shiftKey) {
            // Shift+X: toggle pick-plane mode (place by surface click)
            useStore.getState().setPickPlaneMode(!useStore.getState().pickPlaneMode);
          } else {
            toggleClipPlane();
          }
          break;
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          if (e.shiftKey) {
            // Shift+1-9: isolate the Nth storey (or clear isolation if already active).
            e.preventDefault();
            const state = useStore.getState();
            const tree = state.spatialTree;
            if (!tree) break;
            // Extract storey nodes from the spatial tree (in-order walk).
            const storeys: { id: number; name: string }[] = [];
            const walk = (n: typeof tree) => {
              if (n.ifc_type.toLowerCase() === 'ifcbuildingstorey') {
                storeys.push({ id: n.id, name: n.name });
              }
              for (const c of n.children) walk(c);
            };
            walk(tree);
            const idx = parseInt(e.key, 10) - 1;
            if (idx >= storeys.length) break;
            const storey = storeys[idx];
            // Find the full subtree for isolation.
            let storeyNode: typeof tree | null = null;
            const find = (n: typeof tree): typeof tree | null => {
              if (n.id === storey.id) return n;
              for (const c of n.children) { const h = find(c); if (h) return h; }
              return null;
            };
            storeyNode = find(tree);
            if (!storeyNode) break;
            // Isolate the same leaf-element set as the Viewer Tools storey
            // chips - including container nodes made the isolation set differ
            // from the chip's leaf set, so the chip never lit up for Shift+N.
            const subtreeIds = collectLeavesUnder(storeyNode);
            // Toggle: if this storey is already isolated, clear; else isolate.
            const cur = state.isolatedIds;
            const sameSet = cur.length === subtreeIds.length && new Set(cur).size === new Set(subtreeIds).size &&
              cur.every((id) => subtreeIds.includes(id));
            if (sameSet) {
              clearVisibility();
              state.logActivity({ kind: 'show-all', summary: `Cleared storey isolation` });
            } else {
              setIsolatedIds(subtreeIds);
              state.logActivity({ kind: 'isolate', summary: `Isolated storey "${storey.name}" (Shift+${e.key})` });
            }
          } else if (e.key >= '1' && e.key <= '6') {
            // Plain 1-6: camera views.
            e.preventDefault();
            onCameraView?.(VIEW_MAP[e.key]);
          }
          break;
      }
    },
    [
      modelLoaded, showHelp, setShowHelp, commandPaletteOpen, settingsOpen, perfHudVisible,
      toggleTree, toggleProps, toggleChat, toggleActivity, toggleViewpoints,
      focusLeftPane, focusRightTab, setLeftSidebarOpen, setRightSidebarOpen,
      toggleRightSidebarExpanded, rightSidebarMode, rightSidebarOpen, leftSidebarOpen,
      selectElement, setHighlightedIds,
      setIsolatedIds, addHiddenIds, clearVisibility,
      setCommandPaletteOpen, setSettingsOpen, setPerfHudVisible,
      toggleClipPlane,
      measurementPanelOpen, setMeasurementPanelOpen,
      undoLastEdit, redoLastEdit, isUndoing,
      navigateSelectionHistory,
      onCameraView, onFitModel, onScreenshot, onSaveViewpoint,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!showHelp) return null;

  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <div className="shortcuts-overlay" onClick={() => setShowHelp(false)}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <h2>Keyboard Shortcuts</h2>
          <button className="btn-icon" onClick={() => setShowHelp(false)}>
            &times;
          </button>
        </div>
        <div className="shortcuts-body">
          {categories.map((cat) => (
            <div key={cat} className="shortcuts-category">
              <h3>{cat}</h3>
              <div className="shortcuts-list">
                {SHORTCUTS.filter((s) => s.category === cat).map((s) => (
                  <div key={s.key} className="shortcut-row">
                    <kbd>{s.label}</kbd>
                    <span>{s.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
