import json
import re
from datetime import datetime, timezone

import requests

from harness.models import CATEGORIES, Event, RawItem

CANCELLED = re.compile(r"\b(avlyst|avlyses|cancelled|canceled)\b", re.I)

SYSTEM = f"""You help people in Innlandet, Norway, and visitors find local events (Norwegian and English).
You get one event as text. Reply with ONLY a JSON object with exactly these three keys:
- "category": one of {CATEGORIES}
- "summary_en": ONE English sentence, max 25 words
- "summary_no": the same sentence in Norwegian (bokmål), max 25 words
Rules: use only facts from the text. Do not invent dates, times, prices or names.
Do not copy the description. Do not include URLs.
Do not include phone numbers or email addresses.
Example reply:
{{"category": "concert", "summary_en": "A live concert at the venue.", "summary_no": "En konsert på stedet."}}"""

def build_messages(item: RawItem) -> list[dict]:
    user = (
        f"Title: {item.title}\nVenue: {item.venue}\nAddress: {item.address}\n"
        f"Start: {item.start}\nDescription: {item.description[:1200]}"
    )
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


def parse_reply(text: str) -> dict:
    """Validate the model reply. Raises ValueError if it is unusable."""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        d = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"not JSON: {e}") from None
    if not isinstance(d, dict):
        raise ValueError("JSON is not an object")
    if d.get("category") not in CATEGORIES:
        raise ValueError(f"bad category: {d.get('category')!r}")
    for k in ("summary_en", "summary_no"):
        if not isinstance(d.get(k), str) or not d[k].strip():
            raise ValueError(f"missing {k}")
        if len(d[k].split()) > 45:
            raise ValueError(f"{k} too long ({len(d[k].split())} words)")
        if "http" in d[k] or "www." in d[k]:
            raise ValueError(f"URL in {k}")
    return d


def is_past(item: RawItem, now: datetime) -> bool:
    return datetime.fromisoformat(item.end or item.start) < now


def enrich(items, client, model, temperature, budget, limit=None, now=None):
    now = now or datetime.now(timezone.utc)
    events, stats = [], {"past": 0, "failed": 0}
    for item in items:
        if limit is not None and len(events) >= limit:
            budget.stop("limit")
            break
        if is_past(item, now):
            stats["past"] += 1
            continue
        name = item.url.rsplit("/", 1)[1]
        reply = None
        for attempt in range(2):                      # one retry
            if budget.exhausted():
                break
            try:
                resp = client.chat(model, build_messages(item), temperature, json_mode=True)
            except (requests.exceptions.Timeout, requests.exceptions.HTTPError) as e:
                budget.record(turns=1)                # a failed call still costs a turn
                print(f"warn: {type(e).__name__} (attempt {attempt + 1}) for {name}")
                continue
            budget.record(turns=1, tokens=resp.tokens)
            try:
                reply = parse_reply(resp.text)
                break
            except ValueError as e:
                print(f"warn: attempt {attempt + 1} failed for {name}: {e}")
        if budget.stop_reason in ("max_turns", "max_tokens", "max_seconds") and reply is None:
            break
        if reply is None:
            stats["failed"] += 1
            continue
        events.append(Event(
            title=item.title, start=item.start, end=item.end, venue=item.venue,
            source_id=item.source_id, source_url=item.url, language=item.language,
            description=item.description,
            cancelled=bool(CANCELLED.search(item.title)),
            category=reply["category"], summary_en=reply["summary_en"].strip(),
            summary_no=reply["summary_no"].strip(),
        ))
    if budget.stop_reason is None:
        budget.stop("all_items_done")
    return events, stats