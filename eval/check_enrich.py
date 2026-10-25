"""Acceptance check for task 002. Exit 0 = PASS, exit 1 = FAIL."""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVENTS = ROOT / "out" / "events.json"
RUN = ROOT / "out" / "run.json"
FIXTURE = ROOT / "fixtures" / "hamar_kommune.json"

# Independent copy on purpose: the check must not import what it checks.
CATEGORIES = {"concert", "theatre", "talk", "exhibition", "sports", "kids",
              "senior", "course", "market", "food_drink", "religious",
              "meeting", "workshop", "other"}
CANCELLED = re.compile(r"\b(avlyst|avlyses|cancelled|canceled)\b", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE = re.compile(r"\+47|(?<!\d)\d{8}(?!\d)|(?<!\d)\d{2}(?: \d{2}){3}(?!\d)")
YEAR = re.compile(r"\b20\d\d\b")

events = json.loads(EVENTS.read_text(encoding="utf-8"))
raw = {r["url"]: r for r in json.loads(FIXTURE.read_text(encoding="utf-8"))}
run = json.loads(RUN.read_text(encoding="utf-8"))
now = datetime.now(timezone.utc)

assert len(events) >= 5, f"expected >= 5 events, got {len(events)}"

for e in events:
    u = e["source_url"]
    assert u in raw, f"event not traceable to fixture: {u}"
    assert e["category"] in CATEGORIES, f"bad category {e['category']!r}: {u}"
    for k in ("summary_en", "summary_no"):
        assert isinstance(e[k], str) and e[k].strip(), f"empty {k}: {u}"
        assert not EMAIL.search(e[k]) and not PHONE.search(e[k]), f"PII in {k}: {u}"
    assert isinstance(e["student_fit"], int) and 0 <= e["student_fit"] <= 3, f"bad student_fit: {u}"

    end = datetime.fromisoformat(e["end"] or e["start"])
    assert end >= now, f"past event kept: {u} ({e['start']})"

    assert e["cancelled"] == bool(CANCELLED.search(e["title"])), f"cancelled flag wrong: {u}"

    # Faithfulness: a year in a summary must appear in the source text.
    r = raw[u]
    source = " ".join([r["title"], r["start"], r["description"], *r["schedule"]])
    for k in ("summary_en", "summary_no"):
        for y in YEAR.findall(e[k]):
            assert y in source, f"year {y} in {k} not in source: {u}"

assert run.get("model") and run.get("temperature") is not None, "run.json missing model/temperature"
assert run["budget"]["stop_reason"] is not None, "budget never stopped (stop_reason is None)"

print("PASS")