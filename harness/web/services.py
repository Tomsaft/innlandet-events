"""Entur (geocoder, journey planner) and MET Norway (Yr forecast) clients.

Both are public, open-data APIs. Entur asks for an ET-Client-Name header;
MET asks for an identifying User-Agent with contact info and for clients to
cache until the Expires header. Nothing about the user is sent or stored:
only the chosen starting point, which the user typed or clicked.
"""
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests

GEOCODER = "https://api.entur.io/geocoder/v1/autocomplete"
JOURNEY = "https://api.entur.io/journey-planner/v3/graphql"
FORECAST = "https://api.met.no/weatherapi/locationforecast/2.0/compact"

TRIP_QUERY = """
query($from: Location!, $to: Location!, $dt: DateTime!, $n: Int!) {
  trip(from: $from, to: $to, dateTime: $dt, arriveBy: true, numTripPatterns: $n) {
    tripPatterns {
      expectedStartTime expectedEndTime duration walkDistance
      legs {
        mode distance expectedStartTime expectedEndTime
        fromPlace { name } toPlace { name }
        line { publicCode name }
      }
    }
  }
}
"""


class ServiceError(Exception):
    """An outside service failed or is not configured; shown to the user."""


class Entur:
    def __init__(self, client_name: str, focus: dict):
        self.s = requests.Session()
        self.s.headers["ET-Client-Name"] = client_name
        self.focus = focus

    def places(self, text: str, size: int = 6) -> list[dict]:
        try:
            r = self.s.get(GEOCODER, timeout=10, params={
                "text": text, "size": size, "lang": "no",
                "focus.point.lat": self.focus["lat"],
                "focus.point.lon": self.focus["lon"]})
            r.raise_for_status()
        except requests.RequestException as e:
            raise ServiceError(f"Entur geocoder: {e}") from e
        out = []
        for f in r.json().get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            out.append({"id": f["properties"]["id"], "name": f["properties"]["label"],
                        "lat": lat, "lon": lon})
        return out

    def trips(self, origin: dict, dest: dict, arrive_by: datetime, n: int) -> list[dict]:
        def location(p):
            loc = {"name": p["name"]}
            if str(p.get("id", "")).startswith("NSR:"):
                loc["place"] = p["id"]
            else:
                loc["coordinates"] = {"latitude": p["lat"], "longitude": p["lon"]}
            return loc

        variables = {"from": location(origin), "to": location(dest),
                     "dt": arrive_by.isoformat(), "n": n}
        try:
            r = self.s.post(JOURNEY, timeout=20,
                            json={"query": TRIP_QUERY, "variables": variables})
            r.raise_for_status()
            data = r.json()
        except (requests.RequestException, ValueError) as e:
            raise ServiceError(f"Entur journey planner: {e}") from e
        if data.get("errors"):
            raise ServiceError(f"Entur journey planner: {data['errors'][0].get('message')}")
        return data["data"]["trip"]["tripPatterns"]


class Yr:
    """MET Norway Locationforecast, cached per location until Expires."""

    def __init__(self):
        self.s = requests.Session()
        self._cache: dict[tuple, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def _forecast(self, lat: float, lon: float) -> dict:
        contact = os.environ.get("CRAWLER_CONTACT")
        if not contact:
            raise ServiceError("Weather is off: set CRAWLER_CONTACT before "
                               "`python run.py serve` (MET Norway requires contact info).")
        # MET terms: at most 4 decimals in coordinates.
        key = (round(lat, 4), round(lon, 4))
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
        try:
            r = self.s.get(FORECAST, timeout=10, params={"lat": key[0], "lon": key[1]},
                           headers={"User-Agent": "innlandet-events-student-project "
                                    f"(KIUA2003, University of Inland Norway; contact: {contact})"})
            r.raise_for_status()
            data = r.json()
        except (requests.RequestException, ValueError) as e:
            raise ServiceError(f"MET Norway: {e}") from e
        try:
            expires = parsedate_to_datetime(r.headers["Expires"]).timestamp()
        except (KeyError, TypeError, ValueError):
            expires = time.time() + 600
        with self._lock:
            self._cache[key] = (expires, data)
        return data

    def at(self, lat: float, lon: float, start: datetime, end: datetime) -> dict:
        """Forecast for the event: the slot nearest the start plus a strip around it."""
        series = self._forecast(lat, lon)["properties"]["timeseries"]
        now = datetime.now(timezone.utc)
        last = datetime.fromisoformat(series[-1]["time"])
        days = (start.date() - now.astimezone(start.tzinfo).date()).days
        if start > last + timedelta(hours=6):
            return {"available": False, "days_until": days,
                    "forecast_until": last.isoformat()}

        slots = []
        for t in series:
            when = datetime.fromisoformat(t["time"])
            nxt = t["data"].get("next_1_hours") or t["data"].get("next_6_hours") or {}
            slots.append({
                "time": when.isoformat(),
                "symbol": nxt.get("summary", {}).get("symbol_code", ""),
                "temp": t["data"]["instant"]["details"].get("air_temperature"),
                "wind": t["data"]["instant"]["details"].get("wind_speed"),
                "precip": nxt.get("details", {}).get("precipitation_amount"),
                "hours": 1 if "next_1_hours" in t["data"] else 6,
            })
        nearest = min(slots, key=lambda s: abs(datetime.fromisoformat(s["time"]) - start))
        lo, hi = start - timedelta(hours=3), max(end, start) + timedelta(hours=3)
        strip = [s for s in slots if lo <= datetime.fromisoformat(s["time"]) <= hi]
        # Our own rule of thumb from docs/plan.md, not an official MET scale.
        confidence = "high" if days <= 2 else "medium" if days <= 5 else "low"
        return {"available": True, "days_until": days, "confidence": confidence,
                "at_start": nearest, "strip": strip or [nearest]}
