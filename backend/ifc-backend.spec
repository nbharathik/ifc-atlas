# PyInstaller spec for the FastAPI backend, bundled as a Tauri sidecar.
#
# Build:
#   cd backend
#   pyinstaller --clean --noconfirm ifc-backend.spec
#
# Output:
#   dist/ifc-backend.exe   (Windows, onefile)
#
# The Tauri build script then renames this to
#   src-tauri/binaries/ifc-backend-x86_64-pc-windows-msvc.exe
# so `tauri build` can pick it up via bundle.externalBin.

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Packages with non-trivial data files / lazy imports / C extensions.
# `collect_all` gathers the package's modules, data files and binaries.
_collected_pkgs = [
    "ifcopenshell",          # Schema (.exp) files, C extensions for geometry
    "uvicorn",               # Loops + protocol implementations imported lazily
    "fastapi",
    "starlette",
    "websockets",
    "pydantic",
    "pydantic_core",         # Rust extension
    "anthropic",
    "openai",
    "tiktoken",
    "tiktoken_ext",
    "langgraph",
    "langchain",
    "langchain_core",
    "langchain_openai",
    "langchain_anthropic",
    "mcp",
    "git",                   # gitpython
]

datas, binaries, hiddenimports = [], [], []
for pkg in _collected_pkgs:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # noqa: BLE001
        print(f"[ifc-backend.spec] WARN collect_all({pkg!r}) failed: {exc}")

# Explicit hidden imports that PyInstaller's static analysis misses.
hiddenimports += [
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "tiktoken_ext.openai_public",
    "anyio._backends._asyncio",
    "email.mime.multipart",
    "email.mime.text",
]

# CRITICAL: run.py starts uvicorn with the STRING target "app.main:app"
# (run.py: uvicorn.run("app.main:app", ...)). That is a runtime import
# PyInstaller's static analyzer cannot follow from run.py, so without this
# the frozen exe raises ModuleNotFoundError on boot, never prints
# `BACKEND_READY port=N`, and the Tauri webview hangs forever. Pulling in the
# whole `app` package statically makes every router/service/model resolvable.
# `app.main` alone cascades to most of the graph; collect_submodules("app")
# also catches any module only reached via conditional/late imports.
hiddenimports += ["app.main"]
hiddenimports += collect_submodules("app")

# Deduplicate hidden imports - collect_all can stack duplicates fast.
hiddenimports = sorted(set(hiddenimports))

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Optional deps mentioned in requirements.txt but not installed.
        "fastembed",
        "hnswlib",
        # Heavy test/dev frameworks we never need at runtime.
        "pytest",
        "vitest",
        "IPython",
        "jupyter",
        # Tk pulls a large unused UI runtime on Windows.
        "tkinter",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="ifc-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX often trips Windows Defender; keep off.
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,        # Show the backend log in a console window when running
                         # the .exe directly. Tauri spawns it without a console
                         # in production (see CREATE_NO_WINDOW in lib.rs).
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
