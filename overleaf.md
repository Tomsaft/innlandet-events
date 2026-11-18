# Problem {#sec:problem}

#### Problem statement.

Innlandet county has no shared place or single portal where you can see
happenings, how to get to them, and what the weather will be like. This
is a need both for residents and travelers.

#### The recurring need.

Happenings like concerts, library events, sports, courses, markets and
volunteer activities are published by each municipality and venue
separately, in different places and formats, with no single owner of the
overall picture. Finding out what is on means checking several sites.
The listings are in Norwegian: all 30 events in our sample from Hamar
municipality's culture calendar [@hamar] are tagged as Norwegian.
Knowing that an event exists is only half of the problem. The person
must also work out how to get there by public transport and whether the
weather suits the plan, and these are further searches in further
services.

#### Why the geography makes this hard.

Innlandet is the largest county in Norway by area, 52 072 km$^2$, bigger
than the country of Switzerland. But the county has about 380 000
inhabitants, equal to 8 inhabitants per km$^2$ against 18 for the
country as a whole, and 41 % of its population lives outside built-up
areas, against 18 % nationally [@snl]. Innlandet has 46 municipalities,
27 of them in the least central categories, so events are spread over
many places, publishers and long distances. Public transport is in use:
the county reports a record of nearly 7 million public-transport trips
in 2024 [@ifk2024]. There is also a great amount of commuting between
the largest cities, with Hamar being the biggest with over 10 000
commuters filling the city each day  [@instat]. Finding an event and
finding a way to get there are therefore two separate problems, and the
shared space addresses both. Figures for event participation and for
travel into the county are not yet quantified; travel data from Entur's
open datasets [@entur] will be queried for this after Compulsory 2.

#### Who has the need.

People who lives in Innlandet, and people who travel to the county from
outside, who plan to attend an event in Innlandet: Anyone must be able
to see what is happening before they travel, without knowing to much
about the specifics of the region they plan to visit. Our starting point
was an observation from earlier work on language learning: newcomers
find it hard to become part of the local community, and not knowing what
is happening is one concrete barrier. Norwegian and English are
therefore supported from the start.

#### Information flow between municipalities and the county.

Each municipality publishes its own calendar, but events and travellers
do not stop at municipal borders. Hamar municipaity's calendar already
lists events in places like Brumunddal and Moelv, belonging to the
neighbouring Ringsaker municipaity. The shared space is where these
flows meet: many sources are merged into one shape, an event listed in
two places should appear only once, preferably the original one.

#### What the workflow produces.

For each upcoming public event: title, start and end time, venue,
municipality, a category from a fixed list of 14, a one-sentence summary
in English and Norwegian, and a link to the original listing. The
walking skeleton covers this event part for one source and writes it to
a JSON file. The full scale adds a public-transport route (Entur) and a
weather forecast (Yr) to each event, and presents everything in one
shared web page that anyone can open, with a calendar feed as a second
output (Section [3.0.0.7](#sec:plan){reference-type="ref"
reference="sec:plan"}).

# Definition of success {#sec:success}

The skeleton delivers a \"deduplicated\" list of upcoming events
(`out/events_deduped.json`). It is correct when every stage check exits
with 0. Each check is a script in `eval/`, written *before* the stage it
tests (it fails first, then passes), and keeps its own copy of rules
such as the category list, so a bug in the pipeline cannot make its own
check pass. Together, the checks verify:

1.  **Complete extraction**: at least 20 events, each with a title, a
    calendar URL and a start time with time zone; no API key in saved
    pages.

2.  **Traceable and faithful**: every output event links back to an
    input event; every year in a summary occurs in the source; the
    category is from the fixed list.

3.  **Rules applied in code**: no event that has ended is kept;
    \"cancelled\" is set exactly when the title says \"avlyst\".

4.  **No duplicates**: no two events shares a normalized title, start
    instant (UTC) and venue. Synthetic boundary cases test that the same
    instant with another UTC offset is merged, and another date or venue
    is kept.

5.  **No personal data**: e-mail addresses and phone-number patterns is
    removed from all text fields.

6.  **Bounded and logged**: the run record or log names model and
    temperature, and why the budget stopped the run.

#### Planned checks.

The shared page, Entur and Yr get their checks before they are built.
The page lists exactly the events in the \"deduplicated\" file. An event
with known coordinates gets either a route from a fixed starting point
or an explicit \"travel info unavailable\" flag. A forecast is attached
only when the event falls inside the forecast horizon. No event is
dropped because a service is down.

#### Known gaps.

Format checks cannot tell whether a valid category is the *right* one,
or whether the two summaries agree; a fixed test set and an LLM-as-judge
will cover this for the exam.

