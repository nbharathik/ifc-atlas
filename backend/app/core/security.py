"""Deployment security profiles and API bearer-token enforcement.

Phase 0 intentionally provides a small authentication boundary, not a complete
user/tenant system:

* ``local`` is the desktop/development profile. Loopback without a token is
  allowed for browser development; the Tauri host supplies a random per-launch
  token and therefore authenticates every desktop API request.
* ``server`` requires a strong configured token and rejects anonymous API and
  WebSocket traffic. Later phases replace this coarse deployment token with
  user authentication and project authorization without changing callers.

The middleware is ASGI-native so it protects HTTP and WebSocket routes alike.
"""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from enum import Enum
from ipaddress import ip_address
from typing import Mapping
from urllib.parse import parse_qs

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class SecurityMode(str, Enum):
    LOCAL = "local"
    SERVER = "server"


@dataclass(frozen=True)
class SecuritySettings:
    """Resolved process security settings."""

    mode: SecurityMode
    api_token: str | None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "SecuritySettings":
        raw_mode = (env.get("IFC_ATLAS_SECURITY_MODE") or "local").strip().lower()
        try:
            mode = SecurityMode(raw_mode)
        except ValueError as exc:
            allowed = ", ".join(item.value for item in SecurityMode)
            raise RuntimeError(
                f"Invalid IFC_ATLAS_SECURITY_MODE={raw_mode!r}; expected one of: {allowed}"
            ) from exc

        token = (env.get("IFC_ATLAS_API_TOKEN") or "").strip() or None
        return cls(mode=mode, api_token=token)

    @property
    def auth_required(self) -> bool:
        return self.api_token is not None

    def validate_for_host(self, host: str) -> None:
        """Fail closed for unsafe deployment combinations."""

        if self.mode is SecurityMode.SERVER:
            if self.api_token is None:
                raise RuntimeError(
                    "IFC_ATLAS_SECURITY_MODE=server requires IFC_ATLAS_API_TOKEN"
                )
            if len(self.api_token) < 32:
                raise RuntimeError(
                    "IFC_ATLAS_API_TOKEN must contain at least 32 characters in server mode"
                )
            return

        if not _is_loopback_host(host):
            raise RuntimeError(
                "Local security mode may bind only to loopback; use "
                "IFC_ATLAS_SECURITY_MODE=server for a public bind"
            )


def _is_loopback_host(host: str) -> bool:
    normalized = (host or "").strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def _request_token(scope: Scope) -> str | None:
    authorization = _header(scope, b"authorization") or ""
    scheme, _, value = authorization.partition(" ")
    if scheme.lower() == "bearer" and value:
        return value.strip()

    # Browsers cannot attach arbitrary Authorization headers to WebSocket
    # handshakes. Keep the query-token fallback limited to WebSocket scopes.
    if scope["type"] == "websocket":
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        values = query.get("access_token")
        if values:
            return values[0]
    return None


class ApiTokenMiddleware:
    """Require the configured bearer token for protected API traffic."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        settings: SecuritySettings,
        protected_prefix: str = "/api",
        public_paths: tuple[str, ...] = ("/api/health", "/api/security"),
    ) -> None:
        self.app = app
        self.settings = settings
        self.protected_prefix = protected_prefix
        self.public_paths = frozenset(public_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self._requires_auth(scope):
            await self.app(scope, receive, send)
            return

        expected = self.settings.api_token
        supplied = _request_token(scope)
        if expected is not None and supplied is not None and hmac.compare_digest(
            supplied, expected
        ):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await send(
                Message(
                    {
                        "type": "websocket.close",
                        "code": 4401,
                        "reason": "Authentication required",
                    }
                )
            )
            return

        response = JSONResponse(
            {
                "error": "authentication_required",
                "detail": "A valid IFC Atlas bearer token is required.",
            },
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)

    def _requires_auth(self, scope: Scope) -> bool:
        if not self.settings.auth_required:
            return False
        if scope["type"] not in {"http", "websocket"}:
            return False
        path = scope.get("path", "")
        if not path.startswith(self.protected_prefix):
            return False
        if path in self.public_paths:
            return False
        if scope["type"] == "http" and scope.get("method") == "OPTIONS":
            return False
        return True
