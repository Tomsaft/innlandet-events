# Task 003: Dedupe stage

## Goal
`python run.py dedupe` reads out/events.json and writes out/events_deduped.json
(no two events with the same key) and out/dedupe.json (input/output/removed
counts and which source_url was dropped in favour of which).

## Context
- Input: Event list from task 002
- Key: normalised title (casefold, collapsed whitespace), start instant in
  UTC, normalised venue
- Prepares for more sources (other municipalities, venues) listing the same event

## Constraints
- Do not edit eval/
- Done in code, no LLM call
- First occurrence wins; input order is kept
- Previous outputs are archived with harness.archive.keep before writing
- No person fields added

## Acceptance (all must pass)
- `python run.py dedupe && python eval/check_dedupe.py` prints PASS
- `python run.py all` runs dedupe and its check
- The check failed before this task started (red first)

## Out of scope
Fuzzy matching (typos, different venue spellings), digest (004), scheduling (005)
