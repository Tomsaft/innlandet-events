# Innlandet Events

A small agentic harness that collects public event listings in Innlandet
(starting with Hamar), normalises them with an LLM, removes duplicates, and
produces short English/Norwegian summaries for everyone in Innlandet and
visitors. Course project for KIUA-2003, University of Inland Norway.

Each stage writes a file, and each stage has an independent check in `eval/`
that exits 0 (PASS) or 1 (FAIL).

```
hamar.kommune.no ──probe──▶ fixtures/hamar_kommune.json ──enrich (LLM)──▶ out/events.json ──dedupe──▶ out/events_deduped.json
   (sitemap + event pages)     fixtures/raw/*.html                         out/run.json                 out/dedupe.json
                                     │                                          │                               │
                             eval/check_probe.py                       eval/check_enrich.py            eval/check_dedupe.py
```

| Stage | Command | Reads | Writes | Check |
|---|---|---|---|---|
| 1. Probe | `python run.py probe` | hamar.kommune.no (live) | `fixtures/hamar_kommune.json`, `fixtures/raw/*.html` | `eval/check_probe.py` |
| 2. Enrich | `python run.py enrich` | fixtures (offline) | `out/events.json`, `out/run.json` | `eval/check_enrich.py` |
| 3. Dedupe | `python run.py dedupe` | `out/events.json` | `out/events_deduped.json`, `out/dedupe.json` | `eval/check_dedupe.py` |

The fixtures are committed, so you can reproduce stages 2 and 3 without
network access and, with `--mock`, without a model.

## Requirements

- Python 3.14
- For real model runs: [Ollama](https://ollama.com) running locally with the
  model from `config/pipeline.yaml` (default `qwen2.5:3b`)
- For live probing only: network access and a contact address (see below)

## Setup

Run every command from the repository root; paths are relative to it.

Windows (PowerShell):

```powershell
py -3.14 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

macOS / Linux:

```bash
python3.14 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Quick start: reproduce the run (no network, no model)

One command runs the whole chain (probe → enrich → dedupe → every stage check) and
exits 0 only if all checks pass:

```powershell
python run.py all --offline --mock
```

Expected: `N events, {'past': ..., 'failed': 0}, stopped: all_items_done`,
then `N in, N out, 0 removed` from dedupe, `PASS` for each check and
`3/3 checks passed`.

The same steps one at a time:

```powershell
python run.py enrich --mock
python run.py dedupe
python eval/check_probe.py
python eval/check_enrich.py
python eval/check_dedupe.py
```

Without `--offline`, `all` probes the live source first (needs
`CRAWLER_CONTACT`); without `--mock` it uses the real model. The number of
events and the `past` count depend on today's date, because events that have
already ended are filtered out.

## Real model run

```powershell
ollama pull qwen2.5:3b        # once
python run.py enrich          # Ollama must be running on localhost:11434
python eval/check_enrich.py
```

A full run over the 30 fixture events can take several minutes on a laptop
(the default budget stops it after 15 minutes at most). Use
`--limit N` to enrich only the first N events. Every model call is bounded by
`Budget` (`harness/budget.py`), with limits set in `config/pipeline.yaml`
(`max_turns`, `max_tokens`, `max_seconds`). `out/run.json` records which limit
stopped the run (`stop_reason`).

## Live probe (refreshes the fixtures)

Only needed if you want fresh data. The crawler identifies itself with a
contact address, waits at least 5 s between requests (robots.txt
`Crawl-delay`), and stops on HTTP 403/429/503.

```powershell
$env:CRAWLER_CONTACT = "your.name@example.com"
python run.py probe --max-pages 30
python eval/check_probe.py
```

```bash
CRAWLER_CONTACT="your.name@example.com" python run.py probe --max-pages 30
```

30 pages take about 3 minutes. `python run.py probe --offline` re-reads the
committed fixtures without any network access.

## Command reference

| Flag | Applies to | Effect |
|---|---|---|
| `--offline` | probe, all | Read `fixtures/` instead of fetching |
| `--max-pages N` | probe | Max event pages to fetch (default 30) |
| `--mock` | enrich, all | Use the mock LLM client (fixed replies) |
| `--limit N` | enrich | Enrich at most N events |
| `--config PATH` | enrich | Pipeline config (default `config/pipeline.yaml`) |

## Earlier runs are never overwritten

Before a run replaces a file, the old version is saved to
`archive/<date>_<time>_<command>/`, keeping the same folder layout:

- `enrich` **moves** the previous `out/events.json` and `out/run.json` into
  the archive, so a crashed run can never leave stale output for `eval/` to
  pass on. `dedupe` does the same with `out/events_deduped.json` and
  `out/dedupe.json`.
- A live `probe` **copies** the current fixtures into the archive before
  fetching, so a failed fetch still leaves fixtures to run offline on.

`archive/` and `out/` are git-ignored: they are local history, not part of
the submission.

## Repository layout

```
run.py                  CLI entry point (probe, enrich, dedupe, all)
config/pipeline.yaml    model, temperature, budget limits, audience, languages
config/regions.yaml     regions and their sources (Hamar now, more towns later)
harness/sources/        one adapter per calendar (hamar_kommune.py, sitemap.py)
harness/stages/         pipeline stages (enrich.py, dedupe.py)
harness/llm/            Ollama client and mock client
harness/budget.py       turn/token/time budget (unchanged course starter code)
harness/pii.py          redacts emails and phone numbers at extraction
harness/archive.py      keeps earlier outputs instead of overwriting them
harness/models.py       RawItem and Event dataclasses (no person fields)
eval/                   acceptance checks, one per task (exit 0 = PASS)
fixtures/               committed sample of the source (input for offline runs)
tasks/                  task specifications given to the coding agent
docs/                   prompt log, source notes, exam plan, meeting reports
```

## Context files for the coding agent

The harness was built with a coding agent (Claude Code). These are the files
it works from:

- `CLAUDE.md`: project rules (no personal data, never edit `eval/` or
  `harness/budget.py`, allowed dependencies, run commands)
- `SPEC.md`: problem, users and the checkable definition of success
- `tasks/NNN-*.md`: one specification per task: goal, context, constraints,
  acceptance check, and what is out of scope
- `.claude/settings.json`: agent permissions (for example, `eval/` cannot be
  edited, `.env` cannot be read, `git push` asks first)

Each task follows the same loop: write the spec and a failing check in
`eval/` first (red), then implement until the check passes (green).

## Data and privacy

- Only public event listings from hamar.kommune.no/kulturkalender are used.
  See `docs/source-notes.md` for robots.txt and terms.
- The data model has no fields for performers, contacts or organiser persons.
- Emails and phone numbers are redacted when pages are parsed
  (`harness/pii.py`) and checked again, independently, in `eval/`.
- A Google Maps API key embedded in the source HTML is replaced with
  `key=REDACTED` before raw pages are saved.
- Secrets live in environment variables or a local `.env` (git-ignored);
  `.env.example` lists the names only.
