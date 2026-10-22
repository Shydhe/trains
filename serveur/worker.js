// Trains Nice ZOU — serveur (Cloudflare Worker + base D1)
// Rôles : relais vers l'API SNCF (la clé reste ici), paris entre collègues, classement.
// Variables à définir dans Cloudflare : SNCF_KEY (secret), TEAM_CODE (secret). Base D1 liée sous le nom DB.

const API = "https://api.sncf.com/v1/coverage/sncf";

const STATIONS = {
  ville:   { q: "Nice Ville",           match: /nice.?ville/i,  fallback: "stop_area:SNCF:87756056", label: "Nice-Ville" },
  riquier: { q: "Nice Riquier",         match: /riquier/i,      fallback: null,                      label: "Nice-Riquier" },
  staug:   { q: "Nice Saint-Augustin",  match: /augustin/i,     fallback: null,                      label: "Nice-St-Augustin" },
  monaco:  { q: "Monaco Monte-Carlo",   match: /monaco/i,       fallback: "stop_area:SNCF:87756403", label: "Monaco" },
  antibes: { q: "Antibes",              match: /^antibes/i,     fallback: "stop_area:SNCF:87757625", label: "Antibes" },
};

// Règles du jeu : un pari par jour, avant 14h, sur son train Monaco → Nice de l'après-midi
const GAME = {
  close: "14:00",                         // paris fermés à partir de cette heure, en semaine
  first: "16:00", last: "19:00",          // trains Monaco → Nice concernés
};
// Paliers de retard au départ de Monaco. Un train supprimé compte comme le dernier palier.
const TIERS = [
  { id: 0, label: "À l'heure", sub: "moins de 5 min", max: 5 },
  { id: 1, label: "5 à 15 min", max: 15 },
  { id: 2, label: "15 à 30 min", max: 30 },
  { id: 3, label: "30 min à 1 h", max: 60 },
  { id: 4, label: "1 h à 2 h", max: 120 },
  { id: 5, label: "Plus de 2 h", sub: "ou supprimé", max: Infinity },
];
// Fréquences supposées au départ, remplacées peu à peu par les vrais résultats
const PRIOR = [0.70, 0.18, 0.06, 0.035, 0.015, 0.01];
const PRIOR_WEIGHT = 60;                  // poids de l'estimation de départ, en nombre de trains

const RT_TTL = 90;          // secondes de cache pour le temps réel
const BASE_TTL = 6 * 3600;  // secondes de cache pour la grille théorique

// ---------- utilitaires temps (heure de Paris) ----------
const FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function paris(ms = Date.now()) {
  const p = Object.fromEntries(FMT.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const hm = `${p.hour}:${p.minute}`;
  return { date, hm, dow: new Date(date + "T12:00:00Z").getUTCDay() };
}
// Journée de service : de 4h à 4h du matin
const serviceDay = (ms = Date.now()) => paris(ms - 4 * 3600e3).date;
// Minutes depuis 4h00 de la journée de service
const sMin = hm => { let [h, m] = hm.split(":").map(Number); if (h < 4) h += 24; return h * 60 + m; };
const nowSMin = (ms = Date.now()) => sMin(paris(ms).hm);
const addDays = (date, n) => new Date(Date.parse(date + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const navToHM = s => s ? `${s.slice(9, 11)}:${s.slice(11, 13)}` : null;
const navToMs = s => s ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13)) : null;

// ---------- base de données ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token TEXT NOT NULL UNIQUE, created TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bets(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, day TEXT NOT NULL, train TEXT NOT NULL, dep TEXT NOT NULL, late INTEGER NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, points INTEGER, UNIQUE(user_id, day, train))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS results(day TEXT NOT NULL, train TEXT NOT NULL, dep TEXT NOT NULL, delay INTEGER, cancelled INTEGER NOT NULL DEFAULT 0, void INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL, PRIMARY KEY(day, train))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS paris(user_id INTEGER NOT NULL, day TEXT NOT NULL, train TEXT NOT NULL, dep TEXT NOT NULL, tier INTEGER NOT NULL, points INTEGER NOT NULL, created TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0, actual INTEGER, PRIMARY KEY(user_id, day))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cache(k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)`),
  ]);
  schemaReady = true;
}
async function cacheGet(env, k, ttl) {
  const r = await env.DB.prepare("SELECT v, t FROM cache WHERE k = ?").bind(k).first();
  return r && Date.now() - r.t < ttl * 1000 ? JSON.parse(r.v) : null;
}
async function cachePut(env, k, v) {
  await env.DB.prepare("INSERT INTO cache(k, v, t) VALUES(?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t")
    .bind(k, JSON.stringify(v), Date.now()).run();
}

