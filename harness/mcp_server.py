"""Read-only MCP (Model Context Protocol) server for Beveg: `python run.py mcp`.

Lets AI assistants such as Claude Desktop search the upcoming events in
Innlandet and ask for the weather (Yr / MET Norway) and public transport
(Entur) for one of them. It reuses the demo web page's code
(`harness.web.server`: `load_events`, `event_id`, `App.trips`, `App.weather`
and the Entur places lookup), so the tools return what the HTTP API returns.

Transport: stdio, JSON-RPC 2.0, one UTF-8 JSON message per line. Only
protocol messages go to stdout; all logging goes to stderr.

Rules (CLAUDE.md):
- No LLM calls are made here, so `Budget` does not apply.
- It reads `out/`, `fixtures/` and the web config and writes no files, so
  `harness.archive.keep` does not apply.
- No personal data: event descriptions, performers, contacts and organiser
  people are never returned; only the fields listed in `EVENT_FIELDS`.
  Tool arguments (which can hold a typed starting point) are not logged.
"""
import json
import os
import sys
import traceback
from datetime import date
from pathlib import Path

import yaml

from harness.models import CATEGORIES
from harness.web.server import App, load_events
from harness.web.services import ServiceError

SERVER_INFO = {"name": "beveg", "version": "0.1.0"}
PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]
INSTRUCTIONS = (
    "Beveg: upcoming public events in Innlandet, Norway (starting with Hamar), "
    "for youth (13-21), pensioners (67+) and everyone else. Use search_events to "
    "find events, then event_weather and event_trips with an event id for the "
    "forecast at the venue and public transport there. list_origins gives the "
    "fixed starting points. Read-only.")
EVENT_FIELDS = ["id", "title", "start", "end", "venue", "municipality", "category",
                "summary", "cancelled", "source_url"]

