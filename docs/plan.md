# Plan: one system for events in Innlandet

**Status: planned, not implemented.** Compulsory 2 delivers the events path
only (probe → enrich → dedupe). Everything below is future work for the exam,
to be discussed further and built after Compulsory 2. Source: discussion
between the two group members and lecturer feedback (meetings 5 and 6,
2026-10-20; see docs/meetings/).

## Idea
One place to see what is happening in Innlandet, and optionally how to get
there and what the weather will be:
1. **Events**: what is on, gathered from the kommuner (Hamar first).
2. **Travel (Entur)**: how to get to the event by public transport.
3. **Weather (Yr / MET Norway)**: the forecast for the event's place and time.

Whether an event is indoors or outdoors is not detected; users judge that
themselves from the event and the forecast.

## Users (iterative change)
- Started as: students at the University of Inland Norway in Hamar.
- Grew to: everyone, including people outside Innlandet who want to visit,
  because the same output serves everyone at no extra cost.
- Languages from the start: Norwegian and English.
- Decided 2026-10-27: `student_fit` is removed, and the student-only wording
  in SPEC.md, README.md and CLAUDE.md is replaced by "everyone in Innlandet
  and visitors". Students are part of "everyone", not a separate group.

## Priority order (also the cut order)
| # | Part | Why this rank |
|---|---|---|
| 1 | Events | The core; delivered for Compulsory 2 |
| 2 | Entur | How to get there is harder to find out yourself than the weather |
| 3 | Yr | Nice addition; easy for users to check themselves |

If time runs out, cut from the bottom: the system is still complete without
3, and without 2 and 3.

Entur and Yr each get their own on/off switch (config). With a part switched
off, or its service down, events are still published, marked "travel info
unavailable" / "no forecast". This is also stress-testing material
(perturbation class 2, dependency failure): turn a service off or make it
fail on purpose, check that events still come out, and name the mechanism.

## Information flow: kommune → fylke
```
kommune A calendar ─adapter─┐
kommune B calendar ─adapter─┼─▶ same Event shape ─▶ dedupe ─▶ [Entur] ─▶ [Yr] ─▶ delivery
(more kommuner)  ─adapter───┘   (municipality field)  (fylke level)  (optional) (optional)
```
- One source adapter per kommune (`harness/sources/`); each outputs the same
  Event shape with `municipality` set (the field exists already).
- Fylke level: all kommuner merged and deduplicated. Dedupe matters more here:
  the same event can be listed by a kommune, a venue and the fylke.
- Delivery per kommune and for the whole fylke.
- Scale: Hamar (C2) → neighbouring kommuner → all of Innlandet.

## Travel (Entur), hypothetical
- Needs coordinates for each venue (geocoding the venue address); Yr needs
  the same, so this is a shared first step.
- Starting points, two options for users:
  - Fixed big locations, e.g. Hamar stasjon, the Hamar campus, Oslo S,
    Oslo lufthavn (for visitors from outside the fylke).
  - User chooses their own starting point (interactive page, or plan in
    Entur themselves).
- No user location is stored (no personal data).
- Check Entur's API terms and requirements before building.

## Weather (Yr / MET Norway), hypothetical
- Forecasts only reach about 9–10 days ahead (verify when building); events
  further out show "no forecast yet".
- Forecast confidence by days until the event (our own rule of thumb, not an
  official MET scale):

  | Days until event | Colour | Meaning |
  |---|---|---|
  | 0–2 | 🟢 green | fairly certain |
  | 3–5 | 🟡 yellow | quite uncertain |
  | 6 until end of forecast | 🔴 red | uncertain (long forecast) |
  | beyond forecast | none | "no forecast yet" |

- Show a word next to the colour, not colour alone (colour-blind users).
- Check MET Norway's API terms before building.

## Delivery to the end user, hypothetical
Goal: simple, easy to put in your own calendar, no accounts. Users choose:

| | What | Notes |
|---|---|---|
| A | Calendar feed (.ics), events only | Subscribe once on phone/Google/Outlook |
| B | Calendar feed with travel from fixed points and forecast in the description | Fixed points only; calendar apps refresh feeds on their own schedule (can be hours), so forecasts may lag; colours as emoji |
| C | Web page (app prototype) | Choose own starting point, turn Entur/Yr on or off |

Open question: if A/B are not enough once Entur and Yr are added, build C as
an app prototype instead of relying on the calendar alone.

## Statistics for the problem statement (lecturer feedback)
To be collected by the group, with sources. Questions to answer:
- How many people live in Innlandet, and per kommune?
- How many people go to cultural events?
- How many people travel, and how (public transport, commuting)?
- How many students are there in Hamar / at the university?
- How many events are listed per kommune (our own probe data can count this)?

## Open questions
- Calendar feed only, or also a web page/app prototype (see Delivery)?
- Which fixed starting points?
- Which kommuner come after Hamar?
