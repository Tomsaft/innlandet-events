# SPEC

## Problem
Event information in Innlandet is scattered across municipal sites, venues
and PDFs. Students (Norwegian and international) miss events.

## Users
Students at the University of Inland Norway (Hamar first), later all residents.

## Definition of success (draft, binary-checkable)
Given fixtures from the Hamar source(s), `out/events.json` is produced such that:
- every event has title, ISO-8601 start date, venue, source_url, language
- every date/title in output appears in the source fixture
- no event is duplicated (same title + start + venue)
- no email addresses or phone numbers appear anywhere
- `python eval/check_events.py` exits 0