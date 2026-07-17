"""Focused tests for ID-preserving spatial fragment preprocessing."""

from __future__ import annotations

import asyncio
import json
import struct
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import spatial_fragment_service
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
    inspect_fragment_cache,
    subset_fragment_cache_entry,
)
from app.services.sidecar_manager import _encode_subset_request


_SHA = "7" * 64
_META = {
    "inputBytes": 100,
    "outputBytes": 20,
    "requestedCount": 2,
    "resolvedCount": 2,
    "guidRemapCount": 1,
    "identityCount": 2,
    "identitySha256": "1" * 64,
    "identityVerified": True,
    "contentSha256": "2" * 64,
    "contentVerified": True,
    "elapsedMs": 9,
}


def _model() -> MagicMock:
    model = MagicMock()
    model.by_id.side_effect = lambda element_id: SimpleNamespace(
        GlobalId=f"guid-{element_id}"
    )
    return model


def test_subset_protocol_encodes_identity_json_before_fragment() -> None:
    payload = _encode_subset_request(
        b"FRAGMENT", [(12, "guid-12"), (14, None)]
    )

    assert payload[:8] == b"IFCSUB01"
    metadata_length = struct.unpack("<I", payload[8:12])[0]
    metadata = json.loads(payload[12 : 12 + metadata_length])
    assert metadata == {
        "schemaVersion": 1,
        "items": [
            {"sourceId": 12, "guid": "guid-12"},
            {"sourceId": 14, "guid": None},
        ],
    }
    assert payload[12 + metadata_length :] == b"FRAGMENT"


def test_spatial_fragment_builds_once_and_persists_parity_metadata(tmp_path) -> None:
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"FULL"
    )
    sidecar = MagicMock()
    sidecar.subset = AsyncMock(return_value=(b"SUBSET", _META))
    with (
        patch.object(spatial_fragment_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "sidecar_manager", sidecar),
    ):
        first = asyncio.run(
            spatial_fragment_service.get_or_build_spatial_fragment(
                model=_model(),
                fingerprint=_SHA,
                profile="balanced",
                subset_kind="tile-g2",
                subset_id="0-0-0",
                element_ids=[14, 12],
            )
        )
        second = asyncio.run(
            spatial_fragment_service.get_or_build_spatial_fragment(
                model=_model(),
                fingerprint=_SHA,
                profile="balanced",
                subset_kind="tile-g2",
                subset_id="0-0-0",
                element_ids=[12, 14],
            )
        )

    assert first == (b"SUBSET", "sidecar")
    assert second == (b"SUBSET", "cache")
    sidecar.subset.assert_awaited_once()
    assert sidecar.subset.call_args.kwargs["items"] == [
        (12, "guid-12"),
        (14, "guid-14"),
    ]
    entry = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[12, 14],
    )
    info = inspect_fragment_cache(entry)
    assert info is not None
    assert info.preprocessing["identity"]["verified"] is True
    assert info.preprocessing["content"]["sha256"] == "2" * 64


def test_spatial_fragment_rejects_incomplete_parity_proof(tmp_path) -> None:
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"FULL"
    )
    sidecar = MagicMock()
    sidecar.subset = AsyncMock(
        return_value=(b"SUBSET", {**_META, "resolvedCount": 1})
    )
    with (
        patch.object(spatial_fragment_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "sidecar_manager", sidecar),
        pytest.raises(spatial_fragment_service.SpatialSubsetUnavailable, match="parity"),
    ):
        asyncio.run(
            spatial_fragment_service.get_or_build_spatial_fragment(
                model=_model(),
                fingerprint=_SHA,
                profile="balanced",
                subset_kind="tile-g2",
                subset_id="0-0-0",
                element_ids=[12, 14],
            )
        )

    entry = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="0-0-0",
        element_ids=[12, 14],
    )
    assert not entry.path.exists()
    assert not entry.manifest_path.exists()


# ── Profile drop-set filtering ──────────────────────────────────────────────


