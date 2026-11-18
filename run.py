import argparse
import json
import os
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import yaml

from harness.archive import keep, run_stamp
from harness.budget import Budget
from harness.llm import make_client
from harness.sources.hamar_kommune import HamarKommuneSource
from harness.sources.kulturradar import KulturradarSource
from harness.sources.ticketmaster import KEY_ENV, TicketmasterSource
from harness.stages.dedupe import dedupe
from harness.stages.enrich import enrich
from harness.stages.match import match


TM_FIXTURE = Path("fixtures/ticketmaster.json")
TM_EVENTS = Path("out/events_ticketmaster.json")
KR_FIXTURE = Path("fixtures/kulturradar.json")
KR_EVENTS = Path("out/events_kulturradar.json")


def _load_cfg(path: str) -> dict:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}


def _ticketmaster(args) -> TicketmasterSource:
    return TicketmasterSource(_load_cfg(args.config).get("ticketmaster"), max_pages=args.max_pages)


def _kulturradar(args) -> KulturradarSource:
    return KulturradarSource(_load_cfg(args.config).get("kulturradar"), max_pages=args.max_pages)


def cmd_probe(args):
    stamp = run_stamp("probe")
    if not args.offline:
        moved = keep(["fixtures/hamar_kommune.json", *Path("fixtures/raw").glob("*.html")],
                     stamp, move=False)
        if moved:
            print(f"archived {len(moved)} old fixture files to archive/{moved[0].parts[1]}")
    items = HamarKommuneSource(max_pages=args.max_pages).fetch(offline=args.offline)
    print(f"{len(items)} items")
    for it in items[:5]:
        print(f"- {it.start} | {it.title} | {it.venue}")
    probe_ticketmaster(args, stamp)
    probe_kulturradar(args, stamp)


def probe_ticketmaster(args, stamp):
    """Second source. Never stops the Hamar pipeline: problems are one line each."""
    try:
        tm = _ticketmaster(args)
    except Exception as e:
        print(f"ticketmaster: bad config ({type(e).__name__}); skipping")
        return
    if args.offline:
        if not TM_FIXTURE.is_file():
            print(f"ticketmaster: no {TM_FIXTURE.as_posix()}, skipping")
            return
    elif not tm.has_key():
        print(f"ticketmaster: {KEY_ENV} is not set, skipping (see README)")
        return
    else:
        moved = keep([TM_FIXTURE], stamp, move=False)
        if moved:
            print(f"archived old Ticketmaster fixture to archive/{moved[0].parts[1]}")
    try:
        items = tm.fetch(offline=args.offline)
    except RuntimeError as e:      # our own messages: never contain the URL or key
        print(f"ticketmaster: {e}; skipping, old fixture kept")
        return
    except Exception as e:         # anything else: type name only (may hold the URL)
        print(f"ticketmaster: failed ({type(e).__name__}); skipping, old fixture kept")
        return
    print(f"ticketmaster: {len(items)} items")
    for it in items[:5]:
        print(f"- {it.start} | {it.title} | {it.venue} ({it.municipality})")


def probe_kulturradar(args, stamp):
    """Third source (aggregator). Never stops the pipeline: problems are one line each."""
    try:
        kr = _kulturradar(args)
    except Exception as e:
        print(f"kulturradar: bad config ({type(e).__name__}); skipping")
        return
    if args.offline:
        if not KR_FIXTURE.is_file():
            print(f"kulturradar: no {KR_FIXTURE.as_posix()}, skipping")
            return
    elif not os.environ.get("CRAWLER_CONTACT"):
        print("kulturradar: CRAWLER_CONTACT is not set, skipping")
        return
    else:
        moved = keep([KR_FIXTURE], stamp, move=False)
        if moved:
            print(f"archived old Kulturradar fixture to archive/{moved[0].parts[1]}")
    try:
        items = kr.fetch(offline=args.offline)
    except RuntimeError as e:
        print(f"kulturradar: {e}; skipping, old fixture kept")
        return
    except Exception as e:
        print(f"kulturradar: failed ({type(e).__name__}); skipping, old fixture kept")
        return
    print(f"kulturradar: {len(items)} items")
    for it in items[:5]:
        print(f"- {it.start} | {it.title} | {it.venue} ({it.municipality})")


