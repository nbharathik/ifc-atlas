import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/useStore';
import { BROWSER_ONLY } from '../../config/featureFlags';
import { fetchStoreyManifest } from '../../services/viewer/streaming';
import {
  DEFAULT_WALL_HEIGHT_M,
  DEFAULT_WALL_THICKNESS_M,
  formatWallLength,
  lowestStorey,
  parseDimension,
  type StoreyOption,
  type WallDrawCommitEvent,
  type WallDrawController,
} from '../../services/editor/wallDraw';
import Icon from '../ui/Icon';

interface Props {
  /** Live controller owned by ViewerPanel (recreated per viewer mount). */
  controller: WallDrawController;
}

/**
 * Drawing-session state that must survive the post-commit soft reload:
 * every structural edit remounts the viewer (modelRefresh.ts →
 * setLoadStartTs), which unmounts this toolbar mid-session. Module scope
 * (same pattern as modelRefresh's debounce state) keeps the tool armed and
 * the parameters stable so "draw wall → reload → draw next wall" flows
 * without re-toggling. Reset only by a full page load.
 */
const session = {
  drawing: false,
  heightText: String(DEFAULT_WALL_HEIGHT_M),
  thicknessText: String(DEFAULT_WALL_THICKNESS_M),
  storeyName: '',
};

/**
 * Storey-manifest cache keyed by the storey name set. The soft reload after
 * every wall commit remounts this toolbar; without the cache each commit
 * would re-POST /api/ifc/storey-manifest (which walks all storey element
 * ids). Creating a wall never changes storey names/elevations, so the key
 * only misses when a genuinely different model (or new storey) arrives.
 */
const manifestCache = new Map<string, StoreyOption[]>();

/**
 * Edit-mode drawing toolbar (master-plan B5, first slice: walls only).
 *
 * Floats bottom-centre of the viewport (measurement toolbar is top-right,
 * clip-plane bar top-centre, zoom controls bottom-left). Visible only when
 * `editMode && editModeAvailable && modelLoaded` and never in the
 * BROWSER_ONLY static build (no backend to write to).
 *
 * The toolbar owns the wall PARAMETERS (height / thickness / storey) and the
 * `create_wall` call; all pointer/preview mechanics live in the controller.
 * On commit the operation is staged backend-side; the backend broadcasts
 * `rebuild_started` and App soft-reloads the model - no scene update here.
 */
