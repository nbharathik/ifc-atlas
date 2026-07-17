import asyncio
import logging
import os
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import FRONTEND_URL
from app.api.ifc_routes import router as ifc_router
from app.api.chat_routes import router as chat_router
from app.api.settings_routes import router as settings_router
from app.api.mcp_routes import router as mcp_router
from app.api.system_routes import router as system_router
from app.api.qto_routes import router as qto_router
from app.api.cost_routes import router as cost_router
from app.api.carbon_routes import router as carbon_router
from app.api.cobie_routes import router as cobie_router
from app.api.diff_routes import router as diff_router
from app.api.ids_routes import router as ids_router
from app.api.bcf_routes import router as bcf_router
from app.api.plugin_routes import router as plugin_router
from app.api.viewer_state_routes import router as viewer_state_router
from app.mcp_server import build_sse_app
from app.services.fragment_prebuild_gc import gc_loop as _fragment_prebuild_gc_loop
from app.services.sidecar_manager import sidecar_manager

logger = logging.getLogger(__name__)


def _verbose_enabled() -> bool:
    value = os.getenv("BACKEND_VERBOSE", "")
    return value.strip().lower() in {"1", "true", "yes", "on", "debug"}


def _attach_file_log() -> None:
    """Mirror WARNING+ records to ~/.ifc-atlas/logs/backend.log.

    Console output dies with the terminal, which left chat/LLM tracebacks
    unrecoverable after the fact. Idempotent so uvicorn reload or repeated
    imports never stack duplicate handlers.
    """
    from logging.handlers import RotatingFileHandler
    from app.core.config import BASE_DIR

    root = logging.getLogger()
    if any(getattr(h, "_ifc_atlas_file_log", False) for h in root.handlers):
        return
    try:
        log_dir = BASE_DIR / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            log_dir / "backend.log",
            maxBytes=2 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        handler.setLevel(logging.WARNING)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        handler._ifc_atlas_file_log = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    except Exception:  # noqa: BLE001 - logging must never block startup
        logger.exception("could not attach file log handler (non-fatal)")


_attach_file_log()


@asynccontextmanager
async def _lifespan(_: FastAPI):
    """App lifespan: start background tasks on boot, cancel on shutdown.

    Currently starts the fragment-prebuild GC loop, which scans
    the in-memory registry every 30 s and flips abandoned `inflight` rows
    to `failed`, waking pending `wait_for` callers so they fall back to
    `/convert` instead of blocking for their full timeout.
    """
    logger.info(
        "Backend lifespan starting pid=%s verbose=%s log_level=%s",
        os.getpid(),
        _verbose_enabled(),
        os.getenv("LOG_LEVEL", "info"),
    )
    # Tauri sidecar announce protocol - see docs/architecture/TAURI.md.
    # run.py sets BACKEND_ANNOUNCE_PORT before uvicorn.run; the Tauri Rust
    # side reads this line from stdout and emits a `backend-ready` event
    # to the webview. Outside Tauri the env var is unset and we stay quiet.
    _announce_port = os.getenv("BACKEND_ANNOUNCE_PORT")
    if _announce_port:
        sys.stdout.write(f"BACKEND_READY port={_announce_port}\n")
        sys.stdout.flush()
    gc_task = asyncio.create_task(
        _fragment_prebuild_gc_loop(), name="fragment_prebuild_gc"
    )

    # Pre-warm the Node fragment sidecar in the background so the first IFC
    # upload doesn't pay the ~3 s `npx tsx` cold-start tax. ensure_running is
    # synchronous (threading lock + Popen); offload to a thread so the event
    # loop stays free during startup.
    async def _prewarm_sidecar() -> None:
        try:
            await asyncio.to_thread(sidecar_manager.ensure_running)
        except Exception:  # noqa: BLE001
            logger.exception("sidecar pre-warm failed (non-fatal)")

    prewarm_task = asyncio.create_task(_prewarm_sidecar(), name="sidecar_prewarm")

    try:
        yield
    finally:
        gc_task.cancel()
        prewarm_task.cancel()
        try:
            await gc_task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.exception("fragment_prebuild GC: shutdown raised")
        try:
            await prewarm_task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.exception("sidecar pre-warm: shutdown raised")


app = FastAPI(
    title="IFC Atlas",
    description="IFC Atlas with Multi-LLM Agent Interface",
    version="1.1.0",
    lifespan=_lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
    # In the packaged Tauri desktop app the webview page origin is
    # `http://tauri.localhost` (Windows WebView2) or `tauri://localhost`
    # (macOS/Linux WKWebView). The frontend calls the sidecar cross-origin at
    # http://127.0.0.1:<announced-port>, so without allowing the webview origin
    # every REST request is CORS-blocked. `allow_credentials=True` forbids the
    # "*" wildcard, so we match the desktop + any-port-localhost origins by regex
    # (an origin is allowed if it matches allow_origins OR allow_origin_regex).
    allow_origin_regex=(
        r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?"
        r"|tauri://localhost|https?://tauri\.localhost)$"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Response headers the frontend reads via resp.headers.get(...). Same-origin
    # dev (Vite proxy) can always read them, but the packaged desktop app calls
    # cross-origin, where only safelisted headers are visible to JS unless
    # exposed here ("*" is not a wildcard when credentials are allowed).
    expose_headers=[
        "X-Fragment-Source",
        "X-Fragment-Profile",
        "X-Fragment-Elapsed-Ms",
        "X-Fragment-Source-Sha256",
        "X-Fragment-Cache-Key",
        "X-Fragment-Artifact-Schema",
        "X-Fragments-Format-Version",
        "X-Fragment-Storey-Name",
        "X-Geometry-Batch-Size",
    ],
)


@app.middleware("http")
async def verbose_request_logging(request: Request, call_next):
    if not _verbose_enabled():
        return await call_next(request)

    started = time.perf_counter()
    logger.info(
        "REQ start method=%s path=%s query=%s client=%s",
        request.method,
        request.url.path,
        request.url.query or "-",
        request.client.host if request.client else "-",
    )
    try:
        response = await call_next(request)
    except Exception:
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.exception(
            "REQ error method=%s path=%s elapsed_ms=%.1f",
            request.method,
            request.url.path,
            elapsed_ms,
        )
        raise
    elapsed_ms = (time.perf_counter() - started) * 1000
    logger.info(
        "REQ done method=%s path=%s status=%s elapsed_ms=%.1f",
        request.method,
        request.url.path,
        response.status_code,
        elapsed_ms,
    )
    return response

app.include_router(ifc_router)
app.include_router(chat_router)
app.include_router(settings_router)
app.include_router(mcp_router)
app.include_router(system_router)
app.include_router(qto_router)
app.include_router(cost_router)
app.include_router(carbon_router)
app.include_router(cobie_router)
app.include_router(diff_router)
app.include_router(ids_router)
app.include_router(bcf_router)
app.include_router(plugin_router)
app.include_router(viewer_state_router)

# MCP server (viewer-as-server).
# SSE endpoint: GET  /mcp/sse
# Message post: POST /mcp/messages/
# Set MCP_SERVER_TOKEN env var to enable bearer-token auth.
_mcp_token = os.getenv("MCP_SERVER_TOKEN") or None
app.mount("/mcp", build_sse_app(token=_mcp_token))


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.1.0"}