// ---------- API SNCF ----------
async function nav(env, path) {
  const r = await fetch(API + path, { headers: { Authorization: "Basic " + btoa(env.SNCF_KEY + ":") } });
  if (!r.ok) throw new Error(`API SNCF ${r.status}`);
  return r.json();
}
async function stationId(env, key) {
  const s = STATIONS[key];
  if (!s) throw new Error("gare inconnue");
  const ck = "station:" + key;
  const hit = await cacheGet(env, ck, 30 * 86400);
  if (hit) return hit;
  let id = null;
  try {
    const j = await nav(env, `/places?q=${encodeURIComponent(s.q)}&type[]=stop_area&count=10`);
    const p = (j.places || []).find(p => p.embedded_type === "stop_area" && s.match.test(p.name));
    id = p && p.id;
  } catch (e) { /* on essaie la valeur de secours */ }
  id = id || s.fallback;
  if (!id) throw new Error(`gare introuvable : ${s.label}`);
  await cachePut(env, ck, id);
  return id;
}

function parseStops(json, kind) {
  const effects = {};
  for (const d of json.disruptions || []) effects[d.id] = (d.severity && d.severity.effect) || "";
  return (json[kind + "s"] || []).map(x => {
    const di = x.display_informations || {}, sdt = x.stop_date_time || {};
    const allLinks = [...(x.links || []), ...(di.links || [])];
    const disIds = allLinks.filter(l => l.type === "disruption").map(l => l.id);
    const vjLink = allLinks.find(l => l.type === "vehicle_journey");
    return {
      vj: vjLink ? vjLink.id : null,
      num: String(di.trip_short_name || di.headsign || ""),
      mode: di.commercial_mode || di.physical_mode || "",
      network: di.network || "",
      direction: (di.direction || "").replace(/\s*\(.*\)$/, ""),
      rt: sdt[kind + "_date_time"],
      base: sdt["base_" + kind + "_date_time"] || sdt[kind + "_date_time"],
      effects: disIds.map(id => effects[id]).filter(Boolean),
    };
  }).filter(t => t.num && !/inoui/i.test(t.mode + " " + t.network));
}

// Associe les départs de A aux arrivées en B du même train
function pair(deps, arrs) {
  const byNum = {};
  for (const a of arrs) (byNum[a.num] ||= []).push(a);
  const out = {};
  for (const d of deps) {
    const a = (byNum[d.num] || []).find(a => navToMs(a.base) > navToMs(d.base) && navToMs(a.base) - navToMs(d.base) < 3 * 3600e3);
    if (a) out[d.num + "@" + d.base] = { d, a };
  }
  return out;
}

