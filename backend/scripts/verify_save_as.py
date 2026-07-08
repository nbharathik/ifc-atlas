"""End-to-end verification of the safe-edit + Save-As flow.

Run from the repo root with:
    python backend/scripts/verify_save_as.py

Loads BasicHouse.ifc, applies a rename through the public edit API, runs
save_as() to a temp file, and verifies the original on disk is byte-identical
before and after. Designed to catch the "edits silently overwrite the upload"
regression that the new working-copy code path is supposed to prevent.

Exits non-zero on any failure.
"""

import hashlib
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
FIXTURE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"

# Fallback fixture location (older layout used the repo root directly).
if not FIXTURE.exists():
    alt = REPO_ROOT / "BasicHouse.ifc"
    if alt.exists():
        FIXTURE = alt

sys.path.insert(0, str(BACKEND_ROOT))


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def main() -> int:
    if not FIXTURE.exists():
        print(f"FAIL: fixture not found at {FIXTURE}")
        return 1

    from app.models.ifc_models import EditApplyRequest, EditOperation
    from app.services.ifc_service import IfcService

    # Copy fixture into a temp dir so we can watch the "upload" path's SHA.
    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        upload = td_path / "BasicHouse.ifc"
        shutil.copy2(FIXTURE, upload)
        upload_sha_before = sha256(upload)

        svc = IfcService()
        svc.load(upload)

        # ---1. load() must materialise a working copy distinct from the upload.
        assert svc.original_path == upload, (
            f"original_path={svc.original_path} != upload={upload}"
        )
        assert svc._file_path is not None and svc._file_path != upload, (
            f"_file_path={svc._file_path} should be a sidecar working file"
        )
        assert svc._file_path.exists(), "working file should exist on disk"
        assert ".working" in str(svc._file_path), (
            f"working file should live under .working/: {svc._file_path}"
        )
        assert svc.dirty is False, "dirty must be False right after load"
        print(f"[ok] working copy created at {svc._file_path}")

        # ---2. apply an edit and verify the model actually mutates.
        walls = svc.model.by_type("IfcWall")
        if not walls:
            print("FAIL: no IfcWall entities in fixture")
            return 1
        target = walls[0]
        original_name = target.Name
        new_name = "VERIFIED_RENAME_TEST"
        req = EditApplyRequest(
            base_model_version=svc.model_version,
            operations=[EditOperation(op="set_name", express_id=target.id(), value=new_name)],
        )
        resp = svc.apply_edits(req)
        assert resp.status == "accepted", f"edit rejected: {resp.message}"
        assert svc.model.by_id(target.id()).Name == new_name, "in-memory name not updated"
        print(f"[ok] edit applied: wall #{target.id()} '{original_name}' ->'{new_name}'")

        # ---3. dirty flag flipped + original on disk unchanged.
        assert svc.dirty is True, "dirty must be True after persisted edit"
        upload_sha_after_edit = sha256(upload)
        assert upload_sha_before == upload_sha_after_edit, (
            "ORIGINAL UPLOAD WAS OVERWRITTEN - safety guarantee broken"
        )
        print(f"[ok] original SHA unchanged after edit: {upload_sha_before[:16]}...")

        # ---4. save_as() drops a clean copy elsewhere without touching either file.
        export = td_path / "BasicHouse_edited.ifc"
        svc.save_as(export)
        assert export.exists(), "save_as did not write the file"
        export_sha = sha256(export)
        assert export_sha != upload_sha_before, (
            "exported file is bit-identical to the original - edit didn't survive export"
        )
        # Reload the export to confirm IfcOpenShell can read it back.
        import ifcopenshell
        roundtrip = ifcopenshell.open(str(export))
        assert roundtrip.by_id(target.id()).Name == new_name, (
            "edit didn't survive serialise ->re-open round trip"
        )
        print(f"[ok] save_as wrote a clean edited copy at {export}")

        # ---5. mark_clean clears the dirty flag (used by /save-as/ack).
        svc.mark_clean()
        assert svc.dirty is False, "mark_clean did not reset dirty"
        print("[ok] mark_clean reset dirty flag")

        # ---6. final sanity check on the original.
        upload_sha_final = sha256(upload)
        assert upload_sha_before == upload_sha_final, (
            "ORIGINAL UPLOAD WAS MUTATED somewhere in the flow"
        )
        print(f"[ok] original SHA still unchanged at end: {upload_sha_final[:16]}...")

        # --- 7. sandbox-style reload also flips dirty when fingerprint diverges.
        # Mirrors what `_apply_pending_edit_locked` does after an LLM
        # tool-driven edit lands: writes the model + calls reload_after_sandbox.
        svc.mark_clean()
        assert svc.dirty is False
        walls = svc.model.by_type("IfcWall")
        walls[0].Name = "SANDBOX_PATH_RENAME"
        svc.model.write(str(svc._file_path))
        svc.reload_after_sandbox(edit_id="verify_sandbox")
        assert svc.dirty is True, (
            "reload_after_sandbox must flip dirty when working != original"
        )
        print("[ok] sandbox-path reload correctly flagged dirty=True")

    print("\nALL CHECKS PASSED -- Save-As edit safety verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
