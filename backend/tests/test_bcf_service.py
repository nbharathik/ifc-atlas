"""Tests for the BCF 2.1 service - store CRUD, archive round-trip, foreign
archive parsing, guid mapping, and coordinate conversion.

All IFC models are authored in memory (ifcopenshell.file(schema="IFC4"));
no disk IFC is ever loaded.
"""

from __future__ import annotations

import base64
import io
import math
import uuid
import xml.etree.ElementTree as ET
import zipfile

import pytest

from app.services.bcf_service import (
    bcf_service,
    decode_snapshot_data_url,
    ifc_to_viewer_coords,
    viewer_to_ifc_coords,
)

SNAPSHOT_BYTES = b"\xff\xd8\xff\xe0fake-jpeg-payload"
SNAPSHOT_URL = "data:image/jpeg;base64," + base64.b64encode(SNAPSHOT_BYTES).decode()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _fresh_fingerprint() -> str:
    """Unique store key per test so the shared session temp dir never leaks state."""
    return f"svc-{uuid.uuid4().hex}"


def _model_with_two_walls():
    import ifcopenshell
    import ifcopenshell.guid

    model = ifcopenshell.file(schema="IFC4")
    wall_a = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="Wall A")
    wall_b = model.createIfcWall(GlobalId=ifcopenshell.guid.new(), Name="Wall B")
    return model, wall_a, wall_b


def _viewpoint_for(wall_a, wall_b) -> dict:
    return {
        "camera": {"pos": [1.0, 2.0, 3.0], "target": [4.0, 5.0, 6.0]},
        "isolated_ids": [wall_a.id(), wall_b.id()],
        "hidden_ids": [],
        "selected_id": wall_a.id(),
        "highlighted_ids": [wall_a.id(), wall_b.id()],
    }


def _strip_modified(topics: list[dict]) -> list[dict]:
    return [{k: v for k, v in t.items() if k != "modified_at"} for t in topics]


# ---------------------------------------------------------------------------
# Coordinate conversion invariants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "point",
    [
        [0.0, 0.0, 0.0],
        [1.0, 2.0, 3.0],
        [-4.5, 0.25, 9.75],
        [1000.0, -2000.0, 3.5],
    ],
)
def test_viewer_ifc_round_trip_is_identity(point):
    assert ifc_to_viewer_coords(viewer_to_ifc_coords(point)) == point
    assert viewer_to_ifc_coords(ifc_to_viewer_coords(point)) == point


def test_viewer_to_ifc_axis_mapping():
    assert viewer_to_ifc_coords([1.0, 2.0, 3.0]) == [1.0, -3.0, 2.0]
    assert ifc_to_viewer_coords([1.0, -3.0, 2.0]) == [1.0, 2.0, 3.0]


# ---------------------------------------------------------------------------
# Store CRUD
# ---------------------------------------------------------------------------


def test_create_and_list_topic_defaults():
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="Crack in wall")
    assert topic["title"] == "Crack in wall"
    assert topic["status"] == "Open"
    assert topic["priority"] == "Normal"
    assert topic["topic_type"] == "Issue"
    assert topic["author"]
    assert topic["comments"] == []
    assert topic["viewpoint"] is None
    assert topic["has_snapshot"] is False
    assert [t["guid"] for t in bcf_service.list_topics(fp)] == [topic["guid"]]


def test_update_topic_patches_fields():
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="Old title")
    updated = bcf_service.update_topic(
        fp,
        topic["guid"],
        {"title": "New title", "status": "Resolved", "labels": ["arch"]},
    )
    assert updated["title"] == "New title"
    assert updated["status"] == "Resolved"
    assert updated["labels"] == ["arch"]
    assert bcf_service.update_topic(fp, "no-such-guid", {"title": "x"}) is None


def test_add_comment_appends_and_defaults_author():
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="T")
    updated = bcf_service.add_comment(fp, topic["guid"], "looks wrong", author="alice")
    assert updated["comments"][-1]["comment"] == "looks wrong"
    assert updated["comments"][-1]["author"] == "alice"
    updated = bcf_service.add_comment(fp, topic["guid"], "second")
    assert updated["comments"][-1]["author"]  # OS user fallback, never empty
    assert len(updated["comments"]) == 2
    assert bcf_service.add_comment(fp, "no-such-guid", "x") is None


