from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.ifc_ingestion_service import IfcIngestionError, IfcIngestionService


class FakeIfcService:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.loaded_path = None
        self.model = object()
        self.original_fingerprint = "source-fingerprint"

    def load(self, path) -> None:
        self.loaded_path = path
        if self.fail:
            raise ValueError("invalid IFC")

    def get_model_contract(self):
        return {
            "model_version": 7,
            "model_fingerprint": "f" * 64,
        }


class FakeMetadataIndex:
    def __init__(self) -> None:
        self.current_sha = "old"
        self.unloaded = False
        self.hydrated = None
        self.built_from = None

    def unload(self) -> None:
        self.unloaded = True

    def hydrate_from_disk(self, fingerprint: str) -> None:
        self.hydrated = fingerprint

    async def build_from_bytes(self, data: bytes):
        self.built_from = data
        index = SimpleNamespace(
            stats=SimpleNamespace(
                total_ms=8,
                element_count=10,
                storey_count=2,
            ),
            all_pset_names={"Pset_WallCommon"},
        )
        return index, {}, False


class FakeReadiness:
    def __init__(self) -> None:
        self.events: list[object] = []

    def reset(self, *, model_id: str) -> None:
        self.events.append(("reset", model_id))

    def mark_ifcopenshell_warming(self) -> None:
        self.events.append("ifc-warming")

    def mark_ifcopenshell_ready(self) -> None:
        self.events.append("ifc-ready")

    def mark_ifcopenshell_error(self, error: str) -> None:
        self.events.append(("ifc-error", error))

    def mark_native_index_building(self) -> None:
        self.events.append("index-building")

    def mark_native_index_ready(self, *, total_ms: int) -> None:
        self.events.append(("index-ready", total_ms))

    def mark_native_index_error(self, error: str) -> None:
        self.events.append(("index-error", error))


class FakeConversion:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    async def convert(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(source="sidecar", data=b"F" * 4096)


class FakeBroker:
    def __init__(self) -> None:
        self.events = []

    async def publish(self, event) -> None:
        self.events.append(event)


def make_meta():
    return SimpleNamespace(
        model_version=7,
        model_fingerprint="f" * 64,
        edit_id="edit-1",
        tree=None,
        stats=None,
    )


@pytest.mark.asyncio
async def test_ingestion_orders_model_transition_and_warms_derived_data(tmp_path):
    path = tmp_path / "model.ifc"
    path.write_bytes(b"ISO-10303-21;model")
    ifc = FakeIfcService()
    metadata = FakeMetadataIndex()
    readiness = FakeReadiness()
    conversion = FakeConversion()
    broker = FakeBroker()
    checkpoint = SimpleNamespace(rebind=lambda value: rebound.append(value))
    aabb_calls = []
    aabb = SimpleNamespace(
        compute_async=lambda model, sha: _record_async(
            aabb_calls,
            (model, sha),
        )
    )
    rebound: list[str] = []
    snapshots: list[str] = []
    broadcasts: list[bool] = []
    tasks = []

    def schedule(operation) -> None:
        tasks.append(operation)

    service = IfcIngestionService(
        ifc_service=ifc,
        metadata_index_service=metadata,
        readiness_service=readiness,
        checkpoint_service=checkpoint,
        conversion_service=conversion,
        model_sync_broker=broker,
        aabb_service=aabb,
        broadcast_readiness=lambda: _record_async(broadcasts, True),
        build_meta=lambda _include: make_meta(),
        snapshot_upload=snapshots.append,
        schedule_background=schedule,
    )

    result = await service.ingest(
        path=path,
        source_sha256="a" * 64,
        source_name="model.ifc",
        include_tree_stats=False,
        prebuild_fragments=True,
        prebuild_profile="balanced",
    )
    await tasks[0]

    assert result.model_version == 7
    assert metadata.unloaded is True
    assert metadata.hydrated == "a" * 64
    assert metadata.built_from == path.read_bytes()
    assert ifc.loaded_path == path
    assert rebound == ["source-fingerprint"]
    assert snapshots == ["model.ifc"]
    assert conversion.calls[0]["profile"] == "balanced"
    assert aabb_calls == [(ifc.model, "a" * 64)]
    assert readiness.events[:3] == [
        ("reset", "model.ifc"),
        "ifc-warming",
        "ifc-ready",
    ]
    assert [event.type for event in broker.events] == [
        "metadata_patch",
        "native_index_ready",
    ]
    assert len(broadcasts) == 4


@pytest.mark.asyncio
async def test_failed_model_load_stops_before_checkpoint_and_background_work(tmp_path):
    path = tmp_path / "broken.ifc"
    path.write_bytes(b"broken")
    ifc = FakeIfcService(fail=True)
    readiness = FakeReadiness()
    scheduled = []
    rebound = []
    service = IfcIngestionService(
        ifc_service=ifc,
        metadata_index_service=FakeMetadataIndex(),
        readiness_service=readiness,
        checkpoint_service=SimpleNamespace(
            rebind=lambda value: rebound.append(value)
        ),
        conversion_service=FakeConversion(),
        model_sync_broker=FakeBroker(),
        aabb_service=SimpleNamespace(),
        broadcast_readiness=lambda: _record_async([], True),
        build_meta=lambda _include: make_meta(),
        snapshot_upload=lambda _name: None,
        schedule_background=scheduled.append,
    )

    with pytest.raises(IfcIngestionError, match="invalid IFC"):
        await service.ingest(
            path=path,
            source_sha256="b" * 64,
            source_name="broken.ifc",
            include_tree_stats=True,
            prebuild_fragments=False,
            prebuild_profile="balanced",
        )

    assert ("ifc-error", "invalid IFC") in readiness.events
    assert rebound == []
    assert scheduled == []


async def _record_async(target: list, value):
    target.append(value)
