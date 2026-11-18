"""Fuzzy matching: find the same event listed twice in slightly different ways.

Runs after dedupe. dedupe.py only merges exact keys (normalised title + UTC
start + venue); as more sources come in, the same event shows up as
"KONSERT: Hagen Vinter" at "Kulturhuset Hamar" in one place and "Hagen Vinter"
at "Kulturhuset" in another. This stage catches those.

Pure code, no LLM: no model call, so Budget does not apply. Stdlib only.

Two events are the same when they are on the same Oslo calendar day and one
of four rules fires (checked in this order; the report names the one):

  url_identity  A normalised link of one (source_url or original_url) equals
                a normalised link of the other, and the starts are at most
                CROSS_MAX_MINUTES apart (or a time is unknown). Titles may
                differ. A link that two events of the same source share on the
                same day (a series ticket page, a venue's programme page) is
                ambiguous and never counts; neither does a bare home page.
                The titles must share a significant token (or pass a title
                rule), except for a Ticketmaster /event/<id> link.
  base          (any two events, also from the same source) all three hold:
    (a) time:  starts at most MAX_MINUTES apart; an unknown time on either
               side means the same day is enough.
    (b) title: token-set Jaccard >= TITLE_JACCARD, or difflib ratio >=
               TITLE_RATIO, or one normalised title contains the other as a
               whole-word phrase and the shorter has >= CONTAIN_MIN_TOKENS tokens.
    (c) venue: see venue_rule() below.
  same_source_exact  (same source) starts EXACTLY equal (both times known),
                equal non-empty venue keys, and the shorter title's
                significant tokens are a subset of the longer's (an
                aggregator importing one show twice: "Lørdagsbarn" vs
                "Lørdagsbarn: Jul med Prøysen").
  cross_source  (only events from DIFFERENT sources) all three hold:
    (a) starts at most CROSS_MAX_MINUTES apart, or a time unknown;
    (b) title, without stop words: containment (shared tokens / tokens of the
        shorter title) >= CROSS_CONTAIN, or Jaccard >= CROSS_JACCARD; either
        way with >= 2 shared significant tokens (4+ chars, not a generic
        event word such as "julekonsert" or "bingo"), or the shorter title's
        significant tokens all in the longer title;
    (c) venue compatible (venue_rule). The same-municipality fallback only
        counts here when the base title rule holds and both known starts are
        at most MAX_MINUTES apart ("Teater Innlandet scene" vs "Hamar
        Kulturhus" for the same show at the same time). A missing venue
        together with an unknown time never passes.

Venue rule: one side missing; or folded venues similar (ratio >= VENUE_RATIO)
or one contains the other as whole words; or the same after venue keys
(aliases from config, then town names, "kulturhus", "scene", "salen" ... and
punctuation stripped); or (base rule only) same municipality and title ratio
>= SAME_TOWN_TITLE_RATIO.

The kept copy is the one from the higher-priority source (list passed in,
else input order). Empty fields of the kept copy are filled from the dropped
one; nothing it already has is overwritten. Every output event gets
`also_listed_at`: all source URLs of its cluster, its own first. The report
lists every merge with the rule that fired, and `near_misses`: pairs from
different sources on the same day that were kept apart although a title score
was within NEAR_MISS_MARGIN below its threshold, or the titles matched but
time, venue or complete linkage kept them apart, so thresholds can be tuned.
"""
import difflib
import re
import unicodedata
from datetime import date, datetime, time as dtime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit

MAX_MINUTES = 30
TITLE_JACCARD = 0.6
TITLE_RATIO = 0.85
CONTAIN_MIN_TOKENS = 2
VENUE_RATIO = 0.8
SAME_TOWN_TITLE_RATIO = 0.95
# Cross-source only (two different sources): looser, since copies are reworded.
CROSS_MAX_MINUTES = 60
CROSS_CONTAIN = 0.5
CROSS_JACCARD = 0.45
SIGNIFICANT_MIN_LEN = 4
NEAR_MISS_MARGIN = 0.15

# Filled into the kept copy only when it has no value of its own.
MERGE_FIELDS = ["end", "venue", "summary_en", "summary_no", "summary_de", "municipality",
                "original_url"]