def test_delete_topic_removes_snapshot_file():
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="T", snapshot_data_url=SNAPSHOT_URL)
    assert bcf_service.get_snapshot(topic["guid"]) == SNAPSHOT_BYTES
    assert bcf_service.delete_topic(fp, topic["guid"]) is True
    assert bcf_service.list_topics(fp) == []
    assert bcf_service.get_snapshot(topic["guid"]) is None
    assert bcf_service.delete_topic(fp, topic["guid"]) is False


def test_create_topic_rejects_bad_snapshot_url():
    fp = _fresh_fingerprint()
    with pytest.raises(ValueError):
        bcf_service.create_topic(fp, title="T", snapshot_data_url="nonsense")
    # Validation happens before persistence - nothing was stored.
    assert bcf_service.list_topics(fp) == []


def test_decode_snapshot_data_url_requires_base64_image():
    with pytest.raises(ValueError):
        decode_snapshot_data_url("data:text/plain;base64,aGk=")
    with pytest.raises(ValueError):
        decode_snapshot_data_url("data:image/jpeg,plain-not-base64")
    assert decode_snapshot_data_url(SNAPSHOT_URL) == SNAPSHOT_BYTES


# ---------------------------------------------------------------------------
# Export - guid mapping + XML shape
# ---------------------------------------------------------------------------


def test_export_maps_express_ids_to_ifc_guids():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="Sel", viewpoint=_viewpoint_for(wall_a, wall_b))

    data = bcf_service.export_bcfzip(fp, model)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ET.fromstring(archive.read(f"{topic['guid']}/viewpoint.bcfv"))

    selection = [
        c.get("IfcGuid") for c in root.findall("./Components/Selection/Component")
    ]
    assert selection == [wall_a.GlobalId, wall_b.GlobalId]

    visibility = root.find("./Components/Visibility")
    assert visibility.get("DefaultVisibility") == "false"
    exceptions = [
        c.get("IfcGuid") for c in visibility.findall("./Exceptions/Component")
    ]
    assert exceptions == [wall_a.GlobalId, wall_b.GlobalId]

    # Camera converts viewer Y-up to IFC Z-up: (1,2,3) -> (1,-3,2).
    cam_pos = [
        float(root.findtext(f"./PerspectiveCamera/CameraViewPoint/{axis}"))
        for axis in ("X", "Y", "Z")
    ]
    assert cam_pos == [1.0, -3.0, 2.0]

    direction = [
        float(root.findtext(f"./PerspectiveCamera/CameraDirection/{axis}"))
        for axis in ("X", "Y", "Z")
    ]
    up = [
        float(root.findtext(f"./PerspectiveCamera/CameraUpVector/{axis}"))
        for axis in ("X", "Y", "Z")
    ]
    assert math.isclose(sum(c * c for c in direction), 1.0, abs_tol=1e-9)
    assert math.isclose(sum(c * c for c in up), 1.0, abs_tol=1e-9)
    assert math.isclose(sum(d * u for d, u in zip(direction, up)), 0.0, abs_tol=1e-9)
    assert root.findtext("./PerspectiveCamera/FieldOfView") == "60"


def test_export_skips_express_ids_missing_from_model():
    model, wall_a, _wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    viewpoint = {
        "camera": {"pos": [0.0, 0.0, 10.0], "target": [0.0, 0.0, 0.0]},
        "isolated_ids": [wall_a.id(), 999999],
        "hidden_ids": [],
        "selected_id": 999999,
        "highlighted_ids": [],
    }
    topic = bcf_service.create_topic(fp, title="Stale ids", viewpoint=viewpoint)

    data = bcf_service.export_bcfzip(fp, model)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        root = ET.fromstring(archive.read(f"{topic['guid']}/viewpoint.bcfv"))

    assert root.find("./Components/Selection") is None  # only the stale id was selected
    exceptions = [
        c.get("IfcGuid")
        for c in root.findall("./Components/Visibility/Exceptions/Component")
    ]
    assert exceptions == [wall_a.GlobalId]


