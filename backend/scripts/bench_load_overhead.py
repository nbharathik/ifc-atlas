"""Measure the overhead the .working/ sidecar copy adds to IfcService.load().

The Save-As safety work made load() do a shutil.copy2 of the upload into a
hidden working file. This is unconditional, so it shows up on every cold and
warm semantic-backend load. Run this to confirm it stays well under the
2.5 s cold TTFR target on BasicHouse.

Reports both the copy time alone and the full load time, repeated 5x for
median stability. Excludes the first run as warm-up.
"""

import shutil
import sys
import tempfile
import time
from pathlib import Path
from statistics import median

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = REPO_ROOT / "backend"
FIXTURE = REPO_ROOT / "data" / "fixtures" / "BasicHouse.ifc"
if not FIXTURE.exists():
    alt = REPO_ROOT / "BasicHouse.ifc"
    if alt.exists():
        FIXTURE = alt

sys.path.insert(0, str(BACKEND_ROOT))


def main() -> int:
    if not FIXTURE.exists():
        print(f"FAIL: fixture not found at {FIXTURE}")
        return 1

    from app.services.ifc_service import IfcService

    runs = 6  # 1 warm-up + 5 measured
    copy_ms: list[float] = []
    load_ms: list[float] = []

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        upload = td_path / "BasicHouse.ifc"
        shutil.copy2(FIXTURE, upload)
        size_mb = upload.stat().st_size / (1024 * 1024)

        for i in range(runs):
            # Wipe the working file each iteration so the copy actually runs.
            working = upload.parent / ".working" / upload.name
            if working.exists():
                working.unlink()

            # Copy-only timing - re-run the same shutil.copy2 IfcService uses.
            working.parent.mkdir(parents=True, exist_ok=True)
            t0 = time.perf_counter()
            shutil.copy2(upload, working)
            copy_dt = (time.perf_counter() - t0) * 1000.0
            working.unlink()  # remove so IfcService.load actually re-copies

            # Full load timing (includes the same copy + ifcopenshell.open + caches).
            svc = IfcService()
            t1 = time.perf_counter()
            svc.load(upload)
            load_dt = (time.perf_counter() - t1) * 1000.0

            if i > 0:  # drop the warm-up run
                copy_ms.append(copy_dt)
                load_ms.append(load_dt)

    print(f"Fixture: {FIXTURE.name} ({size_mb:.1f} MB)")
    print(f"Runs: {len(load_ms)} measured (+ 1 warm-up dropped)")
    print()
    print(f"shutil.copy2 only:    min={min(copy_ms):7.2f} ms  median={median(copy_ms):7.2f} ms  max={max(copy_ms):7.2f} ms")
    print(f"IfcService.load full: min={min(load_ms):7.2f} ms  median={median(load_ms):7.2f} ms  max={max(load_ms):7.2f} ms")
    print()
    copy_share = median(copy_ms) / median(load_ms) * 100.0
    print(f"Copy overhead as share of full load: {copy_share:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