def cmd_enrich(args):
    cfg = _load_cfg(args.config)
    llm = cfg["llm"]
    items = HamarKommuneSource().fetch(offline=True)
    tm_items = _ticketmaster(args).fetch(offline=True)     # [] without a fixture
    kr_items = _kulturradar(args).fetch(offline=True)      # [] without a fixture
    # Downstream match output would otherwise be served stale (server prefers it).
    moved = keep(["out/events.json", "out/run.json", TM_EVENTS, KR_EVENTS,
                  "out/events_matched.json", "out/match.json"], run_stamp("enrich"))
    if moved:
        print(f"archived previous output to archive/{moved[0].parts[1]}")
    budget = Budget(**cfg["budget"])
    client = make_client(llm["provider"], mock=args.mock)
    # One call, one Budget: Hamar first, then Ticketmaster, then Kulturradar (the
    # aggregator), so a budget stop costs the least original listings first.
    # out/events.json stays Hamar-only (eval/check_enrich.py traces it to its fixture).
    enriched, stats = enrich(items + tm_items + kr_items, client, llm["model"],
                             llm["temperature"], budget, limit=args.limit)
    others = {TicketmasterSource.id, KulturradarSource.id}
    events = [e for e in enriched if e.source_id not in others]
    tm_events = [e for e in enriched if e.source_id == TicketmasterSource.id]
    kr_events = [e for e in enriched if e.source_id == KulturradarSource.id]

    out = Path("out")
    out.mkdir(exist_ok=True)
    (out / "events.json").write_text(
        json.dumps([asdict(e) for e in events], ensure_ascii=False, indent=2),
        encoding="utf-8")
    TM_EVENTS.write_text(
        json.dumps([asdict(e) for e in tm_events], ensure_ascii=False, indent=2),
        encoding="utf-8")
    KR_EVENTS.write_text(
        json.dumps([asdict(e) for e in kr_events], ensure_ascii=False, indent=2),
        encoding="utf-8")
    (out / "run.json").write_text(json.dumps({
        "model": "mock" if args.mock else llm["model"],
        "temperature": llm["temperature"],
        "budget": budget.summary(),
        "stats": {**stats, "events": len(events), "ticketmaster_items": len(tm_items),
                  "ticketmaster_events": len(tm_events),
                  "kulturradar_items": len(kr_items), "kulturradar_events": len(kr_events)},
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(events)} events, {stats}, stopped: {budget.stop_reason}")
    if stats["not_enriched_budget"]:
        print(f"not enriched (budget stop), per source: {stats['not_enriched_budget']}")
    print(f"ticketmaster: {len(tm_events)} events from {len(tm_items)} items")
    print(f"kulturradar: {len(kr_events)} events from {len(kr_items)} items")


def cmd_dedupe(args):
    events = json.loads(Path("out/events.json").read_text(encoding="utf-8"))
    moved = keep(["out/events_deduped.json", "out/dedupe.json",
                  "out/events_matched.json", "out/match.json"], run_stamp("dedupe"))
    if moved:
        print(f"archived previous output to archive/{moved[0].parts[1]}")
    kept, report = dedupe(events)
    out = Path("out")
    (out / "events_deduped.json").write_text(
        json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "dedupe.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{report['input']} in, {report['output']} out, {report['removed']} removed")


def cmd_match(args):
    """Fuzzy duplicates across listings (no LLM). Reads dedupe's output."""
    events = json.loads(Path("out/events_deduped.json").read_text(encoding="utf-8"))
    extra_reports = {}
    for name, path in (("ticketmaster", TM_EVENTS), ("kulturradar", KR_EVENTS)):
        if path.is_file():         # exact duplicates within the source first
            more, extra_reports[name] = dedupe(json.loads(path.read_text(encoding="utf-8")))
            events = events + more
    cfg = _load_cfg(args.config)
    mcfg = cfg.get("match") or {}
    priority = mcfg.get("source_priority") or []
    moved = keep(["out/events_matched.json", "out/match.json"], run_stamp("match"))
    if moved:
        print(f"archived previous output to archive/{moved[0].parts[1]}")
    kept, report = match(events, priority, mcfg.get("venue_aliases"))
    for name, rep in extra_reports.items():
        report[f"{name}_dedupe"] = {k: rep[k] for k in ("input", "output", "removed")}
        print(f"{name}: {rep['input']} in, {rep['removed']} exact duplicates removed")
    out = Path("out")
    (out / "events_matched.json").write_text(
        json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "match.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{report['input']} in, {report['output']} out, {report['removed']} merged "
          f"{report['merged_by_rule']}, {len(report['near_misses'])} near misses")


def cmd_serve(args):
    """Demo web page: events + Entur travel + Yr weather. Reads out/, writes nothing."""
    from harness.web.server import serve
    if not os.environ.get("CRAWLER_CONTACT"):
        print("note: CRAWLER_CONTACT is not set, so the weather (MET Norway) is off")
    serve(args.web_config, args.host, args.port)


def cmd_mcp(args):
    """Read-only MCP server on stdio for AI assistants. No LLM calls, writes nothing.

    stdout carries only protocol messages, so nothing here may print to it.
    Runs from the project folder so out/ and fixtures/ are found whatever the
    client's working directory is (Claude Desktop may not set one). A relative
    --web-config is therefore taken relative to the project folder too.
    """
    from harness.mcp_server import run
    repo = Path(__file__).resolve().parent
    config = Path(args.web_config)
    if not config.is_absolute():
        config = repo / config
    os.chdir(repo)
    run(str(config))


# One check per implemented stage, in pipeline order.
CHECKS = ["eval/check_probe.py", "eval/check_enrich.py", "eval/check_dedupe.py"]


def cmd_all(args):
    """Whole chain from one command: probe -> enrich -> dedupe -> match -> every stage check."""
    print("== probe")
    cmd_probe(args)
    print("== enrich")
    cmd_enrich(args)
    print("== dedupe")
    cmd_dedupe(args)
    print("== match")
    cmd_match(args)
    failed = []
    for check in CHECKS:
        res = subprocess.run([sys.executable, check], capture_output=True,
                             text=True, encoding="utf-8")
        ok = res.returncode == 0
        print(f"== {check}: {'PASS' if ok else 'FAIL'}")
        if not ok:
            print((res.stdout + res.stderr).strip().splitlines()[-1])
            failed.append(check)
    print(f"{len(CHECKS) - len(failed)}/{len(CHECKS)} checks passed")
    sys.exit(1 if failed else 0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=["probe", "enrich", "dedupe", "match", "all", "serve", "mcp"])
    p.add_argument("--max-pages", type=int, default=30)
    p.add_argument("--offline", action="store_true")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--limit", type=int, default=None, help="max events to enrich per source")
    p.add_argument("--config", default="config/pipeline.yaml")
    p.add_argument("--web-config", default="config/web.yaml")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()
    {"probe": cmd_probe, "enrich": cmd_enrich, "dedupe": cmd_dedupe, "match": cmd_match, "all": cmd_all,
     "serve": cmd_serve, "mcp": cmd_mcp}[args.command](args)


if __name__ == "__main__":
    main()