FILLER = ["velkommen til", "avlyst", "utsatt", "konsert", "cancelled"]
_FILLER_RE = re.compile(r"\b(?:" + "|".join(re.escape(f) for f in FILLER) + r")\b")
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_PUNCT_RE = re.compile(r"[^\w\s]|_")
_NORDIC = str.maketrans({"æ": "ae", "ø": "o", "å": "a"})

# Folded forms. Stop words never count for cross-source title scores; generic
# event words count for the scores but are never the "significant" shared token.
STOPWORDS = {"og", "i", "pa", "med", "av", "til", "for", "fra", "om", "en", "et", "ei",
             "den", "det", "de", "som", "ved", "hos", "the", "and", "of", "a", "an",
             "in", "at", "on", "with", "by", "to", "live", "x"}
GENERIC = {"julekonsert", "konsert", "konserter", "konserten", "jul", "julen", "teater",
           "teateret", "forestilling", "show", "juleshow", "utstilling", "bingo",
           "musikkbingo", "quiz", "kurs", "workshop", "verksted", "juleverksted", "marked",
           "julemarked", "festival", "kveld", "aften", "dag", "dager", "helg", "helgen",
           "barn", "familie", "familiens", "tur", "trening", "foredrag", "omvisning",
           "kafe", "middag", "fest", "julebord", "gudstjeneste", "messe", "film",
           "kino", "stand", "comedy", "event", "hamar", "lillehammer", "gjovik",
           "innlandet", "barnas", "riksteatret", "teaterforestilling", "konsertserie",
           "jazz", "blues", "rock", "quiz", "julemoro", "matine"}
# Stripped from venue keys (whole words, folded).
VENUE_WORDS = {"kulturhus", "kulturhuset", "scene", "scenen", "salen", "storsalen"}
TOWNS = {"hamar", "lillehammer", "gjovik", "elverum", "kongsvinger", "brumunddal",
         "moelv", "stange", "loten", "ringsaker", "raufoss", "otta", "fagernes", "tynset",
         "trysil", "lena", "dokka", "vinstra", "gran", "jessheim", "innlandet"}
_TM_HOST_RE = re.compile(r"(?:^|\.)(ticketmaster\.[a-z.]+)$")
_TM_EVENT_RE = re.compile(r"^/(?:[^/]+/)*event/(?:[^/]+/)*([0-9A-Za-z]+)$")


def _fold(s: str | None) -> str:
    """casefold, æ/ø/å -> ae/o/a, strip accents, drop punctuation, collapse spaces."""
    s = (s or "").casefold().translate(_NORDIC)
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))
    return " ".join(_PUNCT_RE.sub(" ", s).split())


def norm_title(s: str | None) -> str:
    """For comparison only: folded, without years and filler words."""
    folded = _fold(s)
    stripped = " ".join(_FILLER_RE.sub(" ", _YEAR_RE.sub(" ", folded)).split())
    return stripped or folded  # a title that is only filler stays comparable


def norm_venue(s: str | None) -> str:
    return _fold(s)


def venue_key(s: str | None, aliases: dict[str, str] | None = None,
              towns: set[str] | None = None) -> str:
    """Venue for comparison: alias applied, town names and words like
    'kulturhus', 'scene', 'salen' removed. Falls back to the folded name if
    nothing is left (e.g. "Hamar Kulturhus")."""
    aliases = aliases or {}
    strip = VENUE_WORDS | TOWNS | (towns or set())

    def stripped(f: str) -> str:
        return " ".join(t for t in f.split() if t not in strip)

    f = _fold(s)
    f = aliases.get(f, f)
    key = stripped(f)
    key = stripped(aliases.get(key, key))
    return key or f


