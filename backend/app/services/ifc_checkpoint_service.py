"""Git-backed per-edit IFC checkpoints.

After each successful ``apply_pending_edit``, the caller passes the current
IFC bytes to ``ifc_checkpoint_service.snapshot()``.  This service commits
them into a local git repo at ``~/.ifc-atlas/ifc_history/``
(``CHECKPOINT_DIR``) so the user can browse and restore earlier model
states without keeping full IFC copies in memory.

Git gives us de-duplicated binary storage, timestamps, and cheap SHA
references for free.  gitpython is an optional dep - when absent the
service degrades gracefully (all methods return safe defaults).
"""

import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

try:
    import git as _git

    _GIT_AVAILABLE = True
except ImportError:  # pragma: no cover
    _git = None  # type: ignore[assignment]
    _GIT_AVAILABLE = False
    logger.warning("gitpython not installed - IFC checkpoints disabled")

_IFC_FILENAME = "model.ifc"
_GIT_AUTHOR_NAME = "IFC Atlas"
_GIT_AUTHOR_EMAIL = "viewer@local"


class IFCCheckpointService:
    """Gitpython-backed snapshot store.

    One instance is shared across the request lifecycle (singleton below).
    The repo lives at *repo_dir* and is created lazily on first use.

    Thread-safety: single-threaded FastAPI event loop; no extra locking needed.
    """

    def __init__(self, repo_dir: Path) -> None:
        # *repo_dir* is the BASE directory; rebind() nests one repo per model
        # under it so history survives reloads of the same file (ADR 004).
        # Until the first rebind the base itself is the repo (legacy layout).
        self._base_dir = repo_dir
        self._repo_dir = repo_dir
        self._repo: Optional[object] = None  # git.Repo when available
        self._edit_count = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def snapshot(self, ifc_bytes: bytes, message: str = "") -> Optional[str]:
        """Write *ifc_bytes* as a new git commit.

        Returns the short commit SHA (12 chars) or ``None`` on failure.
        """
        if not _GIT_AVAILABLE or not self._open_repo():
            return None
        try:
            ifc_path = self._repo_dir / _IFC_FILENAME
            ifc_path.write_bytes(ifc_bytes)
            repo = self._repo
            repo.index.add([_IFC_FILENAME])  # type: ignore[union-attr]

            # Detect whether anything actually changed (content-addressed).
            # On an empty repo (no commits) gitpython raises BadName or
            # ValueError depending on version - both mean "first commit".
            try:
                nothing_staged = (
                    not repo.index.diff("HEAD")  # type: ignore[union-attr]
                    and not repo.untracked_files  # type: ignore[union-attr]
                )
            except (_git.exc.BadName, ValueError):  # type: ignore[union-attr]
                # No HEAD yet (first commit) - always proceed.
                nothing_staged = False

            if nothing_staged:
                # Content identical to last snapshot - skip empty commit.
                return repo.head.commit.hexsha[:12]  # type: ignore[union-attr]

            self._edit_count += 1
            commit_msg = message or f"Edit #{self._edit_count}"
            actor = _git.Actor(_GIT_AUTHOR_NAME, _GIT_AUTHOR_EMAIL)  # type: ignore[union-attr]
            commit = repo.index.commit(  # type: ignore[union-attr]
                commit_msg,
                author=actor,
                committer=actor,
            )
            return commit.hexsha[:12]
        except Exception:
            logger.exception("IFC checkpoint snapshot failed")
            return None

    def list_checkpoints(self, limit: int = 50) -> list[dict]:
        """Return newest-first list of checkpoint dicts.

        Each dict: ``{sha, message, timestamp, edit_count, is_initial}``.
        """
        if not _GIT_AVAILABLE or not self._open_repo():
            return []
        repo = self._repo
        try:
            commits = list(repo.iter_commits(max_count=limit))  # type: ignore[union-attr]
        except (_git.exc.GitCommandError, ValueError):  # type: ignore[union-attr]
            # No commits yet, or HEAD reference missing.
            return []
        except Exception:
            logger.exception("IFC checkpoint list failed")
            return []

        total = len(commits)
        result = []
        for i, c in enumerate(commits):
            result.append(
                {
                    "sha": c.hexsha[:12],
                    "message": c.message.strip(),
                    "timestamp": datetime.fromtimestamp(
                        c.committed_date, tz=timezone.utc
                    ).isoformat(),
                    "edit_count": total - i,
                    "is_initial": i == total - 1,
                }
            )
        return result

    def restore(self, sha: str) -> Optional[bytes]:
        """Return raw IFC bytes from commit *sha*.

        Returns ``None`` if the SHA is unknown or the blob is missing.
        """
        if not _GIT_AVAILABLE or not self._open_repo():
            return None
        repo = self._repo
        try:
            commit = repo.commit(sha)  # type: ignore[union-attr]
            blob = commit.tree[_IFC_FILENAME]
            return blob.data_stream.read()
        except (_git.exc.BadName, KeyError):  # type: ignore[union-attr]
            return None
        except Exception:
            logger.exception("IFC checkpoint restore failed (sha=%s)", sha)
            return None

    def get_diff(
        self,
        sha: str,
        current_model: Any,
        max_entries: int = 100,
    ) -> Optional[dict]:
        """Diff snapshot *sha* against *current_model*.

        Returns a dict matching ``CheckpointDiffResult`` schema, or ``None``
        when the snapshot cannot be found or IfcOpenShell is unavailable.

        Only IfcProduct entities are compared (these are what the viewer shows).
        Attribute comparison covers Name, Description, ObjectType.
        """
        ifc_bytes = self.restore(sha)
        if ifc_bytes is None:
            return None

        try:
            import ifcopenshell  # type: ignore[import-untyped]
        except ImportError:
            logger.warning("ifcopenshell not available - diff skipped")
            return None

        # Parse the snapshot into a temporary file.
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".ifc")
        try:
            os.write(tmp_fd, ifc_bytes)
            os.close(tmp_fd)
            snapshot = ifcopenshell.open(tmp_path)
        except Exception:
            logger.exception("IFC checkpoint diff: failed to open snapshot")
            try:
                os.close(tmp_fd)
            except OSError:
                pass
            return None
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        _CMP_ATTRS = ("Name", "Description", "ObjectType")

        def _entity_attrs(entity: Any) -> dict[str, str]:
            out: dict[str, str] = {}
            for attr in _CMP_ATTRS:
                try:
                    val = getattr(entity, attr, None)
                    if val is not None:
                        out[attr] = str(val)
                except Exception:
                    pass
            return out

        # Index by GlobalId.
        snap_map: dict[str, Any] = {}
        for e in snapshot.by_type("IfcProduct"):
            try:
                gid = e.GlobalId
                if gid:
                    snap_map[gid] = e
            except Exception:
                pass

        curr_map: dict[str, Any] = {}
        for e in current_model.by_type("IfcProduct"):
            try:
                gid = e.GlobalId
                if gid:
                    curr_map[gid] = e
            except Exception:
                pass

        entries: list[dict] = []
        added_count = removed_count = changed_count = 0

        snap_ids = set(snap_map)
        curr_ids = set(curr_map)

        for gid in snap_ids - curr_ids:
            removed_count += 1
            e = snap_map[gid]
            entries.append({
                "global_id": gid,
                "ifc_type": e.is_a(),
                "name": getattr(e, "Name", None),
                "change": "removed",
                "attribute_changes": [],
                "express_id": None,
            })

        for gid in curr_ids - snap_ids:
            added_count += 1
            e = curr_map[gid]
            entries.append({
                "global_id": gid,
                "ifc_type": e.is_a(),
                "name": getattr(e, "Name", None),
                "change": "added",
                "attribute_changes": [],
                "express_id": e.id(),
            })

        for gid in snap_ids & curr_ids:
            snap_attrs = _entity_attrs(snap_map[gid])
            curr_e = curr_map[gid]
            curr_attrs = _entity_attrs(curr_e)
            attr_changes = []
            for attr in _CMP_ATTRS:
                before = snap_attrs.get(attr)
                after = curr_attrs.get(attr)
                if before != after:
                    attr_changes.append({"attribute": attr, "before": before, "after": after})
            if attr_changes:
                changed_count += 1
                entries.append({
                    "global_id": gid,
                    "ifc_type": curr_e.is_a(),
                    "name": getattr(curr_e, "Name", None),
                    "change": "changed",
                    "attribute_changes": attr_changes,
                    "express_id": curr_e.id(),
                })

        total = added_count + removed_count + changed_count
        truncated = len(entries) > max_entries
        if truncated:
            entries = entries[:max_entries]

        return {
            "sha": sha,
            "added": added_count,
            "removed": removed_count,
            "changed": changed_count,
            "total": total,
            "truncated": truncated,
            "entries": entries,
        }

    def rebind(self, model_key: str) -> None:
        """Point the store at the per-model repo for *model_key*.

        Called on every model load. Deletes NOTHING: reloading the same file
        rebinds to the same repo, so checkpoints persist across sessions
        (ADR 004's "git across sessions" — the old behavior rmtree'd the one
        global repo on every load, destroying all history). Distinct models
        get distinct repos, so histories can't interleave.
        """
        safe = "".join(c for c in model_key if c.isalnum() or c in "-_")[:64] or "default"
        new_dir = self._base_dir / safe
        if new_dir != self._repo_dir:
            self._repo_dir = new_dir
            self._repo = None
        self._edit_count = 0

    def reset(self) -> None:
        """Wipe the CURRENT model's history (explicit destructive action -
        no longer part of the model-load path, which uses rebind())."""
        self._edit_count = 0
        self._repo = None
        if self._repo_dir.exists():
            shutil.rmtree(self._repo_dir, ignore_errors=True)

    @property
    def is_available(self) -> bool:
        return _GIT_AVAILABLE

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _open_repo(self) -> bool:
        """Lazily open or init the git repo. Returns True if ready."""
        if self._repo is not None:
            return True
        if not _GIT_AVAILABLE:
            return False
        try:
            self._repo_dir.mkdir(parents=True, exist_ok=True)
            if (self._repo_dir / ".git").exists():
                self._repo = _git.Repo(str(self._repo_dir))  # type: ignore[union-attr]
            else:
                self._repo = _git.Repo.init(str(self._repo_dir))  # type: ignore[union-attr]
                with self._repo.config_writer() as cfg:  # type: ignore[union-attr]
                    cfg.set_value("user", "name", _GIT_AUTHOR_NAME)
                    cfg.set_value("user", "email", _GIT_AUTHOR_EMAIL)
            return True
        except Exception:
            logger.exception("IFC checkpoint repo init failed")
            self._repo = None
            return False


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
from app.core.config import CHECKPOINT_DIR as _CHECKPOINT_DIR
ifc_checkpoint_service = IFCCheckpointService(_CHECKPOINT_DIR)
