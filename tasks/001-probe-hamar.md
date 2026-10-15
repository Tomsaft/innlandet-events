# Task 001: Probe Hamar kommune kulturkalender

## Goal
After this task, `python run.py probe` fetches a polite sample of event
pages from hamar.kommune.no/kulturkalender and writes extracted fields to
fixtures/hamar_kommune.json, plus raw HTML of 3 hand-picked pages to
fixtures/raw/.

## Context
- Discovery: https://www.hamar.kommune.no/sitemap.xml (event = /kulturkalender/<slug>, no trailing slash)
- Event pages have schema.org/Event JSON-LD (name, startDate, endDate, location.name, inLanguage)
- Address, description and full schedule are only in the HTML body
- robots.txt: Crawl-delay 5, /sok/ disallowed. See docs/source-notes.md

## Constraints
- Do not edit eval/
- No personal data: emails and phone numbers are redacted at extraction
- >= 5 s between requests, honest User-Agent (env CRAWLER_CONTACT), max_pages cap
- Stop on HTTP 403/429/503
- Python 3.14, stdlib + requests + PyYAML + beautifulsoup4

## Acceptance (all must pass)
- `python run.py probe && python eval/check_probe.py` prints PASS
- The check failed before this task started (red first)

## Out of scope
LLM stage, dedupe, other municipalities, scheduling