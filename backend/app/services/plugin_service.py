"""Plugin / user-script system on top of the IFC code sandbox.

A plugin is a named, saved Python script plus a JSON manifest describing
its parameters. Scripts run with exactly the same safety envelope as
LLM-authored code (``SandboxService.execute_python`` -> subprocess child
with audit-hook isolation), so a plugin can only ever touch the sandbox
copy of the model. Write-capable plugins (``requires_write: true``) stage
a pending edit that flows through the existing preview/apply UI.

Storage layout (same shape for both tiers):

- built-ins:  ``backend/plugins_builtin/<id>/{manifest.json,script.py}``
  (shipped with the repo, read-only at runtime)
- user:       ``BASE_DIR/plugins/<id>/{manifest.json,script.py}``

Scripts may use only the names the sandbox child exposes: ``model``,
``ifc``, ``ifcopenshell``, ``math``, ``statistics``, ``re``, ``json``,
``collections``, ``uuid`` - plus ``params``, which the runner prepends as
a ``json.loads`` preamble before the script body.
"""

from __future__ import annotations

import io
import json
import logging
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any, Optional

from app.core.config import BASE_DIR
from app.services.sandbox_service import sandbox_service

logger = logging.getLogger(__name__)


BUILTIN_PLUGIN_DIR = Path(__file__).resolve().parents[2] / "plugins_builtin"

PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
PARAM_TYPES = ("string", "number", "boolean")

# Mirrors code_runner.MAX_CODE_CHARS so the preamble + script always fits
# under the sandbox's own payload cap.
MAX_SCRIPT_CHARS = 100_000

MAX_PLUGIN_ZIP_BYTES = 1_000_000  # 1 MB upload cap for install-zip

# Decompressed per-member read cap - keeps a zip-bomb manifest/script from
# ballooning in memory before the char-count validation can reject it.
_MAX_ZIP_MEMBER_BYTES = 256_000

# Wall-clock budget per plugin run (seconds). Plugins are interactive
# batch helpers, not long jobs.
PLUGIN_RUN_TIMEOUT_S = 120.0

_MANIFEST_KEYS = {"id", "name", "description", "version", "params", "requires_write"}
_PARAM_KEYS = {"name", "label", "type", "default", "required"}


