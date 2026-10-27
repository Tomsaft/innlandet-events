# Innlandet Events Harness
Aggregates public event calendars for Innlandet (start: Hamar), normalises
them with an LLM, and produces an EN/NO digest for everyone in Innlandet and visitors.

## Run (Python 3.14, venv at .venv)
- Probe: `$env:CRAWLER_CONTACT = "<contact>"; python run.py probe` (required)
- Enrich: `python run.py enrich`; add `--mock` for the mock LLM
- Other flags: `--offline`, `--max-pages N`, `--limit N`

## Rules
- Never edit eval/ without asking.
- Never edit harness/budget.py (copied unchanged from course starter code).
- Every model-calling loop must use Budget.
- No personal data: no performer, contact or organiser-person fields.
- Public sources only; respect robots.txt and each source's terms.
- Always open files with encoding="utf-8".
- Never overwrite earlier outputs: before a stage writes a file, pass the old
  one to `harness.archive.keep` (move outputs, copy inputs). Never delete
  `archive/`.
- stdlib + requests + PyYAML + beautifulsoup4 only.
