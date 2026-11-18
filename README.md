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
| 4. Match | `python run.py match` | `out/events_deduped.json`, `out/events_ticketmaster.json`, `out/events_kulturradar.json` | `out/events_matched.json`, `out/match.json` | none yet (draft pending review) |

Ticketmaster (second source, optional) runs beside this chain: `probe` also
writes `fixtures/ticketmaster.json`, `enrich` also writes
`out/events_ticketmaster.json`, and `match` merges it in. `out/events.json`
stays Hamar-only, so the `eval/` checks are unchanged. See
[Ticketmaster source](#ticketmaster-source). Kulturradar (third source, an
aggregator) works the same way with `fixtures/kulturradar.json` and
`out/events_kulturradar.json`; see [Kulturradar source](#kulturradar-source).

### Match stage (fuzzy duplicates)

Dedupe only merges exact keys (normalised title + UTC start + venue). With
more sources the same event is listed slightly differently, so `match`
(`harness/stages/match.py`, pure code, no LLM) merges near-duplicates.
Titles and venues are compared after casefolding, æ/ø/å → ae/o/a, accent
and punctuation stripping, and (titles only) dropping years (19xx/20xx) and
filler words (`avlyst`, `utsatt`, `konsert`, `velkommen til`, `cancelled`).
Two events are only ever merged when they are on the same Oslo calendar
day. Then one of four rules must fire; `out/match.json` names it for every
merge (`rule`, plus the sub-rules and scores) and counts them in
`merged_by_rule`:

1. **`url_identity`:** a link of one event (`source_url`, or the aggregator's
   `original_url` ticket/source link) equals a link of the other, after
   normalising (no scheme, lowercase host without `www.` or a default port,
   no trailing slash, fragment, `utm_*` or `apikey`; any Ticketmaster
   subdomain becomes `ticketmaster.<tld>` and event links are reduced to
   their id). Starts must be at most 60 min apart (or a time unknown), so two
   showings sharing one series ticket page stay apart. The titles must share
   a significant token (or pass a title rule), except for a Ticketmaster
   `/event/<id>` link, where titles may differ completely. A link that two
   events of the same source share on the same day, and a bare home page (no
   path and no query), never count.
2. **`base`** (any two events, also from the same source), all three hold:
   - **Time:** starts at most 30 min apart (two showings at 15:00 and 18:00
     stay separate). If either start time is unknown (midnight, date-only
     listing), the same day is enough.
   - **Title:** token-set Jaccard ≥ 0.6, or difflib ratio ≥ 0.85, or one
     title contains the other as a whole phrase of at least 2 words.
   - **Venue:** compatible (below), or same municipality and title ratio ≥ 0.95.
3. **`same_source_exact`** (same source, narrow): starts exactly equal (both
   times known), equal non-empty venue keys, and the shorter title's
   significant tokens all appear in the longer title. This catches an
   aggregator importing one show twice ("Lørdagsbarn" vs "Lørdagsbarn: Jul
   med Prøysen", same hall, 13:00).
4. **`cross_source`** (only events from different sources), all three hold:
   - **Time:** starts at most 60 min apart, or a time unknown.
   - **Title** (stop words like `og`, `med`, `the` ignored): the shared
     tokens are ≥ 0.5 of the shorter title's tokens, or Jaccard ≥ 0.45; and
     either ≥ 2 shared *significant* tokens (4+ letters, not a generic event
     word such as `julekonsert`, `bingo`, `teater`, `innlandet`), or all
     significant tokens of the shorter title appear in the longer one.
   - **Venue:** compatible, but a missing venue together with an unknown
     time never passes. Same municipality is enough only when the base
     title rule holds and both start at the same time (±30 min), e.g.
     "Teater Innlandet scene" vs "Hamar Kulturhus" for one premiere.

**Venue compatible** means: one venue missing, or difflib ratio ≥ 0.8, or
one contains the other as whole words, or they are the same after *venue
keys*: optional `match.venue_aliases` (in `config/pipeline.yaml`) applied,
then town names, `kulturhus`/`kulturhuset`/`scene`/`scenen`/`salen`/`storsalen`
and punctuation stripped ("Hamar Teater, Teatersalen" → "teater teatersalen").

The same-source thresholds are unchanged, so the looser cross-source rule
never merges two different events from one source. **Near misses:**
`near_misses` in `out/match.json` lists same-day pairs of different origins
that were kept apart although a title score was within 0.15 below its
threshold, or whose titles matched but time, venue or complete linkage (next
paragraph) kept them apart, so the thresholds can be tuned.

An event joins a group only if it matches every copy already in it, so
chains (A like B, B like C) do not merge A with C. Some order dependence
remains: an event that fits two groups joins the first one, so a different
input order can split a borderline group differently. Starts without an
offset are read as Oslo time; unparsable starts pass through unmatched
(`skipped` in the report).

The kept copy comes from the most original source (`match.source_priority`
in `config/pipeline.yaml`, else input order). Its empty fields (end, venue,
summaries, municipality, original_url) are filled from the dropped copy; nothing it has is
overwritten, except: a date-only kept copy takes start/end from a copy with
a known time, and if the copies disagree on `cancelled` the event is marked
cancelled (flagged `cancelled_conflict`). Every event gets `also_listed_at`: all source URLs of the
listing, its own first. `out/match.json` records each merge (kept, dropped,
scores, fired rules) plus input/output/removed counts.

The fixtures are committed, so you can reproduce stages 2 and 3 without
network access and, with `--mock`, without a model.

## Requirements

- Python 3.14
- For real model runs: [Ollama](https://ollama.com) running locally with the
  model from `config/pipeline.yaml` (default `qwen2.5:3b`)
- For live probing only: network access and a contact address (see belo
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

One command runs the whole chain (probe → enrich → dedupe → match → every stage check) and
exits 0 only if all checks pass:

```powershell
python run.py all --offline --mock
```

Expected: `N events, {'past': ..., 'failed': 0}, stopped: all_items_done`,
then `N in, N out, 0 removed` from dedupe, `N in, N out, 0 merged` from match, `PASS` for each check and
`3/3 checks passed`.

The same steps one at a time:

```powershell
python run.py enrich --mock
python run.py dedupe
python run.py match
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
`--limit N` to enrich at most N events per source. Every model call is bounded by
`Budget` (`harness/budget.py`), with limits set in `config/pipeline.yaml`
(`max_turns`, `max_tokens`, `max_seconds`). `out/run.json` records which limit
stopped the run (`stop_reason`) and, when the Budget stopped it, how many
upcoming items per source were not enriched (`stats.not_enriched_budget`;
`enrich` prints the same).

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

## Ticketmaster source

Adds ticketed events (concerts, shows, sport) from all of Innlandet, not
just hamar.kommune.no. It uses only the official
[Discovery API v2](https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/)
(`app.ticketmaster.com/discovery/v2/events.json`); ticketmaster.no is never
scraped, as their terms forbid it.

1. Get a free key: go to developer.ticketmaster.com, register, open your
   app under "My Apps" and copy the **Consumer Key**.
2. Set it for the current shell only and probe:

```powershell
$env:TICKETMASTER_API_KEY = "..."
$env:CRAWLER_CONTACT = "your.name@example.com"
python run.py probe
python run.py enrich --mock      # or without --mock for the real model
python run.py dedupe
python run.py match
```

- **The key is never stored.** It is read from `TICKETMASTER_API_KEY`, sent
  only on the request, kept out of error messages, and `apikey` is stripped
  from every saved link. Without the key, `probe` prints one line
  (`ticketmaster: TICKETMASTER_API_KEY is not set, skipping`) and everything
  else works as before; without `fixtures/ticketmaster.json`, the offline
  run simply has no Ticketmaster events.
- **Coverage:** one `geoPoint` (geohash) + 40 km radius query per town in
  `ticketmaster.points` in `config/pipeline.yaml` (Hamar, Lillehammer,
  Gjøvik, Elverum, Kongsvinger, Otta, Fagernes, Tynset, Trysil, Lom,
  Beitostølen), with `countryCode=NO`, from the start of today (Oslo),
  sorted by date. Results are merged and de-duplicated by Ticketmaster event
  id; cancelled events are skipped. Only venues in Innlandet are kept
  (`require_state: Innlandet`, old names in `state_aliases`); a venue without
  a state is kept if its postal code is in Innlandet. An event whose venue
  has no city gets the town of the query point. A bad event or a bad config
  point is skipped with a warning; any Ticketmaster failure leaves the Hamar
  run untouched.
- **Rate limits:** the API allows 5 requests/s and 5000/day. We wait
  `request_delay_seconds` (0.25 s) between calls and fetch at most
  `--max-pages` pages of `page_size` (50) per town.
- **Privacy:** performers (`_embedded.attractions`), promoters, the free
  text (`info`, `pleaseNote`) and other person fields are never kept. The
  description given to the LLM is only the event name, the Ticketmaster
  category (segment / genre / subgenre) and the venue; it never reaches the
  browser.
- **Attribution:** every Ticketmaster event links to its public
  ticketmaster.no page (`source_url`), shown as "more info" on the page.
- The same `enrich` function and the same `Budget` handle both sources
  (Hamar first). `match` exact-dedupes the Ticketmaster file, then merges it
  with Hamar; `match.source_priority` keeps the hamar.kommune.no copy of an
  event listed in both, with the Ticketmaster link in `also_listed_at`.

## Kulturradar source

[kulturradar.no](https://kulturradar.no) is an event aggregator for
Innlandet (cities: hamar, ringsaker, lillehammer, gjovik, gudbrandsdalen,
osterdalen, valdres). It overlaps heavily with hamar.kommune.no and
Ticketmaster, so it is the **least original** source:
`match.source_priority` is `[hamar_kommune, ticketmaster, kulturradar]`. When
an event is also listed elsewhere, the Kulturradar copy is dropped and its
link kept in `also_listed_at`.

```powershell
$env:CRAWLER_CONTACT = "your.name@example.com"
python run.py probe --max-pages 3     # sitemap + city pages (also probes Hamar)
```

- **robots.txt** (checked 2026-11-18): `Allow: /`, `Disallow: /api/`,
  `/arrangor`, `/admin`; no crawl-delay. The crawler **never** requests
  `/api/` (not even the `/api/out/…` ticket redirects the site's own links
  use), `/arrangor` (organiser pages) or `/admin`. robots.txt is read once
  per run (`urllib.robotparser`; Disallow lines are checked before Allow
  lines, because the parser applies the first match and the file starts
  with `Allow: /`). Every URL must pass both that check and a hard-coded
  deny list for those three paths, and must be https on kulturradar.no.
  Redirects are not followed automatically: each `Location` goes back
  through the same checks and delay, at most 3 hops.
- **Politeness:** one request at a time, at least 3 s apart
  (`kulturradar.request_delay_seconds`, which cannot be set lower), the same
  User-Agent with `CRAWLER_CONTACT` as hamar.kommune.no, and a stop on HTTP
  403/429/503. `--max-pages` caps the sitemap and city page requests
  (robots.txt and redirect hops are not counted).
- **What is fetched:** the sitemap once (to get each event's exact URL),
  then city pages (`/city/<city>`). The site is Next.js (App Router) with no
  JSON-LD on city pages: the event list is in the RSC payload
  (`self.__next_f.push(...)` chunks) under `eventsFromPrisma`, and series
  are under `metaEventsFromPrisma` (e.g. Juleteatret, one sub-event per
  show). One city page carries the listings for the whole region, so the
  crawl stops at the first city page that adds nothing new (in practice
  after 2 city pages, 3 requests in total).
- **What is parsed:** title, start (UTC in the payload, stored with the Oslo
  offset), venue name, venue street address, city (as municipality), the
  event's own kulturradar URL (`/event/<slug>-<id>`, from the sitemap), and
  the original source/ticket link as `original_url` (tracking parameters
  removed; Facebook/Instagram links dropped, as they can be personal
  profiles). Unpublished and cancelled listings are skipped. The free-text
  description and the subtitle are **never** read (they name performers
  and contacts), nor are creator ids or organiser fields. The description
  given to the LLM is only the title, category and venue. `original_url` is
  used for matching only and is not sent to the browser.
- **Terms:** no explicit terms of use were found on the site; `/about` says
  they collect no personal data. We only read public pages that robots.txt
  allows, at a low rate. Check again before wider use.
- **Fragile:** the parser depends on the RSC keys `eventsFromPrisma` and
  `metaEventsFromPrisma`. If the site changes them, the probe finds no
  events, prints one line and keeps the old fixture instead of writing an
  empty one.
- **Enrich:** all three sources go through one `enrich` call with one
  `Budget`: Hamar first, then Ticketmaster, then Kulturradar, so a budget
  stop costs the least original listings first. With the default
  `budget.max_turns: 60`, only about the first 30 Kulturradar events
  (soonest first) get enriched; the rest are counted in
  `stats.not_enriched_budget` in `out/run.json`.
- **Series:** Kulturradar lists a series (Juleteatret) as one event per
  show, while hamar.kommune.no lists it once (the next date, with the other
  dates in its schedule). Only the show on the same day as the Hamar record
  merges; the other shows stay as their own events.

## Demo web page: Beveg (events + travel + weather)

*Beveg* is a small local web app on top of the pipeline output, made for
youth (13–21) and pensioners (67+). It follows a guided "three taps" flow:
what do you feel like, then when, then a short list. Each event page answers
what, when and where, gives the weather at the venue (Yr / MET Norway) and the
public-transport trip there (Entur). It can read aloud, share a link and
download a calendar file. You can also ask by voice or text, and the language
(NO/EN/DE) and text size can be changed. Nothing the user picks is stored.
Run the pipeline first so `out/` exists.

```powershell
$env:CRAWLER_CONTACT = "your.name@example.com"   # MET Norway requires contact info
python run.py serve                                # http://127.0.0.1:8000
```

- Reads `out/events_matched.json` (falls back to `out/events_deduped.json`,
  then `out/events.json`) and
  `fixtures/hamar_kommune.json` / `fixtures/ticketmaster.json` (venue
  addresses); writes nothing.
- Starting points: fixed buttons (Hamar stasjon, the campus, Oslo S, Oslo
  lufthavn; set in `config/web.yaml`) or any stop/address via Entur search.
  Trips arrive 10 minutes before the event starts; return trips (venue back
  to the starting point) leave 10 minutes after it ends (`return_minutes_after`;
  the end is guessed as start + 2 h when unknown, marked `time_guessed`).
  API: `/api/event/<id>/trips?id=&name=&lat=&lon=&dir=out|return` (default
  `out`; any other value gives 400). The reply has `direction` and either
  `arrive_by` (out) or `depart_after` (return), plus `time_guessed`, `venue`
  and `trips`.
- Weather is shown when the event is inside MET's forecast (about 10 days),
  with a certainty marker (our own rule of thumb, see `docs/plan.md`).
- Entur and Yr can each be switched off in `config/web.yaml`; the events
  still show, marked "travel info unavailable" / "no forecast".
- Deep link for presenting: `http://127.0.0.1:8000/#e=<event id>&o=<origin id>`
  (event ids come from `/api/events`). Add `&sky=rain` (or `clear`, `partly`,
  `cloudy`, `fog`, `snow`, `sleet`, `thunder`, `night`) to force the weather
  backdrop, e.g. to show the rain effect on a sunny day.
- Animations are turned off for users who ask their system for reduced motion.
- Descriptions are not sent to the browser (they can name contact people);
  the user's starting point is not logged or stored.

## MCP server (Beveg for AI assistants)

`python run.py mcp` starts a read-only MCP (Model Context Protocol) server on
stdio, so assistants such as Claude Desktop can use Beveg. It reuses the demo
page's code and returns the same data as its API. Tools:

- `search_events`: upcoming events, filtered by `query`, `date_from`/`date_to`
  (YYYY-MM-DD), `category` and `limit` (default 10, max 50)
- `event_weather`: the Yr forecast at an event's venue (needs `CRAWLER_CONTACT`)
- `event_trips`: Entur trips to an event from a configured starting point
  (by name) or any stop/address; defaults to the first starting point;
  `direction` `out` (default) or `return` for the trip home
- `list_origins`: the configured starting points

Claude Desktop config (`claude_desktop_config.json`):

```json
{"mcpServers": {"beveg": {
  "command": "<path>\\.venv\\Scripts\\python.exe",
  "args": ["<path>\\run.py", "mcp"],
  "env": {"CRAWLER_CONTACT": "<contact>"}}}}
```

`<path>` is the folder of this repo (JSON needs each `\` doubled). Use full
paths: the client may start the server from any folder. The server then
runs from the repo folder, so `out/` is found, and a relative `--web-config`
(default `config/web.yaml`) is read from the repo folder too. The server
writes no files, makes no LLM calls, logs only to stderr (method and tool
names, never arguments) and never returns descriptions or person fields.

## Command reference

| Flag | Applies to | Effect |
|---|---|---|
| `--offline` | probe, all | Read `fixtures/` instead of fetching |
| `--max-pages N` | probe | Max event pages to fetch (default 30); for Ticketmaster, max API pages per town |
| `--mock` | enrich, all | Use the mock LLM client (fixed replies) |
| `--limit N` | enrich | Enrich at most N events per source |
| `--config PATH` | enrich | Pipeline config (default `config/pipeline.yaml`) |
| `--web-config PATH` | serve | Demo page config (default `config/web.yaml`) |
| `--host`, `--port` | serve | Address to serve on (default `127.0.0.1:8000`) |

## Earlier runs are never overwritten

Before a run replaces a file, the old version is saved to
`archive/<date>_<time>_<command>/`, keeping the same folder layout:

- `enrich` **moves** the previous `out/events.json`, `out/run.json`,
  `out/events_ticketmaster.json` and `out/events_kulturradar.json` into
  the archive, so a crashed run can never leave stale output for `eval/` to
  pass on. `dedupe` does the same with `out/events_deduped.json` and
  `out/dedupe.json`, and `match` with `out/events_matched.json` and
  `out/match.json`. `enrich` and `dedupe` also move any old
  `out/events_matched.json` and `out/match.json`, so the web page never
  serves a stale match result.
- A live `probe` **copies** the current fixtures into the archive before
  fetching, so a failed fetch still leaves fixtures to run offline on.

`archive/` and `out/` are git-ignored: they are local history, not part of
the submission.

## Repository layout

```
run.py                  CLI entry point (probe, enrich, dedupe, match, all, serve, mcp)
config/pipeline.yaml    model, temperature, budget limits, audience, languages
config/regions.yaml     regions and their sources (Hamar now, more towns later)
config/web.yaml         demo page: Entur/Yr on/off, fixed starting points
harness/sources/        one adapter per calendar (hamar_kommune.py, sitemap.py, ticketmaster.py, kulturradar.py)
harness/stages/         pipeline stages (enrich.py, dedupe.py, match.py)
harness/llm/            Ollama client and mock client
harness/web/            demo web page: stdlib server, Entur + MET clients, static UI
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

- Only public event listings are used: hamar.kommune.no/kulturkalender,
  kulturradar.no city pages (never its `/api/`, `/arrangor` or `/admin`) and,
  with a key, the official Ticketmaster Discovery API (never the website).
  The demo page also calls Entur's open APIs (with an `ET-Client-Name`
  header) and MET Norway's Locationforecast (identifying User-Agent,
  responses cached until their `Expires` time, coordinates at 4 decimals).
  See `docs/source-notes.md` for robots.txt and terms (not in the repo yet;
  the Ticketmaster and Kulturradar rules are in
  [Ticketmaster source](#ticketmaster-source) and
  [Kulturradar source](#kulturradar-source)).
- The data model has no fields for performers, contacts or organiser persons.
- Emails and phone numbers are redacted when pages are parsed
  (`harness/pii.py`) and checked again, independently, in `eval/`.
- A Google Maps API key embedded in the source HTML is replaced with
  `key=REDACTED` before raw pages are saved.
- Secrets live in environment variables or a local `.env` (git-ignored);
  `.env.example` lists the names only.
