"""BCF 2.1 topic store plus .bcfzip import/export, hand-rolled on the stdlib
(``zipfile`` + ``xml.etree.ElementTree`` - no third-party BCF dependency).

Persistence
===========

Topics are stored per model fingerprint at ``BASE_DIR/bcf/<fingerprint>.json``
and snapshot JPEGs at ``BASE_DIR/bcf/snapshots/<topic_guid>.jpg``.

Archive layout (export)
=======================

* ``bcf.version`` at the zip root (BCF 2.1 marker).
* One folder per topic, named by the topic guid, containing ``markup.bcf``,
  ``viewpoint.bcfv`` (when the topic carries a viewpoint), ``snapshot.jpg``
  (when present), and ``ifc_atlas.json`` - our canonical topic JSON. The JSON
  is a legal extra file that BCF readers ignore; it makes our own round-trip
  lossless (camera target, express ids, timestamps survive verbatim).

Coordinate convention
=====================

The viewer camera lives in three.js Y-up right-handed world space while BCF
XML stores IFC Z-up right-handed coordinates. Both are right-handed, so the
mapping is a quarter-turn about the shared X axis:

    viewer (x, y, z) -> IFC (x, -z, y)   on export
    IFC (x, y, z)    -> viewer (x, z, -y) on import

BCF has no camera target point, only a direction; for foreign archives
(no ``ifc_atlas.json``) the target is reconstructed as
``pos + direction * 15`` so orbit controls get a usable pivot.
"""

import base64
import getpass
import io
import json
import logging
import math
import re
import uuid
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.core.config import BASE_DIR

logger = logging.getLogger(__name__)

# Decompressed-size ceiling for snapshot images read from imported archives.
# Viewer-produced snapshots are well under 1 MB; 10 MB tolerates generous
# foreign exports while keeping a crafted zip from exhausting memory.
MAX_SNAPSHOT_BYTES = 10_000_000

BCF_DIR = BASE_DIR / "bcf"
BCF_SNAPSHOT_DIR = BCF_DIR / "snapshots"

TOPIC_TYPES = ("Issue", "Comment", "Request", "Clash")
TOPIC_STATUSES = ("Open", "In Progress", "Resolved", "Closed")
TOPIC_PRIORITIES = ("Low", "Normal", "High", "Critical")

# Look-at distance (model units) used to reconstruct a camera target for
# foreign viewpoints, which only carry a direction vector.
_FOREIGN_TARGET_DISTANCE = 15.0

_BCF_VERSION_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<Version VersionId="2.1" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    'xsi:noNamespaceSchemaLocation="version.xsd">'
    "<DetailedVersion>2.1</DetailedVersion>"
    "</Version>\n"
)


# ---------------------------------------------------------------------------
# Coordinate conversion (public: the unit tests assert the identity invariant)
# ---------------------------------------------------------------------------


def viewer_to_ifc_coords(point: Any) -> list[float]:
    """Map a viewer-space (three.js Y-up) point or vector into IFC Z-up space."""
    x, y, z = (float(point[0]), float(point[1]), float(point[2]))
    return [x, -z, y]


def ifc_to_viewer_coords(point: Any) -> list[float]:
    """Inverse of :func:`viewer_to_ifc_coords`."""
    x, y, z = (float(point[0]), float(point[1]), float(point[2]))
    return [x, z, -y]


def _normalize_vec(vec: Any) -> Optional[list[float]]:
    try:
        values = [float(c) for c in vec]
    except (TypeError, ValueError):
        return None
    if len(values) != 3:
        return None
    length = math.sqrt(sum(c * c for c in values))
    if length < 1e-12:
        return None
    return [c / length for c in values]


def _camera_up_vector(direction: list[float]) -> list[float]:
    """Up vector orthogonal to *direction*, seeded from IFC +Z.

    Gram-Schmidt: project +Z off the view direction and renormalize. When the
    camera looks straight along the IFC Z axis the projection degenerates, so
    fall back to IFC +Y, which is then guaranteed orthogonal.
    """
    z_dot = direction[2]  # dot((0, 0, 1), direction)
    up = [-z_dot * direction[0], -z_dot * direction[1], 1.0 - z_dot * direction[2]]
    length = math.sqrt(sum(c * c for c in up))
    if length < 1e-9:
        return [0.0, 1.0, 0.0]
    return [c / length for c in up]


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default_author() -> str:
    try:
        return getpass.getuser() or "user"
    except Exception:
        # getpass.getuser raises OSError when no login name can be resolved
        # (stripped-down containers); never let that break topic creation.
        return "user"


