"""Characterization and contract tests for the Phase 1 API boundaries."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.models.contracts import (
    ArtifactManifestV1,
    ElementKeyV1,
    ErrorCode,
    ErrorDetailV1,
    JobContractV1,
    JobState,
    build_artifact_manifest,
    build_model_identity,
    sha256_json,
)
from app.services.fragment_cache import (
    atomic_write_fragment_cache,
    full_fragment_cache_entry,
)
from app.services.fragment_prebuild_service import FragmentPrebuildService


SOURCE_SHA = "a" * 64
REVISION_SHA = "b" * 64
GOLDEN_PATH = Path(__file__).parent / "fixtures" / "contracts_v1_golden.json"


def _client() -> TestClient:
    return TestClient(app, raise_server_exceptions=False)


def test_model_identity_matches_approved_golden() -> None:
    identity = build_model_identity(
        project_global_id="2Y$AtlasProject",
        source_sha256=SOURCE_SHA,
        revision_sha256=REVISION_SHA,
        model_version=7,
    )
    golden = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))

    assert identity.model_dump(mode="json") == golden


def test_model_lineage_is_stable_while_revision_changes() -> None:
    first = build_model_identity(
        project_global_id="2Y$AtlasProject",
        source_sha256=SOURCE_SHA,
        revision_sha256=SOURCE_SHA,
        model_version=1,
    )
    edited = build_model_identity(
        project_global_id="2Y$AtlasProject",
        source_sha256=SOURCE_SHA,
        revision_sha256=REVISION_SHA,
        model_version=2,
    )

    assert first.project_id == edited.project_id
    assert first.model_id == edited.model_id
    assert first.revision_id != edited.revision_id


def test_element_key_requires_revision_and_positive_express_id() -> None:
    identity = build_model_identity(
        project_global_id=None,
        source_sha256=SOURCE_SHA,
        revision_sha256=REVISION_SHA,
        model_version=1,
    )
    key = ElementKeyV1(
        model_id=identity.model_id,
        revision_id=identity.revision_id,
        express_id=42,
        global_id="2Y$AtlasElement",
    )
    assert key.express_id == 42

    with pytest.raises(ValidationError):
        ElementKeyV1(
            model_id=identity.model_id,
            revision_id=identity.revision_id,
            express_id=0,
        )


def _manifest() -> ArtifactManifestV1:
    return build_artifact_manifest(
        source_sha256=SOURCE_SHA,
        artifact_kind="full",
        profile="balanced",
        cache_key="c" * 64,
        fragments_format_version="3.4.3",
        artifact_sha256="d" * 64,
        artifact_size=1234,
        serve_url=(
            f"/api/ifc/fragments/serve?fingerprint={SOURCE_SHA}&profile=balanced"
        ),
        provenance={
            "runtime_mode": "bundle",
            "runtime_sha256": "e" * 64,
            "profile_settings_sha256": "f" * 64,
            "dependencies": {
                "web-ifc": "0.0.77",
                "@thatopen/fragments": "3.4.3",
            },
        },
        preprocessing={"identity": {"verified": True}, "triangles": 99},
    )


def test_artifact_manifest_round_trip_and_tamper_detection() -> None:
    manifest = _manifest()
    encoded = manifest.model_dump(mode="json")

    assert ArtifactManifestV1.model_validate(encoded) == manifest
    assert manifest.converter.engine == "web-ifc"
    assert manifest.artifact.byte_length == 1234

    encoded["artifact"]["byte_length"] = 1235
    with pytest.raises(ValidationError, match="manifest_sha256"):
        ArtifactManifestV1.model_validate(encoded)


def test_manifest_preprocessing_checksum_detects_tampering() -> None:
    encoded = _manifest().model_dump(mode="json")
    encoded["preprocessing"]["triangles"] = 100

    with pytest.raises(ValidationError, match="preprocessing_sha256"):
        ArtifactManifestV1.model_validate(encoded)


def test_manifest_rejects_semantically_inconsistent_rehashed_identity() -> None:
    encoded = _manifest().model_dump(mode="json")
    encoded["source_revision_id"] = f"rev_{'9' * 64}"
    encoded["manifest_sha256"] = sha256_json(
        {key: value for key, value in encoded.items() if key != "manifest_sha256"}
    )

    with pytest.raises(ValidationError, match="source_revision_id"):
        ArtifactManifestV1.model_validate(encoded)


def test_job_contract_covers_required_terminal_and_error_cases() -> None:
    assert set(JobState) == {
        JobState.QUEUED,
        JobState.RUNNING,
        JobState.SUCCEEDED,
        JobState.FAILED,
        JobState.CANCELLED,
    }
    assert {
        ErrorCode.CANCELLED,
        ErrorCode.RESOURCE_LIMIT_EXCEEDED,
        ErrorCode.UNSUPPORTED_IFC,
    }.issubset(set(ErrorCode))

    failed = JobContractV1(
        job_id=f"job_{'1' * 64}",
        job_type="ifc_conversion",
        state=JobState.FAILED,
        progress=0.4,
        cancellable=False,
        error=ErrorDetailV1(
            code=ErrorCode.UNSUPPORTED_IFC,
            message="Unsupported IFC schema",
        ),
    )
    assert failed.error is not None
    assert failed.error.code is ErrorCode.UNSUPPORTED_IFC

    with pytest.raises(ValidationError, match="failed jobs require an error"):
        JobContractV1(
            job_id=f"job_{'1' * 64}",
            job_type="ifc_conversion",
            state=JobState.FAILED,
            progress=0.4,
            cancellable=False,
        )


def test_artifact_manifest_route_wraps_validated_cache(tmp_path: Path) -> None:
    entry = full_fragment_cache_entry(tmp_path, SOURCE_SHA, "balanced")
    atomic_write_fragment_cache(
        entry,
        b"fragment-bytes",
        preprocessing={"identity": {"verified": True}},
    )

    with patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path):
        response = _client().get(
            f"/api/ifc/artifact-manifest?fingerprint={SOURCE_SHA}&profile=balanced"
        )

    assert response.status_code == 200
    body = response.json()
    assert body["cached"] is True
    assert body["manifest"]["schema_version"] == 1
    assert body["manifest"]["cache_key"] == entry.key.digest
    assert body["manifest"]["artifact"]["sha256"] == (
        "e6a181542706687c1494ed21fa5834d67eb8089bec7374ae76248adcc0474a26"
    )


def test_http_errors_keep_detail_and_add_stable_error_envelope(tmp_path: Path) -> None:
    with patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path):
        response = _client().get(
            f"/api/ifc/fragments/serve?fingerprint={SOURCE_SHA}&profile=balanced"
        )

    assert response.status_code == 404
    body = response.json()
    assert "Fragment not in disk cache" in body["detail"]
    assert body["contract_version"] == "1.0"
    assert body["error"] == {
        "code": "not_found",
        "message": body["detail"],
        "retryable": False,
        "details": {},
    }


@pytest.mark.parametrize(
    ("message", "expected_code"),
    [
        ("resource limit exceeded", ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        ("unsupported IFC schema IFC5", ErrorCode.UNSUPPORTED_IFC),
        ("sidecar unavailable", ErrorCode.CONVERTER_UNAVAILABLE),
    ],
)
def test_conversion_job_route_maps_stable_error_codes(
    tmp_path: Path,
    message: str,
    expected_code: ErrorCode,
) -> None:
    service = FragmentPrebuildService()
    asyncio.run(service.register_inflight(SOURCE_SHA, "balanced"))
    asyncio.run(service.mark_failed(SOURCE_SHA, "balanced", error=message))

    with (
        patch("app.api.ifc_routes.FRAGMENT_CACHE_DIR", tmp_path),
        patch("app.api.ifc_routes.fragment_prebuild_service", service),
    ):
        response = _client().get(
            f"/api/ifc/conversion-jobs/current?fingerprint={SOURCE_SHA}"
        )

    assert response.status_code == 200
    job = response.json()["job"]
    assert job["state"] == "failed"
    assert job["error"]["code"] == expected_code.value


def test_openapi_exposes_versioned_contracts() -> None:
    spec = app.openapi()
    schemas = spec["components"]["schemas"]

    assert "/api/ifc/identity" in spec["paths"]
    assert "/api/ifc/elements/{element_id}/key" in spec["paths"]
    assert "/api/ifc/artifact-manifest" in spec["paths"]
    assert "/api/ifc/conversion-jobs/current" in spec["paths"]
    assert "ModelIdentityV1" in schemas
    assert "ElementKeyV1" in schemas
    assert "ApiErrorResponseV1" in schemas
    element_key_responses = spec["paths"]["/api/ifc/elements/{element_id}/key"][
        "get"
    ]["responses"]
    assert element_key_responses["404"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/ApiErrorResponseV1"
    }
    assert "ArtifactManifestV1" in schemas
    assert set(schemas["JobState"]["enum"]) == {
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
    }
    assert {
        "cancelled",
        "resource_limit_exceeded",
        "unsupported_ifc",
    }.issubset(set(schemas["ErrorCode"]["enum"]))