def test_export_writes_bcf_version_and_markup():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(
        fp,
        title="Markup check",
        description="desc",
        status="In Progress",
        priority="Critical",
        topic_type="Request",
        assigned_to="bob",
        labels=["one", "two"],
    )
    bcf_service.add_comment(fp, topic["guid"], "note", author="alice")

    data = bcf_service.export_bcfzip(fp, model)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        version = ET.fromstring(archive.read("bcf.version"))
        markup = ET.fromstring(archive.read(f"{topic['guid']}/markup.bcf"))
        names = set(archive.namelist())

    assert version.tag == "Version"
    assert version.get("VersionId") == "2.1"
    assert version.findtext("DetailedVersion") == "2.1"

    topic_el = markup.find("Topic")
    assert topic_el.get("Guid") == topic["guid"]
    assert topic_el.get("TopicType") == "Request"
    assert topic_el.get("TopicStatus") == "In Progress"
    assert topic_el.findtext("Title") == "Markup check"
    assert topic_el.findtext("Priority") == "Critical"
    assert topic_el.findtext("AssignedTo") == "bob"
    assert topic_el.findtext("Description") == "desc"
    assert [el.text for el in topic_el.findall("Labels")] == ["one", "two"]
    comments = markup.findall("Comment")
    assert len(comments) == 1
    assert comments[0].findtext("Comment") == "note"
    assert comments[0].findtext("Author") == "alice"
    # No viewpoint and no snapshot on this topic -> no viewpoint files.
    assert f"{topic['guid']}/viewpoint.bcfv" not in names
    assert f"{topic['guid']}/snapshot.jpg" not in names
    assert f"{topic['guid']}/ifc_atlas.json" in names


# ---------------------------------------------------------------------------
# Full round-trip (export -> wipe -> import) is lossless modulo modified_at
# ---------------------------------------------------------------------------


def test_full_round_trip_lossless():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()

    t1 = bcf_service.create_topic(
        fp,
        title="T1",
        description="first",
        labels=["arch", "urgent"],
        viewpoint=_viewpoint_for(wall_a, wall_b),
        snapshot_data_url=SNAPSHOT_URL,
    )
    bcf_service.add_comment(fp, t1["guid"], "first comment", author="alice")
    bcf_service.create_topic(
        fp,
        title="T2",
        status="Resolved",
        priority="High",
        topic_type="Clash",
        viewpoint={
            "camera": {"pos": [0.0, 0.0, 10.0], "target": [0.0, 0.0, 0.0]},
            "hidden_ids": [wall_b.id()],
        },
    )
    bcf_service.create_topic(fp, title="T3", assigned_to="bob")

    before = bcf_service.list_topics(fp)
    assert len(before) == 3
    data = bcf_service.export_bcfzip(fp, model)

    # Wipe the store and the snapshot files, then restore from the archive.
    bcf_service._store_path(fp).unlink()
    for topic in before:
        bcf_service.snapshot_path(topic["guid"]).unlink(missing_ok=True)
    assert bcf_service.list_topics(fp) == []

    result = bcf_service.import_bcfzip(fp, model, data)
    assert result["imported"] == 3
    assert result["skipped"] == 0

    after = bcf_service.list_topics(fp)
    assert _strip_modified(sorted(after, key=lambda t: t["guid"])) == _strip_modified(
        sorted(before, key=lambda t: t["guid"])
    )
    assert bcf_service.get_snapshot(t1["guid"]) == SNAPSHOT_BYTES


def test_import_merge_by_guid_incoming_wins():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    topic = bcf_service.create_topic(fp, title="Original title")
    data = bcf_service.export_bcfzip(fp, model)

    bcf_service.update_topic(fp, topic["guid"], {"title": "Changed locally"})
    result = bcf_service.import_bcfzip(fp, model, data)

    assert result["imported"] == 1
    topics = bcf_service.list_topics(fp)
    assert len(topics) == 1
    assert topics[0]["guid"] == topic["guid"]
    assert topics[0]["title"] == "Original title"


# ---------------------------------------------------------------------------
# Foreign archive parsing (no ifc_atlas.json)
# ---------------------------------------------------------------------------