async function getBoard(env, from, to, day, fresh = false) {
  const ck = `board:${from}:${to}:${day}`;
  if (!fresh) { const hit = await cacheGet(env, ck, RT_TTL); if (hit) return hit; }
  const [fromId, toId] = await Promise.all([stationId(env, from), stationId(env, to)]);
  const q = `?from_datetime=${day.replace(/-/g, "")}T040000&duration=86400&count=600&depth=1`;
  const baseKey = `base:${from}:${to}:${day}`;
  let base = await cacheGet(env, baseKey, BASE_TTL);
  const calls = [
    nav(env, `/stop_areas/${fromId}/departures${q}&data_freshness=realtime`),
    nav(env, `/stop_areas/${toId}/arrivals${q}&data_freshness=realtime`),
  ];
  if (!base) calls.push(
    nav(env, `/stop_areas/${fromId}/departures${q}&data_freshness=base_schedule`),
    nav(env, `/stop_areas/${toId}/arrivals${q}&data_freshness=base_schedule`),
  );
  const [dRt, aRt, dB, aB] = await Promise.all(calls);
  if (!base) {
    base = Object.values(pair(parseStops(dB, "departure"), parseStops(aB, "arrival")))
      .map(({ d, a }) => ({ num: d.num, mode: d.mode, direction: d.direction, dep: d.base, arr: a.base }));
    await cachePut(env, baseKey, base);
  }
  const rt = pair(parseStops(dRt, "departure"), parseStops(aRt, "arrival"));
  const rtByNum = {};
  for (const v of Object.values(rt)) rtByNum[v.d.num] = v;

  const trains = [];
  const seen = new Set();
  for (const b of base) {
    const r = rtByNum[b.num];
    seen.add(b.num);
    trains.push(makeTrain(b.num, b.mode, b.direction, b.dep, b.arr, r));
  }
  for (const [num, r] of Object.entries(rtByNum)) {            // trains ajoutés en temps réel
    if (!seen.has(num)) trains.push(makeTrain(num, r.d.mode, r.d.direction, r.d.base, r.a.base, r));
  }
  trains.sort((x, y) => sMin(x.dep) - sMin(y.dep));
  const out = { day, from, to, fromLabel: STATIONS[from].label, toLabel: STATIONS[to].label, updated: Date.now(), trains };
  await cachePut(env, ck, out);
  return out;
}

function makeTrain(num, mode, direction, depBase, arrBase, r) {
  const t = { num, mode: shortMode(mode), direction, dep: navToHM(depBase), arr: navToHM(arrBase), depRt: null, arrRt: null, delay: 0, status: "ok" };
  const noService = r && [...r.d.effects, ...r.a.effects].includes("NO_SERVICE");
  if (!r || noService) { t.status = "cancelled"; return t; }
  t.depRt = navToHM(r.d.rt);
  t.arrRt = navToHM(r.a.rt);
  t.delay = Math.max(0, Math.round((navToMs(r.d.rt) - navToMs(depBase)) / 60000));
  const arrDelay = Math.round((navToMs(r.a.rt) - navToMs(arrBase)) / 60000);
  if (t.delay >= 1 || arrDelay >= 3) t.status = "late";
  if (r.d.effects.length || r.a.effects.length) t.note = [...new Set([...r.d.effects, ...r.a.effects])].join(", ");
  return t;
}
function shortMode(m) {
  if (/ouigo/i.test(m)) return "OUIGO";
  if (/interc/i.test(m)) return "Intercités";
  if (/car|bus/i.test(m)) return "Car";
  if (/trenitalia|regionale/i.test(m)) return "Trenitalia";
  if (/ter|zou/i.test(m)) return "TER";
  return m || "Train";
}

// ---------- carte : trains en circulation autour de Nice ----------
// La SNCF ne donne pas de GPS : on renvoie les arrêts de chaque train (coordonnées + heures) et son retard,
// l'app calcule la position entre deux gares.
const hhmm = s => s ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : null;
async function mapTrains(env, ms = Date.now()) {
  const hit = await cacheGet(env, "map", 60);
  if (hit) return hit;
  const ville = await stationId(env, "ville");
  const start = paris(ms - 80 * 60e3);
  const from = start.date.replace(/-/g, "") + "T" + start.hm.replace(":", "") + "00";
  const q = `?from_datetime=${from}&duration=${160 * 60}&count=250&depth=1&data_freshness=realtime`;
  const [deps, arrs] = await Promise.all([
    nav(env, `/stop_areas/${ville}/departures${q}`),
    nav(env, `/stop_areas/${ville}/arrivals${q}`),
  ]);
  const seen = new Map();
  for (const t of [...parseStops(deps, "departure"), ...parseStops(arrs, "arrival")]) {
    if (!t.vj || seen.has(t.num) || t.effects.includes("NO_SERVICE")) continue;
    seen.set(t.num, t);
  }
  const day = serviceDay(ms);
  const trains = [];
  let fetched = 0;
  for (const t of seen.values()) {
    const ck = `vj:${day}:${t.num}`;
    let stops = await cacheGet(env, ck, BASE_TTL);
    if (!stops) {
      if (fetched >= 30) continue;            // garde-fou sur le quota de l'API
      fetched++;
      try {
        const j = await nav(env, `/vehicle_journeys/${encodeURIComponent(t.vj)}?depth=2`);
        const vj = (j.vehicle_journeys || [])[0];
        stops = ((vj && vj.stop_times) || []).map(st => ({
          name: ((st.stop_point && st.stop_point.name) || "").replace(/\s*\(.*\)$/, ""),
          lon: +(st.stop_point && st.stop_point.coord && st.stop_point.coord.lon),
          lat: +(st.stop_point && st.stop_point.coord && st.stop_point.coord.lat),
          arr: hhmm(st.arrival_time), dep: hhmm(st.departure_time),
        })).filter(s => isFinite(s.lon) && isFinite(s.lat) && s.lon && s.arr);
        await cachePut(env, ck, stops);
      } catch (e) { continue; }
    }
    if (stops.length < 2) continue;
    const delay = Math.round((navToMs(t.rt) - navToMs(t.base)) / 60000) || 0;
    trains.push({ num: t.num, mode: shortMode(t.mode), direction: t.direction, delay, stops });
  }
  const out = { day, updated: Date.now(), trains };
  await cachePut(env, "map", out);
  return out;
}

