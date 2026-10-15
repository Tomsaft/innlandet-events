"""Acceptance check for task 001. Exit 0 = PASS, exit 1 = FAIL."""
import json
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "hamar_kommune.json"
RAW_DIR = ROOT / "fixtures" / "raw"
PREFIX = "https://www.hamar.kommune.no/kulturkalender/"

# Independent of harness/pii.py on purpose: this tests the redactor.
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE_PATTERNS = [
    re.compile(r"\+47"),
    re.compile(r"(?<!\d)\d{8}(?!\d)"),
    re.compile(r"(?<!\d)\d{2}(?: \d{2}){3}(?!\d)"),
    re.compile(r"(?<!\d)\d{3} \d{2} \d{3}(?!\d)"),
]

data = json.loads(FIXTURE.read_text(encoding="utf-8"))

assert len(data) >= 20, f"expected >= 20 items, got {len(data)}"

for it in data:
    assert it["title"].strip(), f"empty title: {it['url']}"
    assert it["url"].startswith(PREFIX), f"bad url: {it['url']}"
    assert it["source_id"] == "hamar_kommune", f"bad source_id: {it['url']}"
    dt = datetime.fromisoformat(it["start"])
    assert dt.tzinfo is not None, f"start has no timezone: {it['url']}"

venues = {it["venue"] for it in data}
assert "Teatersalen" in venues, f"known venue Teatersalen missing, got {sorted(venues)[:10]}"

for it in data:
    texts = [it["title"], it["venue"], it["address"], it["description"], *it["schedule"]]
    for t in texts:
        assert not EMAIL.search(t), f"email in {it['url']}: {EMAIL.search(t).group()}"
        for p in PHONE_PATTERNS:
            m = p.search(t)
            assert not m, f"phone-like '{m.group()}' in {it['url']}"

raw = list(RAW_DIR.glob("*.html"))
assert len(raw) >= 3, f"expected >= 3 raw html files in fixtures/raw, got {len(raw)}"
for f in raw:
    assert "key=AIza" not in f.read_text(encoding="utf-8"), f"API key left in {f.name}"

print("PASS")