def norm_url(url: str | None) -> str:
    """Comparable link: no scheme, lowercase host without 'www.' or a default
    port, no trailing slash, fragment, utm_* or apikey params. Ticketmaster
    hosts (any subdomain) become ticketmaster.<tld> and event links are
    reduced to their id. '' for a non-web link or a bare home page (no path
    and no query)."""
    url = (url or "").strip()
    if not url:
        return ""
    try:
        p = urlsplit(url)
    except ValueError:
        return ""
    scheme = p.scheme.lower()
    try:
        host, port = (p.hostname or "").removeprefix("www."), p.port
    except ValueError:                     # bad port
        return ""
    if scheme not in ("http", "https") or not host:
        return ""
    if port is not None and port != {"http": 80, "https": 443}[scheme]:
        host = f"{host}:{port}"            # default ports dropped, others kept
    if (m := _TM_HOST_RE.search(host)):
        host = m.group(1)                  # any ticketmaster subdomain -> ticketmaster.<tld>
    path = re.sub(r"/{2,}", "/", p.path).rstrip("/")
    if host.startswith("ticketmaster.") and (m := _TM_EVENT_RE.match(path)):
        path = f"/event/{m.group(1)}"
    query = sorted((k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
                   if not k.lower().startswith("utm_") and k.lower() != "apikey")
    if not path and not query:
        return ""                          # bare home page: not an identity
    return host + path + ("?" + urlencode(query) if query else "")


def _is_tm_event(norm: str) -> bool:
    return bool(re.match(r"^ticketmaster\.[a-z.]+/event/[0-9A-Za-z]+$", norm))


# --- Oslo time without tzdata (not installed on Windows; stdlib only) -------

def _last_sunday(year: int, month: int) -> date:
    d = date(year, month + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() + 1) % 7)


def oslo_local(dt: datetime) -> datetime:
    """Europe/Oslo wall time: CET, CEST from last Sun of March to last Sun of
    October, switching at 01:00 UTC (EU rule, in force since 1996)."""
    u = dt.astimezone(timezone.utc)
    begin = datetime.combine(_last_sunday(u.year, 3), dtime(1), timezone.utc)
    end = datetime.combine(_last_sunday(u.year, 10), dtime(1), timezone.utc)
    return u + timedelta(hours=2 if begin <= u < end else 1)


def to_aware(dt: datetime) -> datetime:
    """A naive timestamp is taken as Oslo wall time (offset +01:00 or +02:00)."""
    if dt.tzinfo is not None:
        return dt
    for hours in (1, 2):
        cand = dt.replace(tzinfo=timezone(timedelta(hours=hours)))
        if oslo_local(cand).replace(tzinfo=None) == dt:
            return cand
    return dt.replace(tzinfo=timezone(timedelta(hours=1)))  # wall time in the DST gap


def _time_known(e: dict, start: datetime) -> bool:
    """Explicit flag if present; else, like the web server, a midnight start
    means a date-only listing."""
    if "time_known" in e:
        return bool(e["time_known"])
    return start.timetz().replace(tzinfo=None) != dtime(0, 0)


# --- rules ------------------------------------------------------------------

def _contains(short: str, long: str) -> bool:
    return f" {short} " in f" {long} "


def _jaccard(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    return len(sa & sb) / len(sa | sb) if sa | sb else 0.0


def _ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a, b).ratio()


def _significant(tokens) -> list[str]:
    return sorted(t for t in tokens if len(t) >= SIGNIFICANT_MIN_LEN and t not in GENERIC
                  and t not in STOPWORDS and not t.isdigit())


class _Info:
    __slots__ = ("e", "start", "day", "known", "title", "tokens", "venue", "vkey",
                 "town", "source", "origin", "urls")

    def __init__(self, e: dict, aliases: dict[str, str] | None = None):
        self.e = e
        self.start = to_aware(datetime.fromisoformat(e["start"]))
        self.day = oslo_local(self.start).date()
        self.known = _time_known(e, self.start)
        self.title = norm_title(e.get("title"))
        self.tokens = set(self.title.split()) - STOPWORDS
        self.venue = norm_venue(e.get("venue"))
        self.town = _fold(e.get("municipality"))
        self.vkey = venue_key(e.get("venue"), aliases, {self.town} if self.town else None)
        self.source = e.get("source_id") or ""
        self.origin = self.source
        self.urls = {u for u in (norm_url(e.get("source_url")), norm_url(e.get("original_url")))
                     if u}


def _time(a: _Info, b: _Info) -> tuple[float, str | None, bool]:
    """(minutes apart, base time rule or None, cross-source time ok)."""
    minutes = abs((a.start - b.start).total_seconds()) / 60
    if not (a.known and b.known):
        return minutes, "same_day_time_unknown", True
    base = f"within_{MAX_MINUTES}_min" if minutes <= MAX_MINUTES else None
    return minutes, base, minutes <= CROSS_MAX_MINUTES