// ---------- jeu ----------
function windowState(ms = Date.now()) {
  const p = paris(ms), t = sMin(p.hm);
  const weekday = p.dow >= 1 && p.dow <= 5;
  return {
    weekday, date: p.date, now: p.hm,
    open: weekday && t < sMin(GAME.close),
    closed: !weekday || t >= sMin(GAME.close),
    closesAt: GAME.close,
  };
}
// Semaine de jeu : du vendredi au jeudi. Le vendredi, on annonce le gagnant de la semaine qui vient de finir.
function weekStart(date) {
  const dow = new Date(date + "T12:00:00Z").getUTCDay();
  return addDays(date, -((dow - 5 + 7) % 7));
}
function tierOf(res) {
  if (res.cancelled) return 5;
  return TIERS.findIndex(t => res.delay < t.max);
}
// Points de rareté : plus un palier est rare, plus il rapporte. Recalculés chaque vendredi.
function pointsFrom(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  return PRIOR.map((p, i) => {
    const freq = (counts[i] + p * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
    return Math.max(5, Math.round(10 * Math.sqrt(1 / freq)));
  });
}
async function tierPoints(env, day) {
  const until = weekStart(day);
  const ck = "points:" + until;
  const hit = await cacheGet(env, ck, 7 * 86400);
  if (hit) return hit;
  const { results } = await env.DB.prepare(
    "SELECT delay, cancelled FROM results WHERE day < ? AND void = 0 AND dep >= ? AND dep <= ?"
  ).bind(until, GAME.first, GAME.last).all();
  const counts = [0, 0, 0, 0, 0, 0];
  for (const r of results) counts[tierOf(r)]++;
  const out = { points: pointsFrom(counts), counts, total: results.length, since: until };
  await cachePut(env, ck, out);
  return out;
}
async function betTrains(env, day) {
  const board = await getBoard(env, "monaco", "ville", day);
  return board.trains.filter(t => sMin(t.dep) >= sMin(GAME.first) && sMin(t.dep) <= sMin(GAME.last));
}
async function userFrom(env, req) {
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  return env.DB.prepare("SELECT id, name FROM users WHERE token = ?").bind(tok).first();
}
async function leaderboard(env, start, end) {
  const { results } = await env.DB.prepare(
    `SELECT u.name, SUM(p.won * p.points) AS points, COUNT(*) AS bets, SUM(p.won) AS wins
     FROM paris p JOIN users u ON u.id = p.user_id
     WHERE p.settled = 1 AND p.day BETWEEN ? AND ? GROUP BY u.id ORDER BY points DESC, wins DESC, u.name`
  ).bind(start, end).all();
  return { start, end, rows: results };
}

async function game(env, req) {
  const me = await userFrom(env, req);
  const w = windowState();
  const day = w.date;
  let trains = [];
  if (w.weekday) { try { trains = await betTrains(env, day); } catch (e) { trains = []; } }
  const pts = await tierPoints(env, day);
  const { results: bets } = await env.DB.prepare(
    `SELECT p.train, p.dep, p.tier, p.points, p.settled, p.won, p.actual, u.name, p.user_id FROM paris p JOIN users u ON u.id = p.user_id WHERE p.day = ? ORDER BY p.dep, u.name`
  ).bind(day).all();
  const { results: res } = await env.DB.prepare("SELECT train, delay, cancelled, void FROM results WHERE day = ?").bind(day).all();
  const visible = bets.filter(b => w.closed || (me && b.user_id === me.id)).map(({ user_id, ...b }) => ({ ...b, mine: !!me && user_id === me.id }));
  const ws = weekStart(day);
  return {
    me: me ? { name: me.name } : null,
    window: w, rules: GAME,
    tiers: TIERS.map((t, i) => ({ id: t.id, label: t.label, sub: t.sub || "", points: pts.points[i] })),
    stats: { total: pts.total, counts: pts.counts },
    trains: trains.map(t => ({ num: t.num, dep: t.dep, depRt: t.depRt, status: t.status, delay: t.delay })),
    myBet: visible.find(b => b.mine) || null,
    bets: visible,
    count: bets.length,
    results: res.map(r => ({ ...r, tier: r.void ? null : tierOf(r) })),
    week: await leaderboard(env, ws, addDays(ws, 6)),
    lastWeek: await leaderboard(env, addDays(ws, -7), addDays(ws, -1)),
    isFriday: paris().dow === 5,
  };
}

async function placeBet(env, req) {
  const me = await userFrom(env, req);
  if (!me) return err(401, "Rejoins d'abord le jeu avec le code d'équipe.");
  const w = windowState();
  if (!w.open) return err(403, `Les paris se font en semaine, avant ${GAME.close}.`);
  const body = await req.json().catch(() => ({}));
  const day = w.date;
  if (body.remove) {
    await env.DB.prepare("DELETE FROM paris WHERE user_id = ? AND day = ?").bind(me.id, day).run();
    return json({ ok: true });
  }
  const tier = Number(body.tier);
  if (!Number.isInteger(tier) || tier < 0 || tier >= TIERS.length) return err(400, "Choisis un palier de retard.");
  const train = String(body.train || "");
  const t = (await betTrains(env, day)).find(t => t.num === train);
  if (!t) return err(400, "Ce train n'est pas dans la liste de cet après-midi.");
  const pts = (await tierPoints(env, day)).points[tier];
  await env.DB.prepare(
    `INSERT INTO paris(user_id, day, train, dep, tier, points, created) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET train = excluded.train, dep = excluded.dep, tier = excluded.tier, points = excluded.points, created = excluded.created`
  ).bind(me.id, day, train, t.dep, tier, pts, new Date().toISOString()).run();
  return json({ ok: true });
}

async function join(env, req) {
  const body = await req.json().catch(() => ({}));
  if (!env.TEAM_CODE || String(body.team || "").trim() !== env.TEAM_CODE) return err(403, "Code d'équipe incorrect.");
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 20) return err(400, "Le pseudo doit faire entre 2 et 20 caractères.");
  const taken = await env.DB.prepare("SELECT id FROM users WHERE name = ?").bind(name).first();
  if (taken) return err(409, "Ce pseudo est déjà pris.");
  const token = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users(name, token, created) VALUES(?, ?, ?)").bind(name, token, new Date().toISOString()).run();
  return json({ token, name });
}