def _safe_name(value: str) -> str:
    """Filesystem-safe token - imported guids come from untrusted zip content."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", value or "")
    return cleaned or "default"


def _coerce_enum(value: Any, allowed: tuple[str, ...], default: str) -> str:
    """Match *value* against *allowed* case-insensitively; unknown -> *default*.

    Foreign BCF files use free-form statuses/types; collapsing them onto our
    fixed vocabulary keeps the API contract enum-clean.
    """
    text = str(value or "").strip()
    for candidate in allowed:
        if text.lower() == candidate.lower():
            return candidate
    return default


def _normalize_labels(labels: Any) -> list[str]:
    return [str(label) for label in (labels or []) if str(label)]


def decode_snapshot_data_url(data_url: str) -> bytes:
    """Decode a ``data:image/...;base64,...`` URL into raw image bytes."""
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        raise ValueError("snapshot_data_url must be a data:image/... URL")
    head, sep, payload = data_url.partition(",")
    if not sep or "base64" not in head:
        raise ValueError("snapshot_data_url must be base64-encoded")
    try:
        return base64.b64decode(payload, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("snapshot_data_url payload is not valid base64") from exc


def _normalize_viewpoint(raw: Any) -> Optional[dict[str, Any]]:
    """Coerce an arbitrary viewpoint payload into the canonical shape, or None."""
    if not isinstance(raw, dict):
        return None
    camera = raw.get("camera")
    if not isinstance(camera, dict):
        return None
    try:
        pos = [float(v) for v in list(camera.get("pos") or [])]
        target = [float(v) for v in list(camera.get("target") or [])]
    except (TypeError, ValueError):
        return None
    if len(pos) != 3 or len(target) != 3:
        return None

    def int_list(key: str) -> list[int]:
        out: list[int] = []
        for value in raw.get(key) or []:
            try:
                out.append(int(value))
            except (TypeError, ValueError):
                continue
        return out

    selected = raw.get("selected_id")
    try:
        selected_id = int(selected) if selected is not None else None
    except (TypeError, ValueError):
        selected_id = None

    return {
        "camera": {"pos": pos, "target": target},
        "isolated_ids": int_list("isolated_ids"),
        "hidden_ids": int_list("hidden_ids"),
        "selected_id": selected_id,
        "highlighted_ids": int_list("highlighted_ids"),
    }


def _normalize_topic(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce an arbitrary topic payload (imported JSON / parsed markup) into
    the canonical Topic shape the API contract promises."""
    now = _now_iso()
    comments: list[dict[str, str]] = []
    for comment in raw.get("comments") or []:
        if not isinstance(comment, dict):
            continue
        comments.append({
            "guid": str(comment.get("guid") or "") or str(uuid.uuid4()),
            "author": str(comment.get("author") or "") or _default_author(),
            "date": str(comment.get("date") or "") or now,
            "comment": str(comment.get("comment") or ""),
        })
    return {
        "guid": str(raw.get("guid") or "").strip() or str(uuid.uuid4()),
        "title": str(raw.get("title") or "") or "Untitled topic",
        "description": str(raw.get("description") or ""),
        "topic_type": _coerce_enum(raw.get("topic_type"), TOPIC_TYPES, "Issue"),
        "status": _coerce_enum(raw.get("status"), TOPIC_STATUSES, "Open"),
        "priority": _coerce_enum(raw.get("priority"), TOPIC_PRIORITIES, "Normal"),
        "assigned_to": str(raw.get("assigned_to") or ""),
        "author": str(raw.get("author") or "") or _default_author(),
        "created_at": str(raw.get("created_at") or "") or now,
        "modified_at": str(raw.get("modified_at") or "") or now,
        "labels": _normalize_labels(raw.get("labels")),
        "comments": comments,
        "viewpoint": _normalize_viewpoint(raw.get("viewpoint")),
        "has_snapshot": bool(raw.get("has_snapshot")),
    }


# ---------------------------------------------------------------------------
# Express id <-> IfcGuid mapping against the loaded model
# ---------------------------------------------------------------------------