def _titles(a: _Info, b: _Info) -> dict:
    """Every title score, the base rule and the cross-source rule (None = no)."""
    jac, rat = _jaccard(a.title, b.title), _ratio(a.title, b.title)
    short, long = sorted((a.title, b.title), key=len)
    if jac >= TITLE_JACCARD:
        base = "jaccard"
    elif rat >= TITLE_RATIO:
        base = "ratio"
    elif len(short.split()) >= CONTAIN_MIN_TOKENS and _contains(short, long):
        base = "contains"
    else:
        base = None
    shared = a.tokens & b.tokens
    union = a.tokens | b.tokens
    smaller = min(len(a.tokens), len(b.tokens))
    cont = len(shared) / smaller if smaller else 0.0
    cjac = len(shared) / len(union) if union else 0.0
    sig = _significant(shared)
    sa, sb = set(_significant(a.tokens)), set(_significant(b.tokens))
    ss, sl = sorted((sa, sb), key=len)
    sig_subset = bool(ss) and ss <= sl     # shorter title's significant tokens all in the other
    enough = len(sig) >= 2 or sig_subset
    if enough and cont >= CROSS_CONTAIN:
        cross = "token_containment"
    elif enough and cjac >= CROSS_JACCARD:
        cross = "token_jaccard"
    else:
        cross = None
    return {"jaccard": jac, "ratio": rat, "containment": cont, "cross_jaccard": cjac,
            "significant": sig, "sig_subset": sig_subset, "base": base, "cross": cross}


def venue_rule(a: _Info, b: _Info, title_ratio: float | None = None) -> str | None:
    """Why the venues are compatible, or None. title_ratio=None disables the
    same-municipality fallback (the cross-source rule passes 1.0 only for a
    strong title at the same time, else None)."""
    if not a.venue or not b.venue:
        return "venue_missing"
    if _ratio(a.venue, b.venue) >= VENUE_RATIO:
        return "venue_ratio"
    vshort, vlong = sorted((a.venue, b.venue), key=len)
    if _contains(vshort, vlong):
        return "venue_contains"
    kshort, klong = sorted((a.vkey, b.vkey), key=len)
    if a.vkey == b.vkey or _ratio(a.vkey, b.vkey) >= VENUE_RATIO or _contains(kshort, klong):
        return "venue_alias"
    if (title_ratio is not None and a.town and a.town == b.town
            and title_ratio >= SAME_TOWN_TITLE_RATIO):
        return "same_municipality"
    return None


def _scores(minutes: float, t: dict, a: _Info, b: _Info) -> dict:
    v_rat = _ratio(a.venue, b.venue) if a.venue and b.venue else None
    return {"minutes_apart": round(minutes, 1), "title_jaccard": round(t["jaccard"], 3),
            "title_ratio": round(t["ratio"], 3),
            "title_containment": round(t["containment"], 3),
            "title_cross_jaccard": round(t["cross_jaccard"], 3),
            "venue_ratio": None if v_rat is None else round(v_rat, 3)}


def compare(a: _Info, b: _Info, ambiguous: set | None = None) -> dict | None:
    """Rule, scores and sub-rules if a and b are the same event, else None.

    `ambiguous` holds (source, day, url) triples that must not count as an
    identity link.
    """
    if a.day != b.day:
        return None
    minutes, base_time, cross_time = _time(a, b)
    t = _titles(a, b)
    bad = ambiguous or set()
    shared = sorted(u for u in a.urls & b.urls
                    if (a.source, a.day, u) not in bad and (b.source, b.day, u) not in bad)
    # A shared link needs some title agreement too, except a Ticketmaster event id.
    title_ok = bool(t["significant"] or t["base"] or t["cross"])
    shared = [u for u in shared if title_ok or _is_tm_event(u)]
    if shared and cross_time:
        return {"rule": "url_identity", "url": shared[0], "scores": _scores(minutes, t, a, b),
                "rules": {"time": base_time or f"within_{CROSS_MAX_MINUTES}_min",
                          "title": t["base"] or t["cross"] or "differs", "venue": "url"}}
    if base_time and t["base"]:
        venue = venue_rule(a, b, t["ratio"])
        if venue:
            return {"rule": "base", "scores": _scores(minutes, t, a, b),
                    "rules": {"time": base_time, "title": t["base"], "venue": venue}}
    if (a.source == b.source and a.known and b.known and minutes == 0
            and a.venue and b.venue and a.vkey == b.vkey and t["sig_subset"]):
        return {"rule": "same_source_exact", "scores": _scores(minutes, t, a, b),
                "rules": {"time": "same_start", "title": "significant_subset",
                          "venue": "same_venue_key"}}
    if a.origin != b.origin and cross_time and (t["base"] or t["cross"]):
        strong = bool(t["base"]) and a.known and b.known and minutes <= MAX_MINUTES
        venue = venue_rule(a, b, 1.0 if strong else None)
        if venue == "venue_missing" and not (a.known and b.known):
            venue = None                   # no venue AND no time: too little to go on
        if venue:
            return {"rule": "cross_source", "scores": _scores(minutes, t, a, b),
                    "rules": {"time": base_time or f"within_{CROSS_MAX_MINUTES}_min",
                              "title": t["base"] or t["cross"], "venue": venue}}
    return None