export default function EditToolbar({ controller }: Props) {
  const editMode = useStore((s) => s.editMode);
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const editScope = useStore((s) => s.editScope);
  const modelLoaded = useStore((s) => s.modelLoaded);
  const stats = useStore((s) => s.stats);
  const applyOperation = useStore((s) => s.applyOperation);
  const addToast = useStore((s) => s.addToast);

  const [drawing, setDrawing] = useState(session.drawing);
  const [hasStart, setHasStart] = useState(false);
  const [liveLengthM, setLiveLengthM] = useState<number | null>(null);
  const [heightText, setHeightText] = useState(session.heightText);
  const [thicknessText, setThicknessText] = useState(session.thicknessText);
  /** null = manifest not fetched yet; [] = model has no storeys. */
  const [storeys, setStoreys] = useState<StoreyOption[] | null>(null);
  const [storeyName, setStoreyName] = useState(session.storeyName);

  // Mirror the session (render-effect writes never run during the unmount
  // that precedes a soft reload, so a mid-session remount keeps `drawing`).
  useEffect(() => {
    session.drawing = drawing;
    session.heightText = heightText;
    session.thicknessText = thicknessText;
    session.storeyName = storeyName;
  }, [drawing, heightText, thicknessText, storeyName]);

  // Wall drawing creates geometry (reloads the viewer), so it belongs to the
  // structural edit scope only. In semantic scope the toolbar is hidden.
  const visible = editMode && editModeAvailable && editScope === 'structural'
    && modelLoaded && !BROWSER_ONLY;

  // Storey work planes: names + elevations from the backend storey manifest
  // (the only frontend source that carries elevations - stats.storeys is
  // names-only). Refetched only when the storey NAME SET changes, so a
  // create_wall edit (which touches stats) does not re-POST the manifest.
  const storeyNamesKey = useMemo(() => (stats?.storeys ?? []).join('|'), [stats]);
  useEffect(() => {
    if (!visible) return;
    const cached = manifestCache.get(storeyNamesKey);
    if (cached) {
      setStoreys(cached);
      return;
    }
    let cancelled = false;
    fetchStoreyManifest()
      .then((manifest) => {
        if (cancelled) return;
        const options = manifest.storeys.map((s) => ({ name: s.name, elevation: s.elevation }));
        manifestCache.set(storeyNamesKey, options);
        setStoreys(options);
      })
      .catch(() => {
        if (cancelled) return;
        // Backend manifest unavailable: fall back to names-only storeys on a
        // ground plane at elevation 0 (the backend still resolves the name).
        const names = useStore.getState().stats?.storeys ?? [];
        setStoreys(names.map((name) => ({ name, elevation: 0 })));
      });
    return () => { cancelled = true; };
  }, [visible, storeyNamesKey]);

  // Default the selector to the lowest storey (backend find_storey default);
  // keep the user's pick when a refetch still contains it.
  useEffect(() => {
    if (!storeys || storeys.length === 0) return;
    setStoreyName((current) =>
      current && storeys.some((s) => s.name === current)
        ? current
        : lowestStorey(storeys)?.name ?? '',
    );
  }, [storeys]);

  const activeElevation = useMemo(
    () => storeys?.find((s) => s.name === storeyName)?.elevation ?? 0,
    [storeys, storeyName],
  );

  // Keep the controller's work plane on the selected storey.
  useEffect(() => {
    controller.setPlaneElevation(activeElevation);
  }, [controller, activeElevation]);

  // Mirror controller state (Escape can disarm it without a toolbar click).
  useEffect(() => {
    controller.setStateChangeHandler((s) => {
      setDrawing(s.armed);
      setHasStart(s.hasStart);
      setLiveLengthM(s.lengthM);
    });
    return () => controller.setStateChangeHandler(null);
  }, [controller]);

  // Commit: two picked points + current toolbar params -> create_wall.
  // The tool stays armed for the next wall (continuous drawing).
  const handleCommit = useCallback(
    (e: WallDrawCommitEvent) => {
      const params: Record<string, unknown> = {
        start: e.start,
        end: e.end,
        height: parseDimension(heightText, DEFAULT_WALL_HEIGHT_M),
        thickness: parseDimension(thicknessText, DEFAULT_WALL_THICKNESS_M),
      };
      if (storeyName) params.storey_name = storeyName;
      void applyOperation('create_wall', params).then((result) => {
        // applyOperation already toasts failures.
        if (result?.ok && result.changed) {
          addToast('Wall staged - the viewer will refresh', 'success');
        }
      });
    },
    [heightText, thicknessText, storeyName, applyOperation, addToast],
  );

  useEffect(() => {
    controller.setCommitHandler(handleCommit);
    return () => controller.setCommitHandler(null);
  }, [controller, handleCommit]);

  // Drive arm/disarm from the toggle. Leaving the edit surface (Edit mode
  // off, model unloaded) force-disables AND exits the tool, so re-entering
  // Edit mode starts clean. The session flag re-arms the tool only across
  // the post-commit soft reload (where `visible` never flips).
  useEffect(() => {
    if (!visible) {
      controller.disarm();
      setDrawing(false);
      return;
    }
    if (drawing) controller.arm();
    else controller.disarm();
  }, [controller, drawing, visible]);

  // Disarm the outgoing controller/tool when the toolbar itself unmounts.
  useEffect(() => () => controller.disarm(), [controller]);

  if (!visible) return null;

  const hint = !drawing
    ? 'Draw walls on the storey work plane'
    : hasStart
      ? (liveLengthM !== null
          ? `${formatWallLength(liveLengthM)} · click to place end point · Esc cancels`
          : 'Click end point · Esc cancels')
      : 'Click two points · Esc cancels';

  return (
    <div className="edit-toolbar" role="toolbar" aria-label="Edit tools">
      <Icon name="wall" size={12} />
      <button
        className={`edit-toolbar-btn ${drawing ? 'active' : ''}`}
        onClick={() => setDrawing((d) => !d)}
        title="Draw a wall: click a start and an end point on the work plane (Esc exits)"
        aria-pressed={drawing}
      >
        Draw wall
      </button>
      <label className="edit-toolbar-field" title="Wall height in metres">
        H
        <input
          type="number"
          value={heightText}
          min={0.1}
          step={0.1}
          onChange={(e) => setHeightText(e.target.value)}
          aria-label="Wall height (m)"
        />
      </label>
      <label className="edit-toolbar-field" title="Wall thickness in metres">
        T
        <input
          type="number"
          value={thicknessText}
          min={0.05}
          step={0.05}
          onChange={(e) => setThicknessText(e.target.value)}
          aria-label="Wall thickness (m)"
        />
      </label>
      <select
        className="edit-toolbar-select"
        value={storeyName}
        onChange={(e) => setStoreyName(e.target.value)}
        title="Storey work plane - walls are placed at this storey's elevation"
        aria-label="Storey"
      >
        {(!storeys || storeys.length === 0) && (
          <option value="">{storeys ? 'Default storey' : 'Loading storeys…'}</option>
        )}
        {storeys?.map((s, i) => (
          <option key={`${i}:${s.name}`} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <span className="edit-toolbar-hint" aria-live="polite">{hint}</span>
    </div>
  );
}
