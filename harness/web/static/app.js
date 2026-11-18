// Beveg: "Tre trykk unna" (three taps away). A guided flow, one question per screen.
// Routes (hash): #/  #/naar/<tema>  #/liste/<tema>/<når>?filters  #/arr/<id>[/reise|/vaer]
//                #/overrask  #/spor  #/hjelp
// Plain JS, no build step. Nothing the user picks is stored (no localStorage,
// cookies or IndexedDB): language and text size live in memory only.
// Uses I18N (i18n.js) and TalkParser (parser.js).
"use strict";

const NS = "http://www.w3.org/2000/svg";
const TZ = "Europe/Oslo";
const LOC = { no: "nb-NO", en: "en-GB" };
const HTML_LANG = { no: "nb", en: "en" };
// Text sizes: root font size 15 / 17.5 / 20 (default) / 24 / 29 px. Memory only.
const SIZES = ["ts-0", "ts-1", "ts-2", "ts-3", "ts-4"];
const SIZE_PX = [15, 17.5, 20, 24, 29];
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  lang: "no", size: 2, who: "voksen", unginn: false,
  events: [], config: { origins: [], entur: false, yr: false },
  loaded: false, error: null, catsTrusted: true,
  stack: [], shown: new Map(), route: null,
  micOk: false, say: () => "",
  trip: null, weather: null, ask: null,
};

// ---------- small helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
function t(key, ...args) {
  const v = I18N[S.lang][key] ?? I18N.no[key];
  return typeof v === "function" ? v(...args) : v ?? key;
}
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === "") continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}
// replaceChildren() turns null into the text "null": always go through put().
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== ""));
}
function icon(name, cls = "icon") {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
// Event texts are Norwegian; mark them so screen readers pronounce them right.
const nb = (text, tag = "span", attrs = {}) => h(tag, { ...attrs, lang: S.lang === "no" ? null : "nb" }, text);
// Quiet "In Norwegian" marker next to source texts on the English page.
const inNb = () => (S.lang === "no" ? null : h("span", { class: "in-nb" }, t("in_nb")));
// Read-aloud segment in Norwegian (titles, venues from the source).
const NB = (text) => ({ text, lang: "no" });

async function api(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

let liveTimer = 0;
function announce(msg) {
  const live = $("#live");
  live.textContent = "";
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => (live.textContent = msg), 60);
}

// ---------- dates (Europe/Oslo) ----------

const fmt = (d, opts) => new Date(d).toLocaleString(LOC[S.lang], { timeZone: TZ, ...opts });
const dayKey = (d) => new Date(d).toLocaleDateString("sv-SE", { timeZone: TZ });
const todayKey = () => dayKey(Date.now());
const ymdDate = (ymd) => new Date(`${ymd}T12:00:00Z`);
const timeOf = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
const longDay = (d) => fmt(d, { weekday: "long", day: "numeric", month: "long" });
const shortDay = (d) => fmt(d, { weekday: "short", day: "numeric", month: "short" });
const osloHour = (d = Date.now()) => Number(new Date(d).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }));
const addDays = (ymd, n) => TalkParser.addDays(ymd, n);
const weekday = (ymd) => ymdDate(ymd).getUTCDay();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function daysFromToday(iso) {
  return Math.round((ymdDate(dayKey(iso)) - ymdDate(todayKey())) / 86400000);
}

// When-answers -> a day range. Same weekend/next-week rules as the parser.
const WHEN = ["idag", "imorgen", "helga", "nesteuke", "alle"];
function whenRange(key) {
  const today = todayKey(), wd = weekday(today);
  const sat = wd === 0 ? addDays(today, -1) : addDays(today, (6 - wd + 7) % 7);
  const nextMon = addDays(today, (8 - wd) % 7 || 7);
  if (key === "idag") return { from: today, to: today };
  if (key === "imorgen") { const d = addDays(today, 1); return { from: d, to: d }; }
  if (key === "helga") return { from: wd === 0 ? today : sat, to: addDays(sat, 1) };
  if (key === "nesteuke") return { from: nextMon, to: addDays(nextMon, 6) };
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{4}-\d{2}-\d{2}))?$/.exec(key || "");
  const ok = (d) => d && !isNaN(ymdDate(d)) && ymdDate(d).toISOString().slice(0, 10) === d;
  if (m && ok(m[1]) && (!m[2] || (ok(m[2]) && m[2] >= m[1]))) return { from: m[1], to: m[2] || m[1] };
  return null;
}
function whenLabel(key) {
  if (WHEN.includes(key)) return t(`when_${key}`);
  const r = whenRange(key);
  if (!r) return t("when_alle");
  if (r.from === r.to) return cap(longDay(ymdDate(r.from)));
  return `${shortDay(ymdDate(r.from))} – ${shortDay(ymdDate(r.to))}`;
}

// ---------- themes ----------
// cats: the 14 category keys. kw: title words ("~x" anywhere in a word, "=x" whole
// word, plain = start of a word). venue: the same, matched on the venue. Keywords
// make the demo feel right on mock data, where every event has the same category.

const THEMES = [
  { key: "musikk", icon: "music", cats: ["concert"],
    kw: ["~konsert", "~musikk", "music", "~jazz", "blues", "rock", "=band", "=kor", "korps", "~symfoni", "~sang", "vise", "opera"] },
  { key: "kultur", icon: "theatre", cats: ["theatre", "exhibition"],
    kw: ["~teater", "~teatr", "~forestilling", "~utstilling", "~kunst", "galleri", "museum", "revy", "musikal", "~show", "~premiere", "~film", "kino", "opera"],
    venue: ["~teater", "~kunst", "museum", "galleri", "~kulturhus"] },
  { key: "sport", icon: "sport", cats: ["sports"],
    kw: ["~trening", "=tur", "turgruppe", "turlag", "~fottur", "~skitur", "walk", "sport", "~idrett", "=ski", "~fotball", "~håndball", "hockey", "trim", "yoga", "~løp", "=cup", "~potten", "~kondisjon", "styrke", "~aktivitet", "~dans", "~bad"] },
  { key: "laere", icon: "learn", cats: ["course", "talk", "workshop"],
    kw: ["~kurs", "~foredrag", "~verksted", "workshop", "seminar", "~slekt", "~bibliotek", "~språk", "~skaper", "~mestring", "lær"] },
  { key: "mat", icon: "market", cats: ["market", "food_drink"],
    kw: ["~marked", "~kafe", "=mat", "~middag", "~lunsj", "~kaffe", "~smak", "=vin", "=øl", "~bakst", "~landhandel", "~åpning", "~butikk", "~julebord"] },
  { key: "folk", icon: "people", cats: ["meeting", "senior", "religious"],
    kw: ["~treff", "~møte", "~strikk", "~bingo", "senior", "~pensjonist", "~frivillig", "~gruppe", "~kafe", "~gudstjeneste", "messe", "~andakt", "quiz", "~fellesskap", "walkers"],
    venue: ["~frivillig", "~seniorsenter", "~eldresenter"] },
  { key: "familie", icon: "family", cats: ["kids"],
    kw: ["~barn", "~familie", "~baby", "~eventyr", "hest", "~prøysen", "~juleteat", "~lysshow", "~nisse", "lek", "~leke"],
    venue: ["~prøysen"] },
];
const theme = (key) => THEMES.find((x) => x.key === key) || null;
const themeLabel = (key) => (key === "alt" || !theme(key) ? t("theme_alt") : t(`theme_${key}`));

function kwHit(list, text) {
  if (!list?.length) return false;
  const toks = TalkParser.tokens(text);
  return list.some((k) => {
    const w = TalkParser.norm(k.replace(/^[~=]/, ""));
    if (k[0] === "~") return toks.some((x) => x.includes(w));
    if (k[0] === "=") return toks.includes(w);
    return toks.some((x) => x.startsWith(w));
  });
}
// What kind of event: the real category when categories are trusted, else the first
// theme the keywords match, else "other". Same badge on the surprise and event pages.
function kindOf(e) {
  if (S.catsTrusted && e.category && t("cat")[e.category]) {
    const th = THEMES.find((x) => x.cats.includes(e.category));
    return { icon: th ? th.icon : "grid", label: cap(t("cat")[e.category]) };
  }
  const th = THEMES.find((x) => inTheme(x, e));
  return th ? { icon: th.icon, label: t(`theme_${th.key}`) } : { icon: "grid", label: cap(t("cat").other) };
}
function kindBadge(e) {
  const k = kindOf(e);
  return h("p", { class: "kind" }, icon(k.icon, "icon icon-s"), h("span", {}, k.label));
}

function inTheme(th, e) {
  if (!th) return true;
  return (S.catsTrusted && th.cats.includes(e.category)) || kwHit(th.kw, e.title) || kwHit(th.venue, e.venue);
}

// ---------- event texts ----------

const PLACEHOLDER = /^\s*(mock[\s-]*(summary|sammendrag)|lorem ipsum.*|todo|tbd|n\/?a|placeholder|-+)\.?\s*$/i;
const realText = (s) => (s && !PLACEHOLDER.test(s) ? s.trim() : "");
function summaryOf(e) {
  const own = realText(e[`summary_${S.lang}`]);
  if (own) return { text: own, nb: false };
  const no = realText(e.summary_no);
  return no ? { text: no, nb: true } : null;
}
function placeOf(e) {
  const v = (e.venue || "").trim(), m = (e.municipality || "").trim();
  if (!v) return m;
  if (!m || TalkParser.norm(v).includes(TalkParser.norm(m))) return v;
  return `${v}, ${m}`;
}
const sameDay = (e) => !e.end || dayKey(e.end) === dayKey(e.start);
function timeText(e) {
  if (!e.time_known) return t("time_unknown");
  const end = e.end && e.end !== e.start && sameDay(e) ? `–${timeOf(e.end)}` : "";
  return `${t("at_clock")} ${timeOf(e.start)}${end}`;
}
function relDay(e) {
  const d = daysFromToday(e.start);
  if (d <= 0) return t("rel_today");
  if (d === 1) return t("rel_tomorrow");
  return t("rel_days", d);
}

// ---------- filtering ----------

