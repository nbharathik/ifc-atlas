import { useCallback, useMemo, useState } from 'react';
import { useStore, MAX_CLIP_PLANES } from '../../store/useStore';
import type { ClipAxis, ClipPlaneState, ColourByProperty } from '../../store/useStore';
import { buildColourGroups, shortIfcType } from '../../services/viewer/colourByHelper';
import { collectLeavesUnder } from '../../services/viewer/spatialTreeHelpers';
import type { SpatialNode } from '../../types/ifc';
import Icon from '../ui/Icon';

// ── Storey helpers ────────────────────────────────────────────────────────────

function findStoreyNode(root: SpatialNode | null, name: string): SpatialNode | null {
  if (!root) return null;
  const walk = (n: SpatialNode): SpatialNode | null => {
    if (n.ifc_type.toLowerCase() === 'ifcbuildingstorey' && n.name === name) return n;
    for (const c of n.children) { const h = walk(c); if (h) return h; }
    return null;
  };
  return walk(root);
}

// ── Section helpers ───────────────────────────────────────────────────────────

const AXIS_LABELS: Record<ClipAxis, string> = { x: 'X', y: 'Y', z: 'Z' };
const AXIS_HINTS: Record<ClipAxis, string> = {
  x: 'Cut along X (side section)',
  y: 'Cut along Y (horizontal / storey cut)',
  z: 'Cut along Z (front section)',
};

function fmtOffset(v: number): string {
  if (!Number.isFinite(v)) return '0.00';
  return Math.abs(v) < 0.01 ? '0.00' : v.toFixed(2);
}

function ClipPlaneRow({ plane, index }: { plane: ClipPlaneState; index: number }) {
  const updateClipPlane = useStore((s) => s.updateClipPlane);
  const setClipPlaneOffsetTransient = useStore((s) => s.setClipPlaneOffsetTransient);
  const removeClipPlane = useStore((s) => s.removeClipPlane);
  const halfExtents = useStore((s) => s.modelHalfExtents);
  const axisExtent = halfExtents
    ? (plane.axis === 'x' ? halfExtents.x : plane.axis === 'y' ? halfExtents.y : halfExtents.z)
    : 50;
  const range = Math.max(1, axisExtent * 1.15);
  const step = Math.max(0.01, range / 200);

  return (
    <div className="vtp-plane-row">
      <div className="vtp-plane-header">
        <span className="vtp-plane-label">Plane {index + 1}</span>
        <button
          className="vtp-icon-btn vtp-icon-btn-danger"
          onClick={() => removeClipPlane(plane.id)}
          title="Remove this plane"
        >
          <Icon name="x" size={11} />
        </button>
      </div>
      <div className="vtp-btn-row">
        {(Object.keys(AXIS_LABELS) as ClipAxis[]).map((axis) => (
          <button
            key={axis}
            className={`vtp-pill-btn${axis === plane.axis ? ' active' : ''}`}
            onClick={() => updateClipPlane(plane.id, { axis })}
            title={AXIS_HINTS[axis]}
          >
            {AXIS_LABELS[axis]}
          </button>
        ))}
        <button
          className={`vtp-pill-btn${plane.inverted ? ' active' : ''}`}
          onClick={() => updateClipPlane(plane.id, { inverted: !plane.inverted })}
          title="Flip which side is kept"
        >
          Flip
        </button>
      </div>
      <div className="vtp-slider-row">
        <input
          type="range"
          className="vtp-slider"
          min={-range} max={range} step={step}
          value={plane.offset}
          onChange={(e) => setClipPlaneOffsetTransient(plane.id, Number(e.currentTarget.value))}
          onPointerUp={(e) => updateClipPlane(plane.id, { offset: Number(e.currentTarget.value) })}
          onKeyUp={(e) => updateClipPlane(plane.id, { offset: Number(e.currentTarget.value) })}
          onBlur={(e) => updateClipPlane(plane.id, { offset: Number(e.currentTarget.value) })}
          aria-label={`Plane ${index + 1} offset`}
        />
        <span className="vtp-slider-val">{fmtOffset(plane.offset)} m</span>
        <button
          className="vtp-link-btn"
          onClick={() => updateClipPlane(plane.id, { offset: 0 })}
          title="Reset to centre"
        >
          Centre
        </button>
      </div>
    </div>
  );
}

