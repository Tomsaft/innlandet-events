"""Ticketmaster events in Innlandet, via the official Discovery API v2.

Never scrapes ticketmaster.no (their terms forbid it); only the documented
API at app.ticketmaster.com. The API key comes from TICKETMASTER_API_KEY and
is never written anywhere: it is only put on the outgoing request, request
errors are re-raised without the URL, and `apikey` is stripped from every
stored link.

Coverage: one geoPoint (geohash) + radius query per town in the
`ticketmaster.points` list of config/pipeline.yaml. Results are merged and
de-duplicated by Ticketmaster event id.

No personal data: performers (`_embedded.attractions`), promoters and any
other person fields are never read. Description = info + pleaseNote with
Free text (info, pleaseNote) is never kept either: the description given to
enrich is built only from the name, classification and venue.

Only venues in Innlandet are kept (`require_state`): by `state.name` when the
API gives one, else by postal code (Innlandet ranges below).
"""
import json
import os
import time
from datetime import datetime, time as dtime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests

from harness.models import RawItem
from harness.pii import redact
from harness.sources.base import EventSource, FIXTURE_DIR
from harness.stages.match import oslo_local, to_aware

API_URL = "https://app.ticketmaster.com/discovery/v2/events.json"
KEY_ENV = "TICKETMASTER_API_KEY"
USER_AGENT = "innlandet-events-student-project (KIUA2003, University of Inland Norway)"
DEEP_PAGING_LIMIT = 1000          # API rule: size * page must stay below 1000
# Innlandet postal codes, used only when a venue has no state.name: Odal
# (2100-2134) and 2200-2999, minus Lunner (2715-2743, Akershus since 2024).
# 20xx and the rest of 21xx are Akershus; Innlandet has no 3xxx codes.
INNLANDET_POSTAL = [(2100, 2134), (2200, 2714), (2744, 2999)]

_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lon: float, precision: int = 7) -> str:
    """Standard geohash (base32, interleaved lon/lat bits). Stdlib only."""
    lat_r, lon_r = [-90.0, 90.0], [-180.0, 180.0]
    out, bits, ch, even = [], 0, 0, True
    while len(out) < precision:
        rng, val = (lon_r, lon) if even else (lat_r, lat)
        mid = (rng[0] + rng[1]) / 2
        if val >= mid:
            ch = (ch << 1) | 1
            rng[0] = mid
        else:
            ch <<= 1
            rng[1] = mid
        even = not even
        bits += 1
        if bits == 5:
            out.append(_B32[ch])
            bits, ch = 0, 0
    return "".join(out)


def strip_apikey(url: str) -> str:
    """Remove any apikey query parameter (any case) from a link before storing it."""
    if not url:
        return ""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if k.casefold() != "apikey"]
    return urlunsplit(parts._replace(query=urlencode(query)))


def _clean(s) -> str:
    return " ".join(str(s or "").split())


def _when(d: dict | None, end_of_day: bool = False) -> tuple[str | None, bool]:
    """(ISO start with Oslo offset, time_known) from a dates.start/dates.end block.

    Like hamar_kommune, a date-only listing gets a midnight start, which the
    pipeline and web page read as "time unknown". For an end without a time,
    end_of_day gives 23:59 instead, so the event is not treated as past early.
    """
    if not d or d.get("dateTBA") or d.get("dateTBD"):
        return None, False
    no_time = d.get("timeTBA") or d.get("noSpecificTime")
    local_date, local_time = d.get("localDate"), d.get("localTime")
    def oslo():  # dateTime (UTC) as Oslo wall time; only parsed when needed
        utc = datetime.fromisoformat(d["dateTime"].replace("Z", "+00:00"))
        return oslo_local(utc).replace(tzinfo=None)

    if not no_time:
        if local_date and local_time:
            return to_aware(datetime.fromisoformat(f"{local_date}T{local_time}")).isoformat(), True
        if d.get("dateTime"):
            return to_aware(oslo()).isoformat(), True
    if local_date:
        day = datetime.fromisoformat(local_date).date()
    else:
        day = oslo().date() if d.get("dateTime") else None
    if day:                                    # date only: time unknown
        t = dtime(23, 59) if end_of_day else dtime(0, 0)
        return to_aware(datetime.combine(day, t)).isoformat(), False
    return None, False


def in_region(venue: dict, states: list[str]) -> bool:
    """True if the venue is in the wanted region: state.name first, else postal code."""
    if not states:
        return True
    state = _clean((venue.get("state") or {}).get("name"))
    if state:
        return state.casefold() in {s.casefold() for s in states}
    code = _clean(venue.get("postalCode"))
    if not (code.isdigit() and len(code) == 4):
        return False
    return any(lo <= int(code) <= hi for lo, hi in INNLANDET_POSTAL)


def _classification(ev: dict) -> str:
    """'Music / Rock' from the primary classification (segment / genre / subGenre)."""
    cls = ev.get("classifications") or []
    c = next((c for c in cls if c.get("primary")), cls[0] if cls else {})
    names = []
    for k in ("segment", "genre", "subGenre"):
        n = _clean((c.get(k) or {}).get("name"))
        if n and n.casefold() != "undefined" and n not in names:
            names.append(n)
    return " / ".join(names)


