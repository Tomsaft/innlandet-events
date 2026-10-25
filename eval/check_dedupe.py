"""Acceptance check for task 003. Exit 0 = PASS, exit 1 = FAIL."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

SRC = ROOT / "out" / "events.json"
OUT = ROOT / "out" / "events_deduped.json"
REPORT = ROOT / "out" / "dedupe.json"

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(r"\+47|(?<!\d)\d{8}(?!\d)|(?<!\d)\d{2}(?: \d{2}){3}(?!\d)")


def norm(s):
    return " ".join(s.casefold().split())


def key(e):
    start = datetime.fromisoformat(e["start"]).astimezone(timezone.utc)
    return (norm(e["title"]), start, norm(e["venue"]))


def strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings(v)


# 1. Boundary cases on synthetic data (independent of the real fixtures)
from harness.stages.dedupe import dedupe  # noqa: E402

base = {"title": "Musikkbingo", "start": "2026-10-19T20:00:00+02:00",
        "venue": "Heim Hamar", "source_url": "u1"}
same_event = {**base, "title": "  musikkbingo ", "start": "2026-10-19T18:00:00+00:00",
              "source_url": "u2"}                     # same instant, other offset
other_date = {**base, "start": "2026-10-26T20:00:00+01:00", "source_url": "u3"}
other_venue = {**base, "venue": "Festiviteten", "source_url": "u4"}

result, report = dedupe([base, same_event, other_date, other_venue])
assert len(result) == 3, f"expected 3 after dedupe, got {len(result)}"
assert result[0]["source_url"] == "u1", "first occurrence must be kept"
assert [e["source_url"] for e in result] == ["u1", "u3", "u4"], "order or content wrong"
assert report["removed"] == 1, f"report.removed should be 1, got {report['removed']}"

# 2. Real data
src = json.loads(SRC.read_text(encoding="utf-8"))
out = json.loads(OUT.read_text(encoding="utf-8"))
rep = json.loads(REPORT.read_text(encoding="utf-8"))

assert len(src) >= 5, f"input too small: {len(src)}"
keys = [key(e) for e in out]
assert len(keys) == len(set(keys)), "duplicate keys remain in output"
assert len(out) == len({key(e) for e in src}), "over- or under-merged vs unique keys in input"
src_urls = {e["source_url"] for e in src}
assert all(e["source_url"] in src_urls for e in out), "output event not traceable to input"
assert rep["input"] == len(src) and rep["output"] == len(out), "report counts wrong"
assert rep["removed"] == len(src) - len(out), "report.removed wrong"

# 3. PII in every string field of the output
for e in out:
    for t in strings(e):
        assert not EMAIL.search(t), f"email in {e['source_url']}"
        assert not PHONE.search(t), f"phone-like number in {e['source_url']}"

print("PASS")