class PluginValidationError(ValueError):
    """Carries the full list of validation messages for a 422 response."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


# ----------------------------------------------------------------------
# Manifest / script / params validation
# ----------------------------------------------------------------------


def validate_manifest(manifest: Any) -> dict[str, Any]:
    """Validate and normalise a plugin manifest.

    Collects every problem before raising so the client sees the whole
    list at once. Returns the normalised manifest (defaults filled in).
    """
    if not isinstance(manifest, dict):
        raise PluginValidationError(["manifest: must be a JSON object"])

    errors: list[str] = []
    for key in manifest:
        if key not in _MANIFEST_KEYS:
            errors.append(f"manifest: unknown key '{key}'")

    plugin_id = manifest.get("id")
    if not isinstance(plugin_id, str) or not PLUGIN_ID_RE.match(plugin_id):
        errors.append("manifest: 'id' must match ^[a-z0-9][a-z0-9_-]{1,63}$")

    name = manifest.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("manifest: 'name' must be a non-empty string")

    description = manifest.get("description", "")
    if not isinstance(description, str):
        errors.append("manifest: 'description' must be a string")

    version = manifest.get("version", "1.0.0")
    if not isinstance(version, str) or not version.strip():
        errors.append("manifest: 'version' must be a non-empty string")

    requires_write = manifest.get("requires_write", False)
    if not isinstance(requires_write, bool):
        errors.append("manifest: 'requires_write' must be a boolean")

    raw_params = manifest.get("params", [])
    params: list[dict[str, Any]] = []
    if not isinstance(raw_params, list):
        errors.append("manifest: 'params' must be a list")
    else:
        seen_names: set[str] = set()
        for index, entry in enumerate(raw_params):
            normalised = _validate_param_entry(entry, index, seen_names, errors)
            if normalised is not None:
                params.append(normalised)

    if errors:
        raise PluginValidationError(errors)

    return {
        "id": plugin_id,
        "name": name.strip(),
        "description": description,
        "version": version.strip(),
        "params": params,
        "requires_write": requires_write,
    }


def _validate_param_entry(
    entry: Any, index: int, seen_names: set[str], errors: list[str]
) -> Optional[dict[str, Any]]:
    prefix = f"params[{index}]"
    if not isinstance(entry, dict):
        errors.append(f"{prefix}: must be an object")
        return None

    ok = True
    for key in entry:
        if key not in _PARAM_KEYS:
            errors.append(f"{prefix}: unknown key '{key}'")
            ok = False

    name = entry.get("name")
    if not isinstance(name, str) or not name.isidentifier():
        errors.append(f"{prefix}: 'name' must be a valid identifier")
        ok = False
    elif name in seen_names:
        errors.append(f"{prefix}: duplicate param name '{name}'")
        ok = False
    else:
        seen_names.add(name)

    param_type = entry.get("type")
    if param_type not in PARAM_TYPES:
        errors.append(f"{prefix}: 'type' must be one of string|number|boolean")
        ok = False

    label = entry.get("label", name if isinstance(name, str) else "")
    if not isinstance(label, str):
        errors.append(f"{prefix}: 'label' must be a string")
        ok = False

    required = entry.get("required", False)
    if not isinstance(required, bool):
        errors.append(f"{prefix}: 'required' must be a boolean")
        ok = False

    normalised: dict[str, Any] = {
        "name": name,
        "label": label,
        "type": param_type,
        "required": required,
    }

    if "default" in entry and param_type in PARAM_TYPES:
        default = entry["default"]
        if param_type == "string" and not isinstance(default, str):
            errors.append(f"{prefix}: 'default' must be a string")
            ok = False
        elif param_type == "number" and (
            isinstance(default, bool) or not isinstance(default, (int, float))
        ):
            errors.append(f"{prefix}: 'default' must be a number")
            ok = False
        elif param_type == "boolean" and not isinstance(default, bool):
            errors.append(f"{prefix}: 'default' must be a boolean")
            ok = False
        else:
            normalised["default"] = default

    return normalised if ok else None


def validate_script(script: Any) -> str:
    errors: list[str] = []
    if not isinstance(script, str) or not script.strip():
        errors.append("script: must be a non-empty string")
    elif len(script) > MAX_SCRIPT_CHARS:
        errors.append(f"script: exceeds {MAX_SCRIPT_CHARS} character cap")
    if errors:
        raise PluginValidationError(errors)
    return script


def validate_params(manifest: dict[str, Any], raw: Any) -> dict[str, Any]:
    """Coerce raw run params against the manifest's declarations.

    Unknown keys are rejected, missing required-without-default params are
    rejected, and string forms of numbers/booleans are coerced. Every
    problem is collected so the 422 detail lists them all.
    """
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise PluginValidationError(["params: must be an object"])

    declared = {p["name"]: p for p in manifest.get("params", [])}
    errors: list[str] = []

    for key in raw:
        if key not in declared:
            errors.append(f"param '{key}': unknown parameter")

    coerced: dict[str, Any] = {}
    for name, spec in declared.items():
        if name in raw:
            value, error = _coerce_param(raw[name], spec["type"], name)
            if error is not None:
                errors.append(error)
            else:
                coerced[name] = value
        elif "default" in spec:
            coerced[name] = spec["default"]
        elif spec["required"]:
            errors.append(f"param '{name}': required")

    if errors:
        raise PluginValidationError(errors)
    return coerced


def _coerce_param(
    value: Any, param_type: str, name: str
) -> tuple[Any, Optional[str]]:
    if param_type == "string":
        if isinstance(value, str):
            return value, None
        return None, f"param '{name}': expected string"

    if param_type == "number":
        if isinstance(value, bool):
            return None, f"param '{name}': expected number"
        if isinstance(value, (int, float)):
            return value, None
        if isinstance(value, str):
            text = value.strip()
            try:
                return int(text), None
            except ValueError:
                pass
            try:
                return float(text), None
            except ValueError:
                pass
        return None, f"param '{name}': expected number"

    # boolean
    if isinstance(value, bool):
        return value, None
    if isinstance(value, int) and value in (0, 1):
        return bool(value), None
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1"):
            return True, None
        if lowered in ("false", "0"):
            return False, None
    return None, f"param '{name}': expected boolean"


# ----------------------------------------------------------------------
# Service
# ----------------------------------------------------------------------


class PluginService:
    """Disk-backed registry of built-in and user plugins."""

    def __init__(
        self,
        builtin_dir: Optional[Path] = None,
        user_dir: Optional[Path] = None,
    ) -> None:
        self._builtin_dir = builtin_dir or BUILTIN_PLUGIN_DIR
        self._user_dir = user_dir or (BASE_DIR / "plugins")

    # -- discovery ------------------------------------------------------

    def list_plugins(self) -> list[dict[str, Any]]:
        """Manifests of every plugin, built-ins first, each with a ``builtin`` flag."""
        out: list[dict[str, Any]] = []
        for record in self._iter_records():
            out.append({**record["manifest"], "builtin": record["builtin"]})
        return out

    def get_plugin(self, plugin_id: str) -> dict[str, Any]:
        """Full record ``{"manifest", "script", "builtin"}``. KeyError when unknown."""
        record = self._load_record(self._builtin_dir, plugin_id, builtin=True)
        if record is None:
            record = self._load_record(self._user_dir, plugin_id, builtin=False)
        if record is None:
            raise KeyError(plugin_id)
        return record

    def builtin_ids(self) -> set[str]:
        ids: set[str] = set()
        if self._builtin_dir.is_dir():
            for child in self._builtin_dir.iterdir():
                if child.is_dir() and (child / "manifest.json").is_file():
                    ids.add(child.name)
        return ids

    # -- install / update / delete --------------------------------------

    def install(self, manifest: Any, script: Any) -> dict[str, Any]:
        """Persist a new user plugin. FileExistsError / PermissionError on id clash."""
        errors: list[str] = []
        validated: Optional[dict[str, Any]] = None
        try:
            validated = validate_manifest(manifest)
        except PluginValidationError as exc:
            errors.extend(exc.errors)
        try:
            validate_script(script)
        except PluginValidationError as exc:
            errors.extend(exc.errors)
        if errors or validated is None:
            raise PluginValidationError(errors)

        plugin_id = validated["id"]
        if plugin_id in self.builtin_ids():
            raise PermissionError(f"Plugin id '{plugin_id}' is reserved by a built-in")

        target = self._user_dir / plugin_id
        if target.exists():
            raise FileExistsError(f"Plugin '{plugin_id}' already exists")

        target.mkdir(parents=True, exist_ok=True)
        self._write_plugin_files(target, validated, script)
        return {**validated, "builtin": False}

    def install_zip(self, data: bytes) -> dict[str, Any]:
        """Install from a zip holding manifest.json + script.py at root or in one folder."""
        if len(data) > MAX_PLUGIN_ZIP_BYTES:
            raise PluginValidationError(
                [f"zip: exceeds {MAX_PLUGIN_ZIP_BYTES} byte size cap"]
            )
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise PluginValidationError(["zip: not a valid zip archive"]) from exc

        with archive:
            names = [
                info.filename.replace("\\", "/")
                for info in archive.infolist()
                if not info.is_dir()
            ]
            prefix = _find_plugin_prefix(names)
            if prefix is None:
                raise PluginValidationError(
                    [
                        "zip: must contain manifest.json and script.py at the "
                        "root or inside a single top-level folder"
                    ]
                )
            manifest_raw = _read_zip_member(archive, prefix + "manifest.json")
            script_raw = _read_zip_member(archive, prefix + "script.py")

        try:
            manifest = json.loads(manifest_raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PluginValidationError(
                [f"zip: manifest.json is not valid JSON ({exc})"]
            ) from exc
        try:
            script = script_raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PluginValidationError(["zip: script.py is not valid UTF-8"]) from exc

        return self.install(manifest, script)

    def update(
        self,
        plugin_id: str,
        manifest: Any = None,
        script: Any = None,
    ) -> dict[str, Any]:
        """Rewrite manifest and/or script of a user plugin. PermissionError for built-ins."""
        if plugin_id in self.builtin_ids():
            raise PermissionError("Built-in plugins are read-only")

        record = self._load_record(self._user_dir, plugin_id, builtin=False)
        if record is None:
            raise KeyError(plugin_id)

        new_manifest = record["manifest"]
        new_script = record["script"]
        errors: list[str] = []
        if manifest is not None:
            try:
                new_manifest = validate_manifest(manifest)
                if new_manifest["id"] != plugin_id:
                    errors.append("manifest: 'id' cannot be changed on update")
            except PluginValidationError as exc:
                errors.extend(exc.errors)
        if script is not None:
            try:
                new_script = validate_script(script)
            except PluginValidationError as exc:
                errors.extend(exc.errors)
        if errors:
            raise PluginValidationError(errors)

        self._write_plugin_files(self._user_dir / plugin_id, new_manifest, new_script)
        return {"manifest": new_manifest, "script": new_script, "builtin": False}

    def delete(self, plugin_id: str) -> None:
        """Remove a user plugin from disk. PermissionError for built-ins."""
        if plugin_id in self.builtin_ids():
            raise PermissionError("Built-in plugins are read-only")
        target = self._user_dir / plugin_id
        if not (target / "manifest.json").is_file():
            raise KeyError(plugin_id)
        shutil.rmtree(target)

    # -- run -------------------------------------------------------------

    def run(
        self,
        plugin_id: str,
        raw_params: Any,
        *,
        ifc_service: Any,
    ) -> dict[str, Any]:
        """Validate params, prepend the params preamble, run in the sandbox.

        Returns the sandbox result dict (execute_result / execute_error /
        pending_edit / ...) enriched with ``plugin_id`` + ``plugin_name``.
        """
        record = self.get_plugin(plugin_id)
        manifest = record["manifest"]
        params = validate_params(manifest, raw_params)

        # Double-json-encoding yields a Python string literal whose content
        # is the params JSON; json is already in the sandbox namespace.
        preamble = "params = json.loads(" + json.dumps(json.dumps(params)) + ")\n"
        code = preamble + record["script"]

        result = sandbox_service.execute_python(
            ifc_service=ifc_service,
            code=code,
            summary=f"Plugin: {manifest['name']}",
            timeout_s=PLUGIN_RUN_TIMEOUT_S,
            read_only=not manifest["requires_write"],
        )
        # The sandbox dict names the repr field "result"; the plugins API
        # documents it as "result_repr". Carry both so clients can rely on
        # the documented name without breaking sandbox passthrough.
        if "result" in result and "result_repr" not in result:
            result["result_repr"] = result["result"]
        result["plugin_id"] = manifest["id"]
        result["plugin_name"] = manifest["name"]
        return result

    # -- internals -------------------------------------------------------

    def _iter_records(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for root, builtin in ((self._builtin_dir, True), (self._user_dir, False)):
            if not root.is_dir():
                continue
            for child in sorted(root.iterdir(), key=lambda p: p.name):
                if not child.is_dir():
                    continue
                record = self._load_record(root, child.name, builtin=builtin)
                if record is not None:
                    records.append(record)
        return records

    def _load_record(
        self, root: Path, plugin_id: str, *, builtin: bool
    ) -> Optional[dict[str, Any]]:
        directory = root / plugin_id
        manifest_path = directory / "manifest.json"
        script_path = directory / "script.py"
        if not manifest_path.is_file() or not script_path.is_file():
            return None
        try:
            manifest = validate_manifest(
                json.loads(manifest_path.read_text(encoding="utf-8"))
            )
            script = script_path.read_text(encoding="utf-8")
        except (PluginValidationError, json.JSONDecodeError, OSError) as exc:
            logger.warning("Skipping unreadable plugin at %s: %s", directory, exc)
            return None
        if manifest["id"] != plugin_id:
            logger.warning(
                "Skipping plugin at %s: manifest id %r does not match folder name",
                directory,
                manifest["id"],
            )
            return None
        return {"manifest": manifest, "script": script, "builtin": builtin}

    def _write_plugin_files(
        self, directory: Path, manifest: dict[str, Any], script: str
    ) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
        )
        (directory / "script.py").write_text(script, encoding="utf-8")


def _find_plugin_prefix(names: list[str]) -> Optional[str]:
    """Locate manifest.json + script.py at the zip root or in one shared folder."""
    if "manifest.json" in names and "script.py" in names:
        return ""
    top_levels = {name.split("/", 1)[0] for name in names if "/" in name}
    if len(top_levels) == 1 and all("/" in name for name in names):
        folder = top_levels.pop()
        # The prefix is only ever used to look up exact archive member names,
        # never as a filesystem path; reject traversal-looking names anyway.
        if folder in ("", ".", "..") or folder.startswith(("/", "\\")):
            return None
        prefix = folder + "/"
        if prefix + "manifest.json" in names and prefix + "script.py" in names:
            return prefix
    return None


def _read_zip_member(archive: zipfile.ZipFile, name: str) -> bytes:
    info = archive.getinfo(name)
    if info.file_size > _MAX_ZIP_MEMBER_BYTES:
        raise PluginValidationError(
            [f"zip: {name} exceeds {_MAX_ZIP_MEMBER_BYTES} byte decompressed cap"]
        )
    return archive.read(name)


# Singleton
plugin_service = PluginService()
