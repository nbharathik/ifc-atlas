"""Manages the lifecycle of the Node fragment-conversion sidecar.

Part of the server-side convert path
(`docs/architecture/AI_NATIVE_ENGINE.md`).

The sidecar is a Node process running `@thatopen/fragments` + `web-ifc`
in Node. Python spawns it on first convert request (or at startup via
`FASTAPI_SIDECAR_AUTOSTART=1`), monitors it, and tears it down on
application shutdown.

Design choices:
- Subprocess, not threads - Node's runtime is distinct from Python's.
- localhost-only HTTP - no auth needed; loopback boundary.
- Health-probe before use - if the process died since last request,
  respawn transparently.
- Spawn is idempotent - concurrent callers converge on one process.

Spawn command resolution (see ``resolve_sidecar_command``), first hit wins:
1. ``IFC_SIDECAR_CMD`` env var - a full command line, split with shlex
   (quote arguments containing spaces). Escape hatch for packagers and
   for devs who want to force a specific launcher.
2. ``node dist/index.cjs`` - the esbuild bundle built by ``npm run build``
   in ``backend/sidecar``. Production path: needs only a Node runtime on
   PATH, no node_modules or npx. NOTE: while the bundle exists it wins
   over the dev fallback, so rebuild (or delete dist/) after editing
   sidecar sources, or set IFC_SIDECAR_CMD.
3. ``npx tsx src/index.ts`` - dev fallback running the TypeScript source
   (requires node_modules installed in the sidecar directory).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import shlex
import shutil
import struct
import subprocess
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Mapping, Optional

import httpx

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parents[2]
_SIDECAR_DIR = Path(
    os.environ.get("SIDECAR_DIR", str(_BACKEND_DIR / "sidecar"))
).resolve()
_DEFAULT_PORT = int(os.environ.get("SIDECAR_PORT", "9100"))
_DEFAULT_HOST = os.environ.get("SIDECAR_HOST", "127.0.0.1")
_SPAWN_TIMEOUT_S = float(os.environ.get("SIDECAR_SPAWN_TIMEOUT_S", "15"))
_HEALTH_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/health"
_CONVERT_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/convert"
_DECIMATE_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/decimate"
_SUBSET_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/subset"
_PARSE_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/parse"
_GEOMETRY_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/geometry"
_GEOMETRY_STREAM_URL = f"http://{_DEFAULT_HOST}:{_DEFAULT_PORT}/geometry/stream"


def _optional_int_header(headers: httpx.Headers, name: str) -> Optional[int]:
    raw = headers.get(name)
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _optional_float_header(headers: httpx.Headers, name: str) -> Optional[float]:
    raw = headers.get(name)
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _encode_subset_request(
    frag_bytes: bytes,
    items: list[tuple[int, Optional[str]]],
) -> bytes:
    """Encode the sidecar subset protocol without base64-copying the fragment."""

    if not frag_bytes:
        raise ValueError("subset source fragment is empty")
    if not items:
        raise ValueError("subset item list is empty")
    normalized_items: list[dict[str, Any]] = []
    for source_id, guid in items:
        item_id = int(source_id)
        if item_id < 0 or item_id > (2**53 - 1):
            raise ValueError(f"invalid subset source ID: {source_id}")
        if guid is not None and not isinstance(guid, str):
            raise ValueError(f"invalid subset GUID for source ID {source_id}")
        normalized_items.append({"sourceId": item_id, "guid": guid})
    metadata = json.dumps(
        {"schemaVersion": 1, "items": normalized_items},
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return b"IFCSUB01" + struct.pack("<I", len(metadata)) + metadata + bytes(frag_bytes)


def _is_recoverable_sidecar_reason(reason: str | None) -> bool:
    """Return whether a sidecar readiness failure may clear on retry."""
    if not reason:
        return True
    lower = reason.lower()
    hard_markers = (
        "sidecar directory missing",
        "sidecar node_modules missing",
        "node not found",
        "npx not found",
        "spawn failed",
    )
    return not any(marker in lower for marker in hard_markers)


def _split_override_command(value: str) -> list[str]:
    """Split ``IFC_SIDECAR_CMD`` into argv.

    On Windows, posix-mode shlex eats backslashes in paths like
    ``C:\\nodejs\\node.exe``, so split in non-posix mode and strip the
    surrounding quotes it leaves on quoted tokens.
    """
    if os.name == "nt":
        return [token.strip('"') for token in shlex.split(value, posix=False)]
    return shlex.split(value)


def resolve_sidecar_command(
    sidecar_dir: Path,
    env: Mapping[str, str],
    node_path: Optional[str],
    npx_path: Optional[str],
) -> Optional[tuple[list[str], str]]:
    """Pick the sidecar launch command. Pure - no spawning, no globals.

    Priority (see module docstring): ``IFC_SIDECAR_CMD`` override, then
    the esbuild bundle via plain node, then the npx-tsx dev fallback.
    Returns ``(argv, reason)`` or ``None`` when no launcher is viable.
    Relative argv entries resolve against ``sidecar_dir`` - the caller
    spawns with ``cwd=sidecar_dir``.
    """
    override = (env.get("IFC_SIDECAR_CMD") or "").strip()
    if override:
        argv = _split_override_command(override)
        if argv:
            return argv, "IFC_SIDECAR_CMD override"

    dist_entry = sidecar_dir / "dist" / "index.cjs"
    if node_path is not None and dist_entry.exists():
        return [node_path, str(dist_entry)], "bundled dist/index.cjs (node)"

    if npx_path is not None and (sidecar_dir / "node_modules").exists():
        return [npx_path, "tsx", "src/index.ts"], "dev source (npx tsx)"

    return None


@dataclass
class SidecarState:
    """Live sidecar process handle + rolling telemetry."""

    process: Optional[subprocess.Popen] = None  # type: ignore[type-arg]
    started_at: float = 0.0
    last_health_ok_at: float = 0.0
    pid: Optional[int] = None
    available: bool = False
    last_error: Optional[str] = None
    progress_listeners: list[Callable[[dict[str, Any]], None]] = field(default_factory=list)


@dataclass
class ConvertProgress:
    """Snapshot of a single sidecar conversion's progress.

    Updated by ``_tail_stderr`` on every ``SIDECAR_PROGRESS`` event.
    Read by the ``GET /api/ifc/convert/progress/{model_id}`` route so
    the frontend loader UI can show real percent + stage instead of
    stalling at "70 %".
    """

    model_id: str
    stage: str
    progress: float  # 0.0-100.0
    updated_at: float


class SidecarManager:
    """Singleton-ish manager. Instantiate once at app startup."""

    def __init__(self) -> None:
        self.state = SidecarState()
        self._lock = threading.Lock()
        self._stderr_thread: Optional[threading.Thread] = None
        # Last-known progress per modelId. Bounded to 64 entries to
        # cap memory; eldest evicted in FIFO order on update.
        self._progress: "OrderedDict[str, ConvertProgress]" = OrderedDict()
        self._progress_lock = threading.Lock()
        self._max_progress_entries = 64
        # Register an always-on listener that captures every progress event
        # into the snapshot dict, regardless of whether the caller passed an
        # `on_progress` callback to ``convert()``.
        self.state.progress_listeners.append(self._capture_progress)

    # ────────────────────────────────────────────────────────────────────
    # Lifecycle
    # ────────────────────────────────────────────────────────────────────

    def is_running(self) -> bool:
        proc = self.state.process
        return proc is not None and proc.poll() is None

    def _spawn(self) -> None:
        """Start the Node process. Caller holds self._lock."""
        if self.is_running():
            return

        if not _SIDECAR_DIR.exists():
            self.state.last_error = f"sidecar directory missing: {_SIDECAR_DIR}"
            self.state.available = False
            return

        resolved = resolve_sidecar_command(
            _SIDECAR_DIR,
            os.environ,
            shutil.which("node"),
            shutil.which("npx"),
        )
        if resolved is None:
            # Preserve the specific dev-path diagnostics: missing
            # node_modules is the common cause, missing npx the rarer one.
            # A bundle without node means Node itself is absent.
            if (_SIDECAR_DIR / "dist" / "index.cjs").exists():
                self.state.last_error = "node not found on PATH"
            elif not (_SIDECAR_DIR / "node_modules").exists():
                self.state.last_error = (
                    "sidecar node_modules missing - run "
                    "`cd backend/sidecar && npm install` first"
                )
            else:
                self.state.last_error = "npx not found on PATH"
            self.state.available = False
            logger.warning(self.state.last_error)
            return

        cmd, launcher = resolved
        env = {
            **os.environ,
            "SIDECAR_PORT": str(_DEFAULT_PORT),
            "SIDECAR_HOST": _DEFAULT_HOST,
        }

        logger.info(
            "Spawning fragment sidecar: cwd=%s cmd=%s port=%s launcher=%s",
            _SIDECAR_DIR,
            cmd,
            _DEFAULT_PORT,
            launcher,
        )
        try:
            proc = subprocess.Popen(  # noqa: S603 - arguments are controlled
                cmd,
                cwd=str(_SIDECAR_DIR),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            self.state.last_error = f"spawn failed: {exc}"
            self.state.available = False
            logger.exception("sidecar spawn failed")
            return

        self.state.process = proc
        self.state.pid = proc.pid
        self.state.started_at = time.monotonic()
        self.state.last_error = None

        # Tail stderr in a background thread to parse structured progress
        # lines and emit them to listeners (the /convert SSE stream).
        self._stderr_thread = threading.Thread(
            target=self._tail_stderr,
            name="sidecar-stderr",
            daemon=True,
        )
        self._stderr_thread.start()

    def _capture_progress(self, event: dict[str, Any]) -> None:
        """Always-on listener that stores the latest progress
        event per modelId so HTTP polling can read it.

        Ignores non-progress events (ready / done / error / shutdown).
        Bounded to ``_max_progress_entries`` by FIFO eviction.
        """
        if event.get("event") != "progress":
            return
        model_id = event.get("modelId")
        if not isinstance(model_id, str) or not model_id:
            return
        stage = event.get("stage")
        progress = event.get("progress")
        if not isinstance(stage, str) or not isinstance(progress, (int, float)):
            return
        with self._progress_lock:
            # Move-to-end so the LRU eviction below targets stale entries.
            if model_id in self._progress:
                del self._progress[model_id]
            self._progress[model_id] = ConvertProgress(
                model_id=model_id,
                stage=stage,
                progress=float(progress),
                updated_at=time.time(),
            )
            while len(self._progress) > self._max_progress_entries:
                self._progress.popitem(last=False)

    def get_progress(self, model_id: str) -> Optional[ConvertProgress]:
        """Latest known progress for a given modelId, or None
        if the sidecar hasn't reported one yet (or it was evicted)."""
        with self._progress_lock:
            return self._progress.get(model_id)

    def clear_progress(self, model_id: Optional[str] = None) -> None:
        """Drop the snapshot for one modelId or all of them.

        Called when a conversion completes successfully so a follow-up
        poll for the same modelId returns ``None`` instead of stale 100 %.
        """
        with self._progress_lock:
            if model_id is None:
                self._progress.clear()
            else:
                self._progress.pop(model_id, None)

    def _tail_stderr(self) -> None:
        proc = self.state.process
        if proc is None or proc.stderr is None:
            return
        for raw in proc.stderr:
            line = raw.rstrip()
            if not line:
                continue
            # The Node side emits structured prefixes: SIDECAR_READY,
            # SIDECAR_PROGRESS, SIDECAR_DONE, SIDECAR_ERROR, SIDECAR_SHUTDOWN.
            if line.startswith("SIDECAR_"):
                try:
                    prefix, payload = line.split(" ", 1)
                    event = json.loads(payload)
                    event["event"] = prefix.lower().replace("sidecar_", "")
                    for listener in list(self.state.progress_listeners):
                        try:
                            listener(event)
                        except Exception:
                            logger.exception("progress listener failed")
                    if prefix == "SIDECAR_READY":
                        logger.info("sidecar ready: %s", event)
                except ValueError:
                    logger.debug("sidecar stderr (unparsed): %s", line)
            else:
                logger.debug("sidecar stderr: %s", line)

    def ensure_running(self) -> bool:
        """Spawn if not running. Returns True if the process is alive."""
        with self._lock:
            if not self.is_running():
                self._spawn()
            return self.is_running()

    def stop(self) -> None:
        with self._lock:
            proc = self.state.process
            if proc is None:
                return
            if proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
            self.state.process = None
            self.state.pid = None
            self.state.available = False

    # ────────────────────────────────────────────────────────────────────
    # Health + features
    # ────────────────────────────────────────────────────────────────────

    def _mark_health_ok(self, data: dict[str, Any]) -> None:
        self.state.last_health_ok_at = time.monotonic()
        self.state.available = True
        self.state.last_error = None
        if self.state.process is None:
            sidecar_pid = data.get("pid")
            self.state.pid = int(sidecar_pid) if isinstance(sidecar_pid, int) else None

    async def _request_health_once(
        self, client: httpx.AsyncClient
    ) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        try:
            resp = await client.get(_HEALTH_URL)
            if resp.status_code == 200:
                return resp.json(), None
            return None, f"HTTP {resp.status_code}: {resp.text[:120]}"
        except httpx.HTTPError as exc:
            return None, f"{type(exc).__name__}: {exc}"

    async def health(self) -> dict[str, Any]:
        """Reach the sidecar's /health. Starts it if not running."""
        started = time.monotonic()
        logger.debug(
            "sidecar health check start url=%s pid=%s running=%s",
            _HEALTH_URL,
            self.state.pid,
            self.is_running(),
        )
        async with httpx.AsyncClient(timeout=2.0) as client:
            data, last_err = await self._request_health_once(client)
            if data is not None:
                self._mark_health_ok(data)
                logger.debug(
                    "sidecar health check ok elapsed_ms=%.1f response=%s",
                    (time.monotonic() - started) * 1000,
                    data,
                )
                return {"ok": True, "sidecar": data}

            if not self.ensure_running():
                logger.warning("sidecar health check unavailable: %s", self.state.last_error)
                return {
                    "ok": False,
                    "reason": self.state.last_error or last_err or "sidecar not running",
                }

            # Retry while the process is booting. Node + tsx + WASM load can
            # take ~2 s on the first run.
            deadline = time.monotonic() + _SPAWN_TIMEOUT_S
            while time.monotonic() < deadline:
                data, last_err = await self._request_health_once(client)
                if data is not None:
                    self._mark_health_ok(data)
                    logger.debug(
                        "sidecar health check ok elapsed_ms=%.1f response=%s",
                        (time.monotonic() - started) * 1000,
                        data,
                    )
                    return {"ok": True, "sidecar": data}
                logger.debug("sidecar health check retry: %s", last_err)
                await asyncio.sleep(0.3)
        self.state.available = False
        logger.warning(
            "sidecar health check failed elapsed_ms=%.1f reason=%s",
            (time.monotonic() - started) * 1000,
            last_err or "sidecar did not respond in time",
        )
        return {"ok": False, "reason": last_err or "sidecar did not respond in time"}

    async def capabilities(self) -> dict[str, Any]:
        """Summary used by the frontend `/api/ifc/features` probe."""
        try:
            h = await self.health()
        except Exception as exc:  # pragma: no cover - defensive boundary
            logger.exception("sidecar capabilities probe failed")
            return {
                "server_convert": False,
                "available": False,
                "recoverable": True,
                "reason": f"{type(exc).__name__}: {exc}",
            }
        if not h.get("ok"):
            reason = h.get("reason", "unknown")
            return {
                "server_convert": False,
                "available": False,
                "recoverable": _is_recoverable_sidecar_reason(reason),
                "reason": reason,
            }
        sidecar = h.get("sidecar", {})
        return {
            "server_convert": True,
            "available": True,
            "recoverable": True,
            "version": sidecar.get("version"),
            "wasmDir": sidecar.get("wasmDir"),
            "uptimeMs": sidecar.get("uptimeMs"),
        }

    # ────────────────────────────────────────────────────────────────────
    # Convert
    # ────────────────────────────────────────────────────────────────────

    async def convert(
        self,
        ifc_bytes: bytes,
        profile: str,
        model_id: str,
        on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> tuple[bytes, dict[str, Any]]:
        """Convert IFC bytes → fragment bytes via the sidecar.

        Returns `(fragment_bytes, meta)` where meta contains profile used,
        elapsedMs, input/output sizes. Streams progress via `on_progress`
        if supplied.
        """
        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")

        # Temporarily register the listener so stderr progress events get
        # forwarded to the caller's callback.
        listener: Optional[Callable[[dict[str, Any]], None]] = None
        if on_progress is not None:

            def forward(event: dict[str, Any]) -> None:
                if event.get("event") == "progress" and event.get("modelId") == model_id:
                    on_progress(event)

            listener = forward
            self.state.progress_listeners.append(listener)

        try:
            started = time.monotonic()
            logger.info(
                "sidecar convert POST start url=%s model_id=%s profile=%s input=%.2fMB",
                _CONVERT_URL,
                model_id,
                profile,
                len(ifc_bytes) / (1024 * 1024),
            )
            async with httpx.AsyncClient(timeout=None) as client:
                resp = await client.post(
                    _CONVERT_URL,
                    content=ifc_bytes,
                    params={"profile": profile, "modelId": model_id},
                    headers={"Content-Type": "application/octet-stream"},
                )
                if resp.status_code != 200:
                    raise RuntimeError(f"sidecar returned {resp.status_code}: {resp.text[:200]}")
                meta = {
                    "effectiveProfile": resp.headers.get("X-Sidecar-Profile"),
                    "elapsedMs": int(resp.headers.get("X-Sidecar-Elapsed-Ms", "0")),
                    "inputBytes": int(resp.headers.get("X-Sidecar-Input-Bytes", "0")),
                    "outputBytes": int(resp.headers.get("X-Sidecar-Output-Bytes", "0")),
                }
                logger.info(
                    "sidecar convert POST done model_id=%s status=%s output=%.2fMB elapsed_ms=%.1f sidecar_ms=%s",
                    model_id,
                    resp.status_code,
                    len(resp.content) / (1024 * 1024),
                    (time.monotonic() - started) * 1000,
                    meta["elapsedMs"],
                )
                return resp.content, meta
        finally:
            if listener is not None:
                try:
                    self.state.progress_listeners.remove(listener)
                except ValueError:
                    pass

    # ────────────────────────────────────────────────────────────────────
    # Decimate (offline LOD fragment authoring)
    # ────────────────────────────────────────────────────────────────────

    async def decimate(
        self,
        frag_bytes: bytes,
        model_id: str = "lod-model",
        ratio: Optional[float] = None,
        error: Optional[float] = None,
        timeout_s: Optional[float] = None,
    ) -> tuple[bytes, dict[str, Any]]:
        """POST an already-converted ``.frag`` to the sidecar /decimate endpoint.

        Returns ``(lod_frag_bytes, meta)`` where ``meta`` carries input/output
        byte sizes + triangle counts from the response headers. ``ratio`` and
        ``error`` override the sidecar's decimation defaults when provided.

        Raises ``RuntimeError`` if the sidecar is unavailable or decimation
        fails - the caller (``lod_service``) maps that to a graceful 503 so the
        frontend simply keeps using the full model.
        """
        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")

        params: dict[str, str] = {"modelId": model_id}
        if ratio is not None:
            params["ratio"] = str(ratio)
        if error is not None:
            params["error"] = str(error)

        started = time.monotonic()
        logger.info(
            "sidecar decimate POST start url=%s model_id=%s input=%.2fMB ratio=%s error=%s",
            _DECIMATE_URL,
            model_id,
            len(frag_bytes) / (1024 * 1024),
            ratio,
            error,
        )
        # No default timeout: decimation of a big model is a few seconds of CPU.
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                _DECIMATE_URL,
                content=frag_bytes,
                params=params,
                headers={"Content-Type": "application/octet-stream"},
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"sidecar /decimate returned {resp.status_code}: {resp.text[:200]}"
                )
            identity_verified_raw = resp.headers.get(
                "X-Sidecar-Identity-Verified"
            )
            identity_verified: Optional[bool]
            if identity_verified_raw is None:
                identity_verified = None
            elif identity_verified_raw.lower() == "true":
                identity_verified = True
            elif identity_verified_raw.lower() == "false":
                identity_verified = False
            else:
                identity_verified = None
            identity_sha256 = resp.headers.get("X-Sidecar-Identity-Sha256")
            if identity_sha256 is not None:
                try:
                    valid_identity_hash = (
                        len(identity_sha256) == 64
                        and len(bytes.fromhex(identity_sha256)) == 32
                    )
                except ValueError:
                    valid_identity_hash = False
                if not valid_identity_hash:
                    identity_sha256 = None
            meta = {
                "inputBytes": int(resp.headers.get("X-Sidecar-Input-Bytes", "0")),
                "outputBytes": int(resp.headers.get("X-Sidecar-Output-Bytes", "0")),
                "trisBefore": int(resp.headers.get("X-Sidecar-Tris-Before", "0")),
                "trisAfter": int(resp.headers.get("X-Sidecar-Tris-After", "0")),
                "elapsedMs": int(resp.headers.get("X-Sidecar-Elapsed-Ms", "0")),
                "targetRatio": _optional_float_header(
                    resp.headers, "X-Sidecar-Lod-Target-Ratio"
                ),
                "targetError": _optional_float_header(
                    resp.headers, "X-Sidecar-Lod-Target-Error"
                ),
                "achievedMaxError": _optional_float_header(
                    resp.headers, "X-Sidecar-Lod-Max-Error"
                ),
                "achievedWeightedMeanError": _optional_float_header(
                    resp.headers, "X-Sidecar-Lod-Mean-Error"
                ),
                "identityCount": _optional_int_header(
                    resp.headers, "X-Sidecar-Identity-Count"
                ),
                "identitySha256": identity_sha256,
                "identityVerified": identity_verified,
            }
            logger.info(
                "sidecar decimate POST done model_id=%s status=%s output=%.2fMB tris=%s->%s wall_ms=%.1f",
                model_id,
                resp.status_code,
                len(resp.content) / (1024 * 1024),
                meta["trisBefore"],
                meta["trisAfter"],
                (time.monotonic() - started) * 1000,
            )
            return resp.content, meta

    # ────────────────────────────────────────────────────────────────────
    async def subset(
        self,
        frag_bytes: bytes,
        items: list[tuple[int, Optional[str]]],
        model_id: str = "subset-model",
        timeout_s: Optional[float] = None,
    ) -> tuple[bytes, dict[str, Any]]:
        """Create an ID/GUID/material-verified subset of a full fragment."""

        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")
        payload = _encode_subset_request(frag_bytes, items)
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                _SUBSET_URL,
                content=payload,
                params={"modelId": model_id},
                headers={"Content-Type": "application/octet-stream"},
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"sidecar /subset returned {resp.status_code}: {resp.text[:200]}"
                )

            identity_verified = (
                resp.headers.get("X-Sidecar-Identity-Verified", "").lower()
                == "true"
            )
            content_verified = (
                resp.headers.get("X-Sidecar-Content-Verified", "").lower()
                == "true"
            )
            identity_sha256 = resp.headers.get("X-Sidecar-Identity-Sha256", "")
            content_sha256 = resp.headers.get("X-Sidecar-Content-Sha256", "")
            try:
                hashes_valid = (
                    len(bytes.fromhex(identity_sha256)) == 32
                    and len(identity_sha256) == 64
                    and len(bytes.fromhex(content_sha256)) == 32
                    and len(content_sha256) == 64
                )
            except ValueError:
                hashes_valid = False
            if not identity_verified or not content_verified or not hashes_valid:
                raise RuntimeError("sidecar subset did not return a complete parity proof")

            meta = {
                "inputBytes": int(resp.headers.get("X-Sidecar-Input-Bytes", "0")),
                "outputBytes": int(resp.headers.get("X-Sidecar-Output-Bytes", "0")),
                "requestedCount": int(
                    resp.headers.get("X-Sidecar-Subset-Requested", "0")
                ),
                "resolvedCount": int(
                    resp.headers.get("X-Sidecar-Subset-Resolved", "0")
                ),
                "guidRemapCount": int(
                    resp.headers.get("X-Sidecar-Subset-Guid-Remaps", "0")
                ),
                "identityCount": int(
                    resp.headers.get("X-Sidecar-Identity-Count", "0")
                ),
                "identitySha256": identity_sha256,
                "identityVerified": True,
                "contentSha256": content_sha256,
                "contentVerified": True,
                "elapsedMs": int(resp.headers.get("X-Sidecar-Elapsed-Ms", "0")),
            }
            return resp.content, meta

    # Parse (native metadata extraction)
    # ────────────────────────────────────────────────────────────────────

    async def geometry(
        self,
        ifc_bytes: bytes,
        model_id: str = "geo-model",
        timeout_s: float = 120.0,
    ) -> tuple[dict, dict]:
        """POST IFC bytes to the sidecar /geometry endpoint.

        Returns ``(result_json, headers_meta)`` where ``result_json`` has
        the shape ``{meshCount, attempted, skipped, geoElapsedMs, meshes}``.
        Each mesh entry has base64-encoded ``positions`` (Float32) and
        ``indices`` (Uint32), plus ``expressId``, ``ifcType``, ``name``,
        and ``bbox`` (6-element list).
        """
        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")

        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                _GEOMETRY_URL,
                content=ifc_bytes,
                params={"modelId": model_id},
                headers={"Content-Type": "application/octet-stream"},
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"sidecar /geometry returned {resp.status_code}: {resp.text[:200]}"
                )
            meta = {
                "elapsedMs": int(resp.headers.get("X-Sidecar-Elapsed-Ms", "0")),
                "meshCount": int(resp.headers.get("X-Sidecar-Mesh-Count", "0")),
                "attempted": int(resp.headers.get("X-Sidecar-Attempted", "0")),
                "skipped": int(resp.headers.get("X-Sidecar-Skipped", "0")),
            }
            return resp.json(), meta

    async def geometry_stream(
        self,
        ifc_bytes: bytes,
        model_id: str = "geo-stream-model",
        batch_size: int = 100,
        timeout_s: float = 300.0,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming mesh extraction.

        Proxies the sidecar's ``POST /geometry/stream`` NDJSON response,
        yielding one parsed event dict per line. Events are one of:

        * ``{"type": "start", "modelId": ..., "batchSize": N}``
        * ``{"type": "batch", "batchIndex": N, "meshes": [...]}``
        * ``{"type": "summary", "meshCount": X, "attempted": Y, ...}``
        * ``{"type": "error", "message": "..."}``

        Compared to :meth:`geometry`, this method allows the caller to
        flush mesh data to the frontend as soon as the first batch is
        ready (target: a few seconds for the first triangle on a 50 MB
        IFC) rather than waiting for the full conversion to complete.
        """
        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")

        timeout = httpx.Timeout(timeout_s, read=timeout_s)
        params = {"modelId": model_id, "batchSize": str(batch_size)}
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST",
                _GEOMETRY_STREAM_URL,
                content=ifc_bytes,
                params=params,
                headers={"Content-Type": "application/octet-stream"},
            ) as resp:
                if resp.status_code != 200:
                    # Read full body for the error message - only safe
                    # because the failure path is short.
                    body = await resp.aread()
                    raise RuntimeError(
                        f"sidecar /geometry/stream returned {resp.status_code}: "
                        f"{body.decode('utf-8', 'replace')[:200]}"
                    )

                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except ValueError:
                        logger.warning(
                            "sidecar /geometry/stream emitted non-JSON line: %r",
                            line[:120],
                        )
                        continue
                    yield event

    async def parse(
        self,
        ifc_bytes: bytes,
        model_id: str = "sidecar-parse",
        stats_only: bool = False,
        timeout_s: float = 60.0,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """POST IFC bytes to the sidecar /parse endpoint.

        Returns ``(parsed_json, headers_meta)``. ``stats_only=True`` skips
        the metadata-index build and returns just entity counts (cheap
        pre-flight). Raises ``RuntimeError`` if the sidecar is unavailable
        or the parse fails.
        """
        health = await self.health()
        if not health.get("ok"):
            raise RuntimeError(health.get("reason") or "sidecar unavailable")

        params: dict[str, str] = {"modelId": model_id}
        if stats_only:
            params["statsOnly"] = "1"

        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                _PARSE_URL,
                content=ifc_bytes,
                params=params,
                headers={"Content-Type": "application/octet-stream"},
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"sidecar /parse returned {resp.status_code}: {resp.text[:200]}"
                )
            meta = {
                "elapsedMs": int(resp.headers.get("X-Sidecar-Elapsed-Ms", "0")),
                "inputBytes": int(resp.headers.get("X-Sidecar-Input-Bytes", "0")),
                "indexBytes": int(resp.headers.get("X-Sidecar-Index-Bytes", "0")),
                "elementCount": int(resp.headers.get("X-Sidecar-Element-Count", "0")),
                "storeyCount": int(resp.headers.get("X-Sidecar-Storey-Count", "0")),
            }
            return resp.json(), meta


# Module-level singleton - imported by routes + lifespan hooks.
sidecar_manager = SidecarManager()


__all__ = ["sidecar_manager", "SidecarManager", "resolve_sidecar_command"]
