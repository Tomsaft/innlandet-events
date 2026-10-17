# Testt
# Prompt log
# 
## 2026-10-15: Setup and task 001

- **Code source:** `harness/budget.py` is copied unchanged from the course
  starter-code (KIUA2003, week 1). Not written by us or by an AI assistant.
- **AI assistance:** Project structure, `harness/` skeleton, `pii.py`,
  `sitemap.py`, `hamar_kommune.py` and `eval/check_probe.py` were drafted
  with Claude (claude.ai chat). We reviewed and ran all code ourselves.
- **Corrected:** The assistant first suggested omitting all personal names
  from event data. We challenged this: performers listed in a public
  municipal calendar are a public role. Decision: artist names in
  descriptions are allowed; the schema has no person fields; emails and
  phone numbers are redacted at extraction (`pii.py`) and checked in
  `eval/check_probe.py`.
- **Rejected/changed:** The assistant claimed a venv was built with Python
  3.12 based on a `pip3.12.exe` filename. Wrong guess; `sys.version`
  showed 3.14.0. Lesson: verify with a command, not a filename.
- **Caught:** The raw HTML contains a Google Maps API key in the map image
  URL. The fetcher replaces it with `key=REDACTED` before saving to
  `fixtures/raw/`.
- **Observation (probe, 5 pages):** one event had a past start date
  (2026-04-06) and one `venue` was a street address, not a name. To be
  handled in task 002.
- **Open question for lecturers:** reuse terms for hamar.kommune.no
  calendar data are not checked; the site blocks AI crawlers (ClaudeBot)
  in robots.txt.
- **Failure observed (task 002):** qwen2.5:3b ignored "1-2 sentences" and
  returned a ~150-word summary for musikkbingo-1; the 400-token cap cut the
  JSON mid-string. Fix: prompt tightened + 45-word cap and URL check in
  parse_reply. 0 warnings on the same 5 events afterwards.
- **Failure observed:** model omits "student_fit" (3 times on 2 pages in one
  full run, even with an example in the prompt); one event lost (failed: 1).
  Fix: missing student_fit defaults to 0 and is counted (fit_missing).
  Trade-off: a lost event vs. an unreliable field.
- **Failure observed:** HTTP 500 from Ollama crashed the whole run and lost
  all work. Fix: HTTPError and Timeout are caught per call and counted
  against the turn budget.
- **Gap found:** eval/check_enrich.py passed an old out/events.json after a
  crashed run (false PASS). Mitigation: delete out/ before each run.
- **Gap found:** model labelled "Åpent skaperverksted" as food_drink. Valid
  format, wrong content; the check cannot catch this.
- **Gap found:** student_fit is almost constant (24 of 28 events = 3).
  The field passes validation but carries no information. Format checks
  cannot detect this; a distribution check could.