def _express_ids_to_guids(model: Any, express_ids: Any) -> list[str]:
    guids: list[str] = []
    for eid in express_ids or []:
        try:
            guid = model.by_id(int(eid)).GlobalId
        except Exception:
            continue  # deleted or non-rooted entity - leave it out of the BCF
        if guid:
            guids.append(str(guid))
    return guids


def _guids_to_express_ids(model: Any, guids: Any) -> list[int]:
    express_ids: list[int] = []
    for guid in guids or []:
        try:
            express_ids.append(model.by_guid(str(guid)).id())
        except Exception:
            continue  # guid not present in the loaded model - skip
    return express_ids


# ---------------------------------------------------------------------------
# XML helpers
# ---------------------------------------------------------------------------


def _xml_bytes(root: ET.Element) -> bytes:
    ET.indent(root)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _append_xyz(parent: ET.Element, tag: str, vec: list[float]) -> None:
    el = ET.SubElement(parent, tag)
    for axis, value in zip(("X", "Y", "Z"), vec):
        ET.SubElement(el, axis).text = str(float(value))


def _read_xyz(el: Optional[ET.Element]) -> Optional[list[float]]:
    if el is None:
        return None
    try:
        return [float(el.findtext(axis, "")) for axis in ("X", "Y", "Z")]
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class BcfService:
    """Per-model BCF topic store with BCF 2.1 archive import/export.

    Stateless between calls - every operation reads/writes the JSON store on
    disk, so the singleton is safe to share across requests (the FastAPI
    routes serialize CPU-heavy import/export through ``asyncio.to_thread``).
    """

    # -- persistence -------------------------------------------------------

    def _store_path(self, fingerprint: str) -> Path:
        return BCF_DIR / f"{_safe_name(fingerprint)}.json"

    def snapshot_path(self, topic_guid: str) -> Path:
        return BCF_SNAPSHOT_DIR / f"{_safe_name(topic_guid)}.jpg"

    def _load_topics(self, fingerprint: str) -> list[dict[str, Any]]:
        path = self._store_path(fingerprint)
        if not path.exists():
            return []
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("Unreadable BCF store at %s - starting empty", path)
            return []
        topics = raw.get("topics") if isinstance(raw, dict) else None
        if not isinstance(topics, list):
            return []
        return [t for t in topics if isinstance(t, dict)]

    def _save_topics(self, fingerprint: str, topics: list[dict[str, Any]]) -> None:
        BCF_DIR.mkdir(parents=True, exist_ok=True)
        self._store_path(fingerprint).write_text(
            json.dumps({"topics": topics}, indent=2), encoding="utf-8"
        )

    def _write_snapshot(self, topic_guid: str, raw: bytes) -> None:
        BCF_SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        self.snapshot_path(topic_guid).write_bytes(raw)

    # -- topic CRUD ----------------------------------------------------------

    def list_topics(self, fingerprint: str) -> list[dict[str, Any]]:
        return self._load_topics(fingerprint)

    def get_topic(self, fingerprint: str, guid: str) -> Optional[dict[str, Any]]:
        for topic in self._load_topics(fingerprint):
            if topic.get("guid") == guid:
                return topic
        return None

    def create_topic(
        self,
        fingerprint: str,
        *,
        title: str,
        description: str = "",
        status: str = "Open",
        priority: str = "Normal",
        topic_type: str = "Issue",
        assigned_to: str = "",
        labels: Optional[list[str]] = None,
        viewpoint: Optional[dict[str, Any]] = None,
        snapshot_data_url: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a topic. Raises ValueError on a malformed snapshot data URL
        (validated before anything is persisted, so failures leave no state)."""
        snapshot_bytes = (
            decode_snapshot_data_url(snapshot_data_url) if snapshot_data_url else None
        )
        now = _now_iso()
        topic: dict[str, Any] = {
            "guid": str(uuid.uuid4()),
            "title": title,
            "description": description or "",
            "topic_type": _coerce_enum(topic_type, TOPIC_TYPES, "Issue"),
            "status": _coerce_enum(status, TOPIC_STATUSES, "Open"),
            "priority": _coerce_enum(priority, TOPIC_PRIORITIES, "Normal"),
            "assigned_to": assigned_to or "",
            "author": _default_author(),
            "created_at": now,
            "modified_at": now,
            "labels": _normalize_labels(labels),
            "comments": [],
            "viewpoint": _normalize_viewpoint(viewpoint),
            "has_snapshot": False,
        }
        if snapshot_bytes is not None:
            self._write_snapshot(topic["guid"], snapshot_bytes)
            topic["has_snapshot"] = True
        topics = self._load_topics(fingerprint)
        topics.append(topic)
        self._save_topics(fingerprint, topics)
        return topic

    def update_topic(
        self, fingerprint: str, guid: str, patch: dict[str, Any]
    ) -> Optional[dict[str, Any]]:
        """Apply a partial update; returns the topic or None when unknown."""
        topics = self._load_topics(fingerprint)
        for topic in topics:
            if topic.get("guid") != guid:
                continue
            if patch.get("title"):
                topic["title"] = str(patch["title"])
            if patch.get("description") is not None:
                topic["description"] = str(patch["description"])
            if patch.get("status"):
                topic["status"] = _coerce_enum(patch["status"], TOPIC_STATUSES, topic["status"])
            if patch.get("priority"):
                topic["priority"] = _coerce_enum(
                    patch["priority"], TOPIC_PRIORITIES, topic["priority"]
                )
            if patch.get("assigned_to") is not None:
                topic["assigned_to"] = str(patch["assigned_to"])
            if patch.get("labels") is not None:
                topic["labels"] = _normalize_labels(patch["labels"])
            topic["modified_at"] = _now_iso()
            self._save_topics(fingerprint, topics)
            return topic
        return None

    def delete_topic(self, fingerprint: str, guid: str) -> bool:
        topics = self._load_topics(fingerprint)
        remaining = [t for t in topics if t.get("guid") != guid]
        if len(remaining) == len(topics):
            return False
        self._save_topics(fingerprint, remaining)
        self.snapshot_path(guid).unlink(missing_ok=True)
        return True

    def add_comment(
        self,
        fingerprint: str,
        guid: str,
        comment: str,
        author: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        topics = self._load_topics(fingerprint)
        for topic in topics:
            if topic.get("guid") != guid:
                continue
            topic.setdefault("comments", []).append({
                "guid": str(uuid.uuid4()),
                "author": (author or "").strip() or _default_author(),
                "date": _now_iso(),
                "comment": comment,
            })
            topic["modified_at"] = _now_iso()
            self._save_topics(fingerprint, topics)
            return topic
        return None

    def get_snapshot(self, topic_guid: str) -> Optional[bytes]:
        path = self.snapshot_path(topic_guid)
        if not path.exists():
            return None
        try:
            return path.read_bytes()
        except OSError:
            return None

    # -- BCF 2.1 export ------------------------------------------------------

    def export_bcfzip(self, fingerprint: str, model: Any) -> bytes:
        """Serialize every topic stored for *fingerprint* into a BCF 2.1 zip.

        *model* is the loaded ifcopenshell file; viewpoint express ids are
        mapped to IfcGuids through it (ids no longer present are skipped).
        """
        topics = self._load_topics(fingerprint)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("bcf.version", _BCF_VERSION_XML)
            for topic in topics:
                folder = _safe_name(topic["guid"])
                snapshot = self.get_snapshot(topic["guid"])
                viewpoint = topic.get("viewpoint")
                vp_guid = str(uuid.uuid4())

                markup = self._build_markup_xml(
                    topic,
                    vp_guid,
                    has_viewpoint=viewpoint is not None,
                    has_snapshot=snapshot is not None,
                )
                archive.writestr(f"{folder}/markup.bcf", _xml_bytes(markup))
                if viewpoint is not None:
                    visualization = self._build_viewpoint_xml(viewpoint, vp_guid, model)
                    archive.writestr(f"{folder}/viewpoint.bcfv", _xml_bytes(visualization))
                if snapshot is not None:
                    archive.writestr(f"{folder}/snapshot.jpg", snapshot)
                canonical = {**topic, "has_snapshot": snapshot is not None}
                archive.writestr(
                    f"{folder}/ifc_atlas.json", json.dumps(canonical, indent=2)
                )
        return buf.getvalue()

    def _build_markup_xml(
        self,
        topic: dict[str, Any],
        vp_guid: str,
        *,
        has_viewpoint: bool,
        has_snapshot: bool,
    ) -> ET.Element:
        root = ET.Element("Markup")
        topic_el = ET.SubElement(root, "Topic", {
            "Guid": topic["guid"],
            "TopicType": topic["topic_type"],
            "TopicStatus": topic["status"],
        })
        ET.SubElement(topic_el, "Title").text = topic["title"]
        ET.SubElement(topic_el, "Priority").text = topic["priority"]
        ET.SubElement(topic_el, "CreationDate").text = topic["created_at"]
        ET.SubElement(topic_el, "CreationAuthor").text = topic["author"]
        ET.SubElement(topic_el, "ModifiedDate").text = topic["modified_at"]
        if topic.get("assigned_to"):
            ET.SubElement(topic_el, "AssignedTo").text = topic["assigned_to"]
        if topic.get("description"):
            ET.SubElement(topic_el, "Description").text = topic["description"]
        for label in topic.get("labels") or []:
            ET.SubElement(topic_el, "Labels").text = label

        for comment in topic.get("comments") or []:
            comment_el = ET.SubElement(root, "Comment", {"Guid": comment["guid"]})
            ET.SubElement(comment_el, "Date").text = comment["date"]
            ET.SubElement(comment_el, "Author").text = comment["author"]
            ET.SubElement(comment_el, "Comment").text = comment["comment"]

        if has_viewpoint or has_snapshot:
            viewpoints_el = ET.SubElement(root, "Viewpoints", {"Guid": vp_guid})
            if has_viewpoint:
                ET.SubElement(viewpoints_el, "Viewpoint").text = "viewpoint.bcfv"
            if has_snapshot:
                ET.SubElement(viewpoints_el, "Snapshot").text = "snapshot.jpg"
        return root

    def _build_viewpoint_xml(
        self, viewpoint: dict[str, Any], vp_guid: str, model: Any
    ) -> ET.Element:
        root = ET.Element("VisualizationInfo", {"Guid": vp_guid})
        components = ET.SubElement(root, "Components")

        selection_ids: list[int] = []
        if viewpoint.get("selected_id") is not None:
            selection_ids.append(int(viewpoint["selected_id"]))
        for eid in viewpoint.get("highlighted_ids") or []:
            if int(eid) not in selection_ids:
                selection_ids.append(int(eid))
        selection_guids = _express_ids_to_guids(model, selection_ids)
        if selection_guids:
            selection = ET.SubElement(components, "Selection")
            for guid in selection_guids:
                ET.SubElement(selection, "Component", {"IfcGuid": guid})

        isolated = viewpoint.get("isolated_ids") or []
        hidden = viewpoint.get("hidden_ids") or []
        # Isolation wins when both sets are present: BCF expresses visibility
        # as a default plus exceptions, and an isolated set already implies
        # everything else (the hidden set included) is invisible.
        if isolated:
            visibility = ET.SubElement(
                components, "Visibility", {"DefaultVisibility": "false"}
            )
            exceptions = ET.SubElement(visibility, "Exceptions")
            for guid in _express_ids_to_guids(model, isolated):
                ET.SubElement(exceptions, "Component", {"IfcGuid": guid})
        elif hidden:
            visibility = ET.SubElement(
                components, "Visibility", {"DefaultVisibility": "true"}
            )
            exceptions = ET.SubElement(visibility, "Exceptions")
            for guid in _express_ids_to_guids(model, hidden):
                ET.SubElement(exceptions, "Component", {"IfcGuid": guid})

        camera = viewpoint["camera"]
        pos_ifc = viewer_to_ifc_coords(camera["pos"])
        target_ifc = viewer_to_ifc_coords(camera["target"])
        direction = _normalize_vec(
            [target_ifc[i] - pos_ifc[i] for i in range(3)]
        ) or [0.0, 1.0, 0.0]
        up = _camera_up_vector(direction)

        camera_el = ET.SubElement(root, "PerspectiveCamera")
        _append_xyz(camera_el, "CameraViewPoint", pos_ifc)
        _append_xyz(camera_el, "CameraDirection", direction)
        _append_xyz(camera_el, "CameraUpVector", up)
        ET.SubElement(camera_el, "FieldOfView").text = "60"
        return root

    # -- BCF 2.1 import ------------------------------------------------------

    def import_bcfzip(self, fingerprint: str, model: Any, data: bytes) -> dict[str, Any]:
        """Merge the topics of a .bcfzip into the store for *fingerprint*.

        Per topic folder, ``ifc_atlas.json`` is preferred when present (our
        lossless canonical form); otherwise ``markup.bcf`` + ``viewpoint.bcfv``
        are parsed and IfcGuids are mapped back to express ids via *model*.
        Merging is by guid with incoming topics winning. Malformed topic
        folders are counted as skipped and never abort the import.

        Raises ValueError when *data* is not a zip archive at all.
        """
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise ValueError("Not a valid BCF zip archive") from exc

        incoming: list[tuple[dict[str, Any], Optional[bytes]]] = []
        skipped = 0
        with archive:
            folders: dict[str, set[str]] = {}
            for name in archive.namelist():
                normalized = name.replace("\\", "/")
                parts = normalized.split("/")
                if len(parts) >= 2 and parts[0] and parts[-1]:
                    folders.setdefault(parts[0], set()).add(normalized)

            for folder in sorted(folders):
                members = folders[folder]
                if (
                    f"{folder}/markup.bcf" not in members
                    and f"{folder}/ifc_atlas.json" not in members
                ):
                    continue  # asset folder, not a topic - not counted either way
                parsed = self._parse_topic_folder(archive, folder, members, model)
                if parsed is None:
                    skipped += 1
                else:
                    incoming.append(parsed)

        topics = self._load_topics(fingerprint)
        index_by_guid = {t["guid"]: i for i, t in enumerate(topics)}
        for topic, snapshot in incoming:
            if snapshot is not None:
                self._write_snapshot(topic["guid"], snapshot)
            topic["has_snapshot"] = self.snapshot_path(topic["guid"]).exists()
            position = index_by_guid.get(topic["guid"])
            if position is None:
                index_by_guid[topic["guid"]] = len(topics)
                topics.append(topic)
            else:
                topics[position] = topic
        self._save_topics(fingerprint, topics)
        return {"imported": len(incoming), "skipped": skipped, "topics": topics}

    def _parse_topic_folder(
        self,
        archive: zipfile.ZipFile,
        folder: str,
        members: set[str],
        model: Any,
    ) -> Optional[tuple[dict[str, Any], Optional[bytes]]]:
        """Parse one topic folder; returns (topic, snapshot_bytes) or None
        when the folder is malformed (any exception means skip, never fatal)."""
        try:
            snapshot_member: Optional[str] = None
            atlas_member = f"{folder}/ifc_atlas.json"
            if atlas_member in members:
                raw = json.loads(archive.read(atlas_member).decode("utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("ifc_atlas.json must contain a JSON object")
                topic = _normalize_topic(raw)
                if f"{folder}/snapshot.jpg" in members:
                    snapshot_member = f"{folder}/snapshot.jpg"
            else:
                markup_root = ET.fromstring(archive.read(f"{folder}/markup.bcf"))
                raw_topic, viewpoint_file, declared_snapshot = self._parse_markup(
                    markup_root, folder
                )
                topic = _normalize_topic(raw_topic)
                viewpoint_member = f"{folder}/{viewpoint_file or 'viewpoint.bcfv'}"
                if viewpoint_member in members:
                    viewpoint_root = ET.fromstring(archive.read(viewpoint_member))
                    topic["viewpoint"] = self._parse_viewpoint(viewpoint_root, model)
                if declared_snapshot and f"{folder}/{declared_snapshot}" in members:
                    snapshot_member = f"{folder}/{declared_snapshot}"

            if snapshot_member is None:
                # Foreign archives name snapshots freely - take the first image.
                for member in sorted(members):
                    if member.lower().endswith((".jpg", ".jpeg", ".png")):
                        snapshot_member = member
                        break
            snapshot: Optional[bytes] = None
            if snapshot_member:
                # Cap the decompressed size before reading: a crafted archive
                # could otherwise expand a tiny member into hundreds of MB.
                info = archive.getinfo(snapshot_member)
                if info.file_size <= MAX_SNAPSHOT_BYTES:
                    snapshot = archive.read(snapshot_member)
                else:
                    logger.warning(
                        "Skipping oversized BCF snapshot %r (%d bytes > %d)",
                        snapshot_member,
                        info.file_size,
                        MAX_SNAPSHOT_BYTES,
                    )
            return topic, snapshot
        except Exception:
            logger.warning("Skipping malformed BCF topic folder %r", folder, exc_info=True)
            return None

    def _parse_markup(
        self, root: ET.Element, folder: str
    ) -> tuple[dict[str, Any], Optional[str], Optional[str]]:
        """Extract (raw_topic, viewpoint_filename, snapshot_filename) from markup.bcf."""
        topic_el = root.find("Topic")
        if topic_el is None:
            raise ValueError("markup.bcf has no Topic element")

        raw: dict[str, Any] = {
            "guid": topic_el.get("Guid") or folder,
            "topic_type": topic_el.get("TopicType"),
            "status": topic_el.get("TopicStatus"),
            "title": topic_el.findtext("Title"),
            "priority": topic_el.findtext("Priority"),
            "created_at": topic_el.findtext("CreationDate"),
            "author": topic_el.findtext("CreationAuthor"),
            "modified_at": topic_el.findtext("ModifiedDate"),
            "assigned_to": topic_el.findtext("AssignedTo"),
            "description": topic_el.findtext("Description"),
            "labels": [el.text for el in topic_el.findall("Labels") if el.text],
            "comments": [],
        }
        # BCF 2.1 puts Comment elements beside Topic; some writers nest them
        # inside it. Accept both. (No ".//Comment" - the comment text child is
        # also named Comment and would match.)
        for comment_el in list(root.findall("Comment")) + list(topic_el.findall("Comment")):
            raw["comments"].append({
                "guid": comment_el.get("Guid"),
                "date": comment_el.findtext("Date"),
                "author": comment_el.findtext("Author"),
                "comment": comment_el.findtext("Comment"),
            })

        viewpoints_el = root.find("Viewpoints")
        if viewpoints_el is None:
            viewpoints_el = topic_el.find("Viewpoints")
        viewpoint_file: Optional[str] = None
        snapshot_file: Optional[str] = None
        if viewpoints_el is not None:
            viewpoint_file = (viewpoints_el.findtext("Viewpoint") or "").strip() or None
            snapshot_file = (viewpoints_el.findtext("Snapshot") or "").strip() or None
        return raw, viewpoint_file, snapshot_file

    def _parse_viewpoint(self, root: ET.Element, model: Any) -> Optional[dict[str, Any]]:
        """Translate a foreign viewpoint.bcfv into the canonical viewpoint shape."""
        camera_el = root.find("PerspectiveCamera")
        if camera_el is None:
            camera_el = root.find("OrthogonalCamera")
        if camera_el is None:
            return None
        pos_ifc = _read_xyz(camera_el.find("CameraViewPoint"))
        if pos_ifc is None:
            return None
        direction = _normalize_vec(
            _read_xyz(camera_el.find("CameraDirection")) or []
        ) or [0.0, 1.0, 0.0]
        # BCF stores no target point - reconstruct one a fixed distance along
        # the view direction so the viewer's orbit controls get a sane pivot.
        target_ifc = [
            pos_ifc[i] + direction[i] * _FOREIGN_TARGET_DISTANCE for i in range(3)
        ]

        selected_ids: list[int] = []
        isolated_ids: list[int] = []
        hidden_ids: list[int] = []
        components = root.find("Components")
        if components is not None:
            selection = components.find("Selection")
            if selection is not None:
                guids = [c.get("IfcGuid") for c in selection.findall("Component")]
                selected_ids = _guids_to_express_ids(model, [g for g in guids if g])
            visibility = components.find("Visibility")
            if visibility is not None:
                default_visible = (
                    (visibility.get("DefaultVisibility") or "true").strip().lower()
                    != "false"
                )
                exceptions = visibility.find("Exceptions")
                guids = []
                if exceptions is not None:
                    guids = [c.get("IfcGuid") for c in exceptions.findall("Component")]
                exception_ids = _guids_to_express_ids(model, [g for g in guids if g])
                if default_visible:
                    hidden_ids = exception_ids
                else:
                    isolated_ids = exception_ids

        return {
            "camera": {
                "pos": ifc_to_viewer_coords(pos_ifc),
                "target": ifc_to_viewer_coords(target_ifc),
            },
            "isolated_ids": isolated_ids,
            "hidden_ids": hidden_ids,
            "selected_id": selected_ids[0] if selected_ids else None,
            "highlighted_ids": selected_ids,
        }


bcf_service = BcfService()