def _foreign_bcfzip(topic_guid: str, guid_a: str, guid_b: str) -> bytes:
    markup = f"""<?xml version="1.0" encoding="UTF-8"?>
<Markup>
  <Topic Guid="{topic_guid}" TopicType="Clash" TopicStatus="In Progress">
    <Title>Foreign topic</Title>
    <Priority>High</Priority>
    <CreationDate>2026-01-02T03:04:05+00:00</CreationDate>
    <CreationAuthor>carol</CreationAuthor>
    <ModifiedDate>2026-01-03T03:04:05+00:00</ModifiedDate>
    <AssignedTo>dave</AssignedTo>
    <Description>From another tool</Description>
    <Labels>clash</Labels>
    <Labels>structural</Labels>
  </Topic>
  <Comment Guid="{uuid.uuid4()}">
    <Date>2026-01-02T04:00:00+00:00</Date>
    <Author>carol</Author>
    <Comment>please review</Comment>
  </Comment>
  <Viewpoints Guid="{uuid.uuid4()}">
    <Viewpoint>viewpoint.bcfv</Viewpoint>
    <Snapshot>snapshot.jpg</Snapshot>
  </Viewpoints>
</Markup>
"""
    viewpoint = f"""<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="{uuid.uuid4()}">
  <Components>
    <Selection>
      <Component IfcGuid="{guid_a}"/>
    </Selection>
    <Visibility DefaultVisibility="false">
      <Exceptions>
        <Component IfcGuid="{guid_a}"/>
        <Component IfcGuid="{guid_b}"/>
        <Component IfcGuid="0notInModel0000000000n"/>
      </Exceptions>
    </Visibility>
  </Components>
  <PerspectiveCamera>
    <CameraViewPoint><X>1</X><Y>2</Y><Z>3</Z></CameraViewPoint>
    <CameraDirection><X>0</X><Y>1</Y><Z>0</Z></CameraDirection>
    <CameraUpVector><X>0</X><Y>0</Y><Z>1</Z></CameraUpVector>
    <FieldOfView>60</FieldOfView>
  </PerspectiveCamera>
</VisualizationInfo>
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr(
            "bcf.version",
            '<?xml version="1.0"?><Version VersionId="2.1">'
            "<DetailedVersion>2.1</DetailedVersion></Version>",
        )
        archive.writestr(f"{topic_guid}/markup.bcf", markup)
        archive.writestr(f"{topic_guid}/viewpoint.bcfv", viewpoint)
        archive.writestr(f"{topic_guid}/snapshot.jpg", SNAPSHOT_BYTES)
    return buf.getvalue()


def test_import_foreign_bcfzip_without_atlas_json():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    topic_guid = str(uuid.uuid4())

    result = bcf_service.import_bcfzip(
        fp, model, _foreign_bcfzip(topic_guid, wall_a.GlobalId, wall_b.GlobalId)
    )
    assert result["imported"] == 1
    assert result["skipped"] == 0

    topic = bcf_service.get_topic(fp, topic_guid)
    assert topic["title"] == "Foreign topic"
    assert topic["topic_type"] == "Clash"
    assert topic["status"] == "In Progress"
    assert topic["priority"] == "High"
    assert topic["author"] == "carol"
    assert topic["assigned_to"] == "dave"
    assert topic["description"] == "From another tool"
    assert topic["created_at"] == "2026-01-02T03:04:05+00:00"
    assert topic["labels"] == ["clash", "structural"]
    assert len(topic["comments"]) == 1
    assert topic["comments"][0]["comment"] == "please review"
    assert topic["comments"][0]["author"] == "carol"
    assert topic["has_snapshot"] is True
    assert bcf_service.get_snapshot(topic_guid) == SNAPSHOT_BYTES

    viewpoint = topic["viewpoint"]
    # IfcGuid -> express id mapping against the loaded model; the unknown
    # guid in Exceptions is silently skipped.
    assert viewpoint["selected_id"] == wall_a.id()
    assert viewpoint["highlighted_ids"] == [wall_a.id()]
    assert viewpoint["isolated_ids"] == [wall_a.id(), wall_b.id()]
    assert viewpoint["hidden_ids"] == []
    # IFC camera (1,2,3) -> viewer (1,3,-2); target = pos + dir*15 along
    # IFC +Y -> IFC (1,17,3) -> viewer (1,3,-17).
    assert viewpoint["camera"]["pos"] == [1.0, 3.0, -2.0]
    assert viewpoint["camera"]["target"] == [1.0, 3.0, -17.0]


def test_import_skips_malformed_folder_but_keeps_good_ones():
    model, wall_a, wall_b = _model_with_two_walls()
    fp = _fresh_fingerprint()
    good_guid = str(uuid.uuid4())
    good = _foreign_bcfzip(good_guid, wall_a.GlobalId, wall_b.GlobalId)

    buf = io.BytesIO(good)
    with zipfile.ZipFile(buf, "a") as archive:
        archive.writestr("broken-topic/markup.bcf", "<this is not xml")
    result = bcf_service.import_bcfzip(fp, model, buf.getvalue())

    assert result["imported"] == 1
    assert result["skipped"] == 1
    assert bcf_service.get_topic(fp, good_guid) is not None


def test_import_rejects_non_zip_bytes():
    model, _wall_a, _wall_b = _model_with_two_walls()
    with pytest.raises(ValueError):
        bcf_service.import_bcfzip(_fresh_fingerprint(), model, b"definitely not a zip")