function parseFilters(qs) {
  const p = new URLSearchParams(qs || "");
  const list = (k) => (p.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
  return { kat: list("kat"), kw: list("kw"), sted: list("sted"), ord: list("ord"), kveld: p.get("kveld") === "1" };
}
function filterQs(f) {
  const p = new URLSearchParams();
  for (const k of ["kat", "kw", "sted", "ord"]) if (f[k].length) p.set(k, f[k].join(","));
  if (f.kveld) p.set("kveld", "1");
  const s = p.toString();
  return s ? `?${s}` : "";
}
function findEvents(themeKey, whenKey, f) {
  const th = theme(themeKey);
  const range = whenRange(whenKey);
  const base = S.events.filter((e) => inTheme(th, e));
  const q = {
    date: range ? { ...range, evening: f.kveld } : null, evening: f.kveld,
    // On untrusted (mock) categories, only the category words count, not e.category.
    cats: f.kat.length ? (S.catsTrusted ? f.kat : ["__none__"]) : [],
    catWords: f.kw, places: f.sted, words: f.ord,
  };
  return TalkParser.match(q, base);
}
function countFor(themeKey, whenKey) {
  return findEvents(themeKey, whenKey, parseFilters("")).list.length;
}

// ---------- routing ----------

function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  let parts;
  try { parts = path.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { return { name: "notfound", parts: [], qs: "", hash: `#/${raw}` }; }
  const r = { name: "home", parts, qs, hash: `#/${raw}` };
  if (parts[0] === "naar" && parts[1]) r.name = "when";
  else if (parts[0] === "liste" && parts[1]) r.name = "list";
  else if (parts[0] === "arr" && parts[1]) r.name = "ticket";
  else if (parts[0] === "overrask") r.name = "surprise";
  else if (parts[0] === "spor") r.name = "ask";
  else if (parts[0] === "hjelp") r.name = "help";
  else if (parts[0] === "bekreft" && parts[1]) r.name = "confirm";
  else if (parts[0] === "billetter" && parts[1]) r.name = "tickets";
  else if (parts.length) r.name = "notfound";
  return r;
}
function go(hash) {
  if (location.hash === hash) render(false);
  else location.hash = hash;
}
function parentOf(r) {
  if (r.name === "list") return r.parts[1] === "alt" ? "#/" : `#/naar/${r.parts[1]}`;
  if (r.name === "confirm") return `#/arr/${encodeURIComponent(r.parts[1])}/reise${r.qs ? `?${r.qs}` : ""}`;
  if (r.name === "tickets") {
    const p = new URLSearchParams(r.qs);
    p.delete("hvem");
    p.delete("unginn");
    return `#/bekreft/${encodeURIComponent(r.parts[1])}${p.toString() ? `?${p}` : ""}`;
  }
  return "#/";
}
function goBack() {
  if (S.stack.length > 1) history.back();
  else go(parentOf(parseRoute()));
}
function onHashChange() {
  const hash = location.hash || "#/";
  if (S.stack.length > 1 && S.stack[S.stack.length - 2] === hash) S.stack.pop();
  else if (S.stack[S.stack.length - 1] !== hash) S.stack.push(hash);
  render(true);
}

const SCREENS = {
  home: renderHome, when: renderWhen, list: renderList, ticket: renderTicket,
  surprise: renderSurprise, ask: renderAsk, help: renderHelp, notfound: renderNotFound, confirm: renderConfirm, tickets: renderTickets,
};
const STEPS = { home: "step_home", when: "step_when", list: "step_list", ticket: "step_ticket",
  surprise: "step_surprise", ask: "step_ask", help: "step_help", notfound: "step_notfound", confirm: "step_confirm", tickets: "step_tickets" };

function render(moveFocus) {
  stopSpeaking();
  if (rec) { const r0 = rec; rec = null; try { r0.abort(); } catch { /* already stopped */ } }
  $("#toast").hidden = true;
  $("#ret-dialog")?.remove();
  const r = parseRoute();
  const sameScreen = S.route && S.route.hash === r.hash;
  S.route = r;
  document.body.dataset.screen = r.name;
  document.body.dataset.sky = "none";
  $("#step").textContent = t(STEPS[r.name]);
  const main = $("#screen");
  const scrollY = window.scrollY;
  if (!S.loaded) put(main, loadingView());
  else if (S.error) put(main, errorView());
  else put(main, SCREENS[r.name](r));
  document.title = `${$("#screen h1")?.textContent || "Beveg"} · Beveg`;
  if (sameScreen && !moveFocus) window.scrollTo(0, scrollY);
  else window.scrollTo(0, 0);
  if (moveFocus) {
    const target = $("#screen [data-focus]") || $("#screen h1");
    target?.focus({ preventScroll: !target.dataset.focus });
    if (target?.dataset.focus) target.scrollIntoView({ block: "start" });
  }
}

function heading(text, attrs = {}) {
  return h("h1", { tabindex: "-1", class: "q", ...attrs }, text);
}

function loadingView() {
  S.say = () => t("loading");
  return h("section", { class: "screen" }, heading(t("loading")), h("div", { class: "spinner", "aria-hidden": "true" }));
}
function errorView() {
  S.say = () => `${t("err_events_title")}. ${t("err_events_body")}`;
  return h("section", { class: "screen" },
    heading(t("err_events_title")),
    h("p", { class: "lead" }, t("err_events_body")),
    h("button", { class: "btn btn-primary", type: "button", onclick: () => location.reload() },
      icon("refresh"), t("retry")));
}

// ---------- 1. home ----------

function greeting() {
  const hr = osloHour();
  return hr >= 5 && hr < 11 ? t("greet_morning") : hr < 14 && hr >= 11 ? t("greet_day")
    : hr >= 14 && hr < 18 ? t("greet_afternoon") : t("greet_evening");
}
function timeOfDay() {
  const hr = osloHour();
  return hr >= 5 && hr < 11 ? "morning" : hr >= 11 && hr < 17 ? "day" : hr >= 17 && hr < 21 ? "evening" : "night";
}

function renderHome() {
  document.body.dataset.tod = timeOfDay();
  const scene = $("#tpl-landscape").content.cloneNode(true);
  const tiles = THEMES.map((th, i) => h("li", { style: `--i:${i}` },
    h("a", { class: `tile tile-${th.key}`, href: `#/naar/${th.key}` },
      h("span", { class: "tile-art" }, icon(th.icon, "icon icon-xl")),
      h("span", { class: "tile-label" }, t(`theme_${th.key}`)))));
  tiles.push(h("li", { style: `--i:${THEMES.length}` },
    h("a", { class: "tile tile-surprise", href: "#/overrask", onclick: () => { S.surprise = null; } },
      h("span", { class: "tile-art" }, icon("surprise", "icon icon-xl")),
      h("span", { class: "tile-label" }, t("theme_surprise")))));
  S.say = () => `${greeting()}. ${t("home_q")} ${THEMES.map((th) => t(`theme_${th.key}`)).join(", ")}, ${t("theme_surprise")}. ${t("all_btn")}. ${t("ask_btn")}.`;
  return h("section", { class: "screen home" },
    h("div", { class: "hero" },
      h("div", { class: "landscape", "aria-hidden": "true" }, scene),
      h("p", { class: "greeting" }, greeting()),
      heading(t("home_q"))),
    h("ul", { class: "tiles", role: "list" }, tiles),
    h("a", { class: "btn btn-wide btn-secondary", href: "#/liste/alt/alle" }, icon("grid"),
      h("span", {}, t("all_btn"), h("small", {}, t("all_count", S.events.length)))),
    h("a", { class: "btn btn-wide btn-mic", href: "#/spor" }, h("span", { class: "mic-dot" }, icon("mic")), t("ask_btn")),
    footer());
}

function footer() {
  return h("footer", { class: "foot" },
    h("a", { href: "#/hjelp" }, icon("help"), t("help_link")),
    h("p", {}, t("data_credit")));
}

// ---------- 2. when ----------

function renderWhen(r) {
  const tk = r.parts[1];
  const th = tk === "alt" ? null : theme(tk);
  if (!th && tk !== "alt") return renderNotFound();
  const btn = (key) => {
    const n = countFor(tk, key);
    return h("li", {}, h("a", { class: `btn btn-when${key === "alle" ? " btn-primary" : ""}`, href: `#/liste/${tk}/${key}` },
      icon(key === "alle" ? "infinity" : "calendar"),
      h("span", { class: "btn-text" }, t(`when_${key}`), h("small", {}, n ? t("n_things", n) : t("n_none")))));
  };
  const date = h("input", { type: "date", id: "pick-date", min: todayKey(), value: todayKey(), class: "date-input" });
  const showDate = () => { if (/^\d{4}-\d{2}-\d{2}$/.test(date.value)) go(`#/liste/${tk}/${date.value}`); };
  date.addEventListener("keydown", (ev) => { if (ev.key === "Enter") showDate(); });
  S.say = () => `${t("when_q")} ${WHEN.map((k) => t(`when_${k}`)).join(", ")}. ${t("pick_day")}.`;
  return h("section", { class: "screen" },
    h("p", { class: "kicker" }, icon(th ? th.icon : "grid"), themeLabel(tk)),
    heading(t("when_q")),
    h("ul", { class: "when-list", role: "list" }, WHEN.map(btn)),
    h("div", { class: "date-pick" },
      h("label", { for: "pick-date" }, icon("calendar"), t("pick_day")),
      h("div", { class: "date-row" }, date,
        h("button", { class: "btn btn-secondary", type: "button", onclick: showDate }, t("show_day")))),
    footer());
}

// ---------- 3. list ----------

function chipsFor(tk, wk, f) {
  const chips = [];
  const base = `#/liste/`;
  const without = (patch) => {
    const nf = { ...f, ...patch };
    return `${base}${patch.theme ?? tk}/${patch.when ?? wk}${filterQs(nf)}`;
  };
  if (tk !== "alt") chips.push([themeLabel(tk), without({ theme: "alt" })]);
  if (wk !== "alle") chips.push([whenLabel(wk), without({ when: "alle" })]);
  for (const c of f.kat) chips.push([cap(t("cat")[c] || c), without({ kat: f.kat.filter((x) => x !== c), kw: [] })]);
  for (const s of f.sted) chips.push([cap(s), without({ sted: f.sted.filter((x) => x !== s) })]);
  for (const w of f.ord) chips.push([t("quote", w), without({ ord: f.ord.filter((x) => x !== w) })]);
  if (f.kveld) chips.push([t("evening"), without({ kveld: false })]);
  return chips;
}

function renderList(r) {
  const tk = r.parts[1], wk = r.parts[2] || "alle";
  if ((tk !== "alt" && !theme(tk)) || (!WHEN.includes(wk) && !whenRange(wk))) return renderNotFound();
  const f = parseFilters(r.qs);
  const { list, droppedWords } = findEvents(tk, wk, f);
  const key = r.hash;
  const shown = Math.min(list.length, S.shown.get(key) || 5);
  const chips = chipsFor(tk, wk, f);

  const sec = h("section", { class: "screen" });
  const title = list.length ? t("found", list.length) : t("empty_title");
  sec.append(heading(title));
  if (chips.length) sec.append(h("div", { class: "chips", role: "group", "aria-label": t("filters_label") },
    h("span", { class: "chips-lead" }, t("filters_lead")),
    chips.map(([label, href], i) => [i ? h("span", { class: "dot", "aria-hidden": "true" }, "·") : null,
      h("a", { class: "chip", href, "aria-label": t("remove_filter", label) }, h("span", {}, label), icon("x", "icon icon-s"))])));
  if (droppedWords.length) sec.append(h("p", { class: "note" }, t("dropped", droppedWords.map((w) => t("quote", w)).join(", "))));

  if (!list.length) {
    sec.append(
      h("div", { class: "empty" }, icon("binoculars", "icon icon-xxl"), h("p", { class: "lead" }, t("empty_body"))),
      h("div", { class: "stack" },
        h("a", { class: "btn btn-primary btn-wide", href: `#/naar/${tk}` }, icon("calendar"), t("try_other_day")),
        h("a", { class: "btn btn-secondary btn-wide", href: "#/liste/alt/alle" }, icon("grid"), t("all_btn"))));
    S.say = () => `${t("empty_title")}. ${t("empty_body")}`;
    sec.append(footer());
    return sec;
  }

  const ul = h("ul", { class: "cards", role: "list" });
  const addCards = (from, to) => {
    for (let i = from; i < to; i++) ul.append(card(list[i], i - from));
  };
  addCards(0, shown);
  sec.append(ul);
  const more = h("button", { class: "btn btn-primary btn-wide", type: "button" });
  const setMore = () => {
    const left = list.length - (S.shown.get(key) || 5);
    more.hidden = left <= 0;
    put(more, icon("plus"), t("show_more", Math.min(5, left), left));
  };
  more.addEventListener("click", () => {
    const now = S.shown.get(key) || 5;
    const next = Math.min(list.length, now + 5);
    S.shown.set(key, next);
    addCards(now, next);
    setMore();
    ul.children[now]?.querySelector("a")?.focus();
    announce(t("showing", next, list.length));
  });
  S.shown.set(key, shown);
  setMore();
  sec.append(more, h("p", { class: "count" }, t("showing", shown, list.length)));
  S.say = () => {
    const n = S.shown.get(key) || 5;
    return [`${title}.`, ...list.slice(0, n).flatMap((e, i) => [`${i + 1}:`, NB(`${e.title}.`),
      `${cap(longDay(e.start))}, ${timeText(e)}.`, NB(`${placeOf(e)}.`), e.cancelled ? `${t("cancelled")}.` : ""])];
  };
  sec.append(footer());
  return sec;
}

function dateBlock(e) {
  return h("span", { class: "datebox", "aria-hidden": "true" },
    h("span", { class: "db-wd" }, fmt(e.start, { weekday: "short" }).replace(".", "")),
    h("span", { class: "db-day" }, fmt(e.start, { day: "numeric" }).replace(".", "")),
    h("span", { class: "db-mon" }, fmt(e.start, { month: "short" }).replace(".", "")));
}

function card(e, i = 0) {
  return h("li", { class: "card-li", style: `--i:${i}` },
    h("a", { class: `card${e.cancelled ? " is-cancelled" : ""}`, href: `#/arr/${e.id}` },
      dateBlock(e),
      h("span", { class: "card-body" },
        e.cancelled ? h("span", { class: "badge-cancel" }, icon("x", "icon icon-s"), t("cancelled")) : null,
        nb(e.title, "span", { class: "card-title" }),
        h("span", { class: "sr-only" }, cap(longDay(e.start)) + ", "),
        h("span", { class: "card-meta" }, icon("clock", "icon icon-s"), timeText(e)),
        h("span", { class: "card-meta" }, icon("pin", "icon icon-s"), nb(placeOf(e)))),
      icon("chevron", "icon card-go")));
}

function renderNotFound() {
  S.say = () => t("notfound_title");
  return h("section", { class: "screen" }, heading(t("notfound_title")),
    h("p", { class: "lead" }, t("notfound_body")),
    h("a", { class: "btn btn-primary btn-wide", href: "#/liste/alt/alle" }, icon("grid"), t("all_btn")));
}

// ---------- surprise ----------

function renderSurprise() {
  const pool = S.events.filter((e) => !e.cancelled);
  if (!pool.length) return renderNotFound();
  // The pick stays until "Overrask meg igjen", so a language switch or Back keeps it.
  let pick = S.surprise && pool.find((e) => e.id === S.surprise);
  const fresh = !pick;
  if (!pick) { pick = pool[Math.floor(Math.random() * pool.length)]; S.surprise = pick.id; }
  const again = () => { S.surprise = null; render(false); $("#screen h1")?.focus(); };
  const stage = h("div", { class: "reveal", "aria-hidden": "true" });
  const result = h("div", { class: "reveal-result", hidden: true },
    kindBadge(pick),
    realText(pick[`summary_${S.lang}`]) ? h("p", { class: "one-line" }, realText(pick[`summary_${S.lang}`])) : null,
    h("ul", { class: "cards", role: "list" }, card(pick)),
    h("div", { class: "stack" },
      h("a", { class: "btn btn-primary btn-wide", href: `#/arr/${pick.id}` }, icon("check"), t("surprise_yes")),
      h("button", { class: "btn btn-secondary btn-wide", type: "button", onclick: again }, icon("shuffle"), t("surprise_again"))));
  const finish = () => {
    if (!result.isConnected) return;
    stage.remove();
    result.hidden = false;
    result.classList.add("pop");
    if (fresh) announce(`${t("surprise_q")} ${pick.title}, ${longDay(pick.start)}.`);
  };
  if (reduced() || !fresh) setTimeout(finish, 0);
  else {
    const titles = pool.map((e) => e.title);
    let n = 0;
    const spin = () => {
      if (!stage.isConnected) return;
      stage.textContent = titles[Math.floor(Math.random() * titles.length)];
      stage.classList.toggle("flip");
      if (++n < 9) setTimeout(spin, 60 + n * 14);
      else finish();
    };
    setTimeout(spin, 0);
  }
  S.say = () => [`${t("surprise_q")} ${kindOf(pick).label}:`, NB(`${pick.title}.`),
    `${cap(longDay(pick.start))}, ${timeText(pick)}.`, NB(`${placeOf(pick)}.`)];
  return h("section", { class: "screen surprise" },
    h("div", { class: "sparkles", "aria-hidden": "true" }, Array.from({ length: 8 }, (_, i) => h("i", { style: `--k:${i}` }))),
    heading(t("surprise_q")), stage, result, footer());
}

// ---------- 4. ticket ----------

const safeUrl = (u) => /^https?:\/\//i.test(u || "");
function eventById(id) { return S.events.find((e) => e.id === id) || null; }

function renderTicket(r) {
  const e = eventById(r.parts[1]);
  if (!e) return renderNotFound();
  const focusPart = r.parts[2]; // "reise" | "vaer"
  if (S.weather?.id !== e.id) S.weather = { id: e.id, state: "idle" };
  if (S.trip?.id !== e.id) S.trip = newTrip(e, null);
  tripFromQs(e, r.qs);

  const sum = summaryOf(e);
  const others = S.events.filter((x) => x.id !== e.id && x.title === e.title && x.venue === e.venue);

  const skyBand = h("div", { class: "sky-band", "aria-hidden": "true" }, h("div", { class: "scene" }));
  const wxBox = h("div", { class: "answer", id: "wx-box" });
  const tripBox = h("div", { class: "answer", id: "trip-box" });

  const qa = (ic, q, id, ...body) => h("section", { class: "qa", "aria-labelledby": id },
    h("h2", { id, tabindex: "-1" }, h("span", { class: "qa-icon" }, icon(ic)), q), ...body);

  const sec = h("article", { class: "screen ticket" },
    h("div", { class: "ticket-head" }, skyBand,
      h("p", { class: "kicker" }, icon("ticket"), t("your_ticket")),
      nb(e.title, "h1", { class: "q", tabindex: "-1" }),
      inNb(),
      h("p", { class: "ticket-rel" }, relDay(e))),
    e.cancelled ? h("p", { class: "banner-cancel", role: "note" }, icon("x"), t("cancelled_long")) : null,
    h("div", { class: "ticket-body" },
      qa("info", t("q_what"), "q-what",
        h("div", { class: "answer" },
          kindBadge(e),
          sum ? h("p", { lang: sum.nb && S.lang !== "no" ? "nb" : null }, sum.text, sum.nb ? [" ", inNb()] : null)
            : h("p", {}, nb(e.title), " ", inNb()))),
      qa("clock", t("q_when"), "q-when",
        h("div", { class: "answer" },
          h("p", { class: "big" }, cap(longDay(e.start))),
          h("p", {}, timeText(e)),
          !sameDay(e) ? h("p", {}, t("until_day", longDay(e.end))) : null,
          others.length ? h("div", { class: "also" }, h("p", {}, t("also_dates")),
            h("ul", { class: "chips", role: "list" }, others.slice(0, 8).map((x) =>
              h("li", {}, h("a", { class: "chip", href: `#/arr/${x.id}` },
                `${shortDay(x.start)}${x.time_known ? " " + timeOf(x.start) : ""}`))))) : null)),
      qa("pin", t("q_where"), "q-where",
        h("div", { class: "answer" },
          nb(e.venue || e.municipality || t("place_unknown"), "p", { class: "big" }),
          e.address && !(e.venue || "").includes(e.address) ? nb(e.address, "p") : null,
          e.municipality && e.venue ? h("p", { class: "muted" }, `${t("municipality")}: ${e.municipality}`) : null)),
      qa("sun", t("q_weather"), "q-vaer", wxBox),
      qa("bus", t("q_travel"), "q-reise", tripBox),
      h("section", { class: "actions", "aria-label": t("actions_label") },
        h("button", { class: "btn btn-action", type: "button", id: "act-read", onclick: () => toggleSpeak() }, icon("speaker"), t("read_aloud")),
        h("button", { class: "btn btn-action", type: "button", onclick: () => share(e) }, icon("share"), t("share")),
        h("button", { class: "btn btn-action", type: "button", onclick: () => downloadIcs(e) }, icon("calendar-plus"), t("add_cal")),
        safeUrl(e.source_url) ? h("a", { class: "btn btn-action", href: e.source_url, target: "_blank", rel: "noopener" }, icon("external"), t("more_info"),
          h("span", { class: "sr-only" }, ` (${t("new_tab")})`)) : null)),
    footer());

  if (focusPart === "reise") $("#q-reise", sec).dataset.focus = "1";
  if (focusPart === "vaer") $("#q-vaer", sec).dataset.focus = "1";

  renderWeather(e, wxBox, skyBand);
  renderTrip(e, tripBox);
  S.say = () => {
    const parts = [NB(e.title), e.cancelled ? t("cancelled_long") : "",
      `${t("q_what")} ${kindOf(e).label}.`, sum?.nb ? NB(sum.text) : sum ? sum.text : NB(e.title),
      `${t("q_when")} ${cap(longDay(e.start))}, ${timeText(e)}.`,
      t("q_where"), NB(`${placeOf(e)}.`),
      `${t("q_weather")} ${S.weather.sentence || $("#wx-box")?.innerText || ""}`,
      `${t("q_travel")} ${$("#trip-panel ol")?.innerText || $("#trip-box .msg")?.innerText || t("pick_origin")}`];
    return parts.filter(Boolean);
  };
  return sec;
}

// ----- weather -----

function skyKind(sym) {
  if (!sym) return "none";
  if (sym.includes("thunder")) return "thunder";
  if (sym.includes("sleet")) return "sleet";
  if (sym.includes("snow")) return "snow";
  if (sym.includes("rain")) return "rain";
  if (sym.includes("fog")) return "fog";
  if (sym.startsWith("cloudy")) return "cloudy";
  if (sym.endsWith("_night")) return "night";
  if (sym.startsWith("partlycloudy") || sym.startsWith("fair")) return "partly";
  return sym.startsWith("clearsky") ? "clear" : "none";
}
const WX_ICON = { clear: "sun", night: "moon", partly: "partly", cloudy: "cloud", rain: "rain",
  sleet: "snow", snow: "snow", thunder: "thunder", fog: "fog", none: "cloud" };

function symbolPhrase(sym) {
  const k = skyKind(sym);
  const heavy = sym?.startsWith("heavy"), light = sym?.startsWith("light");
  const showers = sym?.includes("showers");
  if (k === "rain") return t(showers ? "wx_showers" : heavy ? "wx_heavyrain" : light ? "wx_lightrain" : "wx_rain");
  if (k === "snow") return t(light ? "wx_lightsnow" : "wx_snow");
  if (k === "night") return t(sym.startsWith("clearsky") ? "wx_clear_night" : "wx_partly");
  return t(`wx_${k}`);
}
function windWord(ms) {
  if (ms === null || ms === undefined) return null;
  return t(ms < 4 ? "wind_calm" : ms < 8 ? "wind_light" : ms < 14 ? "wind_fresh" : "wind_strong");
}

function scene(kind) {
  const n = { rain: 14, thunder: 14, sleet: 12, snow: 14 }[kind] || 0;
  const parts = [];
  if (kind === "clear" || kind === "partly") parts.push(h("i", { class: "sc-sun" }));
  if (kind === "night") parts.push(h("i", { class: "sc-moon" }), ...Array.from({ length: 6 }, (_, i) => h("i", { class: "sc-star", style: `--k:${i}` })));
  if (["partly", "cloudy", "rain", "snow", "sleet", "thunder", "fog"].includes(kind))
    parts.push(...[0, 1, 2].map((i) => h("i", { class: "sc-cloud", style: `--k:${i}` })));
  for (let i = 0; i < n; i++) parts.push(h("i", { class: kind === "snow" || (kind === "sleet" && i % 2) ? "sc-flake" : "sc-drop", style: `--k:${i}` }));
  if (kind === "thunder") parts.push(h("i", { class: "sc-flash" }));
  return parts;
}

function wxMsg(box, text, cls = "msg") {
  put(box, h("p", { class: cls }, text));
}

function wxInfo(w) {
  const s = w.at_start, kind = skyKind(s.symbol);
  const temp = s.temp !== null && s.temp !== undefined ? Math.round(s.temp) : null;
  const tips = [];
  if (temp !== null && temp <= 5) tips.push(t("tip_cold"));
  if (["rain", "sleet", "thunder"].includes(kind)) tips.push(t("tip_umbrella"));
  if (kind === "snow") tips.push(t("tip_shoes"));
  if (!tips.length && temp !== null && temp >= 15 && ["clear", "partly"].includes(kind)) tips.push(t("tip_nice"));
  return { s, kind, temp, tips, sentence: t("wx_sentence", symbolPhrase(s.symbol), temp, windWord(s.wind)) };
}

async function renderWeather(e, box0, band0) {
  const W = S.weather;
  // box0/band0: the new screen before it is in the DOM; later paints look it up.
  const paint = (box = $("#wx-box"), band = $("#screen .sky-band")) => {
    if (!box || S.weather !== W) return;
    const retry = () => { W.state = "idle"; renderWeather(e); };
    if (W.state === "off") return wxMsg(box, t("wx_off"));
    if (W.state === "error") return put(box, h("p", { class: "msg" }, t("wx_error")),
      h("button", { class: "btn btn-secondary", type: "button", onclick: retry }, icon("refresh"), t("retry")));
    if (W.state === "loading") return wxMsg(box, t("wx_loading"), "msg loading");
    const w = W.data;
    if (!w.available) {
      W.sentence = t("wx_later", w.days_until, longDay(w.forecast_until));
      return put(box, h("p", { class: "msg" }, icon("hourglass"), " ", W.sentence));
    }
    const { s, kind, temp, tips, sentence } = wxInfo(w);
    document.body.dataset.sky = kind;
    if (band) put(band.firstChild, ...scene(kind));
    W.sentence = sentence;
    const conf = w.confidence;
    put(box, 
      h("div", { class: "wx-main" },
        h("span", { class: `wx-icon wx-${kind}` }, icon(WX_ICON[kind] || "cloud", "icon icon-xxl")),
        h("div", {},
          temp !== null ? h("p", { class: "wx-temp", "aria-hidden": "true" }, `${temp}°`) : null,
          h("p", { class: "big" }, W.sentence),
          tips.length ? h("p", { class: "tip" }, tips.join(" ")) : null)),
      h("p", { class: `conf conf-${conf}` },
        h("span", { class: "conf-dots", "aria-hidden": "true" }, [0, 1, 2].map((i) =>
          h("i", { class: i < ({ high: 3, medium: 2, low: 1 }[conf] || 1) ? "on" : "" }))),
        t(`conf_${conf}`)),
      w.strip?.length > 1 ? h("ol", { class: "strip", "aria-label": t("wx_hours") }, w.strip.slice(0, 8).map((x) =>
        h("li", { class: x.time === s.time ? "now" : "" },
          h("span", {}, timeOf(x.time)),
          icon(WX_ICON[skyKind(x.symbol)] || "cloud"),
          h("span", {}, x.temp !== null && x.temp !== undefined ? `${Math.round(x.temp)}°` : "–")))) : null,
      w.time_guessed ? h("p", { class: "muted" }, t("wx_guessed")) : null,
      h("p", { class: "muted small" }, t("wx_source")));
  };
  if (W.state !== "idle") return paint(box0, band0);
  if (!S.config.yr) { W.state = "off"; return paint(box0, band0); }
  W.state = "loading";
  paint(box0 || undefined, band0 || undefined);
  try {
    W.data = await api(`/api/event/${e.id}/weather`);
    W.state = "done";
  } catch { W.state = "error"; }
  if (S.weather !== W) return;
  paint();
  if (S.route?.name === "confirm" && S.route.parts[1] === e.id) paintConfirm(e);
  if (S.route?.name === "ticket") announce(W.state === "done" ? t("wx_ready") : t("wx_error"));
}

// ----- travel: outbound and return, only what Entur gives -----
// S.trip = { id, origin, hits, dir: "out" | "ret",
//            out: { state, data, pick }, ret: { state, data, pick (null = no return) } }
// The same origin is used both ways: the return trip goes back to it.

const MODE_ICON = { foot: "walk", bus: "bus", coach: "bus", rail: "train", tram: "train", metro: "train",
  water: "boat", air: "plane", taxi: "bus", bicycle: "walk" };

// Entur names a coordinate start/end "Origin"/"Destination": show the real place instead.
const placeName = (name, fallback) => (!name || /^(origin|destination)$/i.test(name.trim()) ? fallback : name);
// Start and end names for a direction: out = origin -> venue, return = venue -> origin.
function endsOf(e, T, dir) {
  const venue = T[dir].data?.venue?.name || e.venue || e.municipality || "";
  return dir === "out" ? { start: T.origin.name, end: venue } : { start: venue, end: T.origin.name };
}

function tripSteps(p, endName, startName = "") {
  const steps = [];
  p.legs.forEach((l, i) => {
    const mins = Math.max(1, Math.round((new Date(l.expectedEndTime) - new Date(l.expectedStartTime)) / 60000));
    if (l.mode === "foot") {
      if ((l.distance || 0) < 40) return;
      const to = i === p.legs.length - 1 ? endName : placeName(l.toPlace?.name, endName);
      steps.push({ ic: "walk", text: t("step_walk", mins, to) });
    } else {
      steps.push({ ic: MODE_ICON[l.mode] || "bus",
        text: t("step_ride", t("mode")[l.mode] || t("mode").bus, l.line?.publicCode || "", timeOf(l.expectedStartTime),
          placeName(l.fromPlace?.name, startName), placeName(l.toPlace?.name, endName)) });
    }
  });
  steps.push({ ic: "flag", text: t("step_arrive", timeOf(p.expectedEndTime)) });
  return steps;
}
function tripLine(p) {
  return t("trip_line", timeOf(p.expectedStartTime), timeOf(p.expectedEndTime), Math.round(p.duration / 60));
}
function legSummary(p) {
  const tr = p.legs.find((l) => l.mode !== "foot");
  return tr ? `${t("mode")[tr.mode] || t("mode").bus}${tr.line?.publicCode ? ` ${tr.line.publicCode}` : ""}` : t("walk_only");
}
function stepsList(p, endName, startName) {
  return h("ol", { class: "steps" }, tripSteps(p, endName, startName).map((s, i) => h("li", { style: `--i:${i}` },
    h("span", { class: "step-n", "aria-hidden": "true" }, String(i + 1)),
    h("span", { class: "step-ic" }, icon(s.ic)),
    h("span", { class: "step-text" }, s.text))));
}
function enturLink(url) {
  return h("p", {}, h("a", { class: "ext", href: url || "https://entur.no/", target: "_blank", rel: "noopener" },
    icon("external", "icon icon-s"), t("open_entur"), h("span", { class: "sr-only" }, ` (${t("new_tab")})`)));
}

function newTrip(e, origin) {
  return { id: e.id, origin, hits: [], dir: "out",
    out: { state: "idle", data: null, pick: 0 }, ret: { state: "idle", data: null, pick: null } };
}
const tripOf = (e) => (S.trip?.id === e.id ? S.trip : null);
function chosen(T, dir) {
  const D = T?.[dir];
  if (!D || D.state !== "done" || D.pick === null) return null;
  return D.data.trips[D.pick] || null;
}

function originQs(o) {
  const p = new URLSearchParams({ fra: o.id || "" });
  if (!S.config.origins.some((x) => x.id === o.id)) { p.set("navn", o.name); p.set("lat", o.lat); p.set("lon", o.lon); }
  return p;
}
function originFromQs(qs) {
  const p = new URLSearchParams(qs || "");
  const id = p.get("fra") || "";
  const fixed = id && S.config.origins.find((x) => x.id === id);
  if (fixed) return fixed;
  if (!p.get("lat") || !p.get("lon")) return null;
  const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { id, name: p.get("navn") || t("start_point"), lat, lon };
}
// Origin and choices from a URL (?fra=&tur=&retur=) into S.trip, for shared links and Back.
function tripFromQs(e, qs) {
  if (!S.config.entur) return tripOf(e);
  const origin = originFromQs(qs);
  if (!origin) return tripOf(e);
  const p = new URLSearchParams(qs || "");
  const int = (k) => {
    if (p.get(k) === null) return null;
    const n = Number.parseInt(p.get(k), 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  };
  let T = tripOf(e);
  if (!T || !T.origin || T.origin.id !== origin.id || T.origin.name !== origin.name) T = S.trip = newTrip(e, origin);
  if (int("tur") !== null) T.out.pick = int("tur");
  if (int("retur") !== null) T.ret.pick = int("retur");
  return T;
}
// The choices as URL parameters (?fra=&tur=&retur=).
function tripParams(e) {
  const T = tripOf(e);
  const p = T?.origin ? originQs(T.origin) : new URLSearchParams();
  if (T?.origin) {
    if (T.out.pick !== null && T.out.state !== "error" && !(T.out.state === "done" && !T.out.data.trips.length)) p.set("tur", String(T.out.pick));
    if (T.ret.pick !== null && T.ret.state !== "error") p.set("retur", String(T.ret.pick));
  }
  return p;
}

async function loadTrips(e, dir = "out") {
  const T = tripOf(e);
  if (!T?.origin) return;
  const D = T[dir], o = T.origin;
  D.state = "loading";
  repaintTrips(e);
  const qs = new URLSearchParams({ id: o.id || "", name: o.name, lat: o.lat, lon: o.lon, dir: dir === "ret" ? "return" : "out" });
  try {
    const data = await api(`/api/event/${e.id}/trips?${qs}`);
    if (!Array.isArray(data?.trips)) throw new Error("bad response");
    D.data = data;
    D.state = "done";
    if (D.pick !== null && !(D.pick < data.trips.length)) D.pick = dir === "out" ? 0 : null;
  } catch { D.state = "error"; }
  if (S.trip !== T || T.origin !== o) return;
  repaintTrips(e);
  if (["ticket", "confirm"].includes(S.route?.name)) {
    announce(D.state === "error" ? t(dir === "ret" ? "ret_error" : "trip_error")
      : D.data.trips.length ? t("trip_ready", D.data.trips.length) : t("no_trips"));
  }
}
function ensureTrips(e) {
  const T = tripOf(e);
  if (!T?.origin || !S.config.entur) return;
  if (T.out.state === "idle") loadTrips(e, "out");
  if (T.ret.state === "idle" && (T.dir === "ret" || T.ret.pick !== null)) loadTrips(e, "ret");
}
function repaintTrips(e) {
  const el = $("#trip-panel");
  if (el) paintTripPanel(e, el);
  if (S.route?.parts[1] !== e.id) return;
  if (S.route.name === "confirm") paintConfirm(e);
  if (S.route.name === "tickets") paintTickets(e);
}
// After a choice: keep the summary URL shareable, then repaint.
function onTripChange(e) {
  if (S.route?.name === "confirm") {
    const qs = tripParams(e).toString();
    const hash = `#/bekreft/${e.id}${qs ? `?${qs}` : ""}`;
    history.replaceState(null, "", hash);
    S.route = parseRoute(hash);
    S.stack[S.stack.length - 1] = hash;
  }
  repaintTrips(e);
}

function dirBody(e, T, dir) {
  const D = T[dir];
  const retry = h("button", { class: "btn btn-secondary", type: "button", onclick: () => { D.state = "idle"; loadTrips(e, dir); } }, icon("refresh"), t("retry"));
  if (D.state === "idle" || D.state === "loading") return h("p", { class: "msg loading" }, t("trip_loading"));
  if (D.state === "error") return h("div", { class: "msg" }, h("p", {}, t(dir === "ret" ? "ret_error" : "trip_error")), retry);
  if (!D.data.trips.length) return h("p", { class: "msg" }, t("no_trips"));
  const p = D.pick !== null ? D.data.trips[D.pick] : null;
  const ends = endsOf(e, T, dir);
  const pickIt = (i) => {
    D.pick = i;
    onTripChange(e);
    if (dir === "out") { switchDir(e, "ret"); $("#seg-ret")?.focus(); announce(t("now_return")); }
    else $("#trip-result-h")?.focus();
  };
  return h("div", { class: "dir-body" },
    p ? stepsList(p, ends.end, ends.start) : h("p", { class: "lead-s" }, t("pick_return")),
    (D.data.trips.length > 1 || !p) ? h("div", { class: "alts" },
      p ? h("p", {}, t("other_trips")) : null,
      h("ul", { class: "stack", role: "list" }, D.data.trips.map((x, i) => h("li", {},
        h("button", { class: "btn btn-alt", type: "button", "aria-pressed": String(i === D.pick), onclick: () => pickIt(i) },
          icon("clock", "icon icon-s"), tripLine(x)))))) : null,
    dir === "ret" && p ? h("button", { class: "btn btn-secondary", type: "button", onclick: () => pickIt(null) }, icon("x"), t("no_return")) : null);
}
function dirCompact(e, T, dir) {
  const D = T[dir], p = chosen(T, dir);
  const what = p ? `${timeOf(p.expectedStartTime)} → ${timeOf(p.expectedEndTime)}, ${legSummary(p)}`
    : D.state === "loading" ? t("loading_short") : D.state === "error" ? t("ret_error_short") : t("not_chosen");
  return h("button", { class: "dir-compact", type: "button", onclick: () => switchDir(e, dir) },
    h("span", {}, h("strong", {}, `${t(`dir_${dir}`)}: `), what), h("span", { class: "dir-change" }, t("change_dir")));
}
function switchDir(e, dir) {
  const T = tripOf(e);
  if (!T || T.dir === dir) return;
  T.dir = dir;
  ensureTrips(e);
  repaintTrips(e);
  $(`#seg-${dir}`)?.focus();
}
function paintTripPanel(e, el) {
  const T = tripOf(e);
  if (!T?.origin) return put(el, el.dataset.confirm && !S.config.entur ? confirmLink(e) : null);
  const segBtn = (dir) => h("button", { class: "seg-btn", type: "button", id: `seg-${dir}`, "aria-pressed": String(T.dir === dir),
    onclick: () => switchDir(e, dir) }, icon(dir === "out" ? "flag" : "home", "icon icon-s"), t(`dir_${dir}`));
  const other = T.dir === "out" ? "ret" : "out";
  const ready = T.out.state === "done" || T.out.state === "error";
  put(el,
    h("h3", { id: "trip-result-h", tabindex: "-1" }, t("trip_from", T.origin.name)),
    h("div", { class: "dirseg", role: "group", "aria-label": t("dir_label") }, segBtn("out"), segBtn("ret")),
    dirBody(e, T, T.dir),
    dirCompact(e, T, other),
    el.dataset.confirm && ready ? confirmLink(e) : null);
}

function renderTrip(e, box) {
  const T = S.trip;
  if (!S.config.entur) return put(box, h("p", { class: "msg" }, t("travel_off")), confirmLink(e));
  const originBtns = h("ul", { class: "origins", role: "list" }, S.config.origins.map((o) =>
    h("li", {}, h("button", { class: "btn btn-origin", type: "button", "aria-pressed": String(T.origin?.id === o.id),
      onclick: () => pickOrigin(e, o) }, icon(/lufthavn|airport/i.test(o.name) ? "plane" : /stasjon|station| s$/i.test(o.name) ? "train" : "pin"), o.name))));
  const input = h("input", { type: "search", id: "place-q", autocomplete: "off", class: "text-input",
    placeholder: t("place_ph"), "aria-describedby": "place-hint" });
  const hitList = (list) => list.map((p) => h("li", {}, h("button", { class: "hit", type: "button", onclick: () => pickOrigin(e, p) }, icon("pin", "icon icon-s"), p.name)));
  const hits = h("ul", { class: "hits", role: "list", id: "place-hits" }, hitList(T.hits));
  const hitMsg = h("p", { class: "muted", id: "place-hint" }, t("place_hint"));
  let timer = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { put(hits); return; }
    timer = setTimeout(async () => {
      try {
        const res = await api(`/api/places?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return;
        T.hits = res;
        put(hits, hitList(res));
        hitMsg.textContent = res.length ? t("place_n", res.length) : t("place_none");
        announce(hitMsg.textContent);
      } catch {
        hitMsg.textContent = t("place_err");
        announce(t("place_err"));
      }
    }, 300);
  });
  const panel = h("div", { class: "trip-result", id: "trip-panel", "data-confirm": "1" });
  put(box,
    h("p", { class: "lead-s" }, t("from_where")),
    originBtns,
    h("label", { class: "label", for: "place-q" }, icon("search", "icon icon-s"), t("place_label")),
    input, hitMsg, hits, panel, enturLink());
  paintTripPanel(e, panel);
  ensureTrips(e);
}

function pickOrigin(e, o) {
  S.trip = newTrip(e, o);
  const box = $("#trip-box");
  if (box) renderTrip(e, box);
  $("#trip-result-h")?.focus();
}

// ---------- 4b. confirm: a summary of the trip (#/bekreft/<id>?fra=&tur=&retur=) ----------
// Nothing is bought or booked here. Prices are PLACEHOLDERS: events have no price
// field and Entur's journey planner gives none.

// An outbound trip but no return trip: ask before going on (skipped when Entur is
// off, or the return fetch failed or found nothing).
function needsReturnPrompt(e) {
  const T = tripOf(e);
  if (!S.config.entur || !T?.origin || !chosen(T, "out") || T.ret.pick !== null) return false;
  return !(T.ret.state === "error" || (T.ret.state === "done" && !T.ret.data.trips.length));
}
function guardReturn(e) {
  return (ev) => {
    if (!needsReturnPrompt(e)) return;
    ev.preventDefault();
    askNoReturn(e, ev.currentTarget.getAttribute("href"));
  };
}
function askNoReturn(e, href) {
  $("#ret-dialog")?.remove();
  const dlg = h("dialog", { id: "ret-dialog", class: "dlg", "aria-labelledby": "ret-dlg-h", "aria-describedby": "ret-dlg-p" });
  const close = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  const back = () => {
    close();
    switchDir(e, "ret");
    $("#seg-ret")?.focus();
    $("#seg-ret")?.scrollIntoView({ block: "center" });
  };
  const backBtn = h("button", { class: "btn btn-primary btn-wide", type: "button", autofocus: true, onclick: back }, icon("back"), t("dlg_back"));
  put(dlg,
    h("h2", { id: "ret-dlg-h" }, t("dlg_noret_q")),
    h("p", { id: "ret-dlg-p" }, t("dlg_noret_help")),
    h("div", { class: "stack" }, backBtn,
      h("button", { class: "btn btn-secondary btn-wide", type: "button", onclick: () => { close(); go(href); } }, icon("chevron"), t("dlg_continue"))));
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); back(); }); // Escape = Tilbake
  document.body.append(dlg);
  if (typeof dlg.showModal !== "function") { dlg.remove(); go(href); return; }
  dlg.showModal();
  backBtn.focus();
}

function confirmLink(e) {
  const qs = tripParams(e).toString();
  return h("div", { class: "confirm-go" },
    h("a", { class: "btn btn-primary btn-wide", href: `#/bekreft/${e.id}${qs ? `?${qs}` : ""}`, onclick: guardReturn(e) }, icon("check"), t("confirm_btn")),
    h("p", { class: "muted" }, t("confirm_hint")));
}

const WHO = ["ung", "voksen", "honnor"];
const WHO_URL = { ung: "ungdom", voksen: "voksen", honnor: "honnor" };
// Stable fake event price from the event id (a sha1 prefix): 0, 150, 250 or 350.
function eventPrice(e) {
  const n = parseInt(String(e.id).slice(0, 6), 16);
  return [0, 150, 250, 350][(Number.isNaN(n) ? 0 : n) % 4];
}
// Fake one-way fare: 35 + 1.80 per minute + 20 per change, to the nearest 5.
// Youth and honnør pay half. Walking only = free.
function tripPrice(p, who) {
  if (!p) return null;
  const transit = p.legs.filter((l) => l.mode !== "foot").length;
  if (!transit) return 0;
  const mins = Number(p.duration) / 60;
  if (!Number.isFinite(mins)) return null;
  const adult = 35 + 1.8 * mins + 20 * (transit - 1);
  return Math.max(5, Math.round((adult * (who === "voksen" ? 1 : 0.5)) / 5) * 5);
}
const money = (n) => (n === 0 ? t("price_free") : t("money", n));
const fareText = (n) => (n === null ? t("price_na") : n === 0 ? t("price_walk") : money(n));

const round5 = (n) => Math.round(n / 5) * 5;
// Example event price for the chosen group: youth 35 % below adult, and with an
// UngINN card a further 50 % off the youth price (stacked). Free stays free.
function eventPrices(e) {
  const adult = eventPrice(e);
  if (S.who !== "ung" || adult === 0) return { adult, youth: null, final: adult };
  const youth = round5(adult * 0.65);
  return { adult, youth, final: S.unginn ? round5(youth * 0.5) : youth };
}
function totals(e) {
  const T = tripOf(e);
  const out = chosen(T, "out"), ret = chosen(T, "ret");
  const fOut = tripPrice(out, S.who), fRet = tripPrice(ret, S.who);
  // A chosen trip without a fare makes the total unknown, not 0.
  const unknown = (out && fOut === null) || (ret && fRet === null);
  return { T, out, ret, fOut, fRet, ev: eventPrices(e), total: unknown ? null : eventPrices(e).final + (fOut || 0) + (fRet || 0) };
}
const totalMoney = (n) => (n === null ? t("price_na") : money(n));
function totalText(e) { return t("total_now", totalMoney(totals(e).total)); }

function priceTable(e) {
  const { T, out, ret, fOut, fRet, ev: evp, total } = totals(e);
  const evCell = S.unginn && evp.youth !== null
    ? [h("s", {}, h("span", { class: "sr-only" }, `${t("was")} `), money(evp.youth)), " ", money(evp.final), " ",
      h("span", { class: "badge-ung" }, t("unginn_badge"))]
    : money(evp.final);
  const retCell = ret ? fareText(fRet) : T?.ret.state === "error" ? t("price_na") : t("price_not_chosen");
  const row = (label, val, cls) => h("tr", { class: cls || null }, h("th", { scope: "row" }, label), h("td", {}, val));
  return [h("table", { class: "prices" },
    h("caption", { class: "sr-only" }, t("price_caption")),
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }, t("price_item")), h("th", { scope: "col" }, t("price_sum")))),
    h("tbody", {},
      row(t("row_event"), evCell),
      row(t("row_out"), out ? fareText(fOut) : t("price_na")),
      row(t("row_ret"), retCell)),
    h("tfoot", {}, row(t("row_total"), totalMoney(total), "total"))),
    out ? null : h("p", { class: "muted" }, t("price_no_trip"))];
}

function wxLine(e) {
  const W = S.weather;
  if (W?.id !== e.id || W.state !== "done" || !W.data?.available) return null;
  const info = wxInfo(W.data);
  return h("p", { class: "wx-line" }, icon(WX_ICON[info.kind] || "cloud"),
    h("span", {}, h("strong", {}, t("sum_wx")), " ", info.sentence, info.tips.length ? ` ${info.tips.join(" ")}` : ""));
}

function demoHref(e) {
  const p = tripParams(e);
  p.set("hvem", WHO_URL[S.who]);
  if (S.who === "ung" && S.unginn) p.set("unginn", "1");
  return `#/billetter/${e.id}?${p}`;
}

function paintConfirm(e, root = document) {
  const pbox = $("#sum-price", root);
  if (!pbox) return;
  const wx = $("#sum-wx", root);
  if (wx) put(wx, wxLine(e));
  put(pbox, priceTable(e));
  const demo = $("#demo-buy", root);
  if (demo) demo.setAttribute("href", demoHref(e));
}

function renderConfirm(r) {
  const e = eventById(r.parts[1]);
  if (!e) return renderNotFound();
  const T = tripFromQs(e, r.qs);
  if (S.weather?.id !== e.id) S.weather = { id: e.id, state: "idle" };

  const sec2 = (id, ic, title, ...body) => h("section", { class: "sum-sec", "aria-labelledby": id },
    h("h2", { id }, h("span", { class: "qa-icon" }, icon(ic)), title), ...body);
  const fact = (k2, v) => [h("dt", {}, k2), v];
  const ungBox = h("input", { type: "checkbox", id: "unginn", checked: S.unginn ? true : null,
    onchange: () => { S.unginn = ungBox.checked; paintConfirm(e); announce(totalText(e)); } });
  const ungWrap = h("div", { class: "unginn no-print", hidden: S.who !== "ung" ? true : null },
    h("label", { for: "unginn", class: "check" }, ungBox, h("span", {}, t("unginn_label"))),
    h("p", { class: "muted" }, t("unginn_note")));
  const whoSet = h("fieldset", { class: "who" }, h("legend", {}, t("who")),
    h("div", { class: "seg" }, WHO.map((w) => h("label", {},
      h("input", { type: "radio", name: "who", value: w, checked: S.who === w ? true : null,
        onchange: () => {
          S.who = w;
          if (w !== "ung") { S.unginn = false; ungBox.checked = false; }
          ungWrap.hidden = w !== "ung";
          paintConfirm(e);
          announce(`${t("price_updated")} ${totalText(e)}`);
        } }),
      h("span", {}, t(`who_${w}`))))));
  const panel = T?.origin ? h("div", { class: "trip-result", id: "trip-panel" }) : null;

  const sec = h("article", { class: "screen summary" },
    heading(t("sum_title")),
    h("p", { class: "nothing-bought" }, icon("info"), h("span", {}, h("strong", {}, t("sum_nothing")), " ", t("sum_nothing_more"))),
    e.cancelled ? h("p", { class: "banner-cancel", role: "note" }, icon("x"), t("cancelled_long")) : null,
    sec2("sum-ev-h", "ticket", t("sum_event"),
      h("dl", { class: "facts" },
        fact(t("fact_what"), h("dd", {}, nb(e.title), " ", inNb())),
        fact(t("fact_day"), h("dd", {}, cap(longDay(e.start)))),
        fact(t("fact_time"), h("dd", {}, timeText(e), !sameDay(e) ? ` · ${t("until_day", longDay(e.end))}` : "")),
        fact(t("fact_where"), nb(placeOf(e) || t("place_unknown"), "dd"))),
      h("div", { id: "sum-wx" }),
      safeUrl(e.source_url) ? h("p", {}, h("a", { class: "ext", href: e.source_url, target: "_blank", rel: "noopener" },
        icon("external", "icon icon-s"), t("sum_source"), h("span", { class: "sr-only" }, ` (${t("new_tab")})`))) : null),
    sec2("sum-trip-h", "bus", t("sum_trip"),
      panel || h("p", { class: "msg" }, t("sum_no_trip")), enturLink()),
    sec2("sum-good-h", "info", t("sum_good"),
      h("ul", { class: "good" },
        h("li", {}, t("good_ticket")),
        h("li", {}, t("good_early")),
        !e.time_known ? h("li", {}, t("good_time")) : null,
        h("li", {}, t("good_cancel")))),
    sec2("sum-price-h", "market", t("sum_price"),
      h("p", { class: "badge-fake" }, t("price_badge")),
      h("p", { class: "muted" }, t("price_note")),
      whoSet,
      ungWrap,
      h("div", { id: "sum-price" }),
      h("p", { class: "muted" }, t("price_discount")),
      h("div", { class: "buy no-print" },
        safeUrl(e.source_url) ? h("a", { class: "btn btn-secondary btn-wide", href: e.source_url, target: "_blank", rel: "noopener" },
          icon("external"), t("buy_event"), h("span", { class: "sr-only" }, ` (${t("new_tab")})`)) : null,
        h("a", { class: "btn btn-secondary btn-wide", href: "https://entur.no/", target: "_blank", rel: "noopener" },
          icon("external"), t("buy_trip"), h("span", { class: "sr-only" }, ` (${t("new_tab")})`)))),
    h("section", { class: "actions no-print", "aria-label": t("actions_label") },
      h("button", { class: "btn btn-action", type: "button", onclick: () => downloadIcs(e) }, icon("calendar-plus"), t("add_cal")),
      h("button", { class: "btn btn-action", type: "button", onclick: () => window.print() }, icon("print"), t("print")),
      h("button", { class: "btn btn-action", type: "button", id: "act-read", onclick: () => toggleSpeak() }, icon("speaker"), t("read_aloud"))),
    h("div", { class: "demo-go no-print" },
      h("a", { class: "btn btn-primary btn-wide", id: "demo-buy", href: "#/", onclick: guardReturn(e) }, icon("ticket"), t("demo_buy")),
      h("p", { class: "muted" }, t("demo_hint"))),
    footer());

  if (panel) paintTripPanel(e, panel);
  paintConfirm(e, sec);
  ensureTrips(e);
  renderWeather(e);
  S.say = () => [t("sum_title"), `${t("sum_nothing")} ${t("sum_nothing_more")}`, NB(e.title),
    ...[...document.querySelectorAll("#screen .sum-sec")].map((s) => s.innerText)];
  return sec;
}

// ---------- 4c. demo tickets (#/billetter/<id>?...&hvem=&unginn=1) ----------
// SAFETY: every ticket says DEMO / not valid, with a large diagonal watermark, on
// screen and in print. No operator names or logos. Nothing is paid or stored.

function fnv(s, seed = 0x811c9dc5) {
  let x = seed >>> 0;
  for (const ch of String(s)) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return x >>> 0;
}
const hex4 = (n) => n.toString(16).padStart(8, "0").slice(0, 4).toUpperCase();
const ticketNo = (seed) => `BV-${hex4(fnv(seed))}-${hex4(fnv(seed, 0x9e3779b9))}`;

// A decorative, scannable-LOOKING grid drawn from a hash. Not a QR code: it encodes nothing.
function codeSvg(seed) {
  let x = fnv(seed) || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const N = 21;
  const corner = (i, j) => (i < 8 && j < 8) || (i < 8 && j >= N - 8) || (i >= N - 8 && j < 8);
  let d = "";
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (!corner(i, j) && rnd() & 1) d += `M${j} ${i}h1v1h-1z`;
  for (const [ox, oy] of [[0, 0], [N - 7, 0], [0, N - 7]])
    d += `M${ox} ${oy}h7v7h-7zM${ox + 1} ${oy + 1}v5h5v-5zM${ox + 2} ${oy + 2}h3v3h-3z`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "-1 -1 23 23");
  svg.setAttribute("class", "tkt-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  svg.append(el("rect", { x: -1, y: -1, width: 23, height: 23, fill: "#fff" }),
    el("path", { d, fill: "#000", "fill-rule": "evenodd" }),
    el("rect", { x: 4.5, y: 8.4, width: 12, height: 4.4, fill: "#fff", stroke: "#000", "stroke-width": 0.3 }));
  const txt = el("text", { x: 10.5, y: 11.7, "text-anchor": "middle", "font-size": 3.2, "font-weight": 800, fill: "#000", "font-family": "sans-serif" });
  txt.textContent = "DEMO";
  svg.append(txt);
  return svg;
}

