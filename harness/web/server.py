"""Demo web page: pick an event and a date, see how to get there and the weather.

Stdlib http.server only. Reads the pipeline's output (out/events_deduped.json)
and never writes files. Event descriptions are not sent to the browser,
because they can name contact people (CLAUDE.md: no personal data).
"""
import hashlib
import json
import threading
from datetime import datetime, time as dtime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml

from harness.web.services import Entur, ServiceError, Yr

STATIC = Path(__file__).parent / "static"
EVENT_FILES = [Path("out/events_deduped.json"), Path("out/events.json")]
FIXTURE = Path("fixtures/hamar_kommune.json")
CONTENT_TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                 ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                 ".webp": "image/webp"}


def event_id(e: dict) -> str:
    return hashlib.sha1(f"{e['source_url']}|{e['start']}".encode()).hexdigest()[:10]


def load_events() -> list[dict]:
    """Upcoming events from the newest pipeline output, soonest first."""
    path = next((p for p in EVENT_FILES if p.is_file()), None)
    if path is None:
        raise ServiceError("No events yet: run `python run.py all --offline --mock` first.")
    events = json.loads(path.read_text(encoding="utf-8"))
    addresses = {}
    if FIXTURE.is_file():
        for item in json.loads(FIXTURE.read_text(encoding="utf-8")):
            addresses[item["url"]] = item.get("address", "")

    now = datetime.now(timezone.utc)
    out = []
    for e in events:
        start = datetime.fromisoformat(e["start"])
        end = datetime.fromisoformat(e["end"]) if e.get("end") else start
        # Midnight starts come from date-only listings: the time is unknown.
        time_known = start.timetz().replace(tzinfo=None) != dtime(0, 0)
        if not time_known:
            end = max(end, start + timedelta(days=1))
        if end < now:
            continue
        out.append({
            "id": event_id(e), "title": e["title"], "start": e["start"],
            "end": e.get("end"), "time_known": time_known, "venue": e["venue"],
            "address": addresses.get(e["source_url"], ""),
            "municipality": e.get("municipality", ""), "category": e.get("category", ""),
            "cancelled": e.get("cancelled", False), "summary_en": e.get("summary_en", ""),
            "summary_no": e.get("summary_no", ""), "source_url": e["source_url"],
        })
    return sorted(out, key=lambda e: e["start"])


class App:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.entur = Entur(cfg["entur"]["client_name"], cfg["focus"])
        self.yr = Yr()
        self._places: dict[str, dict] = {}
        self._lock = threading.Lock()

    def event(self, eid: str) -> dict:
        for e in load_events():
            if e["id"] == eid:
                return e
        raise LookupError(eid)

    def venue_place(self, e: dict) -> dict:
        """Coordinates for the venue: manual fix, then Entur geocoder, then town centre."""
        manual = (self.cfg.get("venues") or {}).get(e["venue"])
        if manual:
            return {"name": e["venue"], "lat": manual[0], "lon": manual[1], "approximate": False}
        # Full addresses geocode well as they are; a bare venue name ("Teatersalen")
        # needs the town, or the geocoder may pick a namesake elsewhere in Norway.
        text = e["address"] or f"{e['venue']}, {e['municipality']}"
        with self._lock:
            if text in self._places:
                return self._places[text]
        try:
            hits = self.entur.places(text, size=1)
        except ServiceError:
            hits = []
        if hits:
            place = {"name": e["venue"], "lat": hits[0]["lat"], "lon": hits[0]["lon"],
                     "approximate": False}
        else:
            place = {"name": e["venue"], **self.cfg["focus"], "approximate": True}
        with self._lock:
            self._places[text] = place
        return place

    @staticmethod
    def when(e: dict, default_hour: int) -> tuple[datetime, datetime]:
        start = datetime.fromisoformat(e["start"])
        end = datetime.fromisoformat(e["end"]) if e["end"] else start
        if not e["time_known"]:
            start = start.replace(hour=default_hour)
            end = start
        return start, max(start, end)

    def trips(self, eid: str, origin: dict) -> dict:
        if not self.cfg["entur"]["enabled"]:
            raise ServiceError("Travel info is switched off (config/web.yaml).")
        e = self.event(eid)
        start, _ = self.when(e, 10)
        arrive = start - timedelta(minutes=self.cfg["entur"]["arrive_minutes_before"])
        dest = self.venue_place(e)
        patterns = self.entur.trips(origin, dest, arrive, self.cfg["entur"]["trips"])
        return {"arrive_by": arrive.isoformat(), "time_guessed": not e["time_known"],
                "venue": dest, "trips": patterns}

    def weather(self, eid: str) -> dict:
        if not self.cfg["yr"]["enabled"]:
            raise ServiceError("Weather is switched off (config/web.yaml).")
        e = self.event(eid)
        start, end = self.when(e, 12)
        place = self.venue_place(e)
        return {"venue": place, "time_guessed": not e["time_known"],
                **self.yr.at(place["lat"], place["lon"], start, end)}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # Log the path only: query strings can hold a typed starting point.
            print(f"{self.command} {urlparse(self.path).path} -> {args[1] if len(args) > 1 else ''}")

        def send(self, status: int, body: bytes, ctype: str):
            self.send_response(status)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def json(self, data, status: int = 200):
            self.send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"),
                      "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            parts = [p for p in url.path.split("/") if p]
            try:
                if not parts or parts == ["index.html"]:
                    return self.static("index.html")
                if parts[0] == "static" and len(parts) == 2:
                    return self.static(parts[1])
                if parts == ["api", "config"]:
                    return self.json({"origins": app.cfg["origins"],
                                      "entur": app.cfg["entur"]["enabled"],
                                      "yr": app.cfg["yr"]["enabled"]})
                if parts == ["api", "events"]:
                    return self.json(load_events())
                if parts == ["api", "places"]:
                    return self.json(app.entur.places(q.get("q", "")) if q.get("q") else [])
                if len(parts) == 4 and parts[:2] == ["api", "event"]:
                    if parts[3] == "weather":
                        return self.json(app.weather(parts[2]))
                    if parts[3] == "trips":
                        origin = {"id": q.get("id", ""), "name": q.get("name", "Start"),
                                  "lat": float(q["lat"]), "lon": float(q["lon"])}
                        return self.json(app.trips(parts[2], origin))
                self.json({"error": "not found"}, 404)
            except LookupError:
                self.json({"error": "unknown event"}, 404)
            except (KeyError, ValueError):
                self.json({"error": "bad request"}, 400)
            except ServiceError as e:
                self.json({"error": str(e)}, 502)

        def static(self, name: str):
            path = (STATIC / name).resolve()
            if path.parent != STATIC.resolve() or not path.is_file():
                return self.json({"error": "not found"}, 404)
            ctype = CONTENT_TYPES.get(path.suffix, "application/octet-stream")
            self.send(200, path.read_bytes(), ctype)

    return Handler


def serve(config_path: str, host: str, port: int):
    cfg = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
    server = ThreadingHTTPServer((host, port), make_handler(App(cfg)))
    print(f"Serving on http://{host}:{port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