// Relevé automatique, toutes les 5 minutes : note le retard de chaque train Monaco → Nice de 16h à 19h
// (sert aussi à calculer la rareté), puis règle les paris.
async function settle(env, ms = Date.now()) {
  await ensureSchema(env);
  const p = paris(ms);
  if (p.dow < 1 || p.dow > 5) return { settled: 0 };
  const day = serviceDay(ms);
  const now = nowSMin(ms);
  if (now < sMin(GAME.first)) return { settled: 0 };
  const { results: done } = await env.DB.prepare("SELECT train FROM results WHERE day = ?").bind(day).all();
  const doneSet = new Set(done.map(r => r.train));
  let board = null;
  try { board = await getBoard(env, "monaco", "ville", day, true); } catch (e) { board = null; }
  const inWindow = board ? board.trains.filter(t => sMin(t.dep) >= sMin(GAME.first) && sMin(t.dep) <= sMin(GAME.last)) : [];
  const { results: pending } = await env.DB.prepare("SELECT DISTINCT train, dep FROM paris WHERE day = ? AND settled = 0").bind(day).all();
  const toCheck = new Map();
  for (const t of inWindow) if (!doneSet.has(t.num)) toCheck.set(t.num, t.dep);
  for (const b of pending) if (!doneSet.has(b.train)) toCheck.set(b.train, b.dep);
  for (const [num, dep] of toCheck) {
    if (sMin(dep) > now) continue;
    const t = board && board.trains.find(t => t.num === num);
    let res = null;
    if (t && t.status === "cancelled") res = { delay: null, cancelled: 1, void: 0 };
    else if (t && t.depRt && now >= sMin(t.depRt) + 2) res = { delay: t.delay, cancelled: 0, void: 0 };
    else if (now > sMin(dep) + 180) res = { delay: null, cancelled: 0, void: 1 };   // pas d'info fiable : pari annulé
    if (!res) continue;
    await env.DB.prepare(
      `INSERT INTO results(day, train, dep, delay, cancelled, void, updated) VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, train) DO UPDATE SET delay = excluded.delay, cancelled = excluded.cancelled, void = excluded.void, updated = excluded.updated`
    ).bind(day, num, dep, res.delay, res.cancelled, res.void, new Date(ms).toISOString()).run();
  }
  // Règlement des paris dont le train a un résultat
  const { results: ready } = await env.DB.prepare(
    `SELECT p.user_id, p.tier, r.delay, r.cancelled, r.void FROM paris p JOIN results r ON r.day = p.day AND r.train = p.train WHERE p.day = ? AND p.settled = 0`
  ).bind(day).all();
  if (ready.length) await env.DB.batch(ready.map(b => {
    const actual = b.void ? null : tierOf(b);
    return env.DB.prepare("UPDATE paris SET settled = 1, won = ?, actual = ? WHERE user_id = ? AND day = ?")
      .bind(actual !== null && actual === b.tier ? 1 : 0, actual, b.user_id, day);
  }));
  return { settled: ready.length };
}