function tktShell(kind, no, rows, priceText) {
  return h("section", { class: "tkt", "aria-label": `${t("tix_demo_head")}: ${kind}` },
    h("p", { class: "tkt-demo" }, t("tix_demo_head")),
    h("div", { class: "tkt-mark", "aria-hidden": "true" }, h("span", {}, "DEMO")),
    h("div", { class: "tkt-body" },
      h("div", { class: "tkt-info" },
        h("p", { class: "tkt-kind" }, kind),
        h("dl", { class: "facts" }, rows.filter(Boolean).map(([k, v]) => [h("dt", {}, k), v instanceof Node ? v : h("dd", {}, v)])),
        h("p", { class: "tkt-price" }, `${t("price_sum")}: ${priceText}`),
        h("p", { class: "tkt-no" }, `${t("tix_no")}: `, h("span", { class: "mono" }, no))),
      h("div", { class: "tkt-code" }, codeSvg(no))));
}
function whoText() {
  return `${t(`who_${S.who}`)}${S.who === "ung" && S.unginn ? " + UngINN" : ""}`;
}
function eventTicket(e) {
  return tktShell(t("tix_event"), ticketNo(`${e.id}|event`), [
    [t("fact_what"), nb(e.title, "dd")],
    [t("fact_day"), cap(longDay(e.start))],
    [t("fact_time"), timeText(e)],
    [t("fact_where"), nb(placeOf(e) || t("place_unknown"), "dd")],
    [t("tix_who"), whoText()],
  ], money(eventPrices(e).final));
}
function travelTicket(e, T, dir, p) {
  const transit = p.legs.filter((l) => l.mode !== "foot");
  const ends = endsOf(e, T, dir);
  const from = placeName(transit[0]?.fromPlace?.name || p.legs[0]?.fromPlace?.name, ends.start);
  const to = placeName(transit[transit.length - 1]?.toPlace?.name || p.legs[p.legs.length - 1]?.toPlace?.name, ends.end);
  const lines = transit.map((l) => `${cap(t("mode")[l.mode] || t("mode").bus)}${l.line?.publicCode ? ` ${l.line.publicCode}` : ""}`).join(", ");
  return tktShell(t(`tix_${dir}`), ticketNo(`${e.id}|${dir}|${p.expectedStartTime}`), [
    [t("tix_date"), cap(longDay(p.expectedStartTime))],
    [t("tix_from"), nb(from, "dd")],
    [t("tix_to"), nb(to, "dd")],
    [t("tix_line"), lines || cap(t("walk_only"))],
    [t("tix_times"), `${timeOf(p.expectedStartTime)} → ${timeOf(p.expectedEndTime)}`],
    [t("tix_who"), whoText()],
  ], fareText(tripPrice(p, S.who)));
}