// ── Colour-by legend ──────────────────────────────────────────────────────────

const COLOUR_OPTIONS: { value: ColourByProperty; label: string }[] = [
  { value: 'off',      label: 'Off' },
  { value: 'type',     label: 'IFC type' },
  { value: 'storey',   label: 'Storey' },
  { value: 'material', label: 'Material' },
];

// ── Collapsible section wrapper ───────────────────────────────────────────────

function VtpSection({
  id, icon, label, children, defaultOpen = true,
}: {
  id: string;
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="vtp-section">
      <button
        className="vtp-section-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`vtp-${id}`}
      >
        <span className="vtp-section-icon">{icon}</span>
        <span className="vtp-section-label">{label}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      </button>
      {open && (
        <div id={`vtp-${id}`} className="vtp-section-body">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function ViewerToolsPanel() {
  const open = useStore((s) => s.viewerToolsOpen);
  const setOpen = useStore((s) => s.setViewerToolsOpen);
  const hidden = useStore((s) => s.viewerToolsHidden);
  const setHidden = useStore((s) => s.setViewerToolsHidden);
  const modelLoaded = useStore((s) => s.modelLoaded);

  // Storey state
  const stats = useStore((s) => s.stats);
  const spatialTree = useStore((s) => s.spatialTree);
  const isolatedIds = useStore((s) => s.isolatedIds);
  const setIsolatedIds = useStore((s) => s.setIsolatedIds);
  const clearVisibility = useStore((s) => s.clearVisibility);
  const logActivity = useStore((s) => s.logActivity);
  // The active storey chip is derived from the visibility model: a chip is
  // active only while the isolation set is exactly that storey's leaf set,
  // no matter which surface (chips, Shift+1..9, AI commands) isolated it.
  const storeyLeafSets = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const name of stats?.storeys ?? []) {
      const node = findStoreyNode(spatialTree, name);
      if (node) map.set(name, collectLeavesUnder(node));
    }
    return map;
  }, [spatialTree, stats]);
  const activeStorey = useMemo(() => {
    if (isolatedIds.length === 0) return null;
    const iso = new Set(isolatedIds);
    for (const [name, leaves] of storeyLeafSets) {
      if (leaves.length === isolatedIds.length && leaves.every((id) => iso.has(id))) {
        return name;
      }
    }
    return null;
  }, [isolatedIds, storeyLeafSets]);

  // Clip plane state
  const clipPlanes = useStore((s) => s.clipPlanes);
  const addClipPlane = useStore((s) => s.addClipPlane);
  const enabledPlanes = clipPlanes.filter((p) => p.enabled);

  // Measurement state
  const mode = useStore((s) => s.measurement.mode);
  const unit = useStore((s) => s.measurement.unit);
  const setMeasurement = useStore((s) => s.setMeasurement);
  const setMeasurementMode = useStore((s) => s.setMeasurementMode);

  // Section box state
  const sectionBoxEnabled = useStore((s) => s.sectionBoxEnabled);
  const sectionWorkspace = useStore((s) => s.sectionWorkspace);
  const toggleSectionBox = useStore((s) => s.toggleSectionBox);
  const setSectionBoxEnabled = useStore((s) => s.setSectionBoxEnabled);
  const setSectionWorkspace = useStore((s) => s.setSectionWorkspace);
  const clipToElement = useStore((s) => s.clipToElement);
  const clipToElementFn = useStore((s) => s.clipToElementFn);
  const clipToElements = useStore((s) => s.clipToElements);
  const clipToElementsFn = useStore((s) => s.clipToElementsFn);
  const selectedElementId = useStore((s) => s.selectedElementId);
  const selectedIds = useStore((s) => s.selectedIds);

  // Colour-by state
  const colourBy = useStore((s) => s.colourBy);
  const setColourBy = useStore((s) => s.setColourBy);
  // Memoize the full-tree walk so it only re-runs when the tree or the
  // grouping property change, not on the many unrelated store mutations this
  // heavily-subscribed panel re-renders on (selection/visibility/measurement).
  const colourGroups = useMemo(
    () => (colourBy !== 'off' ? buildColourGroups(spatialTree, colourBy) : []),
    [colourBy, spatialTree],
  );

  // Selection focus / ghost mode state
  const selectionFocusMode = useStore((s) => s.selectionFocusMode);
  const setSelectionFocusMode = useStore((s) => s.setSelectionFocusMode);
  const selectionGhostOpacity = useStore((s) => s.selectionGhostOpacity);
  const setSelectionGhostOpacity = useStore((s) => s.setSelectionGhostOpacity);

  // Isolation ghost xray mode
  const ghostModeOn = useStore((s) => s.ghostModeOn);
  const setGhostModeOn = useStore((s) => s.setGhostModeOn);
  const hasIsolation = isolatedIds.length > 0;

  const handleStoreyClick = useCallback((storeyName: string) => {
    if (activeStorey === storeyName) {
      clearVisibility();
      logActivity({ kind: 'show-all', summary: `Cleared storey isolation` });
    } else {
      const node = findStoreyNode(spatialTree, storeyName);
      if (!node) return;
      const ids = collectLeavesUnder(node);
      setIsolatedIds(ids);
      logActivity({ kind: 'isolate', summary: `Isolated storey "${storeyName}" (${ids.length} elements)` });
    }
  }, [activeStorey, spatialTree, setIsolatedIds, clearVisibility, logActivity]);

  const handleStoreySection = useCallback((storeyName: string) => {
    const node = findStoreyNode(spatialTree, storeyName);
    if (!node) return;
    const ids = collectLeavesUnder(node);
    clipToElements(ids, `storey "${storeyName}"`);
  }, [clipToElements, spatialTree]);

  const sectionSelectionIds = selectedIds.length > 0
    ? selectedIds
    : selectedElementId != null
    ? [selectedElementId]
    : [];

  if (!modelLoaded) return null;

  // ── Fully hidden: show a tiny pull-tab on the viewer's left edge ───────────
  if (hidden) {
    return (
      <button
        className="vtp-pulltab"
        onClick={() => setHidden(false)}
        title="Show viewer tools"
        aria-label="Show viewer tools"
      >
        <Icon name="chevron-right" size={14} />
      </button>
    );
  }

  // ── Collapsed strip ──────────────────────────────────────────────────────────
  if (!open) {
    return (
      <div className="vtp-strip vtp-floating" role="complementary" aria-label="Viewer tools (collapsed)">
        <button
          className="vtp-strip-toggle"
          onClick={() => setOpen(true)}
          title="Expand viewer tools"
          aria-label="Expand viewer tools"
        >
          <Icon name="chevron-right" size={14} />
        </button>
        <button
          className={`vtp-strip-btn${enabledPlanes.length > 0 ? ' active' : ''}`}
          onClick={() => setOpen(true)}
          title="Section planes"
        >
          <Icon name="section" size={15} />
        </button>
        <button
          className={`vtp-strip-btn${sectionBoxEnabled ? ' active' : ''}`}
          onClick={toggleSectionBox}
          title={sectionBoxEnabled ? 'Section box ON - click to disable (Alt+B)' : 'Toggle section box crop (Alt+B)'}
          aria-pressed={sectionBoxEnabled}
        >
          <Icon name="box" size={15} />
        </button>
        <button
          className={`vtp-strip-btn${mode !== 'off' ? ' active' : ''}`}
          onClick={() => { setMeasurementMode(mode === 'off' ? 'linear' : 'off'); }}
          title={mode !== 'off' ? 'Measurement active - click to disable' : 'Measurement tools'}
        >
          <Icon name="ruler" size={15} />
        </button>
        <button
          className={`vtp-strip-btn${(stats?.storeys.length ?? 0) > 0 ? '' : ' disabled'}`}
          onClick={() => setOpen(true)}
          title="Storey filter"
        >
          <Icon name="layers" size={15} />
        </button>
        <button
          className={`vtp-strip-btn${colourBy !== 'off' ? ' active' : ''}`}
          onClick={() => setOpen(true)}
          title="Appearance / colour by"
        >
          <Icon name="sliders" size={15} />
        </button>

        {/* Bottom: hide-completely button */}
        <button
          className="vtp-strip-btn vtp-strip-hide"
          onClick={() => setHidden(true)}
          title="Hide viewer tools"
          aria-label="Hide viewer tools"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
    );
  }

  // ── Expanded panel ───────────────────────────────────────────────────────────
  return (
    <aside
      className="vtp-panel vtp-floating"
      role="complementary"
      aria-label="Viewer tools"
    >
      {/* Panel header */}
      <div className="vtp-header">
        <span className="vtp-header-title">Viewer Tools</span>
        <div className="vtp-header-actions">
          <button
            className="vtp-icon-btn"
            onClick={() => setOpen(false)}
            title="Collapse to strip"
            aria-label="Collapse to strip"
          >
            <Icon name="chevron-left" size={13} />
          </button>
          <button
            className="vtp-icon-btn"
            onClick={() => { setOpen(false); setHidden(true); }}
            title="Hide viewer tools"
            aria-label="Hide viewer tools"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      </div>

      <div className="vtp-body">

        {/* ── Storeys ── */}
        {stats && stats.storeys.length > 0 && (
          <VtpSection id="storeys" label="Storeys" defaultOpen icon={<Icon name="layers" size={13} />}>
            {(activeStorey || hasIsolation) && (
              <div className="vtp-section-actions" style={{ marginBottom: 6 }}>
                {(activeStorey || hasIsolation) && (
                  <button
                    className="vtp-link-btn vtp-show-all"
                    onClick={() => { clearVisibility(); logActivity({ kind: 'show-all', summary: 'Cleared storey isolation' }); }}
                  >
                    Show all
                  </button>
                )}
                {hasIsolation && (
                  <button
                    className={`vtp-pill-btn${ghostModeOn ? ' active' : ''}`}
                    onClick={() => setGhostModeOn(!ghostModeOn)}
                    title={ghostModeOn ? 'Ghost xray ON - click to hide non-isolated elements (Shift+G)' : 'Ghost xray - show non-isolated elements as transparent with xray edges (Shift+G)'}
                    aria-pressed={ghostModeOn}
                  >
                    <Icon name="eye" size={11} style={{ marginRight: 3 }} />
                    Ghost xray
                  </button>
                )}
                {activeStorey && (
                  <button
                    className="vtp-pill-btn"
                    onClick={() => handleStoreySection(activeStorey)}
                    disabled={!clipToElementsFn}
                    title={`Fit the section box to storey "${activeStorey}"`}
                  >
                    <Icon name="crop" size={11} style={{ marginRight: 3 }} />
                    Section storey
                  </button>
                )}
              </div>
            )}
            <div className="vtp-chips">
              {stats.storeys.map((s) => (
                <button
                  key={s}
                  className={`vtp-chip${activeStorey === s ? ' active' : ''}`}
                  title={activeStorey === s ? `Clear isolation of "${s}"` : `Isolate "${s}"`}
                  onClick={() => handleStoreyClick(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </VtpSection>
        )}

        {/* ── Section planes ── */}
        <VtpSection id="sections" label="Section planes" defaultOpen={enabledPlanes.length > 0} icon={<Icon name="section" size={13} />}>
          <p className="vtp-section-desc">
            Slice the model along an axis to look inside. Drag the slider to move the cut.
          </p>
          <div className="vtp-section-actions">
            {enabledPlanes.length < MAX_CLIP_PLANES && (
              <button className="vtp-action-btn" onClick={addClipPlane} title={`Add a section plane (up to ${MAX_CLIP_PLANES})`}>
                <Icon name="plus" size={11} />
                Add plane
              </button>
            )}
            {enabledPlanes.length > 0 && (
              <span className="vtp-count-badge">{enabledPlanes.length}/{MAX_CLIP_PLANES}</span>
            )}
          </div>
          {enabledPlanes.length === 0 && (
            <p className="vtp-empty">
              No planes yet. Click Add plane, press <kbd>X</kbd>, or <kbd>Shift+X</kbd> then
              click a surface to cut along it.
            </p>
          )}
          {enabledPlanes.map((plane, i) => (
            <ClipPlaneRow key={plane.id} plane={plane} index={i} />
          ))}
        </VtpSection>

        {/* ── Section box ── */}
        <VtpSection id="sectionbox" label="Section box" defaultOpen={sectionBoxEnabled} icon={<Icon name="box" size={13} />}>
          <p className="vtp-section-desc">
            Hides everything outside a crop box, so you can inspect one room, floor,
            or element without the rest of the building in the way.
          </p>
          <div className="vtp-section-actions">
            <button
              className={`vtp-action-btn${sectionBoxEnabled ? ' active' : ''}`}
              onClick={toggleSectionBox}
              aria-pressed={sectionBoxEnabled}
              title={sectionBoxEnabled ? 'Turn the crop box off (Alt+B)' : 'Turn the crop box on (Alt+B)'}
            >
              <Icon name={sectionBoxEnabled ? 'eye-off' : 'box'} size={11} />
              {sectionBoxEnabled ? 'Turn off' : 'Turn on'}
            </button>
            <button
              className="vtp-action-btn"
              onClick={() => {
                if (selectedIds.length > 0) {
                  clipToElements(selectedIds, `${selectedIds.length} selected elements`);
                } else if (selectedElementId != null) {
                  clipToElement(selectedElementId);
                }
              }}
              disabled={
                sectionSelectionIds.length === 0
                || (selectedIds.length > 0 ? !clipToElementsFn : !clipToElementFn)
              }
              title={
                sectionSelectionIds.length === 0
                  ? 'Select an element first, then shrink the box around it'
                  : sectionSelectionIds.length > 1
                  ? `Shrink the box around the ${sectionSelectionIds.length} selected elements`
                  : 'Shrink the box around the selected element'
              }
            >
              <Icon name="crop" size={11} />
              Box around selection
            </button>
            <button
              className="vtp-action-btn"
              onClick={() => {
                setSectionWorkspace(null);
                setSectionBoxEnabled(true);
              }}
              title="Grow the box back to the whole model"
            >
              <Icon name="maximize" size={11} />
              Whole model
            </button>
          </div>
          {sectionBoxEnabled && (
            <p className="vtp-empty" style={{ marginTop: 4 }}>
              {sectionWorkspace?.name ?? 'Full model section box'} active. <kbd>Alt+B</kbd> toggles
              it off without losing its size.
            </p>
          )}
        </VtpSection>

        {/* ── Measurement ── */}
        <VtpSection id="measure" label="Measure" defaultOpen={mode !== 'off'} icon={<Icon name="ruler" size={13} />}>
          <p className="vtp-row-label" style={{ marginBottom: 5 }}>Construction</p>
          <div className="vtp-btn-row">
            {([
              ['linear', 'Distance', 'Point-to-point distance'],
              ['height', 'Height', 'Project-up height'],
              ['clearance', 'Clearance', 'Shortest/perpendicular witness'],
              ['position', 'Position', 'Project coordinate marker'],
            ] as const).map(([toolMode, label, title]) => (
              <button
                key={toolMode}
                className={`vtp-pill-btn${mode === toolMode ? ' active' : ''}`}
                onClick={() => setMeasurementMode(mode === toolMode ? 'off' : toolMode)}
                title={title}
                aria-pressed={mode === toolMode}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="vtp-row-label" style={{ margin: '8px 0 5px' }}>Geometry</p>
          <div className="vtp-btn-row">
            {([
              ['box', 'Rectangle', 'Two-click rectangular area'],
              ['area', 'Polygon', 'Polygon area'],
              ['angle', 'Angle', 'Three-click angle'],
            ] as const).map(([toolMode, label, title]) => (
              <button
                key={toolMode}
                className={`vtp-pill-btn${mode === toolMode ? ' active' : ''}`}
                onClick={() => setMeasurementMode(mode === toolMode ? 'off' : toolMode)}
                title={title}
                aria-pressed={mode === toolMode}
              >
                {label}
              </button>
            ))}
            {mode !== 'off' && (
              <button
                className="vtp-pill-btn vtp-pill-btn-danger"
                onClick={() => setMeasurementMode('off')}
                title="Disable measurement"
              >
                Off
              </button>
            )}
          </div>
          {mode !== 'off' && (
            <div className="vtp-measure-hint">
              Click surfaces in the 3D view to place points. The live value follows
              your cursor.
              {mode === 'area' && ' Press Enter or double-click to close the polygon.'}
              {mode === 'height' && ' Height follows the project Y axis.'}
              {mode === 'clearance' && ' Snap to both witness targets for an exact result.'}
              {mode === 'position' && ' One click places a persistent coordinate marker.'}
            </div>
          )}
          <div className="vtp-btn-row vtp-unit-row">
            <span className="vtp-row-label">Unit</span>
            {(['m', 'mm', 'ft'] as const).map((u) => (
              <button
                key={u}
                className={`vtp-pill-btn${unit === u ? ' active' : ''}`}
                onClick={() => setMeasurement({ unit: u })}
                title={u === 'm' ? 'Metres' : u === 'mm' ? 'Millimetres' : 'Feet'}
              >
                {u}
              </button>
            ))}
          </div>
        </VtpSection>

        {/* ── Appearance ── */}
        <VtpSection id="appearance" label="Appearance" defaultOpen={colourBy !== 'off' || selectionFocusMode !== 'off'} icon={<Icon name="sliders" size={13} />}>
          <p className="vtp-row-label" style={{ marginBottom: 6 }}>Colour by</p>
          <div className="vtp-btn-row">
            {COLOUR_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                className={`vtp-pill-btn${colourBy === value ? ' active' : ''}`}
                onClick={() => setColourBy(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {colourBy !== 'off' && colourGroups.length > 0 && (
            <div className="vtp-legend">
              {colourGroups.slice(0, 10).map((g) => (
                <div key={g.label} className="vtp-legend-row">
                  <span className="vtp-legend-swatch" style={{ background: `#${g.color.getHexString()}` }} />
                  <span className="vtp-legend-label">
                    {colourBy === 'type' ? shortIfcType(g.label) : g.label}
                  </span>
                  <span className="vtp-legend-count">{g.ids.length}</span>
                </div>
              ))}
              {colourGroups.length > 10 && (
                <div className="vtp-legend-more">+{colourGroups.length - 10} more</div>
              )}
            </div>
          )}

          {/* Focus / ghost mode */}
          <p className="vtp-row-label" style={{ marginTop: 10, marginBottom: 6 }}>Focus mode</p>
          <div className="vtp-btn-row">
            <button
              className={`vtp-pill-btn${selectionFocusMode === 'off' ? ' active' : ''}`}
              onClick={() => setSelectionFocusMode('off')}
              title="No focus effect - selected element highlighted normally"
            >
              Off
            </button>
            <button
              className={`vtp-pill-btn${selectionFocusMode === 'ghost' ? ' active' : ''}`}
              onClick={() => setSelectionFocusMode('ghost')}
              title="Ghost mode - non-selected elements become semi-transparent"
            >
              Ghost
            </button>
          </div>
          {selectionFocusMode === 'ghost' && (
            <div className="vtp-slider-row" style={{ marginTop: 6 }}>
              <input
                type="range"
                className="vtp-slider"
                min={0.05} max={0.60} step={0.05}
                value={selectionGhostOpacity}
                onChange={(e) => setSelectionGhostOpacity(Number(e.currentTarget.value))}
                aria-label="Ghost opacity"
                title="Opacity of non-focused elements (5 % - 60 %)"
              />
              <span className="vtp-slider-val">{Math.round(selectionGhostOpacity * 100)} %</span>
              <button
                className="vtp-link-btn"
                onClick={() => setSelectionGhostOpacity(0.22)}
                title="Reset to default (22 %)"
              >
                Reset
              </button>
            </div>
          )}
        </VtpSection>

      </div>
    </aside>
  );
}
