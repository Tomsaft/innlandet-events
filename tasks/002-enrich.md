# Task 002: LLM enrich stage

## Goal
`python run.py enrich` reads fixtures/hamar_kommune.json and writes
out/events.json (Event objects with category, EN/NO summary, student_fit,
cancelled flag) and out/run.json (model, temperature, budget summary).

## Context
- Input: RawItem list from task 001 (fixtures only, no network)
- Budget class from harness/budget.py bounds every model call
- Local model via Ollama (config/pipeline.yaml); mock client for development

## Constraints
- Do not edit eval/
- Cancelled flag and past-event filter are done in code, not by the LLM
- LLM must reply with JSON only; invalid replies are retried once, then skipped
- No person fields added to Event

## Acceptance (all must pass)
- `python run.py enrich --mock && python eval/check_enrich.py` prints PASS
- Same check passes on a real-model run
- The check failed before this task started (red first)

## Out of scope
Dedupe (003), digest (004), scheduling (005), other municipalities