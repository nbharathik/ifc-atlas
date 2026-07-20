import argparse
import logging
import os
import socket
import sys

import uvicorn
from app.core.config import HOST, PORT


class _AccessNoiseFilter(logging.Filter):
    """Drop high-frequency polling endpoints from the default access log."""

    QUIET_PATHS = (
        "/api/ifc/convert/progress/",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True
        return not any(path in message for path in self.QUIET_PATHS)


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on", "debug"}


def _configure_logging(level: str) -> None:
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=numeric_level,
        format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
        force=True,
    )
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).setLevel(numeric_level)
    if not _truthy(os.getenv("BACKEND_VERBOSE_ACCESS")):
        logging.getLogger("uvicorn.access").addFilter(_AccessNoiseFilter())
    # Keep --verbose useful without turning large multipart uploads into
    # thousands of synchronous console writes. Those debug logs materially
    # slow dev-mode uploads on Windows.
    for name in ("python_multipart", "multipart", "httpx", "httpcore", "websockets"):
        logging.getLogger(name).setLevel(logging.WARNING)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the IFC Atlas FastAPI backend.")
    parser.add_argument("--host", default=os.getenv("HOST", HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", str(PORT))))
    parser.add_argument(
        "--log-level",
        default=os.getenv("LOG_LEVEL", "debug" if _truthy(os.getenv("BACKEND_VERBOSE")) else "info"),
        choices=["critical", "error", "warning", "info", "debug", "trace"],
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        default=_truthy(os.getenv("BACKEND_VERBOSE")),
        help="Enable DEBUG logs and detailed IFC route timing logs.",
    )
    reload_group = parser.add_mutually_exclusive_group()
    reload_group.add_argument(
        "--reload",
        dest="reload",
        action="store_true",
        default=_truthy(os.getenv("BACKEND_RELOAD")),
        help="Enable uvicorn reload. Off by default to avoid stale Windows child processes.",
    )
    reload_group.add_argument(
        "--no-reload",
        dest="reload",
        action="store_false",
        help="Disable uvicorn reload. This is the default.",
    )
    return parser.parse_args()


def _bind_server_socket(host: str, preferred: int) -> socket.socket:
    """Bind and return the actual server socket for the backend.

    Prefer ``preferred`` (default 8000); if it is already taken - e.g. an
    orphaned sidecar from a crashed/force-quit desktop session, or another app
    on the user's machine holding 8000 - fall back to an OS-assigned free port
    instead of dying. The chosen port is announced to the Tauri shell via
    ``BACKEND_READY port=N`` and the frontend connects to whatever was
    announced, so a non-default port is fully supported.

    The bound socket is handed straight to uvicorn (``Server.run(sockets=...)``),
    so there is no probe-then-rebind race: the announced port is one we already
    own. On Windows, ``SO_EXCLUSIVEADDRUSE`` makes the bind fail for ANY
    overlapping claim - a plain probe of 127.0.0.1 used to succeed while
    another process held the wildcard 0.0.0.0:8000, announcing a port the real
    bind then lost (winerror 10048).
    """
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for port in (preferred, 0):
        sock = socket.socket(family, socket.SOCK_STREAM)
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError as exc:
            sock.close()
            if port == 0:
                raise
            logging.getLogger(__name__).warning(
                "Preferred port %s on %s is in use (%s) - selecting a free port instead. "
                "Note: the browser dev workflow proxies to a fixed port; set "
                "VITE_BACKEND_PORT to match if you are not running inside Tauri.",
                preferred,
                host,
                exc,
            )
            continue
        # Start listening HERE, not later inside uvicorn. Loading
        # ``app.main`` pulls in ifcopenshell and every router and takes ~3 s on
        # Windows. A socket that is bound but not yet listening does not refuse
        # connections on Windows - it silently drops the SYN, so the dev proxy
        # and the frontend sit there until they time out. Listening up front
        # means anything that arrives during the import queues in the backlog
        # and is served the moment uvicorn starts accepting.
        # asyncio's create_server() calls listen() again on this same socket,
        # which is a no-op beyond resetting the backlog.
        sock.listen(2048)
        return sock
    raise AssertionError("unreachable")


# Re-entrant child mode for the FROZEN build. ``code_runner.run_ifc_code``
# cannot do ``[sys.executable, "-I", "-c", program]`` when sys.executable is the
# PyInstaller exe (not a Python interpreter), so it spawns ``[sys.executable,
# "--run-ifc-sandbox"]`` instead. We intercept that flag BEFORE argparse and run
# the embedded sandbox child program (code on stdin, sandbox path via env) using
# the bundled interpreter + ifcopenshell, then exit. Harmless no-op in dev,
# where code_runner keeps using the -c form.
if "--run-ifc-sandbox" in sys.argv:
    from app.services.code_runner import _CHILD_PROGRAM

    exec(compile(_CHILD_PROGRAM, "<ifc-sandbox-child>", "exec"), {"__name__": "__main__"})
    raise SystemExit(0)


if __name__ == "__main__":
    args = _parse_args()
    log_level = "debug" if args.verbose else args.log_level
    os.environ["BACKEND_VERBOSE"] = "1" if args.verbose else os.getenv("BACKEND_VERBOSE", "0")
    os.environ["LOG_LEVEL"] = log_level
    _configure_logging(log_level)
    # Bind the server socket BEFORE announcing the port: prefer the requested
    # port, fall back to a free one if it's taken (orphaned sidecar / another
    # app). uvicorn accepts the pre-bound socket, so the announced port is
    # guaranteed to be the one actually served.
    sock = _bind_server_socket(args.host, args.port)
    port = sock.getsockname()[1]
    # Tauri sidecar announce: app/main.py's lifespan prints `BACKEND_READY port=N`
    # when this env var is set so the Rust side can detect "backend up" and tell
    # the webview which port to talk to. Must be the RESOLVED port, not the
    # requested one, or the frontend would connect to the wrong port.
    os.environ["BACKEND_ANNOUNCE_PORT"] = str(port)
    logging.getLogger(__name__).info(
        "Starting backend host=%s port=%s reload=%s log_level=%s pid=%s",
        args.host,
        port,
        args.reload,
        log_level,
        os.getpid(),
    )
    config = uvicorn.Config(
        "app.main:app",
        host=args.host,
        port=port,
        reload=args.reload,
        log_level=log_level,
        log_config=None,
        access_log=True,
    )
    server = uvicorn.Server(config)
    if config.should_reload:
        # Mirrors uvicorn.run()'s reload branch, but with our pre-bound socket
        # instead of a second config.bind_socket() on the same port.
        from uvicorn.supervisors import ChangeReload

        ChangeReload(config, target=server.run, sockets=[sock]).run()
    else:
        server.run(sockets=[sock])
        if not server.started:
            raise SystemExit(3)