function paintTickets(e, root = document) {
  const box = $("#tix", root);
  if (!box) return;
  const T = tripOf(e);
  const list = [eventTicket(e)];
  if (!T?.origin) list.push(h("p", { class: "msg" }, t("tix_no_trip")));
  else for (const dir of ["out", "ret"]) {
    const D = T[dir];
    if (dir === "ret" && D.pick === null) continue;
    if (D.state === "idle" || D.state === "loading") { list.push(h("p", { class: "msg loading" }, t("trip_loading"))); continue; }
    const p = chosen(T, dir);
    list.push(p ? travelTicket(e, T, dir, p) : h("p", { class: "msg" }, t(dir === "ret" ? "ret_error" : "tix_no_trip")));
  }
  put(box, list);
}

function renderTickets(r) {
  const e = eventById(r.parts[1]);
  if (!e) return renderNotFound();
  const qp = new URLSearchParams(r.qs);
  S.who = Object.keys(WHO_URL).find((k) => WHO_URL[k] === qp.get("hvem")) || "voksen";
  S.unginn = S.who === "ung" && qp.get("unginn") === "1";
  tripFromQs(e, r.qs);
  const back = new URLSearchParams(r.qs);
  back.delete("hvem");
  back.delete("unginn");
  const sec = h("article", { class: "screen tickets" },
    heading(t("tix_title")),
    h("p", { class: "demo-warn" }, icon("info"), h("span", {}, t("tix_demo"))),
    h("div", { id: "tix", class: "tix" }),
    h("div", { class: "row no-print" },
      h("button", { class: "btn btn-primary", type: "button", onclick: () => window.print() }, icon("print"), t("tix_print")),
      h("a", { class: "btn btn-secondary", href: `#/bekreft/${e.id}${back.toString() ? `?${back}` : ""}` }, icon("back"), t("tix_back"))),
    footer());
  paintTickets(e, sec);
  ensureTrips(e);
  S.say = () => [t("tix_title"), t("tix_demo"), ...[...document.querySelectorAll("#tix .tkt")].map((x) => x.innerText)];
  return sec;
}