def _near_miss(a: _Info, b: _Info, linked: bool) -> dict | None:
    """Why a same-day cross-source pair that was kept apart came close, or None."""
    minutes, base_time, cross_time = _time(a, b)
    t = _titles(a, b)
    if linked:
        reason = "complete_linkage"        # matches, but not every cluster member
    elif t["base"] or t["cross"]:
        if not cross_time:
            reason = "time"
        elif venue_rule(a, b) is None:
            reason = "venue"
        else:
            return None
    else:
        close = [name for name, score, thr in (
                    ("title_jaccard", t["jaccard"], TITLE_JACCARD),
                    ("title_ratio", t["ratio"], TITLE_RATIO),
                    ("title_containment", t["containment"] if t["significant"] else 0.0,
                     CROSS_CONTAIN),
                    ("title_cross_jaccard", t["cross_jaccard"] if t["significant"] else 0.0,
                     CROSS_JACCARD))
                 if thr - NEAR_MISS_MARGIN <= score < thr]
        if not close:
            return None
        reason = "title_close:" + ",".join(close)
    return {"a": a.e.get("source_url"), "b": b.e.get("source_url"),
            "a_title": a.e.get("title"), "b_title": b.e.get("title"),
            "a_venue": a.e.get("venue"), "b_venue": b.e.get("venue"),
            "reason": reason, "scores": _scores(minutes, t, a, b)}


def _fill(kept: dict, other: dict):
    for f in MERGE_FIELDS:
        if not kept.get(f) and other.get(f):
            kept[f] = other[f]


def _try_info(e: dict, aliases) -> _Info | None:
    try:
        return _Info(e, aliases)
    except (KeyError, TypeError, ValueError, AttributeError):
        return None


def _ambiguous_links(infos: list[_Info]) -> set:
    """(source, day, url) used by two or more events of one source on one day."""
    seen, bad = {}, set()
    for info in infos:
        for u in info.urls:
            k = (info.source, info.day, u)
            if k in seen and seen[k] is not info.e:
                bad.add(k)
            seen.setdefault(k, info.e)
    return bad


