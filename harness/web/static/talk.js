// Beveg talk mode (#talk): ask with your voice or type, hear and see up to three
// events, then ask for the weather or how to get there. Designed for pensioners
// first (large type, few elements) and fine for teenagers too.
//
// Two parts:
//  - TalkParser: a pure, rule-based parser (no network, no LLM). Given the text,
//    the events from /api/events and the origins from /api/config, it returns what
//    was asked. It also runs under Node for testing (module.exports at the end).
//  - Talk: the UI. It uses the globals from app.js (LANGS, CATEGORY, lang, events,
//    config, dataReady, mode, h, fill, api, t, locale, fmtTime, symbolIcon, MODES),
//    and the browser's Web Speech API when it exists. Its own texts live in
//    TALK_TEXT (read with tt()), separate from app.js's TEXT.
//    Nothing is stored: no localStorage, no cookies.
//
// Trip and weather questions always go through a confirmation: Beveg names the
// event it found ("Mener du ...?") and waits for yes/no, or for a tap on a card
// plus "Velg dette arrangementet", before it fetches anything.

// ======================================================================
// Parser
// ======================================================================

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

// ======================================================================
// UI texts (kept apart from app.js's TEXT; read with tt())
// ======================================================================

const TALK_TEXT = {
  no: {
    title_voice: "Spør med stemmen", title_events: "Arrangementer",
    title_travel: "Slik kommer du deg dit", title_weather: "Været der",
    notice: "Siden lagrer ingenting. Men i noen nettlesere (Chrome, Edge) sender nettleseren lyden til sin egen taletjeneste for å gjøre den om til tekst.",
    notice_ok: "Greit, start", notice_type: "Jeg skriver heller",
    type_label: "Eller skriv spørsmålet ditt", type_ph: "For eksempel: Hva skjer i helga?",
    send: "Spør", stop: "Stopp opplesing", read_aloud: "Les svarene høyt",
    no_speech: "Denne nettleseren kan ikke lytte, men du kan skrive spørsmålet ditt.",
    examples_head: "Du kan for eksempel spørre:",
    events_empty: "Her kommer arrangementene du spør om.",
    travel_empty: "Velg et arrangement og spør hvordan du kommer deg dit. Svaret kommer her.",
    weather_empty: "Velg et arrangement og spør om været. Varselet kommer her.",
    mic_idle: "Trykk og snakk", mic_listening: "Jeg lytter … trykk for å stoppe",
    mic_thinking: "Tenker …", mic_speaking: "Trykk og snakk",
    state_listening: "Jeg lytter …", state_thinking: "Tenker …", state_speaking: "Leser opp …",
    err_mic_blocked: "Mikrofonen er ikke tillatt. Du kan skrive spørsmålet i stedet.",
    err_no_speech: "Jeg hørte ingenting. Trykk og prøv igjen.",
    err_speech: "Talegjenkjenning virker ikke akkurat nå. Skriv spørsmålet i stedet.",
    you_said: (s) => `Du sa: «${s}»`, understood: "Jeg forsto:",
    loading_events: "Henter arrangementer …", loading_trip: "Henter reise …", loading_wx: "Henter værvarsel …",
    events_error: "Beklager, jeg får ikke hentet arrangementene akkurat nå.",
    examples: ["Hva skjer i helga?", "Hva skjer i kveld?", "Konserter neste uke", "Noe for barn?",
      "Noe for pensjonister?", "Hva skjer i morgen?", "Teater i desember", "Hva skjer fremover?"],
    found: (n, when) => n === 0 ? `Jeg fant ingenting som passer${when ? " " + when : ""}.`
      : `Jeg fant ${n === 1 ? "én ting" : n + " ting"}${when ? " " + when : ""}.${n > 3 ? " Her er de tre første." : ""}`,
    try_example: (ex) => `Prøv for eksempel: «${ex}»`,
    list_words: ["Først", "Så", "Til slutt"],
    item: (title, when, place) => `${title}, ${when}${place ? ", på " + place : ""}.`,
    more_hint: "Si «neste» for flere.",
    follow_hint: "Trykk på et kort og velg det, eller spør om været eller hvordan du kommer dit.",
    next_intro: "Her er de neste.", no_more: "Det var alle jeg fant.",
    ask_first: "Spør først om hva som skjer.",
    only_showed: (n) => n === 1 ? "Jeg viste bare ett." : `Jeg viste bare ${n}. Si et nummer fra 1 til ${n}.`,
    confirm_q: (title, when, place) => `Mener du ${title}, ${when}${place ? ", på " + place : ""}?`,
    confirm_hint: "Si «ja» eller «nei», eller trykk på en knapp.",
    yes: "Ja", no: "Nei",
    pick_q: "Hvilken av disse mener du? Trykk på et kort og «Velg dette arrangementet», eller si nummeret.",
    say_again: "Beklager. Kan du si navnet på arrangementet en gang til?",
    not_found_event: "Jeg fant ikke det arrangementet. Si navnet en gang til, eller spør hva som skjer.",
    nothing_pending: "Det er ikke noe å svare ja eller nei på akkurat nå.",
    no_such_date: (d, m) => `Det finnes ingen ${d}. ${m}. Prøv en annen dato.`,
    btn_choose: "Velg dette arrangementet", chosen_badge: "Valgt",
    chosen_say: (title) => `Valgt: ${title}. Du kan spørre om været, eller hvordan du kommer dit.`,
    tapped: (n, title) => `Nummer ${n}: ${title}. Trykk «Velg dette arrangementet» for å velge det.`,
    to_event: "Til", from_label: "Fra",
    cancelled_word: "avlyst", time_at: (hh, mm) => `klokka ${hh}${mm ? "." + mm : ""}`,
    today: "i dag", tomorrow: "i morgen", midday: "midt på dagen",
    when: { today: "i dag", tonight: "i kveld", tomorrow: "i morgen", weekend: "i helga",
            next_weekend: "neste helg", this_week: "denne uka", next_week: "neste uke",
            wd: (name) => `på ${name}`, month: (name) => `i ${name}`, day: (d, m) => `den ${d}. ${m}` },
    evening: "om kvelden",
    wx_off: "Beklager, jeg har ikke noe værvarsel akkurat nå.",
    wx_none: (title, d) => `Det er ikke noe værvarsel ennå for ${title}: det er om ${d} dager.`,
    wx_say: (title, when, desc, temp, wind, mm) =>
      `Været ved ${title} ${when}: ${desc}, ${temp} grader og ${wind} meter i sekundet vind${mm ? `, ${mm} millimeter nedbør` : ""}.`,
    wx_unsure: "Det er langt fram, så varselet er usikkert.",
    minus: "minus",
    wx: { clearsky: "klart", fair: "lettskyet", partlycloudy: "delvis skyet", cloudy: "skyet", fog: "tåke",
          rain: "regn", showers: "regnbyger", sleet: "sludd", snow: "snø", thunder: "torden",
          light: "lett", heavy: "kraftig" },
    trip_off: "Beklager, reiseinformasjon er ikke tilgjengelig akkurat nå.",
    trip_none: (from, title) => `Jeg fant ingen reise fra ${from} som rekker ${title}.`,
    trip_say: (from, mode, code, stop, dep, arr, changes) =>
      `Fra ${from}: ta ${mode}${code ? " " + code : ""}${stop ? " fra " + stop : ""} ${dep}, fremme ${arr}${changes ? `, med ${changes} bytte${changes > 1 ? "r" : ""}` : ""}.`,
    trip_walk: (from, dep, arr) => `Fra ${from} kan du gå: gå ${dep}, fremme ${arr}.`,
    place_unknown: (p, used) => `Jeg fant ikke «${p}», så jeg bruker ${used}.`,
    other_start: "Reis fra et annet sted:",
    btn_weather: "Været", btn_trip: "Hvordan kommer jeg dit?", btn_next: "Neste 3", source: "Mer info hos kilden",
    modes: { rail: "toget", bus: "bussen", coach: "bussen", tram: "trikken", metro: "T-banen", water: "båten", air: "flyet" },
    cat_names: null,
  },
  en: {
    title_voice: "Ask with your voice", title_events: "Events",
    title_travel: "How to get there", title_weather: "Weather there",
    notice: "This page stores nothing. But some browsers (Chrome, Edge) send the sound to their own speech service to turn it into text.",
    notice_ok: "OK, start", notice_type: "I'll type instead",
    type_label: "Or type your question", type_ph: "For example: What's on this weekend?",
    send: "Ask", stop: "Stop reading", read_aloud: "Read answers aloud",
    no_speech: "This browser can't listen, but you can type your question.",
    examples_head: "You could ask:",
    events_empty: "The events you ask about appear here.",
    travel_empty: "Choose an event and ask how to get there. The answer appears here.",
    weather_empty: "Choose an event and ask about the weather. The forecast appears here.",
    mic_idle: "Tap and speak", mic_listening: "Listening … tap to stop",
    mic_thinking: "Thinking …", mic_speaking: "Tap and speak",
    state_listening: "Listening …", state_thinking: "Thinking …", state_speaking: "Reading aloud …",
    err_mic_blocked: "The microphone is blocked. You can type your question instead.",
    err_no_speech: "I didn't hear anything. Tap and try again.",
    err_speech: "Speech recognition isn't working right now. Please type your question.",
    you_said: (s) => `You said: “${s}”`, understood: "I understood:",
    loading_events: "Loading events …", loading_trip: "Finding a trip …", loading_wx: "Getting the forecast …",
    events_error: "Sorry, I can't get the events right now.",
    examples: ["What's on this weekend?", "Anything tonight?", "Concerts next week", "Something for kids?",
      "Anything for seniors?", "What's on tomorrow?", "Theatre in December", "What's on?"],
    found: (n, when) => n === 0 ? `I couldn't find anything${when ? " " + when : ""}.`
      : `I found ${n === 1 ? "one event" : n + " events"}${when ? " " + when : ""}.${n > 3 ? " Here are the first three." : ""}`,
    try_example: (ex) => `Try for example: “${ex}”`,
    list_words: ["First", "Then", "Finally"],
    item: (title, when, place) => `${title}, ${when}${place ? ", at " + place : ""}.`,
    more_hint: "Say “next” for more.",
    follow_hint: "Tap a card and choose it, or ask about the weather or how to get there.",
    next_intro: "Here are the next ones.", no_more: "That's all I found.",
    ask_first: "First ask me what's on.",
    only_showed: (n) => n === 1 ? "I only showed one." : `I only showed ${n}. Say a number from 1 to ${n}.`,
    confirm_q: (title, when, place) => `Do you mean ${title}, ${when}${place ? ", at " + place : ""}?`,
    confirm_hint: "Say “yes” or “no”, or press a button.",
    yes: "Yes", no: "No",
    pick_q: "Which of these do you mean? Tap a card and “Choose this event”, or say its number.",
    say_again: "Sorry. Could you say the name of the event again?",
    not_found_event: "I couldn't find that event. Say its name again, or ask me what's on.",
    nothing_pending: "There's nothing to say yes or no to right now.",
    no_such_date: (d, m) => `There is no ${d} ${m}. Try another date.`,
    btn_choose: "Choose this event", chosen_badge: "Chosen",
    chosen_say: (title) => `Chosen: ${title}. You can ask about the weather, or how to get there.`,
    tapped: (n, title) => `Number ${n}: ${title}. Press “Choose this event” to choose it.`,
    to_event: "To", from_label: "From",
    cancelled_word: "cancelled",
    time_at: (hh, mm) => { const h12 = ((hh + 11) % 12) + 1; return `at ${h12}${mm ? ":" + mm : ""} ${hh < 12 ? "am" : "pm"}`; },
    today: "today", tomorrow: "tomorrow", midday: "around midday",
    when: { today: "today", tonight: "tonight", tomorrow: "tomorrow", weekend: "this weekend",
            next_weekend: "next weekend", this_week: "this week", next_week: "next week",
            wd: (name) => `on ${name}`, month: (name) => `in ${name}`, day: (d, m) => `on ${d} ${m}` },
    evening: "in the evening",
    wx_off: "Sorry, no forecast is available right now.",
    wx_none: (title, d) => `There's no forecast yet for ${title}: it's ${d} days away.`,
    wx_say: (title, when, desc, temp, wind, mm) =>
      `Weather for ${title} ${when}: ${desc}, ${temp} degrees, wind ${wind} metres per second${mm ? `, ${mm} millimetres of rain or snow` : ""}.`,
    wx_unsure: "It's a long way off, so the forecast is uncertain.",
    minus: "minus",
    wx: { clearsky: "clear skies", fair: "mostly clear", partlycloudy: "partly cloudy", cloudy: "cloudy", fog: "fog",
          rain: "rain", showers: "showers", sleet: "sleet", snow: "snow", thunder: "thunder",
          light: "light", heavy: "heavy" },
    trip_off: "Sorry, travel info is unavailable right now.",
    trip_none: (from, title) => `I couldn't find a trip from ${from} in time for ${title}.`,
    trip_say: (from, mode, code, stop, dep, arr, changes) =>
      `From ${from}: take the ${mode}${code ? " " + code : ""}${stop ? " from " + stop : ""} ${dep}, arriving ${arr}${changes ? `, with ${changes} change${changes > 1 ? "s" : ""}` : ""}.`,
    trip_walk: (from, dep, arr) => `From ${from} you can walk: leave ${dep}, arriving ${arr}.`,
    place_unknown: (p, used) => `I couldn't find “${p}”, so I'm using ${used}.`,
    other_start: "Travel from somewhere else:",
    btn_weather: "Weather", btn_trip: "How do I get there?", btn_next: "Next 3", source: "More info at the source",
    modes: { rail: "train", bus: "bus", coach: "bus", tram: "tram", metro: "metro", water: "boat", air: "flight" },
    cat_names: { concert: "concert", theatre: "theatre", talk: "talk", exhibition: "exhibition", sports: "sports",
      kids: "kids", senior: "seniors", course: "course", market: "market", food_drink: "food and drink",
      religious: "religious", meeting: "meeting", workshop: "workshop", other: "other" },
  },
  de: {
    title_voice: "Mit der Stimme fragen", title_events: "Veranstaltungen",
    title_travel: "So kommen Sie hin", title_weather: "Das Wetter dort",
    notice: "Diese Seite speichert nichts. Manche Browser (Chrome, Edge) senden den Ton aber an ihren eigenen Sprachdienst, um ihn in Text umzuwandeln.",
    notice_ok: "OK, starten", notice_type: "Lieber tippen",
    type_label: "Oder tippen Sie Ihre Frage", type_ph: "Zum Beispiel: Was ist am Wochenende los?",
    send: "Fragen", stop: "Vorlesen stoppen", read_aloud: "Antworten vorlesen",
    no_speech: "Dieser Browser kann nicht zuhören, aber Sie können Ihre Frage tippen.",
    examples_head: "Sie können zum Beispiel fragen:",
    events_empty: "Hier erscheinen die Veranstaltungen, nach denen Sie fragen.",
    travel_empty: "Wählen Sie eine Veranstaltung und fragen Sie, wie Sie hinkommen. Die Antwort erscheint hier.",
    weather_empty: "Wählen Sie eine Veranstaltung und fragen Sie nach dem Wetter. Die Vorhersage erscheint hier.",
    mic_idle: "Tippen und sprechen", mic_listening: "Ich höre zu … tippen zum Stoppen",
    mic_thinking: "Einen Moment …", mic_speaking: "Tippen und sprechen",
    state_listening: "Ich höre zu …", state_thinking: "Einen Moment …", state_speaking: "Lese vor …",
    err_mic_blocked: "Das Mikrofon ist blockiert. Sie können die Frage auch tippen.",
    err_no_speech: "Ich habe nichts gehört. Tippen und noch einmal versuchen.",
    err_speech: "Die Spracherkennung funktioniert gerade nicht. Bitte tippen Sie Ihre Frage.",
    you_said: (s) => `Sie sagten: „${s}“`, understood: "Ich habe verstanden:",
    loading_events: "Veranstaltungen werden geladen …", loading_trip: "Verbindung wird gesucht …", loading_wx: "Vorhersage wird geladen …",
    events_error: "Leider kann ich die Veranstaltungen gerade nicht laden.",
    examples: ["Was ist am Wochenende los?", "Was gibt es heute Abend?", "Konzerte nächste Woche",
      "Etwas für Kinder?", "Etwas für Senioren?", "Was ist morgen los?", "Theater im Dezember", "Was ist los?"],
    found: (n, when) => n === 0 ? `Ich habe ${when ? when + " " : ""}nichts gefunden.`
      : `Ich habe ${when ? when + " " : ""}${n === 1 ? "eine Veranstaltung" : n + " Veranstaltungen"} gefunden.${n > 3 ? " Hier sind die ersten drei." : ""}`,
    try_example: (ex) => `Versuchen Sie zum Beispiel: „${ex}“`,
    list_words: ["Zuerst", "Dann", "Zuletzt"],
    item: (title, when, place) => `${title}, ${when}${place ? ", Ort: " + place : ""}.`,
    more_hint: "Sagen Sie „weiter“ für mehr.",
    follow_hint: "Tippen Sie auf eine Karte und wählen Sie sie, oder fragen Sie nach Wetter oder Anreise.",
    next_intro: "Hier sind die nächsten.", no_more: "Das war alles, was ich gefunden habe.",
    ask_first: "Fragen Sie zuerst, was los ist.",
    only_showed: (n) => n === 1 ? "Ich habe nur eine gezeigt." : `Ich habe nur ${n} gezeigt. Sagen Sie eine Zahl von 1 bis ${n}.`,
    confirm_q: (title, when, place) => `Meinen Sie ${title}, ${when}${place ? ", Ort: " + place : ""}?`,
    confirm_hint: "Sagen Sie „ja“ oder „nein“, oder drücken Sie einen Knopf.",
    yes: "Ja", no: "Nein",
    pick_q: "Welche davon meinen Sie? Tippen Sie auf eine Karte und „Diese Veranstaltung wählen“, oder sagen Sie die Nummer.",
    say_again: "Entschuldigung. Können Sie den Namen der Veranstaltung noch einmal sagen?",
    not_found_event: "Ich habe diese Veranstaltung nicht gefunden. Sagen Sie den Namen noch einmal, oder fragen Sie, was los ist.",
    nothing_pending: "Gerade gibt es nichts, worauf Sie ja oder nein sagen können.",
    no_such_date: (d, m) => `Einen ${d}. ${m} gibt es nicht. Versuchen Sie ein anderes Datum.`,
    btn_choose: "Diese Veranstaltung wählen", chosen_badge: "Gewählt",
    chosen_say: (title) => `Gewählt: ${title}. Sie können nach dem Wetter fragen, oder wie Sie hinkommen.`,
    tapped: (n, title) => `Nummer ${n}: ${title}. Drücken Sie „Diese Veranstaltung wählen“, um sie zu wählen.`,
    to_event: "Zu", from_label: "Ab",
    cancelled_word: "abgesagt", time_at: (hh, mm) => `um ${hh}${mm ? ":" + mm : ""} Uhr`,
    today: "heute", tomorrow: "morgen", midday: "gegen Mittag",
    when: { today: "heute", tonight: "heute Abend", tomorrow: "morgen", weekend: "am Wochenende",
            next_weekend: "nächstes Wochenende", this_week: "diese Woche", next_week: "nächste Woche",
            wd: (name) => `am ${name}`, month: (name) => `im ${name}`, day: (d, m) => `am ${d}. ${m}` },
    evening: "abends",
    wx_off: "Leider gibt es gerade keine Wettervorhersage.",
    wx_none: (title, d) => `Für ${title} gibt es noch keine Vorhersage: Es ist in ${d} Tagen.`,
    wx_say: (title, when, desc, temp, wind, mm) =>
      `Wetter bei ${title} ${when}: ${desc}, ${temp} Grad, Wind ${wind} Meter pro Sekunde${mm ? `, ${mm} Millimeter Niederschlag` : ""}.`,
    wx_unsure: "Es ist noch lange hin, die Vorhersage ist unsicher.",
    minus: "minus",
    wx: { clearsky: "klar", fair: "heiter", partlycloudy: "teilweise bewölkt", cloudy: "bewölkt", fog: "Nebel",
          rain: "Regen", showers: "Schauer", sleet: "Schneeregen", snow: "Schnee", thunder: "Gewitter",
          light: "leichter", heavy: "starker" },
    trip_off: "Leider sind Reiseinformationen gerade nicht verfügbar.",
    trip_none: (from, title) => `Ich habe keine Verbindung ab ${from} rechtzeitig zu ${title} gefunden.`,
    trip_say: (from, mode, code, stop, dep, arr, changes) =>
      `Ab ${from}: Nehmen Sie ${mode}${code ? " " + code : ""}${stop ? " ab " + stop : ""} ${dep}, Ankunft ${arr}${changes ? `, mit ${changes} Mal Umsteigen` : ""}.`,
    trip_walk: (from, dep, arr) => `Ab ${from} können Sie zu Fuß gehen: los ${dep}, Ankunft ${arr}.`,
    place_unknown: (p, used) => `Ich habe „${p}“ nicht gefunden, ich nehme ${used}.`,
    other_start: "Von woanders anreisen:",
    btn_weather: "Wetter", btn_trip: "Wie komme ich hin?", btn_next: "Nächste 3", source: "Mehr Infos bei der Quelle",
    modes: { rail: "den Zug", bus: "den Bus", coach: "den Bus", tram: "die Straßenbahn", metro: "die U-Bahn", water: "die Fähre", air: "den Flug" },
    cat_names: null,
  },
};