def _typed_model(classes: dict[int, str]) -> MagicMock:
    def by_id(element_id: int):
        entity_class = classes[element_id]
        entity = SimpleNamespace(GlobalId=f"guid-{element_id}")
        entity.is_a = lambda cls=entity_class: cls
        return entity

    model = MagicMock()
    model.by_id.side_effect = by_id
    return model


def test_filter_convertible_element_ids_mirrors_profile_drop_sets() -> None:
    classes = {
        1: "IfcWall",
        2: "IfcOpeningElement",
        3: "IfcFurniture",
        4: "IfcPipeFitting",
        5: "IfcSpace",
    }
    model = _typed_model(classes)
    ids = [1, 2, 3, 4, 5]

    kept_quality = spatial_fragment_service.filter_convertible_element_ids(
        model, ids, "quality"
    )
    kept_balanced = spatial_fragment_service.filter_convertible_element_ids(
        model, ids, "balanced"
    )
    kept_ultra = spatial_fragment_service.filter_convertible_element_ids(
        model, ids, "ultra_fast"
    )

    assert kept_quality == ids
    assert kept_balanced == [1, 3, 4]
    assert kept_ultra == [1]


def test_filter_convertible_element_ids_keeps_unresolvable_entities() -> None:
    model = MagicMock()
    model.by_id.side_effect = RuntimeError("model detached")

    kept = spatial_fragment_service.filter_convertible_element_ids(
        model, [7, 9], "balanced"
    )

    assert kept == [7, 9]


def test_spatial_fragment_request_excludes_profile_dropped_ids(tmp_path) -> None:
    """An opening in the tile membership never reaches the sidecar request.

    The cached 'balanced' fragment physically lacks IfcOpeningElement items,
    so including one could only trip the fail-closed parity proof and 503 the
    whole tile.
    """
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"FULL"
    )
    model = _typed_model({10: "IfcWall", 11: "IfcOpeningElement"})
    meta = {
        **_META,
        "requestedCount": 1,
        "resolvedCount": 1,
        "identityCount": 1,
    }
    sidecar = MagicMock()
    sidecar.subset = AsyncMock(return_value=(b"SUBSET", meta))

    with (
        patch.object(spatial_fragment_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "sidecar_manager", sidecar),
    ):
        payload, source = asyncio.run(
            spatial_fragment_service.get_or_build_spatial_fragment(
                model=model,
                fingerprint=_SHA,
                profile="balanced",
                subset_kind="tile-g2",
                subset_id="t0",
                element_ids=[10, 11],
            )
        )

    assert payload == b"SUBSET"
    assert source == "sidecar"
    requested_items = sidecar.subset.await_args.kwargs["items"]
    assert requested_items == [(10, "guid-10")]
    # The artifact identity must describe the filtered request, not the raw
    # membership list.
    filtered_entry = subset_fragment_cache_entry(
        tmp_path,
        _SHA,
        "balanced",
        subset_kind="tile-g2",
        subset_id="t0",
        element_ids=[10],
    )
    assert filtered_entry.path.exists()


def test_spatial_fragment_all_ids_dropped_is_unavailable(tmp_path) -> None:
    atomic_write_fragment_cache(
        full_fragment_cache_entry(tmp_path, _SHA, "balanced"), b"FULL"
    )
    model = _typed_model({11: "IfcOpeningElement"})
    sidecar = MagicMock()
    sidecar.subset = AsyncMock()

    with (
        patch.object(spatial_fragment_service, "FRAGMENT_CACHE_DIR", tmp_path),
        patch.object(spatial_fragment_service, "sidecar_manager", sidecar),
    ):
        with pytest.raises(spatial_fragment_service.SpatialSubsetUnavailable):
            asyncio.run(
                spatial_fragment_service.get_or_build_spatial_fragment(
                    model=model,
                    fingerprint=_SHA,
                    profile="balanced",
                    subset_kind="tile-g2",
                    subset_id="t1",
                    element_ids=[11],
                )
            )
    sidecar.subset.assert_not_awaited()
