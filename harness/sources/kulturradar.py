"""Kulturradar (kulturradar.no): an event aggregator for Innlandet.

How the site works (checked 2026-11-18): Next.js App Router. A city page
(/city/<city>) carries the event list in its RSC payload (the
`self.__next_f.push([1, "..."])` script chunks), under the keys
`eventsFromPrisma` (single events) and `metaEventsFromPrisma` (series such
as "Juleteatret", each with its own dated sub-events). There is no JSON-LD
list on city pages. One city page holds the listings for the whole region,
so the crawl stops as soon as a city page adds no new events.

Event pages are /event/<slug>-<id> (or /event/<id> when there is no slug).
The sitemap lists them, so it is read once to get the exact URL of each id.

Rules (robots.txt, 2026-11-18: Disallow /api/, /arrangor, /admin; no
crawl-delay): never request /api/ (not even the /api/out/ ticket redirect
the site's own links use), /arrangor (organiser pages) or /admin; one request
at a time, at least REQUEST_DELAY seconds apart; same User-Agent with
CRAWLER_CONTACT as hamar_kommune. robots.txt is read once per run and every
URL, including each redirect target, must pass both its can_fetch and the
hard-coded deny list. --max-pages caps the sitemap + city page requests
(robots.txt and redirect hops not counted).
No explicit terms of use were found; /about says they collect no personal data.

No personal data: only id, slug, title, date, category, status, ticket link
and the venue's name, address and city are read. Never the free-text
description or subtitle (they name performers and contacts), never the
creator id, organiser or any person field. The description handed to
enrich is built from the title, category and venue only.
"""
import json
import re
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

from harness.models import RawItem
from harness.pii import redact
from harness.sources.base import EventSource, FIXTURE_DIR
from harness.sources.hamar_kommune import crawler_session
from harness.sources.sitemap import parse_sitemap
from harness.stages.match import oslo_local, to_aware

BASE = "https://kulturradar.no"
SITEMAP_URL = BASE + "/sitemap.xml"
ROBOTS_URL = BASE + "/robots.txt"
MAX_REDIRECTS = 3
EVENT_PREFIX = BASE + "/event/"
CITIES = ["hamar", "ringsaker", "lillehammer", "gjovik", "gudbrandsdalen",
          "osterdalen", "valdres"]
REQUEST_DELAY = 3.0                       # our own minimum; robots.txt sets none
FORBIDDEN = re.compile(r"^/(?:api(?:/|$)|arrangor|admin)", re.I)
KEEP_STATUS = {"PUBLISHED", "SOLDOUT"}
# Ticket links to these hosts can be personal profiles: not kept.
DROP_LINK_HOSTS = ("facebook.com", "instagram.com", "fb.me")
_ID_RE = re.compile(r"(c[a-z0-9]{24})$")  # cuid at the end of an event slug


def _clean(s) -> str:
    return " ".join(str(s or "").split())


def rsc_payload(html: str) -> str:
    """Concatenate the string parts of all self.__next_f.push([1, "..."]) chunks."""
    soup = BeautifulSoup(html, "html.parser")
    parts = []
    for tag in soup.find_all("script"):
        text = tag.get_text()
        if "self.__next_f.push(" not in text:
            continue
        start, end = text.find("(") + 1, text.rfind(")")
        try:
            arr = json.loads(text[start:end])
        except json.JSONDecodeError:
            continue
        if isinstance(arr, list) and len(arr) > 1 and arr[0] == 1 and isinstance(arr[1], str):
            parts.append(arr[1])
    return "".join(parts)


def _json_list(payload: str, key: str) -> list:
    """The JSON array after `"<key>":` in the payload, or [] if absent/bad."""
    i = payload.find(f'"{key}":')
    if i < 0:
        return []
    try:
        val, _ = json.JSONDecoder().raw_decode(payload, i + len(key) + 3)
    except json.JSONDecodeError:
        return []
    return val if isinstance(val, list) else []


def parse_city_page(html: str) -> list[dict]:
    """Pure function: city page HTML -> flat list of event dicts.

    Meta-event sub-events get the series' status and venue (they only carry
    the city themselves) and have no slug or ticket link.
    """
    payload = rsc_payload(html)
    events = [e for e in _json_list(payload, "eventsFromPrisma") if isinstance(e, dict)]
    for meta in _json_list(payload, "metaEventsFromPrisma"):
        if not isinstance(meta, dict):
            continue
        mvenue = meta.get("venue") or {}
        for sub in meta.get("events") or []:
            if not isinstance(sub, dict):
                continue
            city = (sub.get("venue") or {}).get("city") or mvenue.get("city")
            events.append({"id": sub.get("id"), "title": sub.get("title"),
                           "date": sub.get("date"), "category": sub.get("category"),
                           "status": meta.get("status"), "slug": None, "ticketUrl": None,
                           "venue": {**mvenue, "city": city}})
    return events


