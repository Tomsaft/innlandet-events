// InFoMo demo front end: pick an event (tile 1), see the weather, then plan the
// trip (tile 2). Plain JS, no build step. Nothing the user picks is stored.

const TEXT = {
  en: {
    events: "Events", travel: "Getting there", back: "Back",
    search: "Search events or venues", from_date: "From",
    events_sub: (n) => `${n} upcoming`,
    travel_locked: "Choose an event first", travel_open: "Plan your trip with Entur",
    travel_from: "From", weather: "Weather at the venue",
    from_where: "Where are you travelling from?",
    place: "Or search for a stop or address", sources: "Data:",
    loading: "Loading…", none: "No upcoming events match.",
    time_unknown: "time not given", more: "More info at the source",
    cancelled: "Cancelled", approx: "Location is approximate (town centre).",
    no_forecast: (d, until) => `No forecast yet: the event is in ${d} days, and the forecast reaches ${until}.`,
    conf: { high: "Fairly certain", medium: "Quite uncertain", low: "Uncertain (long forecast)" },
    conf_note: "Certainty is our own rule of thumb based on days until the event.",
    guessed_wx: "Time not given, showing midday.", guessed_trip: "Time not given, arriving by",
    arrive_by: "Arrive by", no_trips: "No trips found for this time.",
    travel_off: "Travel info unavailable", weather_off: "No forecast",
    wind: "wind", precip: "precip.", transfers: (n) => n === 0 ? "direct" : `${n} change${n > 1 ? "s" : ""}`,
    walk: "Walk", min: "min", plan_entur: "Open in Entur",
  },
  no: {
    events: "Arrangementer", travel: "Reise", back: "Tilbake",
    search: "Søk etter arrangement eller sted", from_date: "Fra",
    events_sub: (n) => `${n} kommende`,
    travel_locked: "Velg et arrangement først", travel_open: "Planlegg reisen med Entur",
    travel_from: "Fra", weather: "Været ved arrangementet",
    from_where: "Hvor reiser du fra?",
    place: "Eller søk etter holdeplass eller adresse", sources: "Data:",
    loading: "Laster…", none: "Ingen kommende arrangementer passer.",
    time_unknown: "klokkeslett ikke oppgitt", more: "Mer informasjon hos kilden",
    cancelled: "Avlyst", approx: "Stedet er omtrentlig (sentrum).",
    no_forecast: (d, until) => `Ingen varsel ennå: arrangementet er om ${d} dager, og varselet går til ${until}`,
    conf: { high: "Ganske sikkert", medium: "Nokså usikkert", low: "Usikkert (langtidsvarsel)" },
    conf_note: "Sikkerheten er vår egen tommelfingerregel basert på dager til arrangementet.",
    guessed_wx: "Klokkeslett ikke oppgitt, viser midt på dagen.", guessed_trip: "Klokkeslett ikke oppgitt, fremme innen",
    arrive_by: "Fremme innen", no_trips: "Fant ingen reiser for dette tidspunktet.",
    travel_off: "Reiseinformasjon utilgjengelig", weather_off: "Ingen varsel",
    wind: "vind", precip: "nedbør", transfers: (n) => n === 0 ? "direkte" : `${n} bytte${n > 1 ? "r" : ""}`,
    walk: "Gå", min: "min", plan_entur: "Åpne i Entur",
  },
};
const CATEGORY = {
  no: { concert: "konsert", theatre: "teater", talk: "foredrag", exhibition: "utstilling",
        sports: "sport", kids: "barn", senior: "senior", course: "kurs", market: "marked",
        food_drink: "mat og drikke", religious: "religiøst", meeting: "møte",
        workshop: "verksted", other: "annet" },
};

let lang = "no", events = [], config = null, selected = null, origin = null;
let view = "home", lastWeather = null, lastTrips = null, skyOverride = null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const t = (k) => TEXT[lang][k];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false)
    el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// replaceChildren, but skipping the false/null that `cond && el` leaves behind.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k !== false && k != null));