// ======================================================================
// UI
// ======================================================================

const Talk = typeof window === "undefined" ? null : (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
  const el = (id) => document.getElementById(id);
  const tt = (k) => (TALK_TEXT[lang] || TALK_TEXT.no)[k];

  let results = [], offset = 0;   // the last search, paged three at a time
  let shown = [], sel = 0;        // the cards on screen, and which one is selected (-1 = none)
  let chosen = null;              // the confirmed event (travel/weather go straight to it)
  let pending = null;             // { intent, q, cands, rejected, current, phase: "ask" | "pick" }
  let travel = null, weather = null; // what the travel and weather sections show
  let heard = "", understood = null, answer = null;
  let noticeOk = false;           // privacy notice seen this page load (kept in memory only)
  let rec = null, muted = false, speakId = 0, askId = 0, dataError = null, loaded = false, shownLang = null;

  // ---------- small helpers ----------

  const placeOf = (e) => e.venue || e.municipality || "";
  const titleOf = (e) => e.cancelled ? `${e.title} (${tt("cancelled_word")})` : e.title;
  const ctx = () => ({ events, origins: config?.origins || [], now: Date.now() });

  function setState(s) {
    el("talk-view").dataset.state = s;
    el("mic-label").textContent = tt(`mic_${s}`);
    el("talk-state").textContent = s === "idle" ? "" : tt(`state_${s}`);
    el("stop-speech").disabled = s !== "speaking";
  }

  // Spoken day: "i dag" / "i morgen" / "lørdag" (within a week) / "lørdag 5. desember".
  function dayWords(iso) {
    const d = TalkParser.osloDay(iso), today = TalkParser.osloDay(Date.now());
    if (d === today) return tt("today");
    if (d === TalkParser.addDays(today, 1)) return tt("tomorrow");
    const opts = d <= TalkParser.addDays(today, 6) ? { weekday: "long" } : { weekday: "long", day: "numeric", month: "long" };
    return new Date(iso).toLocaleDateString(locale(), { ...opts, timeZone: "Europe/Oslo" });
  }
  function timeWords(iso) {
    const [hh, mm] = new Date(iso).toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Oslo" }).split(":").map(Number);
    return tt("time_at")(hh, mm ? String(mm).padStart(2, "0") : "");
  }
  const eventWhen = (e) => `${dayWords(e.start)}${e.time_known ? " " + timeWords(e.start) : ""}`;
  const monthName = (m) => new Date(Date.UTC(2024, m - 1, 15)).toLocaleDateString(locale(), { month: "long", timeZone: "UTC" });

  function whenLabel(q) {
    if (!q?.date) return q?.evening ? tt("evening") : "";
    const w = tt("when");
    if (q.date.kind === "wd") {
      const ref = TalkParser.addDays("2024-01-07", q.date.wd); // 2024-01-07 was a Sunday
      return w.wd(new Date(`${ref}T12:00:00Z`).toLocaleDateString(locale(), { weekday: "long", timeZone: "UTC" }));
    }
    if (q.date.kind === "month") return w.month(monthName(q.date.month));
    if (q.date.kind === "day") return w.day(q.date.day, monthName(q.date.month));
    return w[q.date.kind] || "";
  }

  const catName = (c) => (tt("cat_names") || CATEGORY[lang] || {})[c] || c;

  // Example questions that give at least one result right now.
  function workingExamples() {
    const list = tt("examples");
    if (!loaded) return list.slice(0, 4);
    const ok = list.filter((ex) => TalkParser.match(TalkParser.parse(ex, ctx()), events).list.length);
    return (ok.length ? ok : list.slice(-1)).slice(0, 4);
  }
  // Picked when the answer is rendered, so it follows a language switch.
  const exampleNot = (text) => () => {
    const list = workingExamples();
    return list.find((x) => TalkParser.norm(x) !== TalkParser.norm(text)) || list[0];
  };

  function reveal(id) {
    el(id)?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }

  // ---------- speech out ----------

  function speak(text) {
    speakId++;
    if (synth) synth.cancel();
    if (!synth || muted || !text) return setState("idle");
    const id = speakId;
    // One utterance per sentence (Chrome cuts long ones off). Split only before a capital
    // or a quote, so dates like "25. november" stay in one piece.
    const parts = text.split(/(?<=[.!?»“”"])\s+(?=[\p{Lu}«“„"])/u).filter(Boolean);
    const voice = pickVoice();
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = LANGS[lang].locale; u.rate = 0.9;
      if (voice) u.voice = voice;
      if (i === 0) u.onstart = () => id === speakId && setState("speaking");
      if (i === parts.length - 1) u.onend = () => id === speakId && setState("idle");
      u.onerror = () => id === speakId && setState("idle");
      synth.speak(u);
    });
    // Browsers without voices never fire onstart: do not get stuck on "thinking".
    setState("idle");
  }
  function pickVoice() {
    const want = LANGS[lang].locale.toLowerCase();
    const prefixes = lang === "no" ? ["nb", "no", "nn"] : [want.slice(0, 2)];
    const voices = synth.getVoices();
    const l = (v) => v.lang.toLowerCase().replace("_", "-");
    return voices.find((v) => l(v) === want) || voices.find((v) => prefixes.some((p) => l(v).startsWith(p))) || null;
  }
  function stopSpeaking() {
    speakId++;
    if (synth) synth.cancel();
    if (el("talk-view").dataset.state === "speaking") setState("idle");
  }

  // ---------- speech in ----------

  function micClick() {
    if (el("talk-view").dataset.state === "listening") return rec?.stop();
    stopSpeaking();
    if (!noticeOk) {
      el("talk-notice").hidden = false;
      el("notice-ok").focus();
      return;
    }
    listen();
  }

  function listen() {
    rec?.abort();
    const r = new SR();
    rec = r;
    r.lang = LANGS[lang].locale;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "", interim = "", failed = false;
    r.onresult = (ev) => {
      interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      el("ask").value = (finalText || interim).trim();
    };
    r.onerror = (ev) => {
      if (rec !== r || ev.error === "aborted") return;
      failed = true;
      const key = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "err_mic_blocked"
        : ev.error === "no-speech" ? "err_no_speech" : "err_speech";
      show({ say: () => tt(key) });
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      const text = (finalText || interim).trim();
      if (text) return ask(text);
      if (!failed) { setState("idle"); el("talk-state").textContent = tt("err_no_speech"); }
    };
    try {
      r.start();
      setState("listening");
    } catch {
      setState("idle");
      el("talk-state").textContent = tt("err_speech");
    }
  }

  // ---------- answering ----------

  async function ask(text) {
    text = text.trim();
    if (!text) return;
    const id = ++askId;
    stopSpeaking();
    setState("thinking");
    heard = text;
    understood = null;
    el("ask").value = text;
    if (!loaded) {
      renderHeard();
      el("talk-say").textContent = tt("loading_events");
      try { await dataReady; } catch { /* handled below */ }
      if (id !== askId) return;
    }
    if (dataError || !config) return show({ say: () => tt("events_error") });

    // An answer to "Mener du ...?".
    const yn = TalkParser.yesNo(text);
    if (yn && pending) return yn === "yes" ? confirmPending(id) : rejectPending();
    if (yn) return show({ say: () => `${tt("nothing_pending")} ${tt("try_example")(exampleNot(text)())}` });

    // "Ja, hvordan kommer jeg dit?" / "Nei, den andre" while "Mener du ...?" is open.
    const lead = pending && TalkParser.leadYesNo(text);
    if (lead) {
      const rq = TalkParser.parse(lead.rest, ctx());
      if (lead.yn === "yes" && !rq.names) {
        // Yes, plus a weather/trip question about the same event: that becomes the task.
        if (rq.intent === "weather" || rq.intent === "trip") { pending.intent = rq.intent; pending.q = rq; }
        return confirmPending(id);
      }
      if (lead.yn === "no" && !rq.names && rq.ordinal !== null) return rejectThenPick(rq.ordinal);
      if (lead.yn === "no" && !rq.names) return rejectPending();
    }

    const q = TalkParser.parse(text, ctx());
    if (q.badDate) {
      pending = null;
      return show({ say: () => tt("no_such_date")(q.badDate.day, monthName(q.badDate.month)) });
    }

    // "den andre": choosing among the cards on screen, confirmed with "Mener du ...?".
    if (q.intent === "select" && !shown.length)
      return show({ say: () => `${tt("ask_first")} ${tt("try_example")(exampleNot("")())}` });
    if (q.intent === "select") {
      const i = ordinalIndex(q.ordinal);
      if (i === null) return show({ say: () => tt("only_showed")(shown.length) });
      const e = shown[i];
      const p = pending || { intent: "choose", q, cands: [...shown], rejected: new Set() };
      pending = { ...p, current: e, phase: "ask" };
      shown = [e]; sel = 0;
      return askConfirm();
    }

    pending = null; // a new question cancels a pending confirmation
    if (q.intent === "next" && results.length) return showNext();
    if (q.intent === "weather" || q.intent === "trip") return followUp(q, id);

    // A new search.
    const { list } = TalkParser.match(q, events);
    results = list; offset = 0; shown = list.slice(0, 3); sel = 0;
    chosen = null; travel = null; weather = null;
    understood = q;
    if (!list.length) {
      const ex = exampleNot(text);
      return show({ say: () => `${tt("found")(0, whenLabel(q))} ${tt("try_example")(ex())}` });
    }
    show({ say: () => listSentence(q, true) });
  }

  // Index into the cards on screen, or null if the number is out of range.
  function ordinalIndex(n) {
    if (n === -1) return shown.length ? shown.length - 1 : null;
    return n >= 0 && n < shown.length ? n : null;
  }

  function listSentence(q, first) {
    const words = tt("list_words");
    const items = shown.map((e, i) => {
      const lead = shown.length > 1 ? words[i === shown.length - 1 && i > 0 ? 2 : i] + ": " : "";
      return lead + tt("item")(titleOf(e), eventWhen(e), i === 0 ? placeOf(e) : "");
    });
    const head = first ? tt("found")(results.length, whenLabel(q)) : tt("next_intro");
    const more = offset + 3 < results.length ? tt("more_hint") : "";
    return [head, ...items, more, first ? tt("follow_hint") : ""].filter(Boolean).join(" ");
  }

  function showNext() {
    if (offset + 3 >= results.length) return show({ say: () => tt("no_more") });
    offset += 3; shown = results.slice(offset, offset + 3); sel = 0;
    show({ say: () => listSentence(understood, false) });
  }

  // ---------- confirming the event before travel / weather ----------

  // The best event for a weather/trip question: one it names (title words, venue,
  // category, date), from the cards on screen first and then from all events; or the
  // card it points at ("den andre"); or the selected card.
  function followUp(q, id) {
    let cands;
    if (q.names) {
      const score = new Map(events.map((e) => [e.id, TalkParser.score(q, e)]));
      const byScore = (a, b) => score.get(b.id) - score.get(a.id) || a.start.localeCompare(b.start);
      const all = events.filter((e) => score.get(e.id) > 0).sort(byScore);
      const first = shown.filter((e) => score.get(e.id) > 0).sort(byScore)[0] || all[0];
      if (!first) return show({ say: () => tt("not_found_event") });
      cands = [first, ...all.filter((e) => e.id !== first.id)];
    } else {
      let i = sel >= 0 ? sel : 0;
      if (q.ordinal !== null) {
        if (!shown.length) return show({ say: () => `${tt("ask_first")} ${tt("try_example")(exampleNot("")())}` });
        i = ordinalIndex(q.ordinal);
        if (i === null) return show({ say: () => tt("only_showed")(shown.length) });
      } else if (chosen) return runIntent(q.intent, chosen, q, id);
      if (!shown.length) return show({ say: () => `${tt("ask_first")} ${tt("try_example")(exampleNot("")())}` });
      cands = [shown[i], ...shown.filter((_, k) => k !== i), ...results.filter((e) => !shown.includes(e))];
    }
    const e = cands[0];
    if (e.id === chosen?.id) return runIntent(q.intent, e, q, id);
    pending = { intent: q.intent, q, cands, rejected: new Set(), current: e, phase: "ask" };
    shown = [e]; sel = 0;
    askConfirm();
  }

  function askConfirm() {
    const e = pending.current;
    show({ say: () => `${tt("confirm_q")(titleOf(e), eventWhen(e), placeOf(e))} ${tt("confirm_hint")}` });
    reveal("tsec-events");
  }

  function confirmPending(id) {
    const p = pending;
    if (!p.current) {
      if (sel < 0 || !shown[sel]) return show({ say: () => tt("pick_q") });
      p.current = shown[sel];
    }
    pending = null;
    setChosen(p.current); shown = [chosen]; sel = 0;
    runIntent(p.intent, chosen, p.q, id);
  }

  function rejectPending() {
    const p = pending;
    if (p.current) p.rejected.add(p.current.id);
    const alts = p.cands.filter((e) => !p.rejected.has(e.id));
    if (p.phase === "ask" && alts.length) {
      p.phase = "pick"; p.current = null;
      shown = alts.slice(0, 3); sel = -1;
      return show({ say: () => tt("pick_q") });
    }
    pending = null; shown = []; sel = 0;
    show({ say: () => tt("say_again") });
  }

  // A newly confirmed event: travel and weather for another event no longer apply.
  function setChosen(e) {
    chosen = e;
    if (travel && travel.e.id !== e.id) travel = null;
    if (weather && weather.e.id !== e.id) weather = null;
  }

  // "Nei, den andre": reject the event asked about, then ask about candidate number n
  // (counted in the candidate list, where the rejected one was first). If there is no
  // such candidate, the plain "nei" path.
  function rejectThenPick(n) {
    const p = pending;
    if (p.current) p.rejected.add(p.current.id);
    const e = n === -1 ? p.cands[p.cands.length - 1] : p.cands[n];
    if (!e || p.rejected.has(e.id)) return rejectPending();
    pending = { ...p, current: e, phase: "ask" };
    shown = [e]; sel = 0;
    askConfirm();
  }

  function runIntent(intent, e, q, id) {
    if (intent === "trip") return doTrip(e, q, id);
    if (intent === "weather") return doWeather(e, id);
    show({ say: () => tt("chosen_say")(titleOf(e)) });
  }

  // The "Velg dette arrangementet" button: a tap on a card plus this counts as "ja".
  function chooseSelected() {
    const e = shown[sel];
    if (!e) return;
    stopSpeaking();
    const id = ++askId;
    if (pending) { pending.current = e; return confirmPending(id); }
    setChosen(e);
    show({ say: () => tt("chosen_say")(titleOf(e)) });
  }

  function tapCard(i) {
    ++askId;
    stopSpeaking();
    sel = i;
    if (pending?.phase === "pick") pending.current = null; // still needs "Velg dette arrangementet"
    show({ say: () => tt("tapped")(i + 1, titleOf(shown[i])) });
  }

  // ---------- weather: /api/event/<id>/weather ----------

  function weatherDesc(sym) {
    const w = tt("wx");
    if (!sym) return "";
    const base = sym.replace(/_(day|night|polartwilight)$/, "");
    const strength = base.startsWith("light") ? w.light + " " : base.startsWith("heavy") ? w.heavy + " " : "";
    const kind = ["thunder", "sleet", "snow", "showers", "rain", "fog", "partlycloudy", "cloudy", "fair", "clearsky"]
      .find((k) => base.includes(k));
    if (!kind) return "";
    return (["rain", "sleet", "snow"].includes(kind) ? strength : "") + w[kind];
  }
  const temp = (x) => x === null || x === undefined ? "–" : Math.round(x) < 0 ? `${tt("minus")} ${Math.abs(Math.round(x))}` : String(Math.round(x));

  function weatherSentence(wx) {
    const e = wx.e;
    if (wx.state === "off") return tt("wx_off");
    if (wx.state === "loading") return tt("loading_wx");
    if (wx.state === "none") return tt("wx_none")(e.title, wx.w.days_until);
    const s = wx.w.at_start;
    const when = `${dayWords(e.start)} ${e.time_known ? timeWords(e.start) : tt("midday")}`;
    const mm = s.precip ? String(s.precip).replace(".", lang === "en" ? "." : ",") : "";
    const line = tt("wx_say")(e.title, when, weatherDesc(s.symbol) || "–", temp(s.temp), Math.round(s.wind ?? 0), mm);
    return wx.w.confidence === "low" ? `${line} ${tt("wx_unsure")}` : line;
  }

  async function doWeather(e, id) {
    if (!config.yr) {
      weather = { e, state: "off" };
      return show({ say: () => weatherSentence(weather) });
    }
    const mine = weather = { e, state: "loading" };
    render(); setState("thinking");
    let w;
    try { w = await api(`/api/event/${e.id}/weather`); } catch { w = null; }
    if (id !== askId) { if (weather === mine) { weather = null; render(); } return; }
    weather = !w ? { e, state: "off" } : !w.available ? { e, state: "none", w } : { e, state: "ok", w };
    show({ say: () => weatherSentence(weather) });
    reveal("tsec-weather");
  }

  // ---------- travel: /api/event/<id>/trips ----------

  function travelSentence(tr) {
    const e = tr.e;
    if (tr.state === "off") return tt("trip_off");
    if (tr.state === "loading") return tt("loading_trip");
    const note = tr.unknown ? tt("place_unknown")(tr.unknown, tr.from.name) + " " : "";
    if (tr.state === "none") return note + tt("trip_none")(tr.from.name, e.title);
    const trip = tr.trip;
    const transit = trip.legs.filter((l) => l.mode !== "foot");
    const arr = timeWords(trip.expectedEndTime);
    if (!transit.length) return note + tt("trip_walk")(tr.from.name, timeWords(trip.expectedStartTime), arr);
    const l = transit[0];
    return note + tt("trip_say")(tr.from.name, tt("modes")[l.mode] || l.mode, l.line?.publicCode || "",
      l.fromPlace.name === tr.from.name ? "" : l.fromPlace.name, timeWords(l.expectedStartTime), arr, transit.length - 1);
  }

  async function doTrip(e, q, id) {
    if (!config.entur) {
      travel = { e, state: "off" };
      return show({ say: () => travelSentence(travel) });
    }
    const mine = travel = { e, state: "loading" };
    const dropped = () => { if (travel === mine) { travel = null; render(); } };
    render(); setState("thinking");
    let from = q?.origin || config.origins[0], unknown = "";
    if (q?.originText) {
      try {
        const hits = await api(`/api/places?q=${encodeURIComponent(q.originText)}`);
        if (hits.length) from = hits[0];
        else unknown = q.originText;
      } catch {
        if (id !== askId) return dropped();
        travel = { e, state: "off" };
        return show({ say: () => travelSentence(travel) });
      }
      if (id !== askId) return dropped();
    }
    if (!from) { travel = { e, state: "off" }; return show({ say: () => travelSentence(travel) }); }
    const qs = new URLSearchParams({ id: from.id || "", name: from.name, lat: from.lat, lon: from.lon });
    let res;
    try { res = await api(`/api/event/${e.id}/trips?${qs}`); } catch { res = null; }
    if (id !== askId) return dropped();
    if (!res) travel = { e, from, state: "off" };
    else {
      // The latest departure that still arrives in time: the least waiting.
      const trip = [...res.trips].sort((a, b) => b.expectedStartTime.localeCompare(a.expectedStartTime))[0];
      travel = { e, from, res, trip, unknown, state: trip ? "ok" : "none" };
    }
    show({ say: () => travelSentence(travel) });
    reveal("tsec-travel");
  }

  // ---------- rendering ----------

  function show(a) {
    answer = a;
    render();
    speak(el("talk-say").textContent);
  }

  function renderHeard() {
    const box = el("talk-heard");
    if (!heard) return fill(box);
    const chips = [];
    if (understood) {
      const w = whenLabel(understood);
      if (w) chips.push(w);
      for (const c of understood.cats) chips.push(catName(c));
      for (const p of understood.places) chips.push(p.charAt(0).toUpperCase() + p.slice(1));
      for (const p of understood.words) chips.push(`«${p}»`);
    }
    fill(box, h("p", {}, tt("you_said")(heard)),
      chips.length > 0 && h("p", { class: "talk-understood" }, tt("understood"), " ",
        chips.flatMap((c, i) => i > 0 ? [" ", h("span", { class: "tag" }, c)] : [h("span", { class: "tag" }, c)])));
  }

  const btn = (label, onclick, cls = "") => h("button", { class: "big-btn " + cls, type: "button", onclick }, label);

  function renderEvents() {
    el("talk-ev-empty").hidden = shown.length > 0;
    // The confirmation: "Mener du ...?" with Ja / Nei, or "Hvilken mener du?".
    const box = el("talk-confirm");
    box.hidden = !pending;
    if (pending) {
      const e = pending.current;
      fill(box, pending.phase === "ask" && e
        ? [h("p", { class: "confirm-q" }, tt("confirm_q")(titleOf(e), eventWhen(e), placeOf(e))),
           h("div", { class: "talk-row" },
             btn(tt("yes"), () => { stopSpeaking(); confirmPending(++askId); }, "primary yes"),
             btn(tt("no"), () => { stopSpeaking(); ++askId; rejectPending(); }, "no"))]
        : [h("p", { class: "confirm-q" }, tt("pick_q"))]);
    }
    fill(el("talk-cards"), shown.map((e, i) =>
      h("li", {},
        h("button", { class: "tcard" + (i === sel ? " on" : ""), type: "button", "aria-pressed": String(i === sel),
                      onclick: () => tapCard(i) },
          h("span", { class: "tcard-n", "aria-hidden": "true" }, String(i + 1)),
          h("span", { class: "tcard-title" }, e.title,
            e.cancelled && h("span", { class: "tag cancelled" }, tt("cancelled_word")),
            e.id === chosen?.id && h("span", { class: "tag chosen" }, "✓ " + tt("chosen_badge"))),
          h("span", { class: "tcard-when" }, new Date(e.start).toLocaleDateString(locale(),
            { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Oslo" }),
            e.time_known ? ` · ${fmtTime(e.start)}` : ""),
          placeOf(e) && h("span", { class: "tcard-place" }, placeOf(e))))));
    // Under the cards: choose the selected card; once chosen, weather and travel.
    const follow = el("talk-follow");
    const cur = shown[sel];
    const kids = [];
    if (cur && cur.id !== chosen?.id && !(pending?.phase === "ask"))
      kids.push(btn(["✓ ", tt("btn_choose")], chooseSelected, "primary"));
    if (chosen && shown.includes(chosen) && !pending) {
      kids.push(btn([h("span", { "aria-hidden": "true" }, "☀ "), tt("btn_weather")],
        () => { stopSpeaking(); doWeather(chosen, ++askId); }, "fn-weather"));
      kids.push(btn([h("span", { "aria-hidden": "true" }, "→ "), tt("btn_trip")],
        () => { stopSpeaking(); doTrip(chosen, null, ++askId); }, "fn-travel"));
    }
    if (!pending && offset + 3 < results.length && shown.length > 1)
      kids.push(btn([tt("btn_next"), h("span", { "aria-hidden": "true" }, " ↓")], () => { ++askId; stopSpeaking(); showNext(); }));
    const link = chosen && shown.includes(chosen) ? chosen : cur;
    if (link && !pending) kids.push(h("a", { class: "big-link", href: link.source_url, target: "_blank", rel: "noopener" }, `${tt("source")} ↗`));
    follow.hidden = !kids.length;
    fill(follow, kids);
  }

  function renderTravel() {
    const box = el("talk-travel");
    if (!travel) return fill(box, h("p", { class: "tsec-empty" }, tt("travel_empty")));
    const e = travel.e;
    const parts = [h("p", { class: "tsec-for" }, `${tt("to_event")}: `, h("strong", {}, titleOf(e)), `, ${eventWhen(e)}${placeOf(e) ? " · " + placeOf(e) : ""}`)];
    parts.push(h("p", { class: "trip-say" }, travelSentence(travel)));
    if (travel.state === "ok") {
      parts.push(h("ol", { class: "trip-legs" }, travel.trip.legs.map((l) =>
        h("li", {},
          h("span", { class: "leg-time" }, fmtTime(l.expectedStartTime)),
          h("span", { "aria-hidden": "true" }, MODES[l.mode] || "•"),
          h("span", {}, l.line ? h("strong", { class: "line-code" }, l.line.publicCode || l.mode) : t("walk"),
            ` ${l.fromPlace.name} → ${l.toPlace.name}`)))));
    }
    if (travel.state !== "loading" && config?.entur) {
      parts.push(h("div", { class: "talk-origins" },
        h("p", {}, tt("other_start")),
        h("div", { class: "talk-row" }, config.origins.map((o) => {
          const on = travel.from?.id === o.id;
          return h("button", { class: "big-btn" + (on ? " on" : ""), type: "button", "aria-pressed": String(on),
                               onclick: () => { stopSpeaking(); doTrip(e, { origin: o }, ++askId); } }, o.name);
        }))));
    }
    if (travel.state === "ok" || travel.state === "none")
      parts.push(h("p", {}, h("a", { class: "big-link", href: "https://entur.no/", target: "_blank", rel: "noopener" }, t("plan_entur") + " ↗")));
    fill(box, parts);
  }

  function renderWeather() {
    const box = el("talk-weather");
    if (!weather) return fill(box, h("p", { class: "tsec-empty" }, tt("weather_empty")));
    const e = weather.e;
    const s = weather.state === "ok" ? weather.w.at_start : null;
    fill(box,
      h("p", { class: "tsec-for" }, h("strong", {}, titleOf(e)), `, ${eventWhen(e)}`),
      s && h("div", { class: "talk-wx" },
        h("span", { class: "talk-wx-icon", "aria-hidden": "true" }, symbolIcon(s.symbol)),
        h("span", { class: "talk-wx-temp" }, s.temp !== null ? `${Math.round(s.temp)}°` : "–"),
        h("span", {}, weatherDesc(s.symbol))),
      h("p", { class: "wx-say" }, weatherSentence(weather)));
  }

  function render() {
    renderHeard();
    el("talk-say").textContent = answer ? answer.say() : "";
    renderEvents();
    renderTravel();
    renderWeather();
    el("talk-examples").hidden = shown.length > 0;
    fill(el("talk-example-list"), workingExamples().map((ex) =>
      h("button", { class: "big-btn example", type: "button", onclick: () => ask(ex) }, ex)));
  }

  // ---------- wiring ----------

  function texts() {
    document.querySelectorAll("#talk-view [data-tt]").forEach((x) => (x.textContent = tt(x.dataset.tt)));
    document.querySelectorAll("#talk-view [data-ttp]").forEach((x) => (x.placeholder = tt(x.dataset.ttp)));
  }

  function init() {
    el("mic").hidden = !SR;
    el("no-speech").hidden = !!SR;
    el("talk-view").classList.toggle("no-sr", !SR);
    if (!synth) { el("stop-speech").hidden = true; el("mute").hidden = true; }
    else synth.getVoices(); // some browsers load the voice list lazily
    el("mic").addEventListener("click", micClick);
    el("notice-ok").addEventListener("click", () => {
      noticeOk = true;
      el("talk-notice").hidden = true;
      el("mic").focus();
      listen();
    });
    el("notice-type").addEventListener("click", () => {
      el("talk-notice").hidden = true;
      el("ask").focus();
    });
    el("ask-form").addEventListener("submit", (ev) => { ev.preventDefault(); ask(el("ask").value); });
    el("stop-speech").addEventListener("click", stopSpeaking);
    el("mute").addEventListener("click", () => {
      muted = !muted;
      el("mute").setAttribute("aria-pressed", String(!muted));
      if (muted) stopSpeaking();
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape" || mode !== "talk") return;
      if (!el("talk-notice").hidden) { el("talk-notice").hidden = true; el("mic").focus(); }
      rec?.abort(); rec = null;
      stopSpeaking();
      setState("idle");
    });
    texts();
    setState("idle");
  }

  function enter() { render(); }

  function leave() {
    rec?.abort(); rec = null;
    stopSpeaking();
    ++askId;
    // A fetch still running is dropped: do not come back to "Henter ..." for ever.
    if (travel?.state === "loading") travel = null;
    if (weather?.state === "loading") weather = null;
    setState("idle");
  }

  function applyLang() {
    // A new language: stop listening/speaking in the old one, re-render the answer.
    if (shownLang !== null && shownLang !== lang) {
      if (rec) { rec.abort(); rec = null; }
      stopSpeaking();
    }
    shownLang = lang;
    texts();
    setState(el("talk-view").dataset.state);
    render();
  }

  function dataLoaded(err) {
    dataError = err || null;
    loaded = true;
    render();
  }

  return { init, enter, leave, applyLang, dataLoaded };
})();

if (typeof module !== "undefined") module.exports = { TalkParser, TALK_TEXT };
