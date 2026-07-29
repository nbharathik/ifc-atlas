"""Stable, engine-neutral contracts for model identity and render artifacts.

These models are intentionally independent of IfcOpenShell, web-ifc, Three.js,
and Fragments. Runtime adapters may use those libraries, but API consumers
should only depend on the versioned Atlas contracts in this module.
"""

from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Annotated, Any, Literal, Mapping, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    model_validator,
)


Sha256 = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{64}$"),
]
ProjectId = Annotated[
    str,
    StringConstraints(pattern=r"^prj_[0-9a-f]{32}$"),
]
ModelId = Annotated[
    str,
    StringConstraints(pattern=r"^mdl_[0-9a-f]{32}$"),
]
RevisionId = Annotated[
    str,
    StringConstraints(pattern=r"^rev_[0-9a-f]{64}$"),
]
ArtifactId = Annotated[
    str,
    StringConstraints(pattern=r"^art_[0-9a-f]{64}$"),
]


def canonical_json(value: Any) -> bytes:
    """Encode contract material deterministically for hashes and signatures."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _namespaced_id(prefix: str, namespace: str, value: str, length: int) -> str:
    digest = hashlib.sha256(f"{namespace}\0{value}".encode()).hexdigest()
    return f"{prefix}_{digest[:length]}"


def derive_project_id(project_global_id: str | None, source_sha256: str) -> str:
    """Derive the transitional project identity from IFC data.

    The IfcProject GlobalId survives ordinary revisions and is preferred. The
    source digest is a deterministic fallback for malformed/minimal files.
    """

    seed = project_global_id.strip() if project_global_id else source_sha256
    return _namespaced_id("prj", "ifc-project-v1", seed, 32)


def derive_model_id(source_sha256: str) -> str:
    """Identify the imported model lineage for the current migration window."""

    return _namespaced_id("mdl", "ifc-model-import-v1", source_sha256, 32)


def derive_revision_id(revision_sha256: str) -> str:
    """Identify an immutable revision directly from its canonical IFC bytes."""

    return f"rev_{revision_sha256}"


class ModelIdentityV1(BaseModel):
    """Stable identity for one immutable revision of one imported IFC model."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    project_id: ProjectId
    model_id: ModelId
    revision_id: RevisionId
    source_sha256: Sha256
    revision_sha256: Sha256
    model_version: int = Field(ge=0)


def build_model_identity(
    *,
    project_global_id: str | None,
    source_sha256: str,
    revision_sha256: str,
    model_version: int,
) -> ModelIdentityV1:
    return ModelIdentityV1(
        project_id=derive_project_id(project_global_id, source_sha256),
        model_id=derive_model_id(source_sha256),
        revision_id=derive_revision_id(revision_sha256),
        source_sha256=source_sha256,
        revision_sha256=revision_sha256,
        model_version=model_version,
    )