const locale = () => (lang === "no" ? "nb-NO" : "en-GB");
const fmtDate = (iso) => new Date(iso).toLocaleDateString(locale(),
  { weekday: "short", day: "numeric", month: "short", timeZone: "Europe/Oslo" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(locale(),
  { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Oslo" });
const osloDay = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" });
const when = (e) => fmtDate(e.start) + (e.time_known ? " " + fmtTime(e.start) : "");

async function api(path) {
  const r = await fetch(path);
  const data = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

// ---------- views: home (tiles) <-> events panel <-> travel panel ----------

const VIEWS = { home: "home-view", events: "events-view", travel: "travel-view" };

function show(next) {
  if (next === view) return;
  const swap = () => {
    for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== next;
    view = next;
    window.scrollTo(0, 0);
  };
  // The tile and its panel share a view-transition-name, so the tile grows into the panel.
  // Safety net for the live demo: never let a stuck transition hide the new view.
  if (document.startViewTransition && !reducedMotion) {
    const vt = document.startViewTransition(swap);
    setTimeout(() => vt.skipTransition(), 1000);
  } else swap();
}

function renderTiles() {
  $("tile-events-sub").textContent = selected
    ? `✓ ${selected.title} · ${when(selected)}` : t("events_sub")(events.length);
  const travel = $("tile-travel");
  const wasLocked = travel.disabled;
  travel.disabled = !selected;
  $("tile-travel-sub").textContent = !selected ? t("travel_locked")
    : origin ? `${t("travel_from")} ${origin.name}` : t("travel_open");
  if (wasLocked && selected) {
    travel.classList.remove("unlocked");
    void travel.offsetWidth; // restart the pop animation
    travel.classList.add("unlocked");
  }
}

function applyLang() {
  document.documentElement.lang = lang === "no" ? "nb" : "en";
  document.querySelectorAll("[data-t]").forEach((el) => (el.textContent = t(el.dataset.t)));
  document.querySelectorAll("[data-tp]").forEach((el) => (el.placeholder = t(el.dataset.tp)));
  $("lang").textContent = lang === "en" ? "NO" : "EN";
  if (!config) return;
  renderTiles();
  renderList();
  if (selected) renderChosen();
  if (view === "travel") renderTravel();
}

// ---------- events panel ----------

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const from = $("date").value;
  const groups = new Map();
  for (const e of events) {
    if (q && !`${e.title} ${e.venue}`.toLowerCase().includes(q)) continue;
    if (from && osloDay(e.start) < from) continue;
    const key = `${e.title}|${e.venue}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  $("list-status").textContent = groups.size ? "" : t("none");
  fill($("events"), [...groups.values()].map((list, i) =>
    h("li", { class: list.some((e) => e.id === selected?.id) ? "selected" : "", style: `--i:${Math.min(i, 15)}` },
      h("div", { class: "ev-title" }, list[0].title),
      h("div", { class: "ev-venue" }, list[0].venue),
      h("div", { class: "dates" }, list.map((e) =>
        h("button", { class: "chip" + (e.id === selected?.id ? " on" : ""), type: "button",
                      onclick: () => selectEvent(e.id) },
          when(e), e.cancelled && ` (${t("cancelled")})`))))));
}

function selectEvent(id) {
  const e = events.find((x) => x.id === id);
  if (!e) return;
  const changed = selected?.id !== e.id;
  selected = e;
  if (changed) { lastWeather = null; lastTrips = null; }
  renderList();
  show("home");
  renderTiles();
  renderChosen(true);
  if (changed) loadWeather(e);
}

// ---------- chosen event + weather (home) ----------

function renderChosen(animate = false) {
  const e = selected;
  $("chosen").hidden = false;
  if (animate) for (const card of $("chosen").children) {
    card.classList.remove("rise"); void card.offsetWidth; card.classList.add("rise");
  }
  const summary = lang === "no" ? e.summary_no : e.summary_en;
  const cat = (CATEGORY[lang] || {})[e.category] || e.category;
  fill($("event-card"),
    h("div", {}, h("span", { class: "tag" }, cat), e.cancelled && h("span", { class: "tag cancelled" }, t("cancelled"))),
    h("h2", {}, e.title),
    h("p", {}, h("strong", {}, fmtDate(e.start)), " ",
      e.time_known ? `${fmtTime(e.start)}${e.end && e.end !== e.start ? "–" + fmtTime(e.end) : ""}` : `(${t("time_unknown")})`),
    h("p", {}, `📍 ${e.venue}${e.address && !e.venue.includes(e.address) ? ", " + e.address : ""}`),
    summary && h("p", { class: "muted" }, summary),
    h("p", {}, h("a", { href: e.source_url, target: "_blank", rel: "noopener" }, t("more") + " ↗")));
  if (lastWeather) renderWeather(lastWeather);
}

const SYMBOLS = [["thunder", "⛈️"], ["sleet", "🌨️"], ["snow", "❄️"], ["showers", "🌦️"],
  ["rain", "🌧️"], ["fog", "🌫️"], ["partlycloudy", "⛅"], ["cloudy", "☁️"], ["fair", "🌤️"]];
function symbolIcon(code) {
  if (!code) return "❔";
  for (const [k, icon] of SYMBOLS) if (code.includes(k)) return icon;
  if (code.startsWith("clearsky")) return code.endsWith("night") ? "🌙" : "☀️";
  return "🌡️";
}

async function loadWeather(e) {
  setSky(null);
  if (!config.yr) return fill($("weather"), h("p", { class: "muted" }, t("weather_off")));
  fill($("weather"), h("p", { class: "muted" }, t("loading")));
  try {
    const w = await api(`/api/event/${e.id}/weather`);
    if (selected?.id !== e.id) return;
    lastWeather = w;
    renderWeather(w);
  } catch (err) {
    fill($("weather"), h("p", { class: "muted" }, `${t("weather_off")}: `, h("span", { class: "error" }, err.message)));
  }
}

function renderWeather(w) {
  const box = $("weather");
  if (!w.available) {
    setSky(null);
    return fill(box, h("p", { class: "muted" }, t("no_forecast")(w.days_until, fmtDate(w.forecast_until))));
  }
  const s = w.at_start;
  setSky(s.symbol, s.precip);
  fill(box,
    h("div", { class: "wx-now" },
      h("div", { class: "wx-icon", title: s.symbol }, symbolIcon(s.symbol)),
      h("div", { class: "wx-temp" }, s.temp !== null ? `${Math.round(s.temp)}°` : "–"),
      h("div", {},
        h("div", { class: `conf ${w.confidence}` }, t("conf")[w.confidence]),
        h("div", { class: "wx-meta" },
          `${fmtDate(s.time)} ${fmtTime(s.time)} · ${t("wind")} ${s.wind ?? "–"} m/s · ${t("precip")} ${s.precip ?? 0} mm`))),
    h("div", { class: "strip" }, w.strip.map((x, i) =>
      h("div", { class: "slot" + (x.time === s.time ? " start" : ""), style: `--i:${i}` },
        h("div", {}, fmtTime(x.time)),
        h("div", { class: "i", title: x.symbol }, symbolIcon(x.symbol)),
        h("div", {}, x.temp !== null ? `${Math.round(x.temp)}°` : "–"),
        h("div", { class: "p" }, x.precip ? `${x.precip} mm` : "")))),
    w.time_guessed && h("p", { class: "muted" }, t("guessed_wx")),
    w.venue.approximate && h("p", { class: "muted" }, t("approx")),
    h("p", { class: "muted", style: "font-size:.8rem" }, t("conf_note")));
}

// ---------- weather backdrop: sky colour, clouds, sun, rain/snow, lightning ----------

function skyKind(sym) {
  if (!sym) return "none";
  if (sym.includes("thunder")) return "thunder";
  if (sym.includes("sleet")) return "sleet";
  if (sym.includes("snow")) return "snow";
  if (sym.includes("rain")) return "rain";
  if (sym.includes("fog")) return "fog";
  if (sym.endsWith("_night")) return "night";
  if (sym.startsWith("cloudy")) return "cloudy";
  if (sym.startsWith("partlycloudy") || sym.startsWith("fair")) return "partly";
  return sym.startsWith("clearsky") ? "clear" : "none";
}

function setSky(sym, mm = 0) {
  const kind = skyOverride || skyKind(sym);
  document.body.dataset.sky = kind;
  // More drops for "heavy..." symbols or a lot of precipitation, fewer for "light...".
  const amount = skyOverride ? 1 : sym?.startsWith("heavy") || mm > 3 ? 1.8 : sym?.startsWith("light") ? 0.55 : 1;
  Precip.set({ rain: "rain", thunder: "rain", sleet: "sleet", snow: "snow" }[kind] || null,
             kind === "thunder" ? 1.8 : amount);
}

const Precip = (() => {
  const canvas = $("precip"), ctx = canvas.getContext("2d");
  let parts = [], kind = null, raf = 0, w = 0, ht = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    w = innerWidth; ht = innerHeight;
    canvas.width = w * dpr; canvas.height = ht * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(top) {
    const flake = kind === "snow" || (kind === "sleet" && Math.random() < 0.4);
    const y = top ? -20 : Math.random() * ht;
    return flake
      ? { flake, x: Math.random() * w, y, r: 1.5 + Math.random() * 2.5, v: 0.6 + Math.random() * 1.2, ph: Math.random() * 6.3 }
      : { flake, x: Math.random() * w, y, len: 12 + Math.random() * 14, v: 10 + Math.random() * 8 };
  }
  function frame() {
    ctx.clearRect(0, 0, w, ht);
    const drops = new Path2D(), flakes = new Path2D();
    for (const p of parts) {
      if (p.flake) {
        p.y += p.v; p.ph += 0.02; p.x += Math.sin(p.ph) * 0.6;
        flakes.moveTo(p.x + p.r, p.y); flakes.arc(p.x, p.y, p.r, 0, 6.3);
      } else {
        p.y += p.v; p.x += p.v * 0.12;
        drops.moveTo(p.x, p.y); drops.lineTo(p.x - p.len * 0.12, p.y - p.len);
      }
      if (p.y > ht + 30 || p.x > w + 30) Object.assign(p, spawn(true));
    }
    ctx.strokeStyle = "rgba(190, 210, 235, .6)"; ctx.lineWidth = 1.2; ctx.lineCap = "round";
    ctx.stroke(drops);
    ctx.fillStyle = "rgba(255, 255, 255, .9)";
    ctx.fill(flakes);
    raf = requestAnimationFrame(frame);
  }
  addEventListener("resize", resize);
  resize();
  return {
    set(next, amount = 1) {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, w, ht);
      kind = next;
      if (!kind || reducedMotion) return;
      const base = { rain: 170, sleet: 150, snow: 130 }[kind];
      const n = Math.round(base * amount * Math.min(1.4, 0.35 + w / 1400));
      parts = Array.from({ length: n }, () => spawn(false));
      raf = requestAnimationFrame(frame);
    },
  };
})();

// ---------- travel panel ----------

function openTravel() {
  if (!selected) return;
  show("travel");
  renderTravel();
}

function renderTravel() {
  $("travel-event").textContent = `${selected.title} · ${when(selected)} · ${selected.venue}`;
  fill($("origins"), config.origins.map((o) =>
    h("button", { class: "chip" + (origin?.id === o.id ? " on" : ""), type: "button",
                  onclick: () => setOrigin(o) }, o.name)));
  if (lastTrips) renderTrips(lastTrips);
  else if (origin) loadTrips();
  else fill($("trips"));
}

function setOrigin(o) {
  origin = o;
  $("place").value = config.origins.some((x) => x.id === o.id) ? "" : o.name;
  $("place-hits").hidden = true;
  lastTrips = null;
  renderTiles();
  renderTravel();
}

let placeTimer = null;
function onPlaceInput() {
  clearTimeout(placeTimer);
  const q = $("place").value.trim();
  if (q.length < 2) return ($("place-hits").hidden = true);
  placeTimer = setTimeout(async () => {
    try {
      const hits = await api(`/api/places?q=${encodeURIComponent(q)}`);
      fill($("place-hits"), hits.map((p) =>
        h("li", { tabindex: 0, onclick: () => setOrigin(p),
                  onkeydown: (ev) => ev.key === "Enter" && setOrigin(p) }, p.name)));
      $("place-hits").hidden = hits.length === 0;
    } catch { $("place-hits").hidden = true; }
  }, 250);
}

const MODES = { rail: "🚆", bus: "🚌", coach: "🚌", tram: "🚋", metro: "🚇", water: "⛴️",
  air: "✈️", foot: "🚶", bicycle: "🚲", taxi: "🚕" };

async function loadTrips() {
  if (!config.entur) return fill($("trips"), h("p", { class: "muted" }, t("travel_off")));
  fill($("trips"), h("p", { class: "muted" }, t("loading")));
  const e = selected, o = origin;
  const qs = new URLSearchParams({ id: o.id || "", name: o.name, lat: o.lat, lon: o.lon });
  try {
    const res = await api(`/api/event/${e.id}/trips?${qs}`);
    if (selected?.id !== e.id || origin !== o) return;
    lastTrips = res;
    renderTrips(res);
  } catch (err) {
    fill($("trips"), h("p", { class: "muted" }, `${t("travel_off")}: `, h("span", { class: "error" }, err.message)));
  }
}

function renderTrips(res) {
  const head = h("p", { class: "muted" },
    `${res.time_guessed ? t("guessed_trip") : t("arrive_by")} ${fmtTime(res.arrive_by)} · ${origin.name} → ${res.venue.name}`);
  const approx = res.venue.approximate && h("p", { class: "muted" }, t("approx"));
  if (!res.trips.length) return fill($("trips"), head, approx, h("p", {}, t("no_trips")));
  fill($("trips"), head, approx, res.trips.map((p, i) => {
    const transit = p.legs.filter((l) => l.mode !== "foot").length;
    return h("div", { class: "trip", style: `--i:${i}` },
      h("div", { class: "trip-head" },
        h("span", {}, `${fmtTime(p.expectedStartTime)} → ${fmtTime(p.expectedEndTime)}`),
        h("span", { class: "muted" }, `${Math.round(p.duration / 60)} ${t("min")} · ${t("transfers")(Math.max(0, transit - 1))}`)),
      h("ul", { class: "legs" }, p.legs.map((l) =>
        h("li", {},
          h("span", {}, MODES[l.mode] || "•"),
          h("span", {}, fmtTime(l.expectedStartTime)),
          h("span", {},
            l.line ? h("span", { class: "line-code" }, l.line.publicCode || l.mode) : t("walk"),
            ` ${l.fromPlace.name} → ${l.toPlace.name}`,
            l.mode === "foot" && ` (${Math.round(l.distance)} m)`)))));
  }), h("p", {}, h("a", { href: "https://entur.no/", target: "_blank", rel: "noopener" }, t("plan_entur") + " ↗")));
}

// ---------- start ----------

async function init() {
  lang = navigator.language?.startsWith("en") ? "en" : "no";
  $("lang").addEventListener("click", () => { lang = lang === "en" ? "no" : "en"; applyLang(); });
  $("tile-events").addEventListener("click", () => show("events"));
  $("tile-travel").addEventListener("click", openTravel);
  document.querySelectorAll(".back").forEach((b) => b.addEventListener("click", () => show("home")));
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && view !== "home") show("home"); });
  $("search").addEventListener("input", renderList);
  $("date").addEventListener("input", renderList);
  $("place").addEventListener("input", onPlaceInput);
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".place-search")) $("place-hits").hidden = true;
  });
  // Deep link for the demo: #e=<event id>&o=<fixed origin id>&sky=<rain|snow|clear|...>
  const link = new URLSearchParams(location.hash.slice(1));
  skyOverride = link.get("sky");
  applyLang();
  if (skyOverride) setSky(null);
  $("tile-events-sub").textContent = t("loading");
  try {
    [config, events] = await Promise.all([api("/api/config"), api("/api/events")]);
    $("date").value = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Oslo" });
    applyLang();
    if (link.get("e")) selectEvent(link.get("e"));
    const o = config.origins.find((x) => x.id === link.get("o"));
    if (selected && o) { origin = o; renderTiles(); openTravel(); }
  } catch (err) {
    $("tile-events-sub").textContent = err.message;
  }
}
init();
