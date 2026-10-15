import json
import os
import re
import time
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

from harness.models import RawItem
from harness.pii import redact
from harness.sources.base import EventSource, FIXTURE_DIR
from harness.sources.sitemap import event_urls, fetch_sitemap_urls

BASE = "https://www.hamar.kommune.no"
SITEMAP_URL = BASE + "/sitemap.xml"
EVENT_PREFIX = BASE + "/kulturkalender/"
CRAWL_DELAY = 5.0  # robots.txt: Crawl-delay 5

# Hand-picked: normal series page, a cancelled event, a numbered recurring series.
RAW_PICKS = [
    EVENT_PREFIX + "juleteatret-2026-en-julefortelling-av-charles-dickens",
    EVENT_PREFIX + "avlyst-pa-grunn-av-sykdom-violet-road",
    EVENT_PREFIX + "musikkbingo-1",
]
RAW_DIR = FIXTURE_DIR / "raw"


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _find_event_jsonld(soup: BeautifulSoup) -> dict | None:
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.get_text())
        except json.JSONDecodeError:
            continue
        for obj in (data if isinstance(data, list) else [data]):
            if isinstance(obj, dict) and obj.get("@type") == "Event":
                return obj
    return None


def _language(raw: str) -> str:
    raw = (raw or "").lower()
    if raw.startswith(("no", "nb", "nn")):
        return "no"
    return raw[:2] or "no"


def parse_event_page(html: str, url: str, fetched_at: str | None = None) -> RawItem | None:
    """Pure function: HTML in, RawItem out. Testable offline on fixtures/raw/."""
    soup = BeautifulSoup(html, "html.parser")
    ld = _find_event_jsonld(soup)
    if not ld:
        return None
    title = _clean(ld.get("name") or "")
    start = ld.get("startDate")
    if not title or not start:
        return None

    loc = ld.get("location")
    venue = _clean(loc.get("name", "")) if isinstance(loc, dict) else ""

    addr_el = soup.select_one("span.address")
    address = _clean(addr_el.get_text(" ")) if addr_el else ""

    desc_el = soup.select_one('div.wysiwyg[itemprop="description"]')
    description = redact(desc_el.get_text("\n", strip=True)) if desc_el else ""

    schedule = []
    for row in soup.select("div.timetable tr"):
        tds = row.find_all("td")
        if tds:
            schedule.append(_clean(tds[0].get_text(" ")))

    return RawItem(
        source_id="hamar_kommune",
        url=url,
        fetched_at=fetched_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        title=redact(title),
        start=start,
        end=ld.get("endDate"),
        venue=redact(venue),
        address=redact(address),
        description=description,
        schedule=schedule,
        language=_language(ld.get("inLanguage", "")),
    )


def pick_sample(urls: list[str], max_pages: int) -> list[str]:
    """Hand-picked pages first, then evenly spaced pages for variety."""
    must = [u for u in RAW_PICKS if u in urls]
    rest = [u for u in urls if u not in must]
    n = max(max_pages - len(must), 0)
    if n and rest:
        step = max(len(rest) // n, 1)
        rest = rest[::step][:n]
    else:
        rest = []
    return must + rest


class HamarKommuneSource(EventSource):
    id = "hamar_kommune"

    def __init__(self, max_pages: int = 30):
        self.max_pages = max_pages

    def _session(self) -> requests.Session:
        contact = os.environ.get("CRAWLER_CONTACT")
        if not contact:
            raise RuntimeError(
                "Set CRAWLER_CONTACT (e.g. in PowerShell: "
                '$env:CRAWLER_CONTACT="your.name@example.com") so the site can reach us.'
            )
        s = requests.Session()
        s.headers["User-Agent"] = (
            f"innlandet-events-student-project (KIUA2003, University of Inland Norway; contact: {contact})"
        )
        return s

    def _get(self, session: requests.Session, url: str) -> str | None:
        resp = session.get(url, timeout=30)
        if resp.status_code in (403, 429, 503):
            raise RuntimeError(f"Stopping: HTTP {resp.status_code} from {url}")
        if resp.status_code != 200:
            print(f"warn: HTTP {resp.status_code} for {url}")
            return None
        return resp.content.decode("utf-8", errors="replace")  # avoid wrong guessed encoding

    def fetch_live(self) -> list[RawItem]:
        session = self._session()
        urls = event_urls(fetch_sitemap_urls(SITEMAP_URL, session), EVENT_PREFIX)
        sample = pick_sample(urls, self.max_pages)
        print(f"{len(urls)} event URLs in sitemap, fetching {len(sample)} (>= {CRAWL_DELAY}s apart)")

        RAW_DIR.mkdir(parents=True, exist_ok=True)
        items = []
        for i, url in enumerate(sample, 1):
            time.sleep(CRAWL_DELAY)
            html = self._get(session, url)
            if html is None:
                continue
            if url in RAW_PICKS:
                safe = re.sub(r"key=[A-Za-z0-9_\-]+", "key=REDACTED", html)  # Google Maps key
                (RAW_DIR / (url.rsplit("/", 1)[1] + ".html")).write_text(safe, encoding="utf-8")
            item = parse_event_page(html, url)
            if item:
                items.append(item)
            print(f"[{i}/{len(sample)}] {'ok  ' if item else 'skip'} {url.rsplit('/', 1)[1]}")
        return items