// ----- share, calendar -----

async function share(e) {
  const url = `${location.origin}${location.pathname}#/arr/${e.id}`;
  const text = `${e.title} · ${shortDay(e.start)}${e.time_known ? " " + timeOf(e.start) : ""} · ${placeOf(e)}`;
  if (navigator.share) {
    try { await navigator.share({ title: e.title, text, url }); return; }
    catch (err) { if (err?.name === "AbortError") return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    announce(t("link_copied"));
    toast(t("link_copied"));
  } catch {
    window.prompt(t("copy_prompt"), url);
  }
}

function toast(msg) {
  const el = $("#toast");
  put(el, h("span", {}, msg),
    h("button", { class: "toast-x", type: "button", "aria-label": t("close"), onclick: () => (el.hidden = true) }, icon("x")));
  el.hidden = false;
}

function icsEscape(s) {
  return String(s || "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}
// Fold at 75 UTF-8 octets (RFC 5545), never inside a code point.
function icsFold(line) {
  const enc = new TextEncoder(), out = [];
  let cur = "", n = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > 75) { out.push(cur); cur = " "; n = 1; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join("\r\n");
}
const icsUtc = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function downloadIcs(e) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Beveg//Innlandet Events//NO", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${e.id}@beveg`, `DTSTAMP:${icsUtc(Date.now())}`];
  if (e.time_known) {
    const end = e.end && e.end !== e.start ? e.end : new Date(new Date(e.start).getTime() + 2 * 3600000).toISOString();
    lines.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(end)}`);
  } else {
    const d0 = dayKey(e.start), d1 = addDays(e.end ? dayKey(e.end) : d0, 1);
    lines.push(`DTSTART;VALUE=DATE:${d0.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${(d1 > d0 ? d1 : addDays(d0, 1)).replace(/-/g, "")}`);
  }
  const sum = summaryOf(e);
  lines.push(`SUMMARY:${icsEscape((e.cancelled ? `[${t("cancelled")}] ` : "") + e.title)}`,
    `LOCATION:${icsEscape(placeOf(e))}`, safeUrl(e.source_url) ? `URL:${e.source_url.replace(/[\r\n]/g, "")}` : null,
    `DESCRIPTION:${icsEscape([sum?.text, safeUrl(e.source_url) ? e.source_url : ""].filter(Boolean).join("\n\n"))}`,
    e.cancelled ? "STATUS:CANCELLED" : null,
    "END:VEVENT", "END:VCALENDAR");
  const blob = new Blob([lines.filter(Boolean).map(icsFold).join("\r\n") + "\r\n"], { type: "text/calendar;charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `beveg-${e.id}.ics` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  announce(t("cal_done"));
  toast(t("cal_done"));
}

// ---------- 5. ask ----------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let rec = null;

function renderAsk() {
  const A = S.ask || (S.ask = { text: "", result: null });
  const input = h("input", { type: "text", id: "ask-q", class: "text-input big-input", value: A.text,
    autocomplete: "off", placeholder: t("ask_ph"), enterkeyhint: "search" });
  const result = h("div", { class: "ask-result", id: "ask-result" });
  const notice = h("div", { class: "notice", id: "mic-notice", hidden: true, role: "dialog", "aria-labelledby": "mic-notice-h" },
    h("h2", { id: "mic-notice-h", tabindex: "-1" }, icon("shield"), t("privacy_title")),
    h("p", {}, t("privacy_body")),
    h("div", { class: "row" },
      h("button", { class: "btn btn-primary", type: "button", onclick: () => { S.micOk = true; notice.hidden = true; listen(input, micBtn); } }, icon("check"), t("privacy_ok")),
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => { notice.hidden = true; input.focus(); } }, t("privacy_type"))));
  const micBtn = SR ? h("button", { class: "btn btn-mic btn-wide mic-big", type: "button",
    onclick: () => {
      if (rec) { rec.stop(); return; }
      if (!S.micOk) { notice.hidden = false; $("#mic-notice-h").focus(); return; }
      listen(input, micBtn);
    } }, h("span", { class: "mic-dot" }, icon("mic")), h("span", { class: "mic-label" }, t("mic_start"))) : null;
  const form = h("form", { class: "ask-form", onsubmit: (ev) => { ev.preventDefault(); handleAsk(input.value, result); } },
    h("label", { for: "ask-q", class: "label" }, t("ask_label")),
    h("div", { class: "ask-row" }, input,
      h("button", { class: "btn btn-primary", type: "submit" }, icon("search"), t("ask_go"))));
  const examples = h("div", { class: "examples" }, h("p", {}, t("examples")),
    h("ul", { class: "chips", role: "list" }, t("example_list").map((x) =>
      h("li", {}, h("button", { class: "chip chip-btn", type: "button", onclick: () => { input.value = x; handleAsk(x, result); } }, t("quote", x))))));
  S.say = () => `${t("ask_title")}. ${t("ask_intro")} ${$("#ask-result")?.innerText || ""}`;
  if (A.result) setTimeout(() => showAskResult(A.result, result), 0);
  return h("section", { class: "screen ask" },
    heading(t("ask_title")),
    h("p", { class: "lead" }, t("ask_intro")),
    micBtn, SR ? null : h("p", { class: "note" }, icon("info", "icon icon-s"), t("no_listen")),
    notice, form, result, examples, footer());
}

function listen(input, btn) {
  const r = new SR();
  rec = r;
  r.lang = LOC[S.lang];
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let finalText = "", interim = "";
  const setBtn = (on) => {
    btn.classList.toggle("listening", on);
    $(".mic-label", btn).textContent = on ? t("mic_stop") : t("mic_start");
  };
  r.onresult = (ev) => {
    interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript;
      else interim += ev.results[i][0].transcript;
    }
    input.value = (finalText || interim).trim();
  };
  r.onerror = (ev) => {
    if (ev.error === "aborted") return;
    const k = ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "mic_blocked" : ev.error === "no-speech" ? "mic_nothing" : "mic_failed";
    announce(t(k));
    toast(t(k));
  };
  r.onend = () => {
    if (rec !== r) return;
    rec = null;
    setBtn(false);
    const text = (finalText || interim).trim();
    if (text && S.route?.name === "ask") handleAsk(text, $("#ask-result"));
  };
  try { r.start(); setBtn(true); announce(t("mic_listening")); }
  catch { rec = null; setBtn(false); announce(t("mic_failed")); }
}

function askToHash(p) {
  let tk = "alt", kat = [], kw = [];
  if (p.cats.length) {
    const ths = THEMES.filter((th) => p.cats.every((c) => th.cats.includes(c)));
    if (ths.length === 1) tk = ths[0].key;
    else { kat = p.cats; kw = p.catWords; }
  }
  let wk = "alle";
  if (p.date) {
    const preset = { today: "idag", tonight: "idag", tomorrow: "imorgen", weekend: "helga", next_week: "nesteuke" }[p.date.kind];
    wk = preset || (p.date.from === p.date.to ? p.date.from : `${p.date.from}_${p.date.to}`);
  }
  const f = { kat, kw, sted: p.places, ord: p.words, kveld: !!(p.evening || p.date?.evening) };
  return `#/liste/${tk}/${wk}${filterQs(f)}`;
}

function handleAsk(text, box) {
  text = (text || "").trim();
  const A = S.ask;
  A.text = text;
  if (!text) return;
  const ctx = { events: S.events, origins: S.config.origins };
  const p = TalkParser.parse(text, ctx);
  if (p.intent === "trip" || p.intent === "weather") {
    const seen = new Set();
    const scored = S.events.map((e) => ({ e, s: TalkParser.score(p, e) }))
      .filter((x) => x.s >= 3).sort((a, b) => b.s - a.s || a.e.start.localeCompare(b.e.start))
      .filter((x) => { const k = `${x.e.title}|${x.e.venue}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) {
      A.result = { kind: "confirm", id: scored[0].e.id, intent: p.intent, origin: p.origin?.id || null, fallback: p.hasCriteria ? askToHash(p) : null };
      return showAskResult(A.result, box);
    }
    if (!p.hasCriteria) { A.result = { kind: "which" }; return showAskResult(A.result, box); }
  }
  if (!p.hasCriteria) { A.result = { kind: "unclear" }; return showAskResult(A.result, box); }
  A.result = null;
  go(askToHash(p));
}

function showAskResult(res, box) {
  if (!box) return;
  if (res.kind === "confirm") {
    const e = eventById(res.id);
    if (!e) return put(box);
    const yes = h("a", { class: "btn btn-primary btn-yn", href: `#/arr/${e.id}/${res.intent === "weather" ? "vaer" : "reise"}${res.origin ? `?fra=${encodeURIComponent(res.origin)}` : ""}` }, icon("check"), t("yes"));
    const no = h("button", { class: "btn btn-secondary btn-yn", type: "button",
      onclick: () => { S.ask.result = null; go(res.fallback || "#/liste/alt/alle"); } }, icon("x"), t("no"));
    put(box, h("div", { class: "confirm" },
      h("h2", { tabindex: "-1", id: "confirm-h" }, t("did_you_mean")),
      h("ul", { class: "cards", role: "list" }, card(e)),
      h("div", { class: "row yn" }, yes, no)));
    announce(`${t("did_you_mean")} ${e.title}, ${longDay(e.start)}?`);
    $("#confirm-h").focus();
    return;
  }
  const msg = res.kind === "which" ? t("ask_which") : t("ask_unclear");
  put(box, h("div", { class: "msg" }, h("p", {}, msg),
    h("a", { class: "btn btn-secondary btn-wide", href: "#/liste/alt/alle" }, icon("grid"), t("all_btn"))));
  announce(msg);
}

// ---------- 6. help ----------

function mcpSnippet() {
  const path = "<path>";
  return JSON.stringify({ mcpServers: { beveg: {
    command: `${path}/.venv/Scripts/python.exe`,
    args: [`${path}/run.py`, "mcp"],
    env: { CRAWLER_CONTACT: t("mcp_contact") },
  } } }, null, 2);
}

function renderHelp() {
  const steps = [["tap", "help_1"], ["calendar", "help_2"], ["list", "help_3"], ["ticket", "help_4"]];
  const pre = h("pre", { class: "snippet", tabindex: "0", id: "mcp-snippet" }, mcpSnippet());
  const copied = h("p", { class: "muted", role: "status" });
  const copy = async () => {
    try { await navigator.clipboard.writeText(pre.textContent); copied.textContent = t("mcp_copied"); }
    catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      pre.focus();
      copied.textContent = t("mcp_selected");
    }
  };
  S.say = () => `${t("help_title")}. ${steps.map(([, k], i) => `${i + 1}. ${t(k)}`).join(" ")} ${t("a11y_body")}`;
  return h("section", { class: "screen help" },
    heading(t("help_title")),
    h("ol", { class: "help-steps" }, steps.map(([ic, k], i) => h("li", { style: `--i:${i}` },
      h("span", { class: "help-art" }, icon(ic, "icon icon-xl"), h("span", { class: "help-n", "aria-hidden": "true" }, String(i + 1))),
      h("p", {}, t(k))))),
    h("section", { class: "panel", "aria-labelledby": "a11y-h" },
      h("h2", { id: "a11y-h" }, icon("heart"), t("a11y_title")),
      h("p", {}, t("a11y_body"))),
    h("section", { class: "panel panel-quiet", "aria-labelledby": "mcp-h", lang: null },
      h("h2", { id: "mcp-h" }, icon("plug"), t("mcp_title")),
      h("p", {}, t("mcp_intro")),
      h("h3", {}, t("mcp_tools")),
      h("ul", { class: "mcp-tools" },
        [["search_events", "mcp_t_search"], ["event_weather", "mcp_t_weather"], ["event_trips", "mcp_t_trips"], ["list_origins", "mcp_t_origins"]]
          .map(([name, k]) => h("li", {}, h("code", {}, name), " ", t(k)))),
      h("p", {}, t("mcp_readonly")),
      h("p", {}, t("mcp_how")),
      pre,
      h("button", { class: "btn btn-secondary", type: "button", onclick: copy }, icon("copy"), t("mcp_copy")),
      copied,
      h("p", { class: "muted" }, t("mcp_path"))),
    h("a", { class: "btn btn-primary btn-wide", href: "#/" }, icon("home"), t("mcp_back")));
}

// ---------- speech out ----------

let speakId = 0;
function pickVoice(lang = S.lang) {
  const want = LOC[lang].toLowerCase();
  const prefixes = lang === "no" ? ["nb", "no", "nn"] : [want.slice(0, 2)];
  const l = (v) => v.lang.toLowerCase().replace("_", "-");
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => l(v) === want) || voices.find((v) => prefixes.some((p) => l(v).startsWith(p))) || null;
}
function setSpeaking(on) {
  S.speaking = on;
  for (const b of [$("#bb-read"), $("#act-read")]) {
    if (!b) continue;
    b.classList.toggle("is-on", on);
    const label = b.querySelector(".bb-label") || b.lastChild;
    if (label) label.textContent = on ? t("stop_reading") : t("read_aloud");
  }
}
function stopSpeaking() {
  speakId++;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  setSpeaking(false);
}
// Sentences end at . ! ? followed by a capital or digit, but not after "kl." and
// similar; then sentences are grouped into chunks of about 200 characters.
function speechChunks(text) {
  const sentences = [];
  for (const p of text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d«“„])/u)) {
    if (sentences.length && /(^|\s)(\d+|kl|Kl|ca|nr|Nr|min|Min|f\.eks)\.$/.test(sentences[sentences.length - 1]))
      sentences[sentences.length - 1] += " " + p;
    else sentences.push(p);
  }
  const chunks = [];
  for (const s of sentences) {
    if (chunks.length && chunks[chunks.length - 1].length + s.length < 200) chunks[chunks.length - 1] += " " + s;
    else chunks.push(s);
  }
  return chunks.length ? chunks : [text];
}
function toggleSpeak() {
  if (!("speechSynthesis" in window)) { toast(t("no_tts")); announce(t("no_tts")); return; }
  if (S.speaking) return stopSpeaking();
  stopSpeaking();
  const id = speakId;
  // S.say() gives a string or a list of strings / { text, lang } segments, so that
  // Norwegian source texts are read with a Norwegian voice on the English page.
  const said = S.say();
  const segs = (Array.isArray(said) ? said : [said])
    .map((x) => (typeof x === "string" ? { text: x, lang: S.lang } : { lang: S.lang, ...x }))
    .map((x) => ({ ...x, text: String(x.text || "").replace(/\s+/g, " ").trim() })).filter((x) => x.text);
  // Merge neighbours in the same language, then short chunks (some browsers stop long utterances).
  const merged = [];
  for (const x of segs) {
    const last = merged[merged.length - 1];
    if (last && last.lang === x.lang) last.text += ` ${x.text}`;
    else merged.push({ ...x });
  }
  const chunks = merged.flatMap((x) => speechChunks(x.text).map((c) => ({ text: c, lang: x.lang })));
  if (!chunks.length) return;
  setSpeaking(true);
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c.text.trim());
    u.lang = LOC[c.lang];
    const voice = pickVoice(c.lang);
    if (voice) u.voice = voice;
    u.rate = 0.95;
    if (i === chunks.length - 1) u.onend = () => id === speakId && setSpeaking(false);
    u.onerror = () => id === speakId && setSpeaking(false);
    speechSynthesis.speak(u);
  });
}