def match(events: list[dict], priority: list[str] | None = None,
          venue_aliases: dict[str, str] | None = None) -> tuple[list[dict], dict]:
    """Merge fuzzy duplicates. Returns (kept events, report).

    `priority` lists source_ids, most original first; sources not in it come
    after, and ties go to input order. `venue_aliases` maps a venue name to
    the name it should compare as (both folded here, so case and æøå do not
    matter).

    An event joins a cluster only if it matches EVERY member already in it
    (complete linkage), so a later head change cannot pull in copies that do
    not match the new head, and A~B~C chains do not merge A with C. Each event
    is compared only with clusters on the same Oslo day, so cost stays small.
    Remaining order dependence: an event that could join two clusters joins
    the one created first, and greedy assignment means a different input order
    can split a borderline group differently.

    Never crashes on bad starts: an event whose start is missing or
    unparsable is passed through unmatched and listed in report["skipped"].
    A naive start is read as Oslo wall time.
    """
    prio = {s: i for i, s in enumerate(priority or [])}
    aliases = {_fold(k): _fold(v) for k, v in (venue_aliases or {}).items() if k and v}

    def rank(i: int, e: dict) -> tuple:
        return (prio.get(e.get("source_id"), len(prio)), i)

    infos = [_try_info(e, aliases) for e in events]
    ambiguous = _ambiguous_links([x for x in infos if x is not None])

    clusters = []   # {"head": _Info, "rank", "members": [(i, _Info)], "links": []}
    by_day: dict[date, list] = {}
    cluster_of: dict[int, int] = {}          # id(_Info) -> cluster index
    skipped = []
    for i, (e, info) in enumerate(zip(events, infos)):
        if info is None:
            skipped.append(e.get("source_url"))
            clusters.append({"head": None, "e": e, "members": [], "links": []})
            continue
        hit = None
        for c in by_day.get(info.day, []):
            if all(compare(m, info, ambiguous) for _, m in c["members"]):
                hit = (c, compare(c["head"], info, ambiguous))
                break
        if hit is None:
            c = {"head": info, "rank": rank(i, e), "members": [(i, info)], "links": []}
            cluster_of[id(info)] = len(clusters)
            clusters.append(c)
            by_day.setdefault(info.day, []).append(c)
            continue
        c, res = hit
        cluster_of[id(info)] = cluster_of[id(c["members"][0][1])]
        # (event that joined, cluster head it was compared with, result)
        c["links"].append((e, c["head"].e, res))
        c["members"].append((i, info))
        if rank(i, e) < c["rank"]:  # more original source: becomes the head
            c["head"], c["rank"] = info, rank(i, e)

    kept, merged = [], []
    for c in clusters:                       # clusters are in first-seen order
        if c["head"] is None:                # unparsable start: passed through
            kept.append({**c["e"], "also_listed_at": [c["e"].get("source_url")]})
            continue
        keeper = c["head"].e
        head = dict(keeper)
        others = sorted(((i, m) for i, m in c["members"] if m is not c["head"]),
                        key=lambda im: rank(im[0], im[1].e))
        for _, m in others:
            _fill(head, m.e)
        # Kept copy is date-only but another copy has the time: take it.
        time_from = None
        if not c["head"].known:
            timed = next((m for _, m in others if m.known), None)
            if timed is not None:
                head["start"], head["end"] = timed.e["start"], timed.e.get("end")
                head["time_known"] = True
                time_from = timed.e["source_url"]
        copies = [keeper] + [m.e for _, m in others]
        conflict = len({bool(x.get("cancelled")) for x in copies}) > 1
        if conflict:  # never hide a cancellation from users
            head["cancelled"] = True
        head["also_listed_at"] = list(dict.fromkeys(x["source_url"] for x in copies))
        kept.append(head)
        # One report entry per dropped copy, with the comparison that pulled it in
        # (the cluster's first event never "joined", so it uses the first link).
        for _, m in others:
            link = next((l for l in c["links"] if l[0] is m.e), c["links"][0])
            entry = {"kept": keeper["source_url"], "dropped": m.e["source_url"],
                     "kept_source": keeper.get("source_id"),
                     "dropped_source": m.e.get("source_id"),
                     "kept_title": keeper["title"], "dropped_title": m.e["title"],
                     "compared": [link[1]["source_url"], link[0]["source_url"]],
                     **link[2]}
            if conflict:
                entry["cancelled_conflict"] = True
            if time_from == m.e["source_url"]:
                entry["time_taken_from_dropped"] = True
            merged.append(entry)

    # Near misses: same-day pairs from different sources left in different clusters.
    near = []
    for day_clusters in by_day.values():
        members = [m for c in day_clusters for _, m in c["members"]]
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                a, b = members[x], members[y]
                if a.origin == b.origin or cluster_of[id(a)] == cluster_of[id(b)]:
                    continue
                nm = _near_miss(a, b, compare(a, b, ambiguous) is not None)
                if nm:
                    near.append(nm)

    by_rule: dict[str, int] = {}
    for m in merged:
        by_rule[m["rule"]] = by_rule.get(m["rule"], 0) + 1
    report = {"input": len(events), "output": len(kept),
              "removed": len(events) - len(kept),
              "thresholds": {"max_minutes": MAX_MINUTES, "title_jaccard": TITLE_JACCARD,
                             "title_ratio": TITLE_RATIO,
                             "contain_min_tokens": CONTAIN_MIN_TOKENS,
                             "venue_ratio": VENUE_RATIO,
                             "same_town_title_ratio": SAME_TOWN_TITLE_RATIO,
                             "cross_max_minutes": CROSS_MAX_MINUTES,
                             "cross_containment": CROSS_CONTAIN,
                             "cross_jaccard": CROSS_JACCARD,
                             "near_miss_margin": NEAR_MISS_MARGIN},
              "priority": list(priority or []), "venue_aliases": aliases,
              "merged_by_rule": by_rule, "skipped": skipped, "merged": merged,
              "near_misses": near}
    return kept, report