class ElementKeyV1(BaseModel):
    """Compound element identity; local express IDs are never globally unique."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    model_id: ModelId
    revision_id: RevisionId
    express_id: int = Field(gt=0)
    global_id: Optional[str] = Field(default=None, min_length=1, max_length=64)


class ArtifactFileV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_type: str = Field(min_length=1, max_length=128)
    byte_length: int = Field(gt=0)
    sha256: Sha256
    serve_url: str = Field(pattern=r"^/api/", max_length=2048)


class ConverterDescriptorV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    engine: str = Field(min_length=1, max_length=64)
    engine_version: str = Field(min_length=1, max_length=64)
    runtime: Literal["node", "wasm", "native"]
    build_sha256: Sha256
    settings_sha256: Sha256
    dependencies: dict[str, str] = Field(default_factory=dict)


class ArtifactManifestV1(BaseModel):
    """Public Atlas Render Package manifest for one validated artifact."""

    model_config = ConfigDict(extra="forbid")

    schema_name: Literal["ifc-atlas.render-artifact-manifest"] = (
        "ifc-atlas.render-artifact-manifest"
    )
    schema_version: Literal[1] = 1
    artifact_id: ArtifactId
    source_revision_id: RevisionId
    source_sha256: Sha256
    artifact_kind: Literal["full", "storey", "spatial-subset", "lod"]
    profile: Literal["quality", "balanced", "performance", "ultra_fast"]
    cache_key: Sha256
    fragments_format_version: str = Field(min_length=1, max_length=64)
    converter: ConverterDescriptorV1
    artifact: ArtifactFileV1
    preprocessing: dict[str, JsonValue] = Field(default_factory=dict)
    preprocessing_sha256: Sha256
    manifest_sha256: Sha256

    def unsigned_payload(self) -> dict[str, Any]:
        return self.model_dump(exclude={"manifest_sha256"}, mode="json")

    @model_validator(mode="after")
    def validate_contract_hashes(self) -> "ArtifactManifestV1":
        if self.artifact_id != f"art_{self.cache_key}":
            raise ValueError("artifact_id must be derived from cache_key")
        if self.source_revision_id != derive_revision_id(self.source_sha256):
            raise ValueError("source_revision_id must match source_sha256")
        preprocessing_hash = sha256_json(self.preprocessing)
        if self.preprocessing_sha256 != preprocessing_hash:
            raise ValueError("preprocessing_sha256 does not match preprocessing")
        manifest_hash = sha256_json(self.unsigned_payload())
        if self.manifest_sha256 != manifest_hash:
            raise ValueError("manifest_sha256 does not match manifest payload")
        return self


class ArtifactManifestLookupV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    cached: bool
    fingerprint: Sha256
    profile: Literal["quality", "balanced", "performance", "ultra_fast"]
    manifest: Optional[ArtifactManifestV1] = None

    @model_validator(mode="after")
    def validate_lookup(self) -> "ArtifactManifestLookupV1":
        if self.cached != (self.manifest is not None):
            raise ValueError("cached must match manifest availability")
        if self.manifest is not None:
            if self.fingerprint != self.manifest.source_sha256:
                raise ValueError("lookup fingerprint must match manifest source")
            if self.profile != self.manifest.profile:
                raise ValueError("lookup profile must match manifest profile")
        return self


def build_artifact_manifest(
    *,
    source_sha256: str,
    artifact_kind: str,
    profile: str,
    cache_key: str,
    fragments_format_version: str,
    artifact_sha256: str,
    artifact_size: int,
    serve_url: str,
    provenance: Mapping[str, Any],
    preprocessing: Mapping[str, Any],
) -> ArtifactManifestV1:
    """Build and self-check a public manifest from the internal cache record."""

    dependencies_value = provenance.get("dependencies", {})
    dependencies = (
        {str(key): str(value) for key, value in dependencies_value.items()}
        if isinstance(dependencies_value, Mapping)
        else {}
    )
    engine_version = dependencies.get("web-ifc", "unknown")
    runtime_mode = str(provenance.get("runtime_mode", "bundle"))
    runtime = "node" if runtime_mode in {"bundle", "source"} else "native"
    converter = ConverterDescriptorV1(
        engine="web-ifc",
        engine_version=engine_version,
        runtime=runtime,
        build_sha256=str(provenance["runtime_sha256"]),
        settings_sha256=str(provenance["profile_settings_sha256"]),
        dependencies=dependencies,
    )
    normalized_preprocessing = json.loads(canonical_json(dict(preprocessing)))
    unsigned = {
        "schema_name": "ifc-atlas.render-artifact-manifest",
        "schema_version": 1,
        "artifact_id": f"art_{cache_key}",
        "source_revision_id": derive_revision_id(source_sha256),
        "source_sha256": source_sha256,
        "artifact_kind": artifact_kind,
        "profile": profile,
        "cache_key": cache_key,
        "fragments_format_version": fragments_format_version,
        "converter": converter.model_dump(mode="json"),
        "artifact": {
            "media_type": "application/vnd.thatopen.fragments",
            "byte_length": artifact_size,
            "sha256": artifact_sha256,
            "serve_url": serve_url,
        },
        "preprocessing": normalized_preprocessing,
        "preprocessing_sha256": sha256_json(normalized_preprocessing),
    }
    return ArtifactManifestV1(
        **unsigned,
        manifest_sha256=sha256_json(unsigned),
    )


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ErrorCode(StrEnum):
    CANCELLED = "cancelled"
    RESOURCE_LIMIT_EXCEEDED = "resource_limit_exceeded"
    UNSUPPORTED_IFC = "unsupported_ifc"
    INVALID_INPUT = "invalid_input"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    CONVERTER_UNAVAILABLE = "converter_unavailable"
    CONVERSION_FAILED = "conversion_failed"
    INTERNAL_ERROR = "internal_error"


class ErrorDetailV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: ErrorCode
    message: str = Field(min_length=1, max_length=1024)
    retryable: bool = False
    details: dict[str, JsonValue] = Field(default_factory=dict)


class ApiErrorResponseV1(BaseModel):
    """Stable error envelope with FastAPI's legacy ``detail`` preserved."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    detail: JsonValue
    error: ErrorDetailV1


def classify_error_code(message: str, *, status_code: int | None = None) -> ErrorCode:
    """Map legacy exceptions to the stable error vocabulary."""

    normalized = message.casefold()
    if "cancel" in normalized or status_code == 499:
        return ErrorCode.CANCELLED
    if status_code == 413 or any(
        marker in normalized
        for marker in (
            "resource limit",
            "out of memory",
            "memory limit",
            "too large",
            "deadline exceeded",
        )
    ):
        return ErrorCode.RESOURCE_LIMIT_EXCEEDED
    if any(
        marker in normalized
        for marker in (
            "unsupported ifc",
            "unsupported schema",
            "unsupported representation",
        )
    ):
        return ErrorCode.UNSUPPORTED_IFC
    if status_code == 404:
        return ErrorCode.NOT_FOUND
    if status_code == 409:
        return ErrorCode.CONFLICT
    if status_code in {400, 422}:
        return ErrorCode.INVALID_INPUT
    if status_code == 503 or any(
        marker in normalized for marker in ("unavailable", "sidecar not running")
    ):
        return ErrorCode.CONVERTER_UNAVAILABLE
    if status_code is not None and status_code >= 500:
        return ErrorCode.INTERNAL_ERROR
    return ErrorCode.CONVERSION_FAILED


class JobContractV1(BaseModel):
    """Stable asynchronous job state shared by conversion and future indexing."""

    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    job_id: str = Field(pattern=r"^job_[0-9a-f]{64}$")
    job_type: Literal["ifc_conversion", "metadata_index", "spatial_index"]
    state: JobState
    progress: float = Field(ge=0.0, le=1.0)
    cancellable: bool
    elapsed_ms: Optional[int] = Field(default=None, ge=0)
    result_artifact_id: Optional[ArtifactId] = None
    error: Optional[ErrorDetailV1] = None

    @model_validator(mode="after")
    def validate_terminal_shape(self) -> "JobContractV1":
        if self.state is JobState.FAILED and self.error is None:
            raise ValueError("failed jobs require an error")
        if self.state is not JobState.FAILED and self.error is not None:
            raise ValueError("only failed jobs may carry an error")
        if self.state is JobState.SUCCEEDED and self.progress != 1.0:
            raise ValueError("succeeded jobs require progress=1")
        if (
            self.state is JobState.SUCCEEDED
            and self.job_type == "ifc_conversion"
            and self.result_artifact_id is None
        ):
            raise ValueError("succeeded conversion jobs require an artifact")
        if self.state is not JobState.SUCCEEDED and self.result_artifact_id is not None:
            raise ValueError("only succeeded jobs may carry an artifact")
        return self


class ConversionJobLookupV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    contract_version: Literal["1.0"] = "1.0"
    fingerprint: Sha256
    profile: Literal["quality", "balanced", "performance", "ultra_fast"]
    job: Optional[JobContractV1] = None


__all__ = [
    "ApiErrorResponseV1",
    "ArtifactManifestLookupV1",
    "ArtifactManifestV1",
    "ConversionJobLookupV1",
    "ElementKeyV1",
    "ErrorCode",
    "ErrorDetailV1",
    "JobContractV1",
    "JobState",
    "ModelIdentityV1",
    "build_artifact_manifest",
    "build_model_identity",
    "canonical_json",
    "classify_error_code",
    "derive_model_id",
    "derive_project_id",
    "derive_revision_id",
    "sha256_json",
]