def _when(raw) -> str | None:
    """RSC date ("$D2026-12-04T17:00:00.000Z", UTC) -> ISO with the Oslo offset."""
    s = str(raw or "").removeprefix("$D").replace("Z", "+00:00")
    try:
        utc = datetime.fromisoformat(s)
    except ValueError:
        return None
    if utc.tzinfo is None:
        utc = utc.replace(tzinfo=timezone.utc)
    return to_aware(oslo_local(utc).replace(tzinfo=None)).isoformat()


def _city(raw) -> str:
    """'GJØVIK' -> 'Gjøvik', 'Tyinvegen 27 2900 Fagernes' -> 'Fagernes', 'Ukjent' -> ''."""
    c = _clean(raw)
    m = re.search(r"\b\d{4}\s+(\D+)$", c)
    if m:
        c = m.group(1).strip()
    if c.casefold() in {"ukjent", "unknown"}:
        return ""
    return c.title() if c.isupper() else c


def clean_link(url) -> str:
    """Ticket/source link without tracking params; '' if unusable or personal-profile host."""
    url = _clean(url)
    if not url:
        return ""
    parts = urlsplit(url)
    host = parts.netloc.casefold()
    if parts.scheme not in ("http", "https") or not host:
        return ""
    if any(host == h or host.endswith("." + h) for h in DROP_LINK_HOSTS):
        return ""
    if host.endswith("kulturradar.no") and FORBIDDEN.match(parts.path):
        return ""
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.casefold().startswith("utm_") and k.casefold() != "apikey"]
    return urlunsplit(parts._replace(query=urlencode(query), fragment=""))


def event_url(ev: dict, known: dict[str, str] | None = None) -> str:
    """The event's own kulturradar URL: from the sitemap if listed, else built."""
    eid = _clean(ev.get("id"))
    if known and eid in known:
        return known[eid]
    slug = _clean(ev.get("slug"))
    return f"{EVENT_PREFIX}{slug}-{eid}" if slug and slug != "None" else f"{EVENT_PREFIX}{eid}"


def parse_event(ev: dict, known_urls: dict[str, str] | None = None,
                fetched_at: str | None = None) -> RawItem | None:
    """Pure function: one event dict from the payload -> RawItem (None = skip).

    Skips unpublished and cancelled events. Reads only the fields listed in
    the module docstring.
    """
    status = _clean(ev.get("status")).upper()
    if status not in KEEP_STATUS or "cancel" in _clean(ev.get("sourceStatus")).casefold():
        return None
    title = _clean(ev.get("title"))
    start = _when(ev.get("date"))
    if not title or not start or not _clean(ev.get("id")):
        return None
    v = ev.get("venue") or {}
    venue = _clean(v.get("name"))
    city = _city(v.get("city"))
    street = _clean(v.get("address"))
    # No street = no address (the web page then geocodes "venue, municipality").
    address = street if not street or not city or city.casefold() in street.casefold()         else f"{street}, {city}"
    cats = ", ".join(_clean(c) for c in (ev.get("category") or []) if _clean(c))
    place = ", ".join(x for x in (venue, city) if x)
    parts = [title, f"Kategori: {cats}" if cats else "", f"Sted: {place}" if place else ""]
    return RawItem(
        source_id=KulturradarSource.id,
        url=event_url(ev, known_urls),
        fetched_at=fetched_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        title=redact(title),
        start=start,
        end=None,
        venue=redact(venue),
        address=redact(address),
        description=redact("\n".join(p for p in parts if p)),
        schedule=[],
        language="no",
        municipality=city,
        original_url=clean_link(ev.get("ticketUrl")),
    )


def disallow_first(lines: list[str]) -> list[str]:
    """urllib.robotparser applies the FIRST matching rule, so kulturradar's
    leading "Allow: /" would allow everything. Within each run of rule lines,
    put Disallow before Allow: any matching Disallow then wins (stricter than
    longest-match, never looser)."""
    out, run = [], []

    def flush():
        run.sort(key=lambda l: 0 if l.strip().lower().startswith("disallow") else 1)
        out.extend(run)
        run.clear()

    for line in lines:
        if line.strip().lower().startswith(("allow", "disallow")):
            run.append(line)
        else:
            flush()
            out.append(line)
    flush()
    return out


