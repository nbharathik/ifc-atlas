import { useStore } from '../../store/useStore';
import Icon from '../ui/Icon';

/**
 * Beta warning banner shown while Edit mode is in the **structural** scope.
 *
 * Structural edits (create walls/slabs, delete elements) change geometry and
 * reload the 3D viewer - briefly disruptive. Semantic edits (names, properties)
 * update in place with no reload. This live banner makes the trade-off explicit
 * so the user knows why the viewer reloads after a geometry edit. See
 * dev/docs/EDIT_SCOPES.md.
 */
export default function EditScopeBanner() {
  const editModeAvailable = useStore((s) => s.editModeAvailable);
  const editMode = useStore((s) => s.editMode);
  const editScope = useStore((s) => s.editScope);
  const setEditScope = useStore((s) => s.setEditScope);

  if (!editModeAvailable || !editMode || editScope !== 'structural') return null;

  return (
    <div className="edit-scope-banner" role="status">
      <Icon name="alert-circle" size={13} strokeWidth={2} />
      <span className="edit-scope-banner-tag">Beta</span>
      <span className="edit-scope-banner-text">
        Structural edits (walls, slabs, delete) <strong>reload the 3D viewer</strong>.
        Property and other semantic edits update instantly without a reload.
      </span>
      <button
        type="button"
        className="edit-scope-banner-switch"
        onClick={() => setEditScope('semantic')}
        title="Switch back to semantic edits (no viewer reload)"
      >
        Switch to Semantic
      </button>
    </div>
  );
}
