// Beveg question parser: a pure, rule-based parser (no network, no LLM).
// Extracted unchanged from the old talk.js. Given the text, the events from
// /api/events and the origins from /api/config, TalkParser.parse() says what was
// asked (dates, categories, places, free text, trip/weather intent);
// TalkParser.match() finds the events. Also runs under Node for testing.
"use strict";

const TalkParser = (() => {
  // Lower case, strip accents (å -> a, é -> e, ä -> a, ß -> ss); æ and ø stay.
  // Vocabulary and the user's text go through the same function, so they agree.
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").normalize("NFC");
  const tokens = (s) => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const rawTokens = (s) => String(s || "").toLowerCase().normalize("NFC")
    .replace(/ß/g, "ss").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const set = (list) => new Set(list.map(norm));

  // Word plus a stem without a common Norwegian/German/English ending
  // ("julemarkedet" -> "julemarked", "konserter" -> "konsert").
  function stems(w) {
    const out = [w];
    if (w.length >= 6) for (const end of ["ene", "ane", "er", "et", "en", "es", "a", "e", "s"])
      if (w.endsWith(end) && w.length - end.length >= 4) { out.push(w.slice(0, -end.length)); break; }
    return out;
  }

  // ---------- vocabulary ----------

  // Multi-word phrases first (longest match wins at each position).
  const DATE_WORDS = {
    today: ["i dag", "idag", "today", "heute", "heute morgen"],
    tonight: ["i kveld", "ikveld", "i natt", "tonight", "this evening", "heute abend", "heute nacht"],
    tomorrow: ["i morgen", "imorgen", "tomorrow", "morgen"],
    weekend: ["i helga", "i helgen", "i helg", "denne helga", "denne helgen", "helga", "helgen", "helg",
      "this weekend", "the weekend", "weekend", "am wochenende", "dieses wochenende", "wochenende"],
    next_weekend: ["neste helg", "neste helga", "neste helgen", "next weekend",
      "nächstes wochenende", "nächste wochenende", "kommendes wochenende"],
    this_week: ["denne uka", "denne uken", "this week", "diese woche"],
    next_week: ["neste uke", "neste uka", "neste veke", "next week", "nächste woche", "kommende woche"],
  };
  const EVENING = ["kveld", "kvelden", "kveldstid", "evening", "abend", "abends"];
  // JS weekday numbers: 0 = Sunday ... 6 = Saturday.
  const WEEKDAYS = [
    ["søndag", "sunday", "sonntag"], ["mandag", "monday", "montag"], ["tirsdag", "tuesday", "dienstag"],
    ["onsdag", "wednesday", "mittwoch"], ["torsdag", "thursday", "donnerstag"],
    ["fredag", "friday", "freitag"], ["lørdag", "saturday", "samstag", "sonnabend"],
  ];
  const WEEKDAY_PREFIX = ["", "på", "on", "am", "denne", "this", "diesen"];
  // "neste fredag" said on a Friday means the Friday a week later.
  const WEEKDAY_NEXT = ["neste", "next", "nächsten", "nächster", "kommende", "kommenden"];
  const MONTHS = [
    ["januar", "january"], ["februar", "february"], ["mars", "march", "märz"], ["april"],
    ["mai", "may"], ["juni", "june"], ["juli", "july"], ["august"], ["september"],
    ["oktober", "october"], ["november"], ["desember", "december", "dezember"],
  ];
  // English words that are also ordinary words: a month only after "in" or with a day number.
  const AMBIGUOUS_MONTH = set(["may", "march"]);
  const INTENT_WORDS = {
    next: ["neste", "flere", "fler", "mer", "videre", "vis flere", "next", "more", "show more",
      "other", "others", "anything else", "something else", "noe annet", "noe mer",
      "weiter", "mehr", "nächste", "die nächsten", "andere", "anderes", "anderen", "etwas anderes"],
    weather: ["vær", "været", "værmelding", "værmeldingen", "værvarsel", "værvarselet", "yr",
      "regn", "regne", "regner", "temperatur", "temperaturen", "kaldt", "varmt",
      "weather", "forecast", "rain", "raining", "temperature", "cold", "warm",
      "wetter", "wettervorhersage", "vorhersage", "regen", "regnet", "kalt"],
    // Phrases that are clearly a travel question on their own.
    trip: ["kommer jeg dit", "komme meg dit", "komme dit", "kommer dit", "komme seg dit", "reise dit",
      "kommer jeg meg dit", "hvordan kommer jeg", "hvordan kommer man", "hvordan komme seg", "komme meg",
      "kommer meg", "kommer jeg til", "komme meg til", "veien dit",
      "get there", "getting there", "how do i get", "how to get", "how can i get", "directions",
      "komme ich hin", "komme ich dahin", "wie komme ich", "hinkommen", "anreise", "anfahrt"],
    // Transport words: only a travel question together with a question/travel cue
    // ("Hvilken buss går dit?"), so "Jeg tok toget" is not one.
    trip_weak: ["reise", "reisen", "buss", "bussen", "tog", "toget", "kollektivt", "rute", "ruten",
      "travel", "bus", "train", "route", "zug", "verbindung", "fahren"],
  };
  const TRIP_CUES = set(["hvordan", "hvilken", "hvilket", "hvilke", "når", "dit", "ta", "fra", "frå",
    "how", "which", "when", "there", "take", "from", "wie", "welche", "welcher", "welchen", "wann",
    "hin", "dahin", "nehmen", "von", "ab"]);
  const ORDINALS = [
    [0, ["første", "først", "first", "erste", "ersten", "erster", "1", "nummer en", "nummer ett",
      "nummer 1", "number one", "number 1", "nummer eins"]],
    [1, ["andre", "second", "zweite", "zweiten", "zweiter", "2", "nummer to", "nummer 2",
      "number two", "number 2", "nummer zwei"]],
    [2, ["tredje", "third", "dritte", "dritten", "dritter", "3", "nummer tre", "nummer 3",
      "number three", "number 3", "nummer drei"]],
    [-1, ["siste", "last", "letzte", "letzten", "letzter"]],
  ];
  // 4-10: words, and "nummer/number" with a digit or a number word. (Bare digits 4-10
  // are not ordinals: they are too often a time or a day.)
  [
    ["fjerde", "fourth", "vierte", "fire", "four", "vier"],
    ["femte", "fifth", "fünfte", "fem", "five", "fünf"],
    ["sjette", "sixth", "sechste", "seks", "six", "sechs"],
    ["sjuende", "seventh", "siebte", "sju", "seven", "sieben", "syvende", "syv"],
    ["åttende", "eighth", "achte", "åtte", "eight", "acht"],
    ["niende", "ninth", "neunte", "ni", "nine", "neun"],
    ["tiende", "tenth", "zehnte", "ti", "ten", "zehn"],
  ].forEach(([no, en, de, noNum, enNum, deNum, noAlt, noAltNum], k) => {
    const n = k + 4, list = [no, en, de, `${de}n`, `${de}r`, `nummer ${n}`, `number ${n}`,
      `nummer ${noNum}`, `number ${enNum}`, `nummer ${deNum}`];
    if (noAlt) list.push(noAlt, `nummer ${noAltNum}`);
    ORDINALS.push([n - 1, list]);
  });
  // An ordinal counts only after one of these ("den andre"), with a weather/trip
  // question, or when nothing else was said; "andre ting" is not "the second".
  const ORD_LEAD = set(["den", "det", "the", "die", "der", "das", "dem", "nummer", "number", "for", "til", "zum", "zur", "beim"]);
  // "andre" before a noun like these, or after one of the verbs/words below, means
  // "other" ("Har dere andre ting?"): it then works like "neste" (show more).
  const OTHER_NOUNS = set(["ting", "arrangementer", "arrangement", "aktiviteter", "forslag", "steder", "konserter",
    "events", "things", "ones", "veranstaltungen", "sachen"]);
  const OTHER_BEFORE = set(["har", "vise", "vis", "noe", "noen", "finnes", "fins", "flere", "gi", "some", "any"]);

  // Category keywords -> the 14 category keys. "within" also matches inside a
  // compound word (julemarked, julekonsert, weihnachtsmarkt), "prefix" matches the
  // start of a word (kurs, kurset), "exact" only the whole word.
  const CATEGORY_WORDS = [
    ["concert", "within", ["konsert", "musikk", "concert", "konzert", "jazz"]],
    ["concert", "exact", ["musik", "music", "rock", "band", "kor", "korps", "chor", "gig", "gigs"]],
    ["concert", "prefix", ["choir"]],
    ["theatre", "within", ["teater", "theatre", "theater", "forestilling"]],
    ["theatre", "prefix", ["revy", "musikal", "musical", "schauspiel", "aufführung", "drama", "opera", "ballett", "ballet"]],
    ["theatre", "exact", ["oper"]],
    ["talk", "within", ["foredrag", "vortrag", "vorträge"]],
    ["talk", "prefix", ["lecture", "debatt", "debate", "seminar", "samtale"]],
    ["talk", "exact", ["talk", "talks"]],
    ["exhibition", "within", ["utstilling", "ausstellung", "kunst", "exhibition"]],
    ["exhibition", "prefix", ["museum", "galleri", "gallery", "galerie", "exhibit"]],
    ["exhibition", "exact", ["art"]],
    ["sports", "within", ["idrett", "fotball", "football", "fussball", "håndball", "hockey", "trening", "training"]],
    ["sports", "prefix", ["sport", "soccer", "yoga", "skiing", "kampen"]],
    ["sports", "exact", ["ski", "trim", "kamp", "match"]],
    // "kind" alone is also English and German ("what kind", "das Kind"): only "kinder"/"für Kinder".
    ["kids", "prefix", ["barn", "kids", "children", "child", "familie", "family", "families", "kinder", "baby"]],
    ["kids", "exact", ["kid"]],
    ["senior", "within", ["pensjonist"]],
    ["senior", "prefix", ["senior", "pensioner", "retired", "rentner"]],
    ["senior", "exact", ["eldre", "elderly"]],
    ["course", "prefix", ["kurs", "course"]],
    ["course", "exact", ["class", "classes"]],
    ["market", "within", ["marked", "market", "markt"]],
    ["market", "prefix", ["loppis", "basar", "bazaar", "flea"]],
    ["food_drink", "prefix", ["food", "drink", "drikke", "kafe", "cafe", "kaffe", "coffee", "middag",
      "dinner", "lunsj", "lunch", "brunsj", "brunch", "beer", "wein"]],
    ["food_drink", "exact", ["mat", "maten", "essen", "trinken", "vin", "wine", "øl", "bier"]],
    ["religious", "within", ["gudstjeneste", "gottesdienst"]],
    ["religious", "prefix", ["andakt", "andacht", "religiøs", "religious", "worship"]],
    ["religious", "exact", ["messe"]],
    ["meeting", "within", ["møte", "treff"]],
    ["meeting", "prefix", ["meeting"]],
    ["meeting", "exact", ["treffen"]],
    ["workshop", "within", ["verksted", "workshop", "werkstatt"]],
    ["workshop", "prefix", ["hobby", "maker"]],
    ["workshop", "exact", ["diy"]],
  ].map(([cat, how, words]) => [cat, how, words.map(norm)]);

  // Words that mean "church" match venues with "kirke" in them (a place, not a category).
  const PLACE_ALIASES = { kirke: ["kirke", "kirka", "kirken", "kyrkje", "church", "kirche"] };
  // Venue words too generic to count as a place on their own.
  const GENERIC_PLACE = set(["scene", "salen", "huset", "senter", "senteret", "folkets", "etg",
    "kommune", "unummerert", "gate", "gata", "vegen", "veien"]);

  // Words for travel origins in /api/config: alias -> a word in the origin's name.
  const ORIGIN_ALIASES = {
    stasjon: ["stasjon", "stasjonen", "jernbanestasjon", "jernbanestasjonen", "station", "bahnhof"],
    lufthavn: ["lufthavn", "lufthavna", "lufthavnen", "flyplass", "flyplassen", "gardermoen", "airport", "flughafen"],
    universitetet: ["universitet", "universitetet", "university", "campus", "høgskolen", "uni", "universität", "hochschule"],
  };
  const FROM_WORDS = set(["fra", "frå", "from", "von", "ab"]);
  const FROM_END = set(["til", "to", "zu", "nach", "kl", "klokka", "klokken"]);

  // Answers to "Mener du ...?". Filler words around them are ignored ("ja takk", "yes please").
  const YES = set(["ja", "jepp", "japp", "jo", "jada", "javisst", "stemmer", "riktig", "korrekt", "akkurat",
    "yes", "yeah", "yep", "yup", "correct", "right", "exactly", "sure", "richtig", "genau", "jawohl", "stimmt"]);
  const NO = set(["nei", "neida", "nope", "no", "nah", "nein", "nee", "feil", "wrong", "falsch", "ikke", "not"]);
  const YN_FILLER = set(["det", "den", "er", "takk", "gjerne", "that", "thats", "s", "it", "is", "please",
    "thanks", "thank", "you", "bitte", "danke", "das", "ist", "ok", "okay", "oh", "ah", "hmm", "one", "dem", "der", "die"]);

  const STOP = set([
    // Norwegian
    "hva", "skjer", "det", "er", "noe", "noen", "på", "i", "for", "til", "med", "og", "eller", "en", "et", "ei",
    "jeg", "vi", "vil", "kan", "gå", "går", "gjøre", "finnes", "fins", "har", "dere", "du", "meg", "oss", "vis", "finn",
    "gi", "om", "ting", "arrangement", "arrangementer", "arrangementet", "aktivitet", "aktiviteter", "som",
    "der", "her", "hvor", "hvilke", "hvilken", "hvilket", "slags", "skal", "kunne", "være", "bli", "blir", "ha", "nå",
    "nær", "nærheten", "snart", "fremover", "framover", "kommende", "gjerne", "takk", "hei", "hallo", "litt",
    "mye", "kanskje", "ute", "inne", "dit", "dem", "den", "de", "sted", "steder", "hos", "ved", "av", "ja",
    "nei", "ok", "okei", "min", "mitt", "alle", "alt", "ett", "også", "bare", "at", "hvordan", "når", "klokka",
    "kl", "rundt", "området", "byen", "lyst", "tips", "anbefale", "morsomt", "gøy", "fint", "dag", "nummer",
    "valgt", "velg", "velge", "sånn", "sjekk", "fortell", "si", "spør", "seg", "sin", "deg", "kommer", "komme",
    "ta", "tok", "tar", "man", "vise", "viser", "vist", "dere",
    // English
    "what", "whats", "s", "is", "are", "on", "in", "at", "to", "the", "a", "an", "any", "anything",
    "something", "some", "things", "thing", "events", "event", "show", "me", "find", "can", "could", "there",
    "happening", "going", "do", "does", "near", "around", "please", "tell", "about", "and", "or", "of",
    "with", "my", "we", "us", "you", "it", "this", "that", "be", "will", "would", "like", "want", "good",
    "fun", "nice", "upcoming", "soon", "coming", "up", "here", "where", "which", "when", "how", "get", "one",
    "ones", "hi", "hello", "okay", "thanks", "area", "town", "city", "place", "places", "by", "out", "go",
    "see", "have", "has", "number", "choose", "pick", "for", "take", "kind", "type", "sort", "i",
    "may", "might", "march", "else", "other", "others",
    // German
    "was", "ist", "sind", "los", "gibt", "gibts", "es", "im", "am", "an", "um", "für", "zum", "zur", "der",
    "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "etwas", "veranstaltung",
    "veranstaltungen", "zeig", "zeige", "zeigen", "mir", "uns", "bitte", "ich", "wir", "sie", "kann",
    "können", "wo", "welche", "welcher", "welchen", "und", "oder", "mit", "bei", "beim", "nach", "zu", "auch", "mal",
    "hier", "da", "dort", "gern", "gerne", "danke", "ja", "nein", "irgendwas", "irgendetwas", "demnächst",
    "bald", "wie", "wann", "möchte", "will", "gehen", "machen", "tun", "sehen", "nähe", "umgebung", "stadt",
    "ort", "schön", "wird", "werden", "nummer", "hin", "dahin", "nehmen", "komme", "kommen",
    // Age groups without a category of their own: understood, but not a filter
    // (else "ungdom" would match the venue "Brumunddal Ungdomsskole").
    "ungdom", "ungdommer", "ungdommen", "unge", "tenåring", "tenåringer", "youth", "teen", "teens",
    "teenager", "teenagers", "jugend", "jugendliche", "jugendlichen",
  ]);

  // One table of phrases, longest first, so "neste uke" beats "neste".
  const PHRASES = [];
  const addPhrase = (text, type, value) => PHRASES.push({ toks: tokens(text), type, value });
  for (const [kind, list] of Object.entries(DATE_WORDS)) for (const p of list) addPhrase(p, "date", kind);
  for (const p of EVENING) addPhrase(p, "evening", true);
  WEEKDAYS.forEach((names, wd) => {
    for (const n of names) {
      for (const pre of WEEKDAY_PREFIX) addPhrase(`${pre} ${n}`.trim(), "wd", { wd, next: false });
      for (const pre of WEEKDAY_NEXT) addPhrase(`${pre} ${n}`, "wd", { wd, next: true });
    }
  });
  MONTHS.forEach((names, i) => { for (const n of names) addPhrase(n, "month", i + 1); });
  for (const [type, list] of Object.entries(INTENT_WORDS)) for (const p of list) addPhrase(p, type, true);
  for (const [n, list] of ORDINALS) for (const p of list) addPhrase(p, "ord", n);
  PHRASES.sort((a, b) => b.toks.length - a.toks.length);
  const MONTH_OF = new Map();
  MONTHS.forEach((names, i) => names.forEach((n) => MONTH_OF.set(norm(n), i + 1)));
  const DAY_NUM = /^(\d{1,2})(st|nd|rd|th|ste|nde|te)?$/;

  // ---------- dates (Europe/Oslo calendar days as "YYYY-MM-DD") ----------

  const osloDay = (d) => new Date(d).toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" });
  const osloHour = (iso) => Number(new Date(iso).toLocaleString("en-GB",
    { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }));
  const addDays = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
  const pad = (n) => String(n).padStart(2, "0");

  function dateRange(spec, today) {
    const wd = weekday(today);
    const sat = wd === 0 ? addDays(today, -1) : addDays(today, (6 - wd + 7) % 7);
    const nextMon = addDays(today, (8 - wd) % 7 || 7);
    switch (spec.kind) {
      case "today": return { from: today, to: today };
      case "tonight": return { from: today, to: today, evening: true };
      case "tomorrow": { const d = addDays(today, 1); return { from: d, to: d }; }
      // Weekend = Saturday and Sunday; on a Sunday, just today.
      case "weekend": return { from: wd === 0 ? today : sat, to: addDays(sat, 1) };
      case "next_weekend": return { from: addDays(sat, 7), to: addDays(sat, 8) };
      case "this_week": return { from: today, to: addDays(today, (7 - wd) % 7) };
      case "next_week": return { from: nextMon, to: addDays(nextMon, 6) };
      case "wd": {
        // "lørdag neste uke" -> that weekday in next week; "neste fredag" on a Friday -> in 7 days;
        // otherwise the next one from today (today included).
        let delta = (spec.wd - wd + 7) % 7;
        if (spec.next && delta === 0) delta = 7;
        const d = spec.inNextWeek ? addDays(nextMon, (spec.wd + 6) % 7) : addDays(today, delta);
        return { from: d, to: d };
      }
      case "day": return { from: spec.ymd, to: spec.ymd };
      case "month": {
        const [y, m] = today.split("-").map(Number);
        const year = spec.month >= m ? y : y + 1;
        const first = `${year}-${pad(spec.month)}-01`;
        const last = addDays(spec.month === 12 ? `${year + 1}-01-01` : `${year}-${pad(spec.month + 1)}-01`, -1);
        return { from: first < today ? today : first, to: last };
      }
    }
    return null;
  }

  // "5. desember", "3 december", "December 3", "the 3rd of December" -> one day (this year,
  // or next year if it has passed). The number is used up, so it is not read as an ordinal.
  function findDay(toks, used, today) {
    for (let i = 0; i < toks.length; i++) {
      const month = MONTH_OF.get(toks[i]);
      if (!month || used[i]) continue;
      let at = -1;
      if (i > 0 && DAY_NUM.test(toks[i - 1])) at = i - 1;
      else if (i > 1 && toks[i - 1] === "of" && DAY_NUM.test(toks[i - 2])) at = i - 2;
      else if (i + 1 < toks.length && DAY_NUM.test(toks[i + 1])) at = i + 1;
      if (at < 0) continue;
      const day = Number(DAY_NUM.exec(toks[at])[1]);
      const lo = Math.min(at, i), hi = Math.max(at, i);
      const [y] = today.split("-").map(Number);
      let ymd = `${y}-${pad(month)}-${pad(day)}`;
      if (ymd < today) ymd = `${y + 1}-${pad(month)}-${pad(day)}`;
      const check = new Date(`${ymd}T12:00:00Z`);
      for (let k = lo; k <= hi; k++) used[k] = true;
      if (day < 1 || day > 31 || check.getUTCMonth() + 1 !== month) return { kind: "bad", day, month }; // 31. november
      return { kind: "day", ymd, day, month };
    }
    return null;
  }

  // ---------- parse ----------

  /**
   * parse(text, { origins, events, now }) -> {
   *   intent: "search" | "next" | "weather" | "trip" | "select",
   *   date: null | { kind, wd?, month?, day?, ymd?, from, to, evening? },
   *   evening, cats: [category keys], catWords: [the words that gave them],
   *   places: [words], words: [free-text words],
   *   ordinal: null | 0 | 1 | 2 | -1, origin: null | origin object, originText: "",
   *   hasCriteria, names }   // names: the text names an event (words, place, category or date)
   */
  function parse(text, ctx = {}) {
    const toks = tokens(text), raw = rawTokens(text);
    const used = new Array(toks.length).fill(false);
    const out = { intent: "search", date: null, evening: false, cats: [], catWords: [], places: [], words: [],
                  ordinal: null, origin: null, originText: "", hasCriteria: false, names: false };
    const today = osloDay(ctx.now ?? Date.now());
    let dateSpec = findDay(toks, used, today), wd = null, month = null, flags = {}, ord = null;
    if (dateSpec?.kind === "bad") { out.badDate = { day: dateSpec.day, month: dateSpec.month }; dateSpec = null; }

    // 1. Phrases: dates, weekdays, months, evening, follow-up intents, ordinals.
    for (let i = 0; i < toks.length; i++) {
      for (const p of PHRASES) {
        if (i + p.toks.length > toks.length) continue;
        if (!p.toks.every((w, k) => toks[i + k] === w && !used[i + k])) continue;
        if (p.type === "month" && AMBIGUOUS_MONTH.has(p.toks[0]) && toks[i - 1] !== "in") continue;
        for (let k = 0; k < p.toks.length; k++) used[i + k] = true;
        if (p.type === "date") dateSpec = dateSpec?.kind === "day" ? dateSpec : { kind: p.value };
        else if (p.type === "wd") wd = p.value;
        else if (p.type === "month") month = p.value;
        else if (p.type === "evening") out.evening = true;
        else if (p.type === "ord") ord = { value: p.value, at: i, len: p.toks.length };
        else flags[p.type] = true;
        i += p.toks.length - 1;
        break;
      }
    }
    if (flags.trip_weak && toks.some((w) => TRIP_CUES.has(w))) flags.trip = true;
    if (dateSpec?.kind !== "day") {
      if (wd !== null) dateSpec = { kind: "wd", wd: wd.wd, next: wd.next, inNextWeek: dateSpec?.kind === "next_week" };
      else if (!dateSpec && month) dateSpec = { kind: "month", month };
    }

    // 2. Travel origin: "fra Oslo S", "from the airport", "von Hamar stasjon".
    if (flags.trip) {
      const at = toks.findIndex((w, i) => !used[i] && FROM_WORDS.has(w));
      if (at >= 0) {
        used[at] = true;
        const idx = [];
        for (let i = at + 1; i < toks.length && idx.length < 4; i++) {
          if (FROM_END.has(toks[i])) break;
          if (!used[i]) idx.push(i);
        }
        const want = idx.map((i) => toks[i]).filter((w) => !STOP.has(w))
          .map((w) => Object.keys(ORIGIN_ALIASES).find((k) => ORIGIN_ALIASES[k].map(norm).includes(w)) || w);
        if (want.length) {
          out.origin = (ctx.origins || []).find((o) => {
            const name = new Set(tokens(o.name));
            return want.every((w) => name.has(w));
          }) || null;
          if (!out.origin) out.originText = idx.map((i) => raw[i] ?? toks[i]).join(" ");
          for (const i of idx) used[i] = true;
        }
      }
    }

    // 3. Categories. The word is kept too: it may also be part of a title or venue
    //    ("julemarked", "Kunstbanken"), and match() then also searches for it as text.
    const cats = new Set();
    toks.forEach((w, i) => {
      if (used[i]) return;
      for (const [cat, how, words] of CATEGORY_WORDS) {
        const hit = words.some((s) => how === "exact" ? w === s : how === "prefix" ? w.startsWith(s) : w.includes(s));
        if (hit) { cats.add(cat); if (!used[i]) out.catWords.push(w); used[i] = true; }
      }
    });
    out.cats = [...cats];

    // 4. Places: venue and municipality words from the events themselves.
    const placeWords = new Set();
    for (const e of ctx.events || []) for (const w of tokens(`${e.venue} ${e.municipality}`))
      if (w.length >= 4 && !GENERIC_PLACE.has(w) && !STOP.has(w)) placeWords.add(w);
    toks.forEach((w, i) => {
      if (used[i]) return;
      const alias = Object.keys(PLACE_ALIASES).find((k) => PLACE_ALIASES[k].map(norm).includes(w));
      if (alias) { out.places.push(alias); used[i] = true; return; }
      if (w.length < 4 || STOP.has(w)) return;
      // Exact word, or (5+ letters) the start of a venue word, or an inflected venue word.
      for (const p of placeWords) if (p === w || (w.length >= 5 && p.startsWith(w)) || w.startsWith(p)) {
        out.places.push(w.startsWith(p) ? p : w); used[i] = true; return;
      }
    });

    // 5. Ordinals: only after "den/the/die...", with a weather/trip question, or alone.
    //    "andre" + noun ("andre ting") or after har/vise/noe means "other": like "neste".
    if (ord && toks[ord.at] === "andre" && ord.len === 1 &&
        (OTHER_NOUNS.has(toks[ord.at + 1] || "") || (ord.at > 0 && OTHER_BEFORE.has(toks[ord.at - 1])))) {
      flags.next = true;
      if (OTHER_NOUNS.has(toks[ord.at + 1] || "")) used[ord.at + 1] = true;
      ord = null;
    }
    if (ord) {
      const others = toks.some((w, i) => !used[i] && !STOP.has(w) && w.length >= 3 && !/^\d+$/.test(w));
      const lead = ord.at > 0 && ORD_LEAD.has(toks[ord.at - 1]);
      const alone = !others && !out.cats.length && !out.places.length && !dateSpec;
      if (lead || flags.weather || flags.trip || alone) out.ordinal = ord.value;
      else for (let k = 0; k < ord.len; k++) used[ord.at + k] = false; // back to free text
    }

    // 6. Whatever is left: free text on title and venue, like the explore search.
    toks.forEach((w, i) => {
      if (!used[i] && !STOP.has(w) && !FROM_WORDS.has(w) && w.length >= 3 && !/^\d+$/.test(w)) out.words.push(w);
    });

    if (dateSpec) {
      const r = dateRange(dateSpec, today);
      out.date = { ...dateSpec, ...r, evening: r.evening || out.evening };
    }
    out.names = !!(out.date || out.badDate || out.cats.length || out.places.length || out.words.length);
    out.hasCriteria = out.names || out.evening;
    out.intent = flags.trip ? "trip" : flags.weather ? "weather"
      : flags.next && !out.hasCriteria ? "next"
      : out.ordinal !== null && !out.hasCriteria ? "select" : "search";
    return out;
  }

  /** yesNo(text) -> "yes" | "no" | null: a short answer to "Mener du ...?". */
  function yesNo(text) {
    const toks = tokens(text).filter((w) => !YN_FILLER.has(w));
    if (!toks.length) return null;
    if (toks.every((w) => YES.has(w))) return "yes";
    if (toks.every((w) => NO.has(w))) return "no";
    return null;
  }

  /** leadYesNo(text) -> { yn: "yes" | "no", rest } when the text starts with a yes/no word
   *  and goes on ("Ja, hvordan kommer jeg dit?", "Nei, den andre"); otherwise null. */
  function leadYesNo(text) {
    const toks = tokens(text), raw = rawTokens(text);
    let i = 0;
    while (i < toks.length && YN_FILLER.has(toks[i])) i++;
    if (i >= toks.length) return null;
    const yn = YES.has(toks[i]) ? "yes" : NO.has(toks[i]) ? "no" : null;
    if (!yn) return null;
    let j = i + 1;
    while (j < toks.length && (YES.has(toks[j]) || NO.has(toks[j]))) j++; // "ja genau", "nei nei"
    const rest = raw.slice(j).join(" ");
    return rest ? { yn, rest } : null;
  }

  // ---------- match ----------

  const hay = (e) => norm(`${e.title} ${e.venue}`);
  const hasText = (e, w) => stems(w).some((s) => hay(e).includes(s));

  function inDate(q, e) {
    const d0 = osloDay(e.start), d1 = osloDay(e.end || e.start);
    if (q.date && (d0 > q.date.to || d1 < q.date.from)) return false;
    const evening = q.date?.evening || q.evening;
    if (evening && e.time_known && osloHour(e.start) < 16 && osloHour(e.end || e.start) < 17) return false;
    return true;
  }
  const placeScore = (q, e) => {
    const words = tokens(`${e.venue} ${e.municipality}`);
    return q.places.filter((p) => words.some((w) => w === p || w.startsWith(p) || w.includes(p))).length;
  };

  /** match(parsed, events, now) -> { list, droppedWords }: matching events, soonest first,
   *  one per title + venue (the earliest date).
   *  - Categories: events of that category, plus events whose title/venue contains the
   *    category word itself (so "julemarked" and "Kunstbanken" find their events).
   *  - Free-text words are tried strictly (all words), then loosely (any word); if
   *    neither matches but other filters exist, the words are dropped instead of giving
   *    an empty answer to a slightly off sentence. */
  function match(q, events, now = Date.now()) {
    const today = osloDay(now);
    let base = events.filter((e) => inDate(q, e) && osloDay(e.end || e.start) >= today);
    if (q.places.length) {
      const best = Math.max(0, ...base.map((e) => placeScore(q, e)));
      base = best ? base.filter((e) => placeScore(q, e) === best) : [];
    }
    let list = base;
    if (q.cats.length) {
      const byCat = base.filter((e) => q.cats.includes(e.category));
      const byText = base.filter((e) => q.catWords.some((w) => hasText(e, w)));
      list = base.filter((e) => byCat.includes(e) || byText.includes(e));
    }
    let droppedWords = [];
    if (q.words.length) {
      const all = list.filter((e) => q.words.every((w) => hasText(e, w)));
      const any = list.filter((e) => q.words.some((w) => hasText(e, w)));
      if (all.length) list = all;
      else if (any.length) list = any;
      else if (q.date || q.evening || q.cats.length || q.places.length) droppedWords = q.words;
      else list = [];
    }
    const seen = new Set();
    list = [...list].sort((a, b) => a.start.localeCompare(b.start)).filter((e) => {
      const key = `${e.title}|${e.venue}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { list, droppedWords };
  }

  /** score(parsed, event) -> how well a question names this event (0 = not at all).
   *  Used to find "the" event in "Hvordan kommer jeg til Koigen Walkers?". */
  function score(q, e) {
    if (q.date && !inDate(q, e)) return 0;
    const title = norm(e.title), venue = norm(`${e.venue} ${e.municipality}`);
    let s = 0;
    for (const w of [...q.words, ...q.catWords, ...q.places]) {
      if (stems(w).some((x) => title.includes(x))) s += 3;
      else if (stems(w).some((x) => venue.includes(x))) s += 2;
    }
    if (q.cats.includes(e.category)) s += 1;
    if (q.date) s += 1;
    return s;
  }

  return { parse, match, score, yesNo, leadYesNo, norm, tokens, osloDay, osloHour, addDays };
})();

if (typeof module !== "undefined") module.exports = { TalkParser };
