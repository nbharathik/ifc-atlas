"""Application-owned IFC conversion boundary.

The active adapter delegates to the existing web-ifc Node sidecar. Routes use
this contract so a future benchmark candidate can be substituted without
changing upload, cache, job, or renderer-facing code.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping, Protocol


ConversionProfile = Literal["quality", "balanced", "performance", "ultra_fast"]


@dataclass(frozen=True)
class ConversionResult:
    data: bytes
    metadata: Mapping[str, Any]


class IfcConverter(Protocol):
    engine: str

    async def capabilities(self) -> Mapping[str, Any]:
        """Return availability and supported runtime features."""

    async def convert(
        self,
        *,
        ifc_bytes: bytes,
        profile: ConversionProfile,
        model_id: str,
    ) -> ConversionResult:
        """Convert immutable IFC bytes into one render artifact."""


class WebIfcSidecarConverter:
    """Thin adapter around the current sidecar manager."""

    engine = "web-ifc"

    def __init__(self, manager: Any) -> None:
        self._manager = manager

    async def capabilities(self) -> Mapping[str, Any]:
        return await self._manager.capabilities()

    async def convert(
        self,
        *,
        ifc_bytes: bytes,
        profile: ConversionProfile,
        model_id: str,
    ) -> ConversionResult:
        data, metadata = await self._manager.convert(
            ifc_bytes=ifc_bytes,
            profile=profile,
            model_id=model_id,
        )
        return ConversionResult(data=bytes(data), metadata=dict(metadata))


__all__ = [
    "ConversionProfile",
    "ConversionResult",
    "IfcConverter",
    "WebIfcSidecarConverter",
]