def parse_event(ev: dict, fetched_at: str | None = None,
                fallback_city: str = "") -> RawItem | None:
    """Pure function: one Discovery API event in, RawItem out (None = skip).

    Skips cancelled events (dates.status.code == "cancelled") and events
    without a usable date. Reads only the fields listed here; never
    attractions, promoter, info, pleaseNote or other person/free-text fields.
    `fallback_city` (the query point's name) is used when the venue has no city.
    """
    dates = ev.get("dates") or {}
    if ((dates.get("status") or {}).get("code") or "").casefold() == "cancelled":
        return None
    title = _clean(ev.get("name"))
    url = strip_apikey(ev.get("url") or "")
    start, _ = _when(dates.get("start"))
    if not title or not url or not start:
        return None
    end, _ = _when(dates.get("end"), end_of_day=True)
    if end and datetime.fromisoformat(end) <= datetime.fromisoformat(start):
        end = None

    venues = (ev.get("_embedded") or {}).get("venues") or []
    v = venues[0] if venues else {}
    city = _clean((v.get("city") or {}).get("name")) or _clean(fallback_city)
    line1 = _clean((v.get("address") or {}).get("line1"))
    town = " ".join(x for x in (_clean(v.get("postalCode")), city) if x)
    address = ", ".join(x for x in (line1, town) if x)

    venue_name = _clean(v.get("name"))
    cls = _classification(ev)
    place = ", ".join(x for x in (venue_name, city) if x)
    parts = [title, f"Kategori: {cls}" if cls else "", f"Sted: {place}" if place else ""]
    description = redact("\n".join(p for p in parts if p))

    return RawItem(
        source_id="ticketmaster",
        url=url,
        fetched_at=fetched_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        title=redact(title),
        start=start,
        end=end,
        venue=redact(venue_name),
        address=redact(address),
        description=description,
        schedule=[],
        language="no",
        municipality=city,
    )


class TicketmasterSource(EventSource):
    id = "ticketmaster"

    def __init__(self, cfg: dict | None = None, max_pages: int = 30):
        cfg = cfg or {}
        self.points = cfg.get("points") or []
        self.radius_km = int(cfg.get("radius_km", 40))
        self.page_size = int(cfg.get("page_size", 50))
        self.delay = float(cfg.get("request_delay_seconds", 0.25))
        self.max_pages = max_pages        # per geoPoint
        st = cfg.get("require_state")
        self.states = ([st] if isinstance(st, str) else list(st or [])) + \
            list(cfg.get("state_aliases") or [])

    @staticmethod
    def has_key() -> bool:
        return bool(os.environ.get(KEY_ENV))

    def fetch(self, offline: bool = False) -> list[RawItem]:
        if offline and not (FIXTURE_DIR / f"{self.id}.json").is_file():
            return []
        return super().fetch(offline=offline)

    def _get(self, session: requests.Session, params: dict) -> dict | None:
        """One API call. Errors never include the URL (it carries the key)."""
        try:
            resp = session.get(API_URL, params={**params, "apikey": os.environ[KEY_ENV]},
                               timeout=30)
        except requests.RequestException as e:
            raise RuntimeError(f"Ticketmaster request failed ({type(e).__name__})") from None
        if resp.status_code == 401:
            raise RuntimeError("Ticketmaster rejected the API key (HTTP 401)")
        if resp.status_code in (403, 429, 503):
            raise RuntimeError(f"Stopping: HTTP {resp.status_code} from Ticketmaster")
        if resp.status_code != 200:
            print(f"warn: HTTP {resp.status_code} from Ticketmaster for {params.get('geoPoint')}")
            return None
        try:
            return json.loads(resp.content.decode("utf-8", errors="replace"))
        except ValueError:
            print(f"warn: bad JSON from Ticketmaster for {params.get('geoPoint')}")
            return None

    def fetch_live(self) -> list[RawItem]:
        if not self.has_key():
            raise RuntimeError(f"{KEY_ENV} is not set")
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
        # Start of today in Oslo, so events that began earlier today are kept.
        today = oslo_local(datetime.now(timezone.utc)).date()
        since = to_aware(datetime.combine(today, dtime(0, 0))).astimezone(timezone.utc)
        base = {"countryCode": "NO", "locale": "*", "sort": "date,asc",
                "startDateTime": since.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "radius": self.radius_km, "unit": "km", "size": self.page_size}
        seen, items, calls, outside, bad = set(), [], 0, 0, 0
        for p in self.points:
            try:
                gh = geohash(float(p["lat"]), float(p["lon"]))
            except (KeyError, TypeError, ValueError):
                print(f"warn: ticketmaster point {p!r} has no valid lat/lon, skipped")
                continue
            page, total_pages = 0, 1
            while page < min(total_pages, self.max_pages) and \
                    (page + 1) * self.page_size <= DEEP_PAGING_LIMIT:
                if calls:
                    time.sleep(self.delay)       # limit is 5 req/s; stay well under
                calls += 1
                data = self._get(session, {**base, "geoPoint": gh, "page": page})
                if data is None:
                    break
                total_pages = int((data.get("page") or {}).get("totalPages") or 0)
                events = (data.get("_embedded") or {}).get("events") or []
                new = 0
                for ev in events:
                    if not ev.get("id") or ev["id"] in seen:
                        continue
                    seen.add(ev["id"])
                    try:
                        venues = (ev.get("_embedded") or {}).get("venues") or [{}]
                        if not in_region(venues[0], self.states):
                            outside += 1
                            continue
                        item = parse_event(ev, fallback_city=str(p.get("name") or ""))
                    except (ValueError, TypeError, KeyError, AttributeError, IndexError):
                        bad += 1
                        continue
                    if item:
                        items.append(item)
                        new += 1
                print(f"[{p.get('name', gh)} p{page}] {len(events)} events, {new} new")
                page += 1
        print(f"{calls} Ticketmaster API calls, {len(items)} items, "
              f"{outside} outside {'/'.join(self.states) or 'region'}, {bad} unparsable")
        return items
