"""Resolution-order tests for ``resolve_sidecar_command``.

The function is pure (no spawning, no globals), so these tests build fake
sidecar directory layouts under tmp_path and assert which launcher wins:
IFC_SIDECAR_CMD override > bundled dist/index.cjs via node > npx tsx dev
fallback > None.
"""

from pathlib import Path

from app.services.sidecar_manager import resolve_sidecar_command

NODE = "/usr/bin/node"
NPX = "/usr/bin/npx"


def _sidecar_dir(tmp_path: Path, *, dist: bool = False, node_modules: bool = False) -> Path:
    d = tmp_path / "sidecar"
    d.mkdir()
    if dist:
        (d / "dist").mkdir()
        (d / "dist" / "index.cjs").write_text("// bundle stub")
    if node_modules:
        (d / "node_modules").mkdir()
    return d


def test_env_override_wins_over_everything(tmp_path):
    d = _sidecar_dir(tmp_path, dist=True, node_modules=True)
    resolved = resolve_sidecar_command(
        d, {"IFC_SIDECAR_CMD": "custom-node --flag entry.cjs"}, NODE, NPX
    )
    assert resolved is not None
    argv, reason = resolved
    assert argv == ["custom-node", "--flag", "entry.cjs"]
    assert "IFC_SIDECAR_CMD" in reason


def test_env_override_splits_quoted_paths(tmp_path):
    d = _sidecar_dir(tmp_path)
    resolved = resolve_sidecar_command(
        d,
        {"IFC_SIDECAR_CMD": '"C:/Program Files/nodejs/node.exe" dist/index.cjs'},
        None,
        None,
    )
    assert resolved is not None
    argv, _ = resolved
    assert argv == ["C:/Program Files/nodejs/node.exe", "dist/index.cjs"]


def test_blank_env_override_is_ignored(tmp_path):
    d = _sidecar_dir(tmp_path, dist=True)
    resolved = resolve_sidecar_command(d, {"IFC_SIDECAR_CMD": "   "}, NODE, NPX)
    assert resolved is not None
    argv, _ = resolved
    assert argv[0] == NODE


def test_dist_bundle_with_node_prefers_node(tmp_path):
    d = _sidecar_dir(tmp_path, dist=True, node_modules=True)
    resolved = resolve_sidecar_command(d, {}, NODE, NPX)
    assert resolved is not None
    argv, reason = resolved
    assert argv == [NODE, str(d / "dist" / "index.cjs")]
    assert "dist/index.cjs" in reason


def test_dist_bundle_without_node_falls_back_to_npx(tmp_path):
    d = _sidecar_dir(tmp_path, dist=True, node_modules=True)
    resolved = resolve_sidecar_command(d, {}, None, NPX)
    assert resolved is not None
    argv, reason = resolved
    assert argv == [NPX, "tsx", "src/index.ts"]
    assert "npx tsx" in reason


def test_no_dist_falls_back_to_npx(tmp_path):
    d = _sidecar_dir(tmp_path, node_modules=True)
    resolved = resolve_sidecar_command(d, {}, NODE, NPX)
    assert resolved is not None
    argv, _ = resolved
    assert argv == [NPX, "tsx", "src/index.ts"]


def test_npx_fallback_requires_node_modules(tmp_path):
    d = _sidecar_dir(tmp_path)  # no dist, no node_modules
    assert resolve_sidecar_command(d, {}, NODE, NPX) is None


def test_nothing_available_returns_none(tmp_path):
    d = _sidecar_dir(tmp_path, dist=True, node_modules=True)
    assert resolve_sidecar_command(d, {}, None, None) is None