TOOLS = [
    {
        "name": "search_events",
        "description": (
            "Search upcoming public events in Innlandet (Hamar first), soonest first. "
            "All filters are optional and combined. `query` matches title, venue, "
            "municipality and summary (case-insensitive). `date_from`/`date_to` "
            "(YYYY-MM-DD, inclusive) keep events that are running on any day in the "
            "range. Returns id, title, start, end, venue, municipality, category, "
            "summary {en, no}, cancelled and source_url. Use the id with "
            "event_weather and event_trips."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Free-text search."},
                "date_from": {"type": "string", "format": "date",
                              "description": "First day, YYYY-MM-DD."},
                "date_to": {"type": "string", "format": "date",
                            "description": "Last day, YYYY-MM-DD."},
                "category": {"type": "string", "enum": CATEGORIES,
                             "description": "Event category."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10,
                          "description": "Max events to return (1-50, default 10)."},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "event_weather",
        "description": (
            "Weather forecast (Yr / MET Norway) at the venue of one event, for its "
            "start time. Only available when the event is inside MET's forecast "
            "(about 10 days ahead); otherwise `available` is false. Includes a "
            "confidence marker (our own rule of thumb) and `time_guessed` when the "
            "event has no start time."),
        "inputSchema": {
            "type": "object",
            "properties": {"event_id": {"type": "string",
                                        "description": "Event id from search_events."}},
            "required": ["event_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "event_trips",
        "description": (
            "Public transport (Entur) to one event, arriving 10 minutes before it "
            "starts. `origin` is the name of a configured starting point (see "
            "list_origins; case-insensitive) or any stop/address in Norway, which is "
            "looked up with Entur's place search (first hit). Without `origin`, the "
            "first configured starting point is used."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "event_id": {"type": "string", "description": "Event id from search_events."},
                "origin": {"type": "string", "description": "Starting point name or address."},
            },
            "required": ["event_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_origins",
        "description": "The fixed starting points for event_trips (id, name, lat, lon).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
]
TOOL_SCHEMAS = {t["name"]: t["inputSchema"] for t in TOOLS}


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


class ToolError(Exception):
    """A tool failed in an expected way: returned as isError, not a crash."""


def log(msg: str):
    print(f"[beveg-mcp] {msg}", file=sys.stderr, flush=True)


def log_exception(where: str, exc: BaseException):
    """Exception type and stack frames only: messages can echo tool arguments."""
    frames = "".join(traceback.format_tb(exc.__traceback__))
    log(f"{where}: internal error {type(exc).__name__}\n{frames}")


def check_args(name: str, args: dict):
    """Minimal JSON Schema check for our flat schemas; raises -32602."""
    schema = TOOL_SCHEMAS[name]
    props = schema["properties"]
    for key in schema.get("required", []):
        if key not in args:
            raise RpcError(-32602, f"{name}: missing required argument '{key}'")
    for key, value in args.items():
        if key not in props:
            raise RpcError(-32602, f"{name}: unknown argument '{key}'")
        spec = props[key]
        if spec["type"] == "string" and not isinstance(value, str):
            raise RpcError(-32602, f"{name}: '{key}' must be a string")
        if spec["type"] == "integer" and (isinstance(value, bool) or not isinstance(value, int)):
            raise RpcError(-32602, f"{name}: '{key}' must be an integer")
        if "enum" in spec and value not in spec["enum"]:
            raise RpcError(-32602, f"{name}: '{key}' must be one of {spec['enum']}")
        if spec.get("format") == "date":
            try:
                date.fromisoformat(value)
            except ValueError:
                raise RpcError(-32602, f"{name}: '{key}' must be YYYY-MM-DD") from None


def public_event(e: dict) -> dict:
    """Only the listed fields; never descriptions or person fields."""
    summary = {k: e[f"summary_{k}"] for k in ("en", "no") if e.get(f"summary_{k}")}
    out = {k: e.get(k) for k in EVENT_FIELDS if k != "summary"}
    out["summary"] = summary
    return {k: out[k] for k in EVENT_FIELDS}


class BevegTools:
    def __init__(self, cfg: dict):
        self.app = App(cfg)

    def search_events(self, args: dict):
        query = args.get("query", "").strip().lower()
        d_from = date.fromisoformat(args["date_from"]) if "date_from" in args else None
        d_to = date.fromisoformat(args["date_to"]) if "date_to" in args else None
        limit = min(max(args.get("limit", 10), 1), 50)
        try:
            events = load_events()
        except ServiceError as e:
            raise ToolError(str(e)) from None
        hits = []
        for e in events:
            first = date.fromisoformat(e["start"][:10])
            last = date.fromisoformat((e["end"] or e["start"])[:10])
            if d_from and max(first, last) < d_from:
                continue
            if d_to and first > d_to:
                continue
            if args.get("category") and e["category"] != args["category"]:
                continue
            if query:
                text = " ".join([e["title"], e["venue"], e["municipality"],
                                 e["summary_en"], e["summary_no"]]).lower()
                if query not in text:
                    continue
            hits.append(public_event(e))
        return {"count": len(hits[:limit]), "total_matches": len(hits),
                "events": hits[:limit]}

    def _event(self, eid: str) -> dict:
        try:
            return self.app.event(eid)
        except LookupError:
            raise ToolError(f"Unknown event id '{eid}'. Use search_events to find ids.") from None

    def event_weather(self, args: dict):
        self._event(args["event_id"])
        if self.app.cfg["yr"]["enabled"] and not os.environ.get("CRAWLER_CONTACT"):
            raise ToolError("Weather is off: set CRAWLER_CONTACT in the MCP server's "
                            "environment (MET Norway requires contact info).")
        return self.app.weather(args["event_id"])

    def resolve_origin(self, text: str | None) -> dict:
        origins = self.app.cfg["origins"]
        if not text or not text.strip():
            return origins[0]
        wanted = text.strip().casefold()
        for o in origins:
            if o["name"].casefold() == wanted or str(o["id"]).casefold() == wanted:
                return o
        hits = self.app.entur.places(text.strip(), size=1)
        if not hits:
            raise ToolError(f"No place found for origin '{text.strip()}'.")
        return hits[0]

    def event_trips(self, args: dict):
        self._event(args["event_id"])
        if not self.app.cfg["entur"]["enabled"]:
            raise ToolError("Travel info is switched off (web config).")
        origin = self.resolve_origin(args.get("origin"))
        result = self.app.trips(args["event_id"], origin)
        return {"origin": origin, **result}

    def list_origins(self, args: dict):
        return {"origins": self.app.cfg["origins"]}

    def call(self, name: str, args: dict) -> dict:
        try:
            data = getattr(self, name)(args)
            return {"content": [{"type": "text",
                                 "text": json.dumps(data, ensure_ascii=False)}],
                    "isError": False}
        except (ToolError, ServiceError) as e:
            msg = str(e)
            # The message can hold the typed origin: log the error type only.
            log(f"tool {name}: error {type(e).__name__}")
        except Exception as e:  # keep serving; frames only to stderr
            log_exception(f"tool {name}", e)
            msg = f"{name} failed with an internal error."
        return {"content": [{"type": "text", "text": msg}], "isError": True}


class Server:
    def __init__(self, cfg: dict):
        self.tools = BevegTools(cfg)

    def handle(self, method: str, params: dict):
        if method == "initialize":
            asked = params.get("protocolVersion")
            return {"protocolVersion": asked if asked in PROTOCOL_VERSIONS
                    else PROTOCOL_VERSIONS[0],
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            name = params.get("name")
            args = params.get("arguments", {})
            if args is None:
                args = {}
            if name not in TOOL_SCHEMAS:
                raise RpcError(-32602, f"Unknown tool: {name!r}")
            if not isinstance(args, dict):
                raise RpcError(-32602, "'arguments' must be an object")
            check_args(name, args)
            log(f"tools/call {name}")
            return self.tools.call(name, args)
        raise RpcError(-32601, f"Method not found: {method}")

    def dispatch(self, line: str) -> dict | None:
        """One incoming line -> one reply, or None for notifications."""
        try:
            msg = json.loads(line)
        except ValueError:
            return error_reply(None, -32700, "Parse error")
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" \
                or not isinstance(msg.get("method"), str):
            if isinstance(msg, dict) and "method" not in msg and ("result" in msg or "error" in msg):
                return None  # a reply to a request we never sent: ignore
            rid = msg.get("id") if isinstance(msg, dict) else None
            return error_reply(rid, -32600, "Invalid Request")
        method, is_notification = msg["method"], "id" not in msg
        if is_notification:
            log(f"notification {method}")
            return None
        params = msg.get("params", {})
        if params is None:
            params = {}
        try:
            if not isinstance(params, dict):
                raise RpcError(-32602, "params must be an object")
            log(f"request {method}")
            return {"jsonrpc": "2.0", "id": msg["id"], "result": self.handle(method, params)}
        except RpcError as e:
            return error_reply(msg["id"], e.code, str(e))
        except Exception as e:
            log_exception(f"request {method}", e)
            return error_reply(msg["id"], -32603, "Internal error")


def error_reply(rid, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def run(config_path: str):
    """Serve MCP over stdio until stdin closes."""
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    out = sys.stdout
    sys.stdout = sys.stderr  # any stray print() must not corrupt the protocol stream
    cfg = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
    server = Server(cfg)
    log(f"ready (config {config_path}; weather "
        f"{'on' if cfg['yr']['enabled'] and os.environ.get('CRAWLER_CONTACT') else 'off'}, "
        f"travel {'on' if cfg['entur']['enabled'] else 'off'})")
    for line in sys.stdin:
        line = line.strip().lstrip("﻿")
        if not line:
            continue
        reply = server.dispatch(line)
        if reply is not None:
            out.write(json.dumps(reply, ensure_ascii=False) + "\n")
            out.flush()
    log("stdin closed, exiting")