// ---------- chrome: language, text size, bottom bar ----------

function applyChrome() {
  document.documentElement.lang = HTML_LANG[S.lang];
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("meta_desc"));
  document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = t(el.dataset.t)));
  document.querySelectorAll("[data-ta]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.ta)));
  document.querySelectorAll("#lang [data-lang]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === S.lang)));
  const sz = $("#size");
  sz.setAttribute("aria-label", t("size_label", t(`size_${S.size}`)));
  if (sizeOpen()) buildSizePanel();
}

// ----- text size: a disclosure with a radio group, applied at once -----
const sizeOpen = () => $("#size").getAttribute("aria-expanded") === "true";
function buildSizePanel() {
  put($("#size-panel"), 
    h("fieldset", {}, h("legend", {}, t("size_legend")),
      SIZES.map((_, i) => h("label", { class: "size-opt" },
        h("input", { type: "radio", name: "textsize", value: String(i), checked: i === S.size ? true : null, onchange: () => setSize(i) }),
        h("span", { class: "size-prev", style: `font-size:${SIZE_PX[i] * 1.15}px`, "aria-hidden": "true" }, "Aa"),
        h("span", { class: "size-txt" }, t(`size_${i}`))))),
    h("button", { class: "btn btn-secondary btn-wide", type: "button", onclick: () => closeSize(true) }, icon("x"), t("close")));
}
function setSize(i) {
  document.documentElement.classList.remove(SIZES[S.size]);
  S.size = i;
  document.documentElement.classList.add(SIZES[i]);
  $("#size").setAttribute("aria-label", t("size_label", t(`size_${i}`)));
  announce(t("size_now", t(`size_${i}`)));
}
function openSize() {
  buildSizePanel();
  $("#size-panel").hidden = false;
  $("#size").setAttribute("aria-expanded", "true");
  $("#size-panel input:checked")?.focus();
}
function closeSize(focusButton) {
  if (!sizeOpen()) return;
  $("#size-panel").hidden = true;
  $("#size").setAttribute("aria-expanded", "false");
  if (focusButton) $("#size").focus();
}

function init() {
  const qLang = new URLSearchParams(location.search).get("lang");
  if (qLang && Object.hasOwn(I18N, qLang)) S.lang = qLang;
  document.querySelectorAll("#lang [data-lang]").forEach((b) => b.addEventListener("click", () => {
    if (S.lang === b.dataset.lang) return;
    S.lang = b.dataset.lang;
    if (rec) rec.abort();
    applyChrome();
    render(false);
    announce(t("lang_now"));
  }));
  $("#size").addEventListener("click", () => (sizeOpen() ? closeSize(true) : openSize()));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && sizeOpen()) { ev.preventDefault(); closeSize(true); }
  });
  document.addEventListener("click", (ev) => {
    if (!sizeOpen() || $("#size-panel").contains(ev.target) || $("#size").contains(ev.target)) return;
    const a = document.activeElement;
    closeSize(!a || a === document.body || $("#size-panel").contains(a));
  });
  $(".skip").addEventListener("click", (ev) => { ev.preventDefault(); $("#screen").focus(); $("#screen").scrollIntoView(); });
  $("#bb-back").addEventListener("click", goBack);
  $("#bb-read").addEventListener("click", toggleSpeak);
  if ("speechSynthesis" in window) speechSynthesis.getVoices();
  addEventListener("hashchange", onHashChange);
  document.documentElement.classList.add(SIZES[S.size]);
  if (!location.hash) history.replaceState(null, "", "#/");
  S.stack = [location.hash];
  applyChrome();
  render(false);
  load();
}

async function load() {
  const [cfg, evs] = await Promise.allSettled([api("/api/config"), api("/api/events")]);
  if (cfg.status === "fulfilled") S.config = { origins: [], ...cfg.value };
  if (evs.status === "fulfilled") {
    S.events = evs.value;
    // Mock LLM output: placeholder summaries and one category for everything. Then
    // the categories mean nothing, and themes go by title keywords only.
    S.catsTrusted = S.events.some((e) => realText(e.summary_no) || realText(e.summary_en))
      && new Set(S.events.map((e) => e.category)).size > 1;
  } else S.error = evs.reason;
  S.loaded = true;
  const r = parseRoute();
  render(r.name === "ticket" && r.parts[2] ? true : false);
}

addEventListener("DOMContentLoaded", init);
