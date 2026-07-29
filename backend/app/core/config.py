"""
Application config.

User data layout
================

ALL writable state lives in a single per-user dotfolder, following the
standard layout used by many desktop CLI tools, so the repo / install directory stays clean
whether you're running the desktop build, dev mode, or hitting localhost.
The location is the same on every platform:

    Windows: %USERPROFILE%\\.ifc-atlas\\
    macOS:   ~/.ifc-atlas/
    Linux:   ~/.ifc-atlas/

Layout (created lazily):

    ~/.ifc-atlas/
        .env                  # optional user-supplied env overrides (loaded at boot)
        secrets.json          # API keys written by the in-app AI-keys UI
        data/                 # custom agents, prompts, tool sets, snippets,
                              #   models.json, aabb-cache/, ifc-index/, doc_index/
        uploads/              # uploaded IFC files (+ hidden .working/ edit copies)
        fragments/            # versioned converted-fragment cache + manifests
        snapshots/            # geometry snapshots
        ifc_history/          # git-backed model checkpoints
        mcp_servers.json      # external MCP server registry (optional)

Override the root with the ``IFC_ATLAS_HOME`` env var (absolute path); the
legacy ``IFC_VIEWER_HOME`` is still honored. Individual dirs can be
re-pointed with ``UPLOAD_DIR`` / ``SNAPSHOT_DIR`` / ``DATA_DIR`` /
``CHECKPOINT_DIR`` / ``FRAGMENT_CACHE_DIR``.
"""

import logging
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

from app.core.security import SecuritySettings

logger = logging.getLogger(__name__)


# Folder resolution

_USER_HOME_DIR_NAME = ".ifc-atlas"
_LEGACY_DIR_NAME = ".ifc-viewer"  # pre-rename folder; auto-migrated when found


def _user_data_root() -> Path:
    """Return the user-data root (``~/.ifc-atlas`` by default).

    Honors ``IFC_ATLAS_HOME`` first, then the legacy ``IFC_VIEWER_HOME``.
    """
    override = os.environ.get("IFC_ATLAS_HOME") or os.environ.get("IFC_VIEWER_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / _USER_HOME_DIR_NAME


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


# First-launch migration


def _migrate_legacy_home(target: Path) -> None:
    """One-time, idempotent move of ``~/.ifc-viewer`` (pre-rename) into ``target``.

    Checked per entry so a partially-populated user-home (e.g. a pre-existing
    empty ``uploads/``) never blocks the rest of the migration. Existing
    destination files / dirs are never overwritten.
    """
    legacy_home = Path.home() / _LEGACY_DIR_NAME
    if not (legacy_home.exists() and legacy_home.is_dir() and legacy_home != target):
        return
    moved_any = False
    try:
        for entry in legacy_home.iterdir():
            dest = target / entry.name
            if dest.exists():
                continue
            shutil.move(str(entry), str(dest))
            moved_any = True
        try:
            legacy_home.rmdir()
        except OSError:
            pass
        if moved_any:
            logger.info("Migrated legacy %s -> %s", legacy_home, target)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Legacy folder migration failed (%s); continuing.", exc)


BASE_DIR = _user_data_root()
BASE_DIR.mkdir(parents=True, exist_ok=True)
_migrate_legacy_home(BASE_DIR)
load_dotenv(BASE_DIR / ".env")


UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(BASE_DIR / "uploads")))
SNAPSHOT_DIR = Path(os.getenv("SNAPSHOT_DIR", str(BASE_DIR / "snapshots")))
DATA_DIR = Path(os.getenv("DATA_DIR", str(BASE_DIR / "data")))
CHECKPOINT_DIR = Path(os.getenv("CHECKPOINT_DIR", str(BASE_DIR / "ifc_history")))
FRAGMENT_CACHE_DIR = Path(os.getenv("FRAGMENT_CACHE_DIR", str(BASE_DIR / "fragments")))

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Cache-size cap (bytes). Settings UI surfaces this as a slider; the
# uploads-dir LRU sweep enforces it. 0 = unlimited.
CACHE_MAX_BYTES = int(os.getenv("IFC_VIEWER_CACHE_MAX_BYTES", str(2 * 1024 * 1024 * 1024)))

# Per-request IFC body cap for upload/convert/preview endpoints. 0 = unlimited.
# Keep the default generous so existing large-model desktop workflows continue
# to work, while production deployments can tighten it through .env.
MAX_IFC_UPLOAD_BYTES = int(os.getenv("IFC_VIEWER_MAX_UPLOAD_BYTES", str(512 * 1024 * 1024)))

# Local development and the desktop sidecar should never listen on every
# interface by default. Container/server deployments must opt into a public
# bind and the server security profile explicitly.
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8000"))
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
SECURITY_SETTINGS = SecuritySettings.from_env(os.environ)
# Free-form Python is trusted-local by default and disabled in server mode.
# This is intentionally separate from structured edit operations.
CODE_EXECUTION_ENABLED = _truthy(
    os.getenv(
        "IFC_ATLAS_ENABLE_CODE_EXECUTION",
        "1" if SECURITY_SETTINGS.mode.value == "local" else "0",
    )
)

# LLM settings.
#
# Per-provider API keys are NOT exposed as module-level constants here;
# they would be captured at import time, so a key written via the in-app
# "AI Keys" modal would not take effect until the backend restarted. Use
# :func:`app.services.secrets_service.get_api_key` at the actual point of
# use instead; it re-resolves on every call (env var -> ``secrets.json``).
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Feature toggles
# v1.1.0: editing is ON by default (ADR 003 phased flip - the operation layer,
# dual-mode gating, verifier loop, undo/redo, and save round-trip all landed).
# The flag gates BOTH surfaces from this single point: the human editor
# (/operations routes return 403 when off; the frontend probes the flag at
# runtime via /api/ifc/edit-state, so no rebuild is needed) and the AI Edit
# tier (``stream_chat`` drops every ``write_edit``-tier tool when off; MCP
# direct ops honour it too). Set ``EDIT_MODE_ENABLED=0`` to run a read-only
# deployment (kiosk/demo servers).
EDIT_MODE_ENABLED = _truthy(os.getenv("EDIT_MODE_ENABLED", "1"))
