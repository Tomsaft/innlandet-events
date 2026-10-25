import argparse
import json
import subprocess
import sys
from dataclasses import asdict
from pathlib import Path

import yaml

from harness.archive import keep, run_stamp
from harness.budget import Budget
from harness.llm import make_client
from harness.sources.hamar_kommune import HamarKommuneSource
from harness.stages.dedupe import dedupe
from harness.stages.enrich import enrich


def cmd_probe(args):
    if not args.offline:
        moved = keep(["fixtures/hamar_kommune.json", *Path("fixtures/raw").glob("*.html")],
                     run_stamp("probe"), move=False)
        if moved:
            print(f"archived {len(moved)} old fixture files to archive/{moved[0].parts[1]}")
    items = HamarKommuneSource(max_pages=args.max_pages).fetch(offline=args.offline)
    print(f"{len(items)} items")
    for it in items[:5]:
        print(f"- {it.start} | {it.title} | {it.venue}")


def cmd_enrich(args):
    cfg = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    llm = cfg["llm"]
    items = HamarKommuneSource().fetch(offline=True)
    moved = keep(["out/events.json", "out/run.json"], run_stamp("enrich"))
    if moved:
        print(f"archived previous output to archive/{moved[0].parts[1]}")
    budget = Budget(**cfg["budget"])
    client = make_client(llm["provider"], mock=args.mock)
    events, stats = enrich(items, client, llm["model"], llm["temperature"],
                           budget, limit=args.limit)

    out = Path("out")
    out.mkdir(exist_ok=True)
    (out / "events.json").write_text(
        json.dumps([asdict(e) for e in events], ensure_ascii=False, indent=2),
        encoding="utf-8")
    (out / "run.json").write_text(json.dumps({
        "model": "mock" if args.mock else llm["model"],
        "temperature": llm["temperature"],
        "budget": budget.summary(),
        "stats": {**stats, "events": len(events)},
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(events)} events, {stats}, stopped: {budget.stop_reason}")


def cmd_dedupe(args):
    events = json.loads(Path("out/events.json").read_text(encoding="utf-8"))
    moved = keep(["out/events_deduped.json", "out/dedupe.json"], run_stamp("dedupe"))
    if moved:
        print(f"archived previous output to archive/{moved[0].parts[1]}")
    kept, report = dedupe(events)
    out = Path("out")
    (out / "events_deduped.json").write_text(
        json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
    (out / "dedupe.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{report['input']} in, {report['output']} out, {report['removed']} removed")


# One check per implemented stage, in pipeline order.
CHECKS = ["eval/check_probe.py", "eval/check_enrich.py", "eval/check_dedupe.py"]


def cmd_all(args):
    """Whole chain from one command: probe -> enrich -> dedupe -> every stage check."""
    print("== probe")
    cmd_probe(args)
    print("== enrich")
    cmd_enrich(args)
    print("== dedupe")
    cmd_dedupe(args)
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
    p.add_argument("command", choices=["probe", "enrich", "dedupe", "all"])
    p.add_argument("--max-pages", type=int, default=30)
    p.add_argument("--offline", action="store_true")
    p.add_argument("--mock", action="store_true")
    p.add_argument("--limit", type=int, default=None, help="max events to enrich")
    p.add_argument("--config", default="config/pipeline.yaml")
    args = p.parse_args()
    {"probe": cmd_probe, "enrich": cmd_enrich, "dedupe": cmd_dedupe, "all": cmd_all}[args.command](args)


if __name__ == "__main__":
    main()