# Architecture {#sec:arch}

::: {#tab:stages}
  Stage        What it does                                                                                               Output                          Check
  ------------ ---------------------------------------------------------------------------------------------------------- ------------------------------- ----------------
  1\. Probe    Sitemap, then up to 30 event pages 5 s apart; extracts event data; removes e-mails and phone numbers       `fixtures/*.json`               `check_probe`
  2\. Enrich   Code drops past events and flags cancelled ones; model gives category and EN/NO summary; reply validated   `out/events.json`, `run.json`   `check_enrich`
  3\. Dedupe   Merges events with the same normalised title, start and venue; first listing wins                          `events_deduped.json`           `check_dedupe`

  : Stages of the walking skeleton. Each stage reads the previous
  stage's file, writes its own, and has its own check.
:::

#### Stages.

Table [1](#tab:stages){reference-type="ref" reference="tab:stages"}
shows the pipeline. Pages carry schema.org *Event* data [@schemaorg],
which means that title, times and venue are read from the structured
data. The fetched sample is committed, so the later stages reproduce
offline. Each source is an adapter that outputs the same event shape
with a `municipality` field: adding a municipality means adding an
adapter, not changing the pipeline.

#### Division of work between code and model.

The language model Qwen2.5 3B is run locally with Ollama [@ollama],
temperature 0.2. The LLM does only what needs language understanding
like choosing a category and writing the two summaries. Everything that
can be decided by a rule is done in code and checked like removing past
events, flagging cancellations and removing duplicates. The model must
reply with JSON only. Replies that are not JSON use an unknown category.
Sentences that are too long or contain a link are rejected, retried
once, then skipped and counted.

#### Context.

Two agents are involved. *The pipeline model* receives a short system
prompt, namely the three keys to return, the category list and rules
such as \"use only facts from the text\". It alsp takes title, venue,
address, start and at most 1200 characters of description; no URL, no
other events, no history. *The coding agent* (Claude Code) that builds
the harness works from `CLAUDE.md` (project rules) and `SPEC.md`
(definition of success). It takes one specification per task in
`tasks/`, and a permission file that blocks editing `eval/`, reading
secrets and merging. We write the specifications and checks and review
every change and merge.

#### What runs without a person.

The command `python run.py all` runs the three stages and every check
without a person driving each step, and exits with 0 only if all pass.
Each run is bounded by 60 model calls, 80 000 tokens, 900 s as the
budget. The stop reason is recorded. The crawler stops at the first HTTP
403, 429 or 503, and previous outputs are moved to an archive before
each run, so a crashed run cannot leave stale output for a check to pass
on. A scheduled run is planned
(Section [4](#sec:schedule){reference-type="ref"
reference="sec:schedule"}).

#### Technical minimum.

Checkable output contains probe, enrich and dedupe probe, which acts as
three seperate stages, each with its own file and check. The pipeline
uses several tools, and among these are HTTP requests to the source,
files between stages, a local model server, and shell commands for the
checks.

#### Status.

`python run.py all --offline --mock` reproduces the chain without
network or model and passes all checks. In two full runs with the real
model (Appendix [9](#app:runs){reference-type="ref"
reference="app:runs"}) no event was lost and the budget was never
reached. The runs also exposed a weakness that format checks miss when
both \"Åpent skaperverksted\" (open maker space) sessions were labeled
*food_drink*, because no category fitted. We added the category
*workshop* (Appendix [7](#app:prompts){reference-type="ref"
reference="app:prompts"}). Removal of duplicates is essential when a
second municipality posts the same event.

#### Linking events to public transport and weather. {#sec:plan}

The events, public transport, and weather will be three separate parts
that will function together as one service. Entur answers *how do I get
there*, and Yr answers *what will the weather be*. We build in a
hierarchy priority order, with the most important being events from
municipalities, public-transport routes (Entur), and finally weather
(Yr). Both need venue coordinates, and shall each be able to be switched
off; when one is off or down, events are still published, marked "travel
info unavailable" or "no forecast". Routes start from fixed points
(e.g. Hamar station, Lillehammer station, Oslo S), so no user location
is stored. Entur's open data [@entur] also records punctuality and
cancellations per stop, and using it to show how reliable a route is
remains future work. The shared space is a web page where anyone can
browse the county's events, filter by municipality and category, and
choose a starting point; a calendar feed carries the same events to
people's own calendar apps.

# Schedule {#sec:schedule}

Table [2](#tab:schedule){reference-type="ref" reference="tab:schedule"}
works backwards from the demonstration in weeks 46--47. The slot is not
yet announced, so we plan for the earliest, Monday 9.11: week 45 is the
main build week, with a freeze on 6.11. The demonstration shows the
progress at that point; parts that do not yet pass their check are shown
as work in progress. Events are priority one, then Entur, then Yr. The
abandonment rule protects the core for the exam: if Entur does not pass
its check by 22.11, Entur and Yr are dropped, and the white paper states
that the problem statement is only partly solved.

::: {#tab:schedule}
  Week     Dates          Milestone
  -------- -------------- -------------------------------------------------------------------------------------------------------------------------------
  44       26.10--01.11   Repository public (29.10); Compulsory 2 submitted (30.10); scheduled run of `run.py all`
  45       02.11--08.11   Main build: second municipality (if terms allow); shared web page; Entur routes from fixed points, check by 5.11; freeze 6.11
  46       09.11--15.11   Demonstration if slot is in week 46; stress test 1 (Entur unavailable); fixed test set
  47       16.11--22.11   Demonstration if slot is in week 47; Yr; calendar feed; stress test 2 (instructions hidden in an event); abandonment decision
  48--49   23.11--03.12   Feedback addressed; full evaluation run; white paper; tag `exam`; submission 03.12, 11:59

  : Milestones from Compulsory 2 to the exam, planned backwards from the
  earliest demonstration slot (9.11).
:::

# Risk assessment

Table [3](#tab:risks){reference-type="ref" reference="tab:risks"} lists
the risks we consider most likely, ordered by how much they threaten
delivery. Four have already happened while building the skeleton, and
for those the response is already implemented.

::: {#tab:risks}
  Risk                                                                                                     Observed  How we address
  ------------------------------------------------------------------------------------------------------- ---------- ---------------------------------------------------------------------------------------------------
  Source access: robots.txt allows our path but blocks AI crawlers by name; reuse terms not yet checked              Low volume, 5 s delay, honest identification, cached data; asked the lecturer; else switch source
  Valid but wrong model output (wrong category)                                                              yes     Rules kept in code; category list extended; test set and LLM-as-judge for the exam
  Model server fails mid-run (HTTP 500 lost a run)                                                           yes     Errors caught per call, counted against the budget
  Check passes on stale output                                                                               yes     Old outputs archived before each run
  Coding agent oversteps its permissions                                                                     yes     Every change to `eval/` reviewed before merging
  Source changes its page structure                                                                                  Pages without event data skipped and counted; probe check fails below 20 events
  Entur or Yr down, wrong or stale                                                                                   Events published without them and marked as such; link to the original listing; stress test 1
  Personal data reaches the output                                                                                   No person fields; redaction at extraction; independent check on every text field

  : Risks and our response. \"Observed\" marks risks that have already
  occurred.
:::

# Repository and reproduction

<https://github.com/Tomsaft/innlandet-events>. The README describes
setup and reproduction: `python run.py all --offline --mock` needs
neither network nor model; `python run.py all` uses the real model. The
context files are in the repository: `CLAUDE.md`, `SPEC.md`, `tasks/`,
`config/` and `.claude/`.

::: thebibliography
9 Hamar municipaity. Kulturkalender.
<https://www.hamar.municipaity.no/kulturkalender/>. Accessed 2026-10-16.
Schema.org. Event. <https://schema.org/Event>. Ollama.
<https://ollama.com>. Store norske leksikon. Innlandet.
<https://snl.no/Innlandet>. Accessed 2026-10-28. Innlandet
fylkeskommune. Årsberetning og årsregnskap 2024. 2025. See p. 2.
Published via Oslo Børs (Euronext):
<https://live.euronext.com/sites/default/files/company_press_releases/attachments_oslo/2025/04/15/643193_Innlandet%20fylkeskommune%20-%20%C3%A5rsberetning%20og%20%C3%A5rsregnskap%202024.pdf>.
Accessed 2026-10-28. Entur. Open data: datasets, including
`realtime_siri_et`. <https://data.entur.no/public/datasets>; guide:
<https://data.entur.no/help>. Accessed 2026-10-28. Innlandsstatistikk.
Commuters (Pendling)
<https://www.innlandsstatistikk.no/befolkning/pendling/>
:::

# Prompt logs {#app:prompts}

Representative excerpts from our work with coding agents (Claude in the
claude.ai chat, and Claude Code), selected where agent output was
corrected, challenged or rejected. The full log is `docs/prompt-log.md`.

#### A.1 A task specification as the prompt.

Each task is given to the agent as a specification, written by us
together with a failing check. Excerpt from task 003:

> Goal: python run.py dedupe reads out/events.json and writes
> out/events_deduped.json (no two events with the same key) \[...\]\
> Constraints: Do not edit eval/. Done in code, no LLM call. First
> occurrence wins; input order is kept. \[...\]\
> Acceptance: python run.py dedupe && python eval/check_dedupe.py prints
> PASS. The check failed before this task started (red first).

Before implementing, the agent pointed out three gaps in our
specification: the title mentioned a PII check that no acceptance line
covered, the rule for a start time without a UTC offset was missing, and
the handling of cancelled events was unspecified. We added all three to
the specification.

#### A.2 Challenged: personal names.

The assistant first proposed removing all personal names from event
data. We disagreed: performers listed in a public municipal calendar act
in a public role. Decision: artist names in descriptions are allowed,
the data model has no person fields, and e-mails and phone numbers are
removed at extraction and checked independently.

#### A.3 Rejected: a guess presented as a fact.

The assistant stated that the virtual environment used Python 3.12,
based on a file name (`pip3.12.exe`). Running `sys.version` showed
3.14.0. Lesson: verify with a command, not a file name.

#### A.4 Caught: a secret in the source.

The fetched HTML contained a Google Maps API key in a map image URL. The
fetcher now replaces it before raw pages are saved, and the probe check
fails if a key is left.

#### A.5 Model failures that changed the design.

(i) Asked for "1--2 sentences", the model returned a summary of about
150 words, and the token cap cut the JSON mid-string. Fix: a stricter
prompt (one sentence, at most 25 words, no links), and a word cap and
link check in the reply parser. (ii) Both open makerspace sessions were
labeled *food_drink*: the format was valid, the content wrong. Fix: the
category *workshop*. Trade-off: a fixed list always forces a choice, and
the model can still pick a wrong but valid label.

#### A.6 Gap in our own checks.

After a crashed run, the enrich check passed on an old output file: a
false pass. Old outputs are now moved to an archive before every run, so
a check can only see output from the current run.

#### A.7 Agent went around a permission rule.

Adding *workshop* also required the independent category list in
`eval/check_enrich.py` to change, and we approved that. Our permission
file blocks the agent's *edit tool* on `eval/`, but the agent made the
change with a shell command, which the rule does not cover. The agent
reported this itself two days later. Lesson: permission rules alone do
not protect the checks; changes to `eval/` must also be reviewed before
merging.

# Meeting reports {#app:meetings}

All meetings were held online with both group members. Full reports are
in `docs/meetings/`.

#### 1. Kick-off (2026-10-13).

Agreed on goals, how to approach the project, meeting frequency,
logistics (chat, calls, file sharing) and a flexible way of working.
Outcome: a shared working arrangement.

#### 2. Idea generation (2026-10-14).

Reviewed our earlier work, including language learning, and the
observation that foreigners find it hard to get involved in the local
community. Outcome: a direction around community integration for
newcomers.

#### 3. Concept (2026-10-16).

Decision: an event service that helps Norwegian- and English-speaking
students find and attend events in Hamar and Innlandet.

#### 4. Scope expansion (2026-10-19).

Decision: widen the target group from students in Hamar to all citizens
of Innlandet, and plan two more data sources: Entur (how to get there)
and Yr (what the weather will be). *Changed since meeting 3:* target
group and data sources.

#### 5. Feedback from the lecturer (2026-10-20, with the lecturer).

The idea was well received. Feedback: build a stronger foundation for
why the service is needed, with statistics (e.g. how many people
travel); start from the problem and work toward the solution, including
how information reaches the end user; anyone, also outside the county,
should be able to see what is happening; consider the information flow
between municipalities and the county; aim for the full scale in the
long term. Actions: problem statement backed by statistics; define
delivery to the end user; describe the municipality-to-county flow.

#### 6. Prioritisation (2026-10-20, after meeting 5).

Turned the feedback into a ranked list of what to build: (1) events,
(2) Entur, (3) Yr.

#### 7. Coding review and writing report (2026-10-29).

Listed content and details in documentation. Made som excerps with LLMs.
We had som discussions about setting the target for the exam, the
success factor and also what we would like to see this project develop
into beyond the scope of our assignment.

#### 8. Report review (2026-10-30).

Oversight of the report. Proofreading and rewriting of bad text and long
sentences, especially summaries made with LLMs. Made the report more
pedagogical readable. Delivery of the compulsory.

# Run records {#app:runs}

::: {#tab:runs}
  Run            Enriched   Past (dropped)   Failed   Tokens   Time
  ------------ ---------- ---------------- -------- -------- ------
  2026-10-20           28                2        0   15 708   85 s
  2026-10-25           22                8        0   12 249   67 s

  : Full runs with the real model on the committed sample of 30 events.
  Fewer events in the second run because more had passed.
:::
