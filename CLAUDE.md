# Innlandet Events Harness
Aggregates public event calendars for Innlandet (start: Hamar), normalises
them with an LLM, and produces an EN/NO digest aimed at students.

## Run
- Normal: `python run.py --region hamar`
- Offline (fixtures): `python run.py --region hamar --offline`
- Mock LLM: add `--mock`

## Rules
- Never edit eval/ without asking.
- No personal data: no performer, contact or organiser-person fields.
- Public sources only; respect robots.txt and each source's terms.
- Every model-calling loop must use Budget.
- Always open files with encoding="utf-8".
- Python 3.14, stdlib + requests + PyYAML only.