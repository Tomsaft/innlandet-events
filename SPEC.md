# SPEC

## Problem
Event information in Innlandet is scattered across municipal sites, venues
and PDFs. Students (Norwegian and international) miss events.

## Users
Students at the University of Inland Norway (Hamar first), later all residents.

## Definition of success (binary-checkable)
The workflow is correct when every stage check below exits 0. Each check is
independent of the code it tests: it reimplements its own patterns rather
than importing them, and it compares output against the committed fixture.

| Stage | Run | Check |
|---|---|---|
| Probe | `python run.py probe` (or `--offline`) | `python eval/check_probe.py` |
| Enrich | `python run.py enrich [--mock]` | `python eval/check_enrich.py` |
| Dedupe (task 003) | in progress | `python eval/check_dedupe.py` |

What the checks verify:

1. **Extraction is complete and well-formed** (`check_probe.py`):
   at least 20 items; every item has a non-empty title, a source URL under
   `hamar.kommune.no/kulturkalender/`, and an ISO-8601 start with a timezone;
   a known venue (Teatersalen) is present; at least 3 raw HTML pages are saved
   and contain no API key.
2. **Every event is traceable and faithful** (`check_enrich.py`):
   at least 5 events; every `source_url` exists in the fixture; every year
   mentioned in a summary appears in the source text; `category` is one of
   the fixed list; `summary_en` and `summary_no` are non-empty;
   `student_fit` is an integer 0–3.
3. **Rules done in code are applied** (`check_enrich.py`): no event that has
   already ended is kept; `cancelled` is true exactly when the title says
   avlyst/cancelled.
4. **No event is duplicated** (`check_dedupe.py`, task 003): no two output
   events share (normalised title, start instant in UTC, normalised venue);
   output count equals the number of unique keys in the input; synthetic
   boundary cases (same instant with another UTC offset, different date,
   different venue) are handled.
5. **No personal data** (all three checks): no email address or Norwegian
   phone-number pattern in titles, venues, addresses, descriptions,
   schedules or summaries.
6. **Every run is bounded and recorded** (`check_enrich.py`): `out/run.json`
   names the model and temperature, and the budget recorded a `stop_reason`.

## Planned (exam)
Travel (Entur), weather (Yr), more kommuner and delivery to users are
planned, not built: see docs/plan.md.

## Known gaps (not yet checked by code)
- Correctness of `category` (a valid but wrong label passes; see
  docs/prompt-log.md, "Åpent skaperverksted" labelled food_drink).
- Usefulness of `student_fit` (almost constant across events; a
  distribution check could catch this).
- `language` and `venue` presence on enriched events.
- Translation quality of `summary_no` vs `summary_en` (candidate for
  LLM-as-judge in the final evaluation harness).
