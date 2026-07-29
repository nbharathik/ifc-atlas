from __future__ import annotations

import hashlib

import pytest

from app.services.fragment_cache import read_fragment_cache
from app.services.fragment_prebuild_service import FragmentPrebuildService
from app.services.ifc_conversion_service import (
    ConverterUnavailableError,
    IfcConversionService,
    InvalidRenderArtifactError,
)
from app.services.ifc_converter import ConversionResult


class FakeConverter:
    engine = "test-converter"

    def __init__(self, data: bytes = b"F" * 4096) -> None:
        self.data = data
        self.calls = 0

    async def capabilities(self):
        return {"available": True}

    async def convert(self, *, ifc_bytes: bytes, profile: str, model_id: str):
        self.calls += 1
        return ConversionResult(
            data=self.data,
            metadata={
                "effectiveProfile": profile,
                "elapsedMs": 12,
                "modelId": model_id,
            },
        )


class FailingConverter(FakeConverter):
    async def convert(self, *, ifc_bytes: bytes, profile: str, model_id: str):
        self.calls += 1
        raise RuntimeError("converter unavailable")


def make_service(tmp_path, converter, *, clear_progress=lambda _model_id: None):
    return IfcConversionService(
        cache_dir=tmp_path,
        converter=converter,
        prebuild_service=FragmentPrebuildService(),
        clear_progress=clear_progress,
    )


@pytest.mark.asyncio
async def test_fresh_conversion_publishes_cache_and_clears_progress(tmp_path):
    converter = FakeConverter()
    cleared: list[str] = []
    service = make_service(tmp_path, converter, clear_progress=cleared.append)

    result = await service.convert(
        ifc_bytes=b"ISO-10303-21;fresh",
        profile="balanced",
        model_id="model-1",
    )

    assert result.source == "sidecar"
    assert result.effective_profile == "balanced"
    assert read_fragment_cache(result.cache_entry) == converter.data
    assert converter.calls == 1
    assert cleared == ["model-1"]


@pytest.mark.asyncio
async def test_cache_hit_skips_converter(tmp_path):
    converter = FakeConverter()
    service = make_service(tmp_path, converter)
    source = b"ISO-10303-21;cached"

    first = await service.convert(
        ifc_bytes=source,
        profile="quality",
        model_id="model-1",
    )
    second = await service.convert(
        ifc_bytes=source,
        profile="quality",
        model_id="model-2",
    )

    assert first.source == "sidecar"
    assert second.source == "cache"
    assert second.source_sha256 == hashlib.sha256(source).hexdigest()
    assert second.data == first.data
    assert converter.calls == 1


@pytest.mark.asyncio
async def test_no_cache_bypasses_cache_read_and_publication(tmp_path):
    converter = FakeConverter()
    service = make_service(tmp_path, converter)
    source = b"ISO-10303-21;uncached"

    first = await service.convert(
        ifc_bytes=source,
        profile="performance",
        model_id="model-1",
        no_cache=True,
    )
    second = await service.convert(
        ifc_bytes=source,
        profile="performance",
        model_id="model-2",
        no_cache=True,
    )

    assert first.source == second.source == "sidecar"
    assert read_fragment_cache(first.cache_entry) is None
    assert converter.calls == 2


@pytest.mark.asyncio
async def test_converter_failure_has_application_error_and_failed_job_state(tmp_path):
    converter = FailingConverter()
    prebuilds = FragmentPrebuildService()
    service = IfcConversionService(
        cache_dir=tmp_path,
        converter=converter,
        prebuild_service=prebuilds,
    )
    source = b"ISO-10303-21;failure"
    fingerprint = hashlib.sha256(source).hexdigest()

    with pytest.raises(ConverterUnavailableError, match="converter unavailable"):
        await service.convert(
            ifc_bytes=source,
            profile="balanced",
            model_id="model-1",
        )

    assert prebuilds.get_status(fingerprint, "balanced").status == "failed"


@pytest.mark.asyncio
async def test_tiny_converter_output_is_never_published(tmp_path):
    converter = FakeConverter(data=b"empty-stub")
    service = make_service(tmp_path, converter)

    with pytest.raises(InvalidRenderArtifactError, match="suspiciously small"):
        await service.convert(
            ifc_bytes=b"ISO-10303-21;tiny",
            profile="balanced",
            model_id="model-1",
        )

    assert list(tmp_path.glob("*.frag")) == []