// ---------- HTTP ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
const err = (status, message) => json({ error: message }, status);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      await ensureSchema(env);
      if (url.pathname === "/api/health") {
        const out = { ok: true, paris: paris(), key: !!env.SNCF_KEY, team: !!env.TEAM_CODE, stations: {} };
        for (const k of Object.keys(STATIONS)) { try { out.stations[k] = await stationId(env, k); } catch (e) { out.stations[k] = "ERREUR : " + e.message; out.ok = false; } }
        try { const b = await getBoard(env, "ville", "monaco", serviceDay(), true); out.sample = b.trains.slice(0, 3); out.trainsToday = b.trains.length; }
        catch (e) { out.ok = false; out.sampleError = e.message; }
        return json(out);
      }
      if (url.pathname === "/api/board" && req.method === "GET") {
        const from = url.searchParams.get("from"), to = url.searchParams.get("to");
        if (!STATIONS[from] || !STATIONS[to] || from === to) return err(400, "Gares invalides.");
        return json(await getBoard(env, from, to, serviceDay()));
      }
      if (url.pathname === "/api/map" && req.method === "GET") return json(await mapTrains(env));
      if (url.pathname === "/api/game" && req.method === "GET") return json(await game(env, req));
      if (url.pathname === "/api/join" && req.method === "POST") return join(env, req);
      if (url.pathname === "/api/bet" && req.method === "POST") return placeBet(env, req);
      if (url.pathname === "/api/settle" && req.method === "POST") {
        const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (tok !== env.TEAM_CODE) return err(403, "Interdit.");
        return json(await settle(env));
      }
      return err(404, "Adresse inconnue.");
    } catch (e) {
      return err(502, "Le serveur n'a pas pu répondre : " + e.message);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(settle(env));
  },
};