def sitemap_event_urls(xml_bytes: bytes) -> dict[str, str]:
    """{event id: event URL} from the sitemap's /event/ entries."""
    out = {}
    for u in parse_sitemap(xml_bytes):
        if not u.startswith(EVENT_PREFIX):
            continue
        m = _ID_RE.search(u[len(EVENT_PREFIX):])
        if m:
            out[m.group(1)] = u
    return out


class KulturradarSource(EventSource):
    id = "kulturradar"

    def __init__(self, cfg: dict | None = None, max_pages: int = 30):
        cfg = cfg or {}
        self.cities = list(cfg.get("cities") or CITIES)
        self.delay = max(float(cfg.get("request_delay_seconds", REQUEST_DELAY)), REQUEST_DELAY)
        self.max_pages = max_pages        # total requests, sitemap included
        self._last = 0.0
        self._robots: RobotFileParser | None = None

    def fetch(self, offline: bool = False) -> list[RawItem]:
        if offline and not (FIXTURE_DIR / f"{self.id}.json").is_file():
            return []
        return super().fetch(offline=offline)

    def _allowed(self, session: requests.Session, url: str) -> bool:
        """https on kulturradar.no only, never the hard-coded deny list, and
        (once robots.txt is loaded) robots.txt's own can_fetch."""
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != urlsplit(BASE).netloc:
            return False
        if FORBIDDEN.match(parts.path):
            return False
        if self._robots is not None:
            ua = session.headers.get("User-Agent", "*")
            return self._robots.can_fetch(ua, url)
        return url == ROBOTS_URL           # before robots.txt: only robots.txt itself

    def _load_robots(self, session: requests.Session):
        """Read /robots.txt once per run. Unreadable = do not crawl."""
        body = self._get(session, ROBOTS_URL)
        if body is None:
            raise RuntimeError("robots.txt not readable; not crawling")
        rp = RobotFileParser()
        rp.parse(disallow_first(body.decode("utf-8", errors="replace").splitlines()))
        self._robots = rp

    def _get(self, session: requests.Session, url: str, hops: int = 0) -> bytes | None:
        """One polite request. Redirects are not followed automatically: each
        Location goes back through _get (checked and delayed again), at most
        MAX_REDIRECTS hops."""
        parts = urlsplit(url)
        if not self._allowed(session, url):
            raise RuntimeError(f"refusing to fetch disallowed URL {parts.netloc}{parts.path}")
        wait = self._last + self.delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            resp = session.get(url, timeout=60, allow_redirects=False)
        finally:
            self._last = time.monotonic()
        if resp.status_code in (403, 429, 503):
            raise RuntimeError(f"Stopping: HTTP {resp.status_code} from {parts.path}")
        if 300 <= resp.status_code < 400:
            loc = resp.headers.get("Location")
            if not loc:
                print(f"kulturradar: warn: HTTP {resp.status_code} without Location for {parts.path}")
                return None
            if hops >= MAX_REDIRECTS:
                raise RuntimeError(f"too many redirects from {parts.path}")
            return self._get(session, urljoin(url, loc), hops + 1)
        if resp.status_code != 200:
            print(f"kulturradar: warn: HTTP {resp.status_code} for {parts.path}")
            return None
        return resp.content

    def fetch_live(self) -> list[RawItem]:
        session = crawler_session()
        self._load_robots(session)         # one extra request, not counted in --max-pages
        budget = self.max_pages
        known: dict[str, str] = {}
        if budget >= 2:                    # leave at least one request for a city page
            xml = self._get(session, SITEMAP_URL)
            budget -= 1
            if xml:
                try:
                    known = sitemap_event_urls(xml)
                except Exception as e:     # bad XML: build URLs from slug + id instead
                    print(f"kulturradar: sitemap unreadable ({type(e).__name__})")
            print(f"kulturradar: {len(known)} event URLs in sitemap")
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        seen: dict[str, RawItem] = {}
        for city in self.cities:
            if budget <= 0:
                print("kulturradar: --max-pages reached")
                break
            body = self._get(session, f"{BASE}/city/{city}")
            budget -= 1
            if body is None:
                continue
            raw = parse_city_page(body.decode("utf-8", errors="replace"))
            new = 0
            for ev in raw:
                eid = _clean(ev.get("id"))
                if not eid or eid in seen:
                    continue
                item = parse_event(ev, known, fetched_at)
                if item:
                    seen[eid] = item
                    new += 1
            print(f"kulturradar: /city/{city}: {len(raw)} listed, {new} new")
            if raw and new == 0:           # the page repeats the region-wide list
                print("kulturradar: no new events, stopping (city pages share one list)")
                break
        if not seen:
            raise RuntimeError("no events parsed (page layout may have changed)")
        return sorted(seen.values(), key=lambda it: (it.start, it.url))
