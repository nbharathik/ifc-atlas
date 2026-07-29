from __future__ import annotations

from typing import Any

import pytest

from app.services.ifc_converter import (
    ConversionResult,
    IfcConverter,
    WebIfcSidecarConverter,
)


class _FakeSidecarManager:
    def __init__(self) -> None:
        self.convert_call: dict[str, Any] | None = None
        self.metadata = {"elapsedMs": 12, "effectiveProfile": "balanced"}

    async def capabilities(self) -> dict[str, Any]:
        return {"available": True, "server_convert": True, "version": "test"}

    async def convert(self, **kwargs: Any) -> tuple[bytes, dict[str, Any]]:
        self.convert_call = kwargs
        return b"fragment", self.metadata


@pytest.mark.asyncio
async def test_web_ifc_adapter_satisfies_converter_contract() -> None:
    manager = _FakeSidecarManager()
    converter: IfcConverter = WebIfcSidecarConverter(manager)

    capabilities = await converter.capabilities()
    result = await converter.convert(
        ifc_bytes=b"IFC",
        profile="balanced",
        model_id="model-1",
    )

    assert converter.engine == "web-ifc"
    assert capabilities["server_convert"] is True
    assert result == ConversionResult(
        data=b"fragment",
        metadata={"elapsedMs": 12, "effectiveProfile": "balanced"},
    )
    assert manager.convert_call == {
        "ifc_bytes": b"IFC",
        "profile": "balanced",
        "model_id": "model-1",
    }


@pytest.mark.asyncio
async def test_adapter_copies_mutable_sidecar_metadata() -> None:
    manager = _FakeSidecarManager()
    converter = WebIfcSidecarConverter(manager)
    result = await converter.convert(
        ifc_bytes=b"IFC",
        profile="performance",
        model_id="model-2",
    )

    assert isinstance(result.metadata, dict)
    assert result.metadata is not manager.metadata
    assert manager.convert_call is not None
