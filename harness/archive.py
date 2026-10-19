import shutil
from datetime import datetime
from pathlib import Path

ARCHIVE_DIR = Path("archive")


def run_stamp(command: str) -> str:
    """One folder name per run, e.g. 2026-10-19_101500_enrich."""
    return f"{datetime.now():%Y-%m-%d_%H%M%S}_{command}"


def keep(paths, stamp: str, move: bool = True) -> list[Path]:
    """Save files that a run is about to replace into archive/<stamp>/.

    Nothing is ever deleted: old outputs and fixtures stay readable there.
    Outputs are moved, so a crashed run cannot leave a stale out/events.json
    behind for eval/ to pass on. Inputs (fixtures) are copied (move=False),
    so a failed live fetch still leaves something to run offline on.
    """
    moved = []
    for p in map(Path, paths):
        if not p.is_file():
            continue
        dest = ARCHIVE_DIR / stamp / p
        dest.parent.mkdir(parents=True, exist_ok=True)
        if move:
            shutil.move(p, dest)
        else:
            shutil.copy2(p, dest)
        moved.append(dest)
    return moved
