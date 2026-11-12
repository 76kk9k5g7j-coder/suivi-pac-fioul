// PAC fioul – récepteur Shelly (Cloudflare Worker, syntaxe module) — RELAIS v3 (KV + D1)
// Liaisons attendues (à configurer dans le tableau de bord Cloudflare) :
//   HOURS        : espace de noms KV
//   DB           : base D1 (FACULTATIF). Sans DB, le relais marche exactement comme la v2 (tout en KV).
//                  Avec DB : minutes prise/sondes + relevés Midea écrits dans D1 (100 000 lignes/jour gratuites,
//                  au lieu de 1 000 écritures KV/jour) => envoi possible CHAQUE MINUTE. Les tables se créent seules.
//                  Les anciennes données KV restent lues (fusion automatique), rien à migrer à la main.
//   WRITE_TOKEN  : secret (utilisé par la prise Shelly)
//   READ_TOKEN   : secret (utilisé par l'app sur le téléphone)
// Aucun jeton n'est écrit dans ce fichier ni journalisé.
//
// API
//   GET  /ping                       -> {ok:true}  (+ last si READ_TOKEN fourni)
//   POST /push   {h,wh} | {items:[{h,wh},...]}     (Bearer WRITE_TOKEN)
//   GET  /hours?since=AAAA-MM-JJTHH  -> {ok,items:[{h,wh}],last}  (Bearer READ_TOKEN)
//   POST /minutes {src:"plug"|"probes", rows:[[t, ...valeurs], ...]}  (Bearer WRITE_TOKEN)
//   POST /backup (copie complète de l'appli) · GET /backup (liste) · GET /backup?d=AAAA-MM-JJ  (Bearer READ_TOKEN)
//   GET  /minutes?since=UNIX&until=UNIX&src=plug|probes  (Bearer READ_TOKEN)
//        -> {ok, since, until, src:{plug:{cols,rows,last}, probes:{...}}, today:{date,wh}}
//   POST /midea {samples:[{t,d},...]}  (Bearer WRITE_TOKEN)  — relevés clim Midea (dict brut midea-local)
//   GET  /midea?since=UNIX&until=UNIX  (Bearer READ_TOKEN) -> {ok,since,until,samples,last}
//   GET  /midea/last                   (Bearer READ_TOKEN) -> {ok,sample}  (dernier relevé, lectures seules)
//   GET  /live?since=UNIX[&until=UNIX]  (Bearer READ_TOKEN, v3, facultatif) -> {ok,since,until,src:{plug,probes},today,midea:{samples,last}}
//        = /minutes?src=all + /midea en UNE requête (pour un rafraîchissement chaque minute appli ouverte). Au plus 1 jour.
//   t = début de la minute en secondes unix (multiple de 60) : même grille pour toutes les sources.
//   Colonnes : plug = [t, wh (compteur cumulé), w (puissance)] ; probes = [t, t_in, t_out, t_ext] (°C ou null)
//   Un renvoi de la même minute REMPLACE la ligne (idempotent).
// h = heure LOCALE Europe/Paris 'AAAA-MM-JJTHH' (début de l'heure), wh = Wh de cette heure.
// Un renvoi de la même heure REMPLACE la valeur (idempotent).
//
// Stockage : une clé KV par mois "m:AAAA-MM" -> {"AAAA-MM-JJTHH": wh, ...}
//            une clé "meta" -> {last:"AAAA-MM-JJTHH", at:"ISO UTC de réception"}
//            une clé par source et par jour (Europe/Paris) "d:SRC:AAAA-MM-JJ" -> {"cols":[...],"rows":[[t,...],...]}
//            => 1 écriture KV par paquet (2 si le paquet chevauche minuit).
//            une clé par HEURE (Europe/Paris) "midea:AAAA-MM-JJTHH" -> {"samples":[{t,d},...]}  (v2 ; avant : une clé par jour "midea:AAAA-MM-JJ", encore lue)
//            => 1 écriture KV par POST (2 au passage de l'heure) ; expirationTtl ~31 j (rétention ~30 j).
// Pas d'expiration pour heures/minutes/backup (rétention illimitée).
// v3 avec D1 : tables plug(t,wh,w), probes(t,t_in,t_out,t_ext), midea(t,d) ; t = clé primaire (un renvoi REMPLACE la ligne).
//            1 ligne écrite par minute et par source. Rétention D1 : 62 jours (2 mois) pour plug, probes ET midea :
//            au plus une purge par heure (et par instance), glissée dans un envoi ; une ligne effacée compte comme une ligne écrite.
//            Heures (/push), meta et /backup restent en KV (≈ 50 écritures KV/jour).
//            GET /minutes et /midea : jusqu'à 62 jours par demande (l'appli lit par tranches plus petites : moins de CPU).

// Adresses autorisées à lire le relais depuis le navigateur (l'appli). La prise Shelly n'est pas concernée.
// A ADAPTER : mets ici l'adresse de TON appli (ex. https://mon-appli.pages.dev), entre guillemets droits.
const ALLOWED_ORIGINS = ["https://TON-APPLI.pages.dev"];
const MAX_BODY = 8192;          // octets
const MAX_ITEMS = 72;           // heures par envoi
const MAX_WH = 4000;            // Plug S Gen3 : 16 A x 230 V ≈ 3680 Wh max par heure
const MAX_RANGE_MONTHS = 14;    // GET /hours : au plus ~14 mois lus
const DEFAULT_DAYS = 31;
const FAIL_LIMIT = 20;          // échecs d'auth par IP et par minute (par instance)

const H_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;
const fails = new Map();

function corsHeaders(req) {
  const h = { "Vary": "Origin" };
  const origin = req.headers.get("Origin");
  if (ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

function json(req, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }, corsHeaders(req)),
  });
}

// Comparaison en temps constant : on compare les empreintes SHA-256 (longueur fixe).
async function sha(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function tokenOk(req, expected) {
  if (typeof expected !== "string" || expected.length < 16) return false; // secret absent/trop court
  const auth = req.headers.get("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = await sha(given), b = await sha(expected);
  let diff = given.length === 0 ? 1 : 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function clientIp(req) { return req.headers.get("CF-Connecting-IP") || "?"; }
function tooManyFails(req) {
  const e = fails.get(clientIp(req));
  return !!e && e.n >= FAIL_LIMIT && Date.now() - e.t < 60000;
}
function noteFail(req) {
  const ip = clientIp(req), now = Date.now();
  const e = fails.get(ip);
  if (!e || now - e.t >= 60000) fails.set(ip, { n: 1, t: now }); else e.n++;
  if (fails.size > 1000) fails.clear();
}

// Valide 'AAAA-MM-JJTHH' (vraie date du calendrier, années 2020..2100).
export function validHour(h) {
  if (typeof h !== "string") return false;
  const m = H_RE.exec(h);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3], hh = +m[4];
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12 || hh > 23 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}
function validWh(wh) {
  return typeof wh === "number" && Number.isFinite(wh) && wh >= 0 && wh <= MAX_WH;
}
// Refuse les heures trop dans le futur (horloge de la prise déréglée) : > maintenant + 1 jour.
function notFuture(h, nowMs) {
  const m = H_RE.exec(h);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]) - 2 * 3600e3; // Paris = UTC+1/+2
  return t <= nowMs + 24 * 3600e3;
}
const monthKey = (h) => "m:" + h.slice(0, 7);

async function readMonth(env, key) {
  const v = await env.HOURS.get(key, "json");
  return v && typeof v === "object" ? v : {};
}

async function handlePush(req, env) {
  const len = +(req.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  const text = await req.text();
  if (text.length > MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  let body;
  try { body = JSON.parse(text); } catch { return json(req, 400, { ok: false, error: "bad_json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(req, 400, { ok: false, error: "bad_body" });

  let items;
  if (Array.isArray(body.items)) items = body.items;
  else if ("h" in body || "wh" in body) items = [body];
  else return json(req, 400, { ok: false, error: "bad_body" });
  if (items.length === 0 || items.length > MAX_ITEMS) return json(req, 400, { ok: false, error: "bad_count" });

  const now = Date.now();
  const byMonth = new Map();
  for (const it of items) {
    if (!it || typeof it !== "object" || !validHour(it.h) || !validWh(it.wh) || !notFuture(it.h, now)) {
      return json(req, 400, { ok: false, error: "bad_item" }); // lot refusé en entier
    }
    const k = monthKey(it.h);
    if (!byMonth.has(k)) byMonth.set(k, {});
    byMonth.get(k)[it.h] = Math.round(it.wh * 10) / 10; // la dernière valeur d'une même heure gagne
  }

  let maxH = "";
  for (const [k, upd] of byMonth) {
    const cur = await readMonth(env, k);
    Object.assign(cur, upd); // remplace, jamais d'addition => idempotent
    await env.HOURS.put(k, JSON.stringify(cur));
    for (const h of Object.keys(upd)) if (h > maxH) maxH = h;
  }
  const meta = (await env.HOURS.get("meta", "json")) || {};
  if (!meta.last || maxH > meta.last) meta.last = maxH;
  meta.at = new Date(now).toISOString();
  await env.HOURS.put("meta", JSON.stringify(meta));
  return json(req, 200, { ok: true, saved: items.length, last: meta.last });
}

function addMonths(y, m, n) { const t = y * 12 + (m - 1) + n; return [Math.floor(t / 12), (t % 12) + 1]; }
const pad = (n) => String(n).padStart(2, "0");

async function handleHours(req, env, url) {
  let since = url.searchParams.get("since");
  const now = new Date();
  if (since === null || since === "") {
    const d = new Date(now.getTime() - DEFAULT_DAYS * 86400e3);
    since = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00`;
  }
  if (!validHour(since)) return json(req, 400, { ok: false, error: "bad_since" });
  let [y, m] = [+since.slice(0, 4), +since.slice(5, 7)];
  const endY = now.getUTCFullYear(), endM = now.getUTCMonth() + 1;
  // borne : au plus MAX_RANGE_MONTHS mois en arrière
  const span = (endY * 12 + endM) - (y * 12 + m);
  if (span > MAX_RANGE_MONTHS - 1) {
    [y, m] = addMonths(endY, endM, -(MAX_RANGE_MONTHS - 1));
    const s2 = `${y}-${pad(m)}-01T00`;
    if (s2 > since) since = s2;
  }
  const items = [];
  // inclut le mois suivant (fin de mois/fuseau) au cas où
  const [lastY, lastM] = addMonths(endY, endM, 1);
  while (y * 12 + m <= lastY * 12 + lastM) {
    const data = await readMonth(env, `m:${y}-${pad(m)}`);
    for (const h of Object.keys(data)) {
      if (h >= since && validHour(h) && validWh(data[h])) items.push({ h, wh: data[h] });
    }
    [y, m] = addMonths(y, m, 1);
  }
  items.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const meta = (await env.HOURS.get("meta", "json")) || {};
  return json(req, 200, { ok: true, since, items, last: meta.last || null, at: meta.at || null });
}

// ---------------- relevés minute ----------------
const MIN_SOURCES = {
  plug:   { cols: ["t", "wh", "w"],                min: [0, 0],          max: [1e8, 4000],      nullable: false },
  probes: { cols: ["t", "t_in", "t_out", "t_ext"], min: [-55, -55, -55], max: [125, 125, 125], nullable: true },
};
// ---------------- D1 (v3) ----------------
const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS plug (t INTEGER PRIMARY KEY, wh REAL NOT NULL, w REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS probes (t INTEGER PRIMARY KEY, t_in REAL, t_out REAL, t_ext REAL)",
  "CREATE TABLE IF NOT EXISTS midea (t INTEGER PRIMARY KEY, d TEXT NOT NULL)",
];
let d1Ready = null;                 // promesse : schéma créé (une fois par instance)
const d1First = {};                 // première minute présente dans D1, par table (mise en cache une fois connue)
function useD1(env) { return !!(env.DB && typeof env.DB.prepare === "function"); }
async function d1(env) {
  if (!d1Ready) d1Ready = env.DB.batch(D1_SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { d1Ready = null; throw e; });
  await d1Ready;
  return env.DB;
}
// plus ancienne ligne de la table (1 ligne lue : t est la clé primaire). null = table vide.
async function d1FirstT(env, tbl) {
  if (d1First[tbl]) return d1First[tbl];
  const db = await d1(env);
  const r = await db.prepare(`SELECT MIN(t) AS m FROM ${tbl}`).first();
  const m = r && Number.isInteger(r.m) ? r.m : null;
  if (m !== null) d1First[tbl] = m;
  return m;
}
// une journée de Paris est encore à lire dans KV si elle est antérieure ou égale au jour de la 1re ligne D1
function kvDayNeeded(date, firstT) { return firstT === null || date <= parisDate(firstT); }

const MIN_MAX_BODY = 32768;      // octets
const MIN_MAX_ROWS = 300;        // lignes par envoi (la prise en envoie 15, 120 au plus après une panne)
const MIN_MAX_AGE_S = 8 * 86400; // lignes acceptées jusqu'à 8 jours en arrière
const D1_KEEP_S = 62 * 86400;      // v3 : rétention D1 (2 mois) pour plug, probes et midea
const PURGE_EVERY_S = 3600;        // purge au plus une fois par heure (par instance)
const MIN_MAX_SPAN_S = 62 * 86400; // GET : au plus 62 jours lus (KV seul : il n'y a de toute façon que ce qui existe)
let lastPurge = 0;                 // dernière purge D1 (unix, par instance)
// purge D1 (rétention 62 j) : renvoie les requêtes à ajouter au lot d'écriture, ou [] si déjà faite depuis moins d'une heure.
// t = clé primaire => DELETE ... WHERE t < ? ne lit que les lignes effacées (0 ligne lue / écrite s'il n'y a rien à effacer).
function purgeStmts(db, nowS) {
  if (nowS - lastPurge < PURGE_EVERY_S) return [];
  lastPurge = nowS;
  const cut = nowS - D1_KEEP_S;
  return ["plug", "probes", "midea"].map((tb) => db.prepare(`DELETE FROM ${tb} WHERE t < ?`).bind(cut));
}
const parisFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
export function parisDate(t) { return parisFmt.format(new Date(t * 1000)); } // 'AAAA-MM-JJ'
// minuit (heure de Paris) du jour contenant t, en unix
export function parisMidnight(t) {
  const d = parisDate(t);
  for (const off of [3600, 7200]) {
    const m = Date.parse(d + "T00:00:00Z") / 1000 - off;
    if (parisDate(m) === d && parisDate(m - 1) !== d) return m;
  }
  return Date.parse(d + "T00:00:00Z") / 1000 - 3600;
}
const dayKey = (src, date) => "d:" + src + ":" + date;

function validRow(row, spec, nowS) {
  if (!Array.isArray(row) || row.length !== spec.cols.length) return false;
  const t = row[0];
  if (!Number.isInteger(t) || t % 60 !== 0 || t < 1577836800 || t > nowS + 600 || t < nowS - MIN_MAX_AGE_S) return false;
  for (let i = 1; i < row.length; i++) {
    const v = row[i];
    if (v === null && spec.nullable) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < spec.min[i - 1] || v > spec.max[i - 1]) return false;
  }
  return true;
}

async function handleMinutesPost(req, env) {
  const len = +(req.headers.get("Content-Length") || 0);
  if (len > MIN_MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  const text = await req.text();
  if (text.length > MIN_MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  let body;
  try { body = JSON.parse(text); } catch { return json(req, 400, { ok: false, error: "bad_json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(req, 400, { ok: false, error: "bad_body" });
  const spec = Object.prototype.hasOwnProperty.call(MIN_SOURCES, body.src) ? MIN_SOURCES[body.src] : null;
  if (!spec) return json(req, 400, { ok: false, error: "bad_src" });
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MIN_MAX_ROWS) return json(req, 400, { ok: false, error: "bad_count" });
  const nowS = Math.floor(Date.now() / 1000);
  const byDay = new Map();
  for (const r of rows) {
    if (!validRow(r, spec, nowS)) return json(req, 400, { ok: false, error: "bad_row" }); // lot refusé en entier
    const k = dayKey(body.src, parisDate(r[0]));
    if (!byDay.has(k)) byDay.set(k, new Map());
    byDay.get(k).set(r[0], r.slice());
  }
  let last = 0;
  if (useD1(env)) {
    const db = await d1(env);
    const c = spec.cols, set = c.slice(1).map((x) => `${x}=excluded.${x}`).join(",");
    const q = db.prepare(`INSERT INTO ${body.src} (${c.join(",")}) VALUES (${c.map(() => "?").join(",")}) ON CONFLICT(t) DO UPDATE SET ${set}`);
    const stmts = [];
    for (const upd of byDay.values()) for (const [t, r] of upd) { stmts.push(q.bind(...r)); if (t > last) last = t; }
    for (const x of purgeStmts(db, nowS)) stmts.push(x); // rétention 62 j, au plus 1 fois par heure
    await db.batch(stmts);                   // 1 ligne écrite par minute (+ lignes de plus de 62 j effacées)
    return json(req, 200, { ok: true, saved: rows.length, last });
  }
  for (const [k, upd] of byDay) {            // en pratique 1 seul jour => 1 lecture + 1 écriture
    const cur = await env.HOURS.get(k, "json");
    const merged = new Map();
    if (cur && Array.isArray(cur.rows)) for (const r of cur.rows) if (Array.isArray(r)) merged.set(r[0], r);
    for (const [t, r] of upd) merged.set(t, r); // remplace, jamais d'addition => idempotent
    const out = [...merged.values()].sort((a, b) => a[0] - b[0]);
    await env.HOURS.put(k, JSON.stringify({ cols: spec.cols, rows: out }));
    for (const t of upd.keys()) if (t > last) last = t;
  }
  return json(req, 200, { ok: true, saved: rows.length, last });
}

// énergie (Wh) entre la première et la dernière ligne, en tolérant une remise à zéro du compteur
function energyOf(rows) {
  let wh = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][1], b = rows[i][1];
    wh += b >= a ? b - a : b;
  }
  return Math.round(wh * 100) / 100;
}

// jours de Paris couverts par [since, until]
function parisDates(since, until) {
  const dates = [];
  for (let t = since; ; t += 6 * 3600) {      // pas de 6 h : aucun jour sauté, même aux changements d'heure
    const d = parisDate(Math.min(t, until));
    if (!dates.includes(d)) dates.push(d);
    if (t >= until) break;
  }
  return dates;
}

// lignes minute [since, until] d'une source : D1 (v3) + anciennes clés KV (jours antérieurs à D1), triées, une ligne par t
async function minutesRows(env, s, since, until) {
  const byT = new Map();
  let firstT = null;
  if (useD1(env)) {
    firstT = await d1FirstT(env, s);
    if (firstT !== null && until >= firstT) {
      const db = await d1(env);
      const r = await db.prepare(`SELECT ${MIN_SOURCES[s].cols.join(",")} FROM ${s} WHERE t >= ? AND t <= ? ORDER BY t`).bind(since, until).raw();
      for (const row of r) byT.set(row[0], row);
    }
  }
  for (const d of parisDates(since, until)) {
    if (useD1(env) && !kvDayNeeded(d, firstT)) continue;
    const v = await env.HOURS.get(dayKey(s, d), "json");
    if (v && Array.isArray(v.rows)) for (const r of v.rows) if (Array.isArray(r) && r[0] >= since && r[0] <= until && !byT.has(r[0])) byT.set(r[0], r);
  }
  return [...byT.values()].sort((a, b) => a[0] - b[0]);
}

async function minutesData(env, since, until, srcs) {
  const out = {};
  for (const s of srcs) {
    const rows = await minutesRows(env, s, since, until);
    out[s] = { cols: MIN_SOURCES[s].cols, rows, last: rows.length ? rows[rows.length - 1] : null };
  }
  const res = { ok: true, since, until, src: out };
  // consommation du jour (Paris) : seulement si la plage demandée couvre le jour de 'until'
  if (out.plug) {
    const m = parisMidnight(until);
    const today = out.plug.rows.filter((r) => r[0] >= m);
    if (since <= m) res.today = { date: parisDate(until), wh: energyOf(today), from: today.length ? today[0][0] : null, to: today.length ? today[today.length - 1][0] : null };
  }
  return res;
}

async function handleMinutesGet(req, env, url) {
  const nowS = Math.floor(Date.now() / 1000);
  const p = (n) => url.searchParams.get(n);
  const intOr = (s, d) => (s === null || s === "" ? d : (/^\d{1,11}$/.test(s) ? +s : NaN));
  let until = intOr(p("until"), nowS);
  let since = intOr(p("since"), parisMidnight(nowS));
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return json(req, 400, { ok: false, error: "bad_range" });
  if (until - since > MIN_MAX_SPAN_S) since = until - MIN_MAX_SPAN_S;
  const which = p("src");
  let srcs;
  if (which === null || which === "" || which === "all") srcs = Object.keys(MIN_SOURCES);
  else if (Object.prototype.hasOwnProperty.call(MIN_SOURCES, which)) srcs = [which];
  else return json(req, 400, { ok: false, error: "bad_src" });
  return json(req, 200, await minutesData(env, since, until, srcs));
}

// ---------------- relevés Midea (clim) ----------------
// v2 : une clé KV par HEURE de Paris "midea:AAAA-MM-JJTHH" -> {"samples":[{t,d},...]} (triés par t, un seul relevé par t).
// Les anciennes clés par jour "midea:AAAA-MM-JJ" (avant v2) sont encore lues jusqu'à leur expiration (31 j).
// CPU : en lecture, une heure entièrement dans la plage est recopiée telle quelle (texte, sans JSON.parse) ;
// seules les heures du bord de plage (et les jours anciens format) sont décodées puis filtrées.
const MIDEA_MAX_BODY = 1048576;      // octets (1 Mo ; v2 : 256 Ko, trop juste pour 200 gros relevés après une coupure)
const MIDEA_MAX_SAMPLES = 200;       // ~10 / 10 min ; marge après panne
const MIDEA_MAX_SPAN_S = 62 * 86400; // GET : au plus 62 jours (v3 ; l'appli lit par tranches de 6 h)
const MIDEA_MAX_AGE_S = 31 * 86400;  // POST : lignes acceptées jusqu'à 31 jours en arrière
const MIDEA_TTL = 31 * 86400;        // expirationTtl KV (~30 j de rétention utile) — sans D1 seulement ; avec D1 : D1_KEEP_S (62 j)
const MIDEA_MAX_KEYS = 24;           // POST : heures distinctes par paquet (1 en temps normal, 2 au passage de l'heure ; plus après une coupure)
const MIDEA_LAST_BACK_H = 48;        // /midea/last : heures relues vers l'arrière avant de lister les clés
const mideaKey = (date) => "midea:" + date; // date = 'AAAA-MM-JJ' (ancien format) ou 'AAAA-MM-JJTHH'
const parisHourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
export function parisHour(t) { // 'AAAA-MM-JJTHH' (heure de Paris)
  const p = {};
  for (const x of parisHourFmt.formatToParts(new Date(t * 1000))) p[x.type] = x.value;
  return p.year + "-" + p.month + "-" + p.day + "T" + (p.hour === "24" ? "00" : p.hour);
}
const MIDEA_PRE = '{"samples":[', MIDEA_SUF = "]}";

function validMideaSample(s, nowS) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return false;
  const t = s.t;
  if (!Number.isInteger(t) || t < 1577836800 || t > nowS + 600 || t < nowS - MIDEA_MAX_AGE_S) return false;
  if (!s.d || typeof s.d !== "object" || Array.isArray(s.d)) return false;
  return true;
}

async function handleMideaPost(req, env) {
  const len = +(req.headers.get("Content-Length") || 0);
  if (len > MIDEA_MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  const text = await req.text();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MIDEA_MAX_BODY) return json(req, 413, { ok: false, error: "too_large" });
  let body;
  try { body = JSON.parse(text); } catch { return json(req, 400, { ok: false, error: "bad_json" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(req, 400, { ok: false, error: "bad_body" });
  const samples = body.samples;
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > MIDEA_MAX_SAMPLES) {
    return json(req, 400, { ok: false, error: "bad_count" });
  }
  const nowS = Math.floor(Date.now() / 1000);
  const byHour = new Map();
  const days = new Set();
  for (const s of samples) {
    if (!validMideaSample(s, nowS)) return json(req, 400, { ok: false, error: "bad_sample" });
    const k = mideaKey(parisHour(s.t));
    if (!byHour.has(k)) byHour.set(k, new Map());
    byHour.get(k).set(s.t, { t: s.t, d: s.d }); // même t => remplace (idempotent)
    days.add(k.slice(6, 16));
  }
  let last = 0;
  if (useD1(env)) {                          // v3 : 1 ligne par relevé, pas de limite d'heures par paquet
    const db = await d1(env);
    const q = db.prepare("INSERT INTO midea (t, d) VALUES (?, ?) ON CONFLICT(t) DO UPDATE SET d=excluded.d");
    const stmts = [];
    for (const upd of byHour.values()) for (const [t, x] of upd) { stmts.push(q.bind(t, JSON.stringify(x.d))); if (t > last) last = t; }
    for (const x of purgeStmts(db, nowS)) stmts.push(x); // rétention 62 j, au plus 1 fois par heure
    await db.batch(stmts);
    return json(req, 200, { ok: true, saved: samples.length, days: days.size, hours: byHour.size, last });
  }
  if (byHour.size > MIDEA_MAX_KEYS) return json(req, 400, { ok: false, error: "bad_span" });
  for (const [k, upd] of byHour) {
    const cur = await env.HOURS.get(k, "json");
    const merged = new Map();
    if (cur && Array.isArray(cur.samples)) {
      for (const s of cur.samples) if (s && Number.isInteger(s.t)) merged.set(s.t, s);
    }
    for (const [t, s] of upd) merged.set(t, s);
    const out = [...merged.values()].sort((a, b) => a.t - b.t);
    await env.HOURS.put(k, JSON.stringify({ samples: out }), { expirationTtl: MIDEA_TTL });
    for (const t of upd.keys()) if (t > last) last = t;
  }
  return json(req, 200, { ok: true, saved: samples.length, days: days.size, hours: byHour.size, last });
}

// relevés d'une valeur KV (texte) ; null si vide / illisible
function mideaParse(txt) {
  if (!txt) return null;
  try { const v = JSON.parse(txt); return v && Array.isArray(v.samples) ? v.samples.filter((s) => s && Number.isInteger(s.t)) : null; } catch { return null; }
}

// relevés Midea KV (format v2 heure + v1 jour) de [since, until] -> {parts: [texte JSON d'un relevé], last}
async function kvMideaRange(env, since, until) {
  // heures de Paris de la plage (les décalages de Paris sont des heures entières : une heure UTC = une heure de Paris)
  const hours = new Map(); // clé -> [début, fin] en unix
  for (let h = Math.floor(since / 3600) * 3600; h <= until; h += 3600) {
    const k = mideaKey(parisHour(h));
    const r = hours.get(k);
    if (r) r[1] = h + 3599; else hours.set(k, [h, h + 3599]);
  }
  // anciens jours (avant v2) : lus et fusionnés seulement s'ils existent
  const days = [];
  for (let t = since; ; t += 6 * 3600) {
    const d = parisDate(Math.min(t, until));
    if (!days.includes(d)) days.push(d);
    if (t >= until) break;
  }
  const legacy = new Map();
  for (const d of days) {
    const v = mideaParse(await env.HOURS.get(mideaKey(d)));
    if (v) for (const s of v) if (s.t >= since && s.t <= until) legacy.set(s.t, s);
  }
  const parts = [];      // morceaux JSON (texte) dans l'ordre
  let lastObj = null, lastTxt = null, lastT = -1;
  const pushObj = (s) => { parts.push(JSON.stringify(s)); if (s.t > lastT) { lastT = s.t; lastObj = s; lastTxt = null; } };
  for (const [k, [a, b]] of hours) {
    const txt = await env.HOURS.get(k);
    if (txt === null) continue;
    const whole = a >= since && b <= until && b - a === 3599 && !legacy.size &&
      txt.startsWith(MIDEA_PRE) && txt.endsWith(MIDEA_SUF);
    if (whole) {
      const inner = txt.slice(MIDEA_PRE.length, txt.length - MIDEA_SUF.length);
      if (inner) {
        parts.push(inner);
        // dernier relevé : décodé seulement pour la dernière heure non vide (voir plus bas)
        if (b > lastT) { lastT = b; lastTxt = txt; lastObj = null; }
      }
      continue;
    }
    const v = mideaParse(txt);
    if (!v) continue;
    for (const s of v) {
      if (s.t < since || s.t > until) continue;
      if (legacy.size) legacy.set(s.t, s); // fusion avec l'ancien format (même t => la clé horaire gagne)
      else pushObj(s);
    }
  }
  if (legacy.size) {
    const all = [...legacy.values()].sort((x, y) => x.t - y.t);
    return { parts: all.map((x) => JSON.stringify(x)), last: all.length ? all[all.length - 1] : null };
  }
  let last = lastObj;
  if (!last && lastTxt) { const v = mideaParse(lastTxt); if (v && v.length) last = v.reduce((m, s) => (s.t > m.t ? s : m)); }
  return { parts, last };
}

// D1 (v3) + KV (avant D1) ; les relevés D1 sont recopiés en texte (pas de JSON.parse) => peu de CPU
async function mideaRange(env, since, until) {
  let firstT = null;
  const parts = [];
  let last = null, lastRow = null;
  if (useD1(env)) firstT = await d1FirstT(env, "midea");
  if (!useD1(env) || firstT === null || since < firstT) {
    const kvUntil = firstT === null ? until : Math.min(until, firstT - 1);
    if (since <= kvUntil) { const k = await kvMideaRange(env, since, kvUntil); for (const x of k.parts) parts.push(x); last = k.last; }
  }
  if (useD1(env) && firstT !== null && until >= firstT) {
    const db = await d1(env);
    const r = await db.prepare("SELECT t, d FROM midea WHERE t >= ? AND t <= ? ORDER BY t").bind(since, until).raw();
    for (const row of r) parts.push('{"t":' + row[0] + ',"d":' + row[1] + "}");
    if (r.length) lastRow = r[r.length - 1];
  }
  if (lastRow) { try { last = { t: lastRow[0], d: JSON.parse(lastRow[1]) }; } catch { last = null; } }
  return { parts, last };
}

async function handleMideaGet(req, env, url) {
  const nowS = Math.floor(Date.now() / 1000);
  const p = (n) => url.searchParams.get(n);
  const intOr = (s, d) => (s === null || s === "" ? d : (/^\d{1,11}$/.test(s) ? +s : NaN));
  let until = intOr(p("until"), nowS);
  let since = intOr(p("since"), nowS - MIDEA_MAX_SPAN_S);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return json(req, 400, { ok: false, error: "bad_range" });
  if (until - since > MIDEA_MAX_SPAN_S) since = until - MIDEA_MAX_SPAN_S;
  const m = await mideaRange(env, since, until);
  const body = '{"ok":true,"since":' + since + ',"until":' + until + ',"samples":[' + m.parts.join(",") + '],"last":' + (m.last ? JSON.stringify(m.last) : "null") + "}";
  return new Response(body, { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, corsHeaders(req)) });
}

// v3 : tout ce qui est nouveau depuis 'since' en une requête (minutes prise + sondes + Midea)
const LIVE_MAX_SPAN_S = 86400;
async function handleLive(req, env, url) {
  const nowS = Math.floor(Date.now() / 1000);
  const p = (n) => url.searchParams.get(n);
  const intOr = (s, d) => (s === null || s === "" ? d : (/^\d{1,11}$/.test(s) ? +s : NaN));
  let until = intOr(p("until"), nowS);
  let since = intOr(p("since"), until - 3600);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) return json(req, 400, { ok: false, error: "bad_range" });
  if (until - since > LIVE_MAX_SPAN_S) since = until - LIVE_MAX_SPAN_S;
  const res = await minutesData(env, since, until, Object.keys(MIN_SOURCES));
  const m = await mideaRange(env, since, until);
  const head = JSON.stringify(res);
  const body = head.slice(0, -1) + ',"midea":{"samples":[' + m.parts.join(",") + '],"last":' + (m.last ? JSON.stringify(m.last) : "null") + "}}";
  return new Response(body, { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, corsHeaders(req)) });
}

async function handleMideaLast(req, env) {
  // lectures seules : on remonte heure par heure depuis maintenant (en temps normal : 1 à 2 lectures)
  const nowS = Math.floor(Date.now() / 1000);
  const best = (v) => (v && v.length ? v.reduce((m, s) => (s.t > m.t ? s : m)) : null);
  if (useD1(env)) {                          // v3 : 1 ligne lue
    const db = await d1(env);
    const r = await db.prepare("SELECT t, d FROM midea ORDER BY t DESC LIMIT 1").first();
    if (r) { try { return json(req, 200, { ok: true, sample: { t: r.t, d: JSON.parse(r.d) } }); } catch {} }
  }
  let found = null;
  for (let i = 0, seen = new Set(); i < MIDEA_LAST_BACK_H && !found; i++) {
    const k = mideaKey(parisHour(nowS - i * 3600));
    if (seen.has(k)) continue;
    seen.add(k);
    found = best(mideaParse(await env.HOURS.get(k)));
  }
  // ancien format (jour) : peut contenir plus récent que la dernière clé horaire trouvée (nuit de la mise à jour)
  for (const d of [parisDate(nowS), parisDate(nowS - 86400)]) {
    const s = best(mideaParse(await env.HOURS.get(mideaKey(d))));
    if (s && (!found || s.t > found.t)) found = s;
  }
  if (!found) {
    const listed = await env.HOURS.list({ prefix: "midea:" });
    const keys = listed.keys.map((k) => k.name).filter((n) => /^midea:\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(n));
    keys.sort((a, b) => (a.slice(6, 16) === b.slice(6, 16) ? (a.length > b.length ? -1 : a.length < b.length ? 1 : a < b ? 1 : -1) : a < b ? 1 : -1));
    for (const k of keys) {
      const s = best(mideaParse(await env.HOURS.get(k)));
      if (s) { found = s; break; }
    }
  }
  return json(req, 200, { ok: true, sample: found });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }
      if (!env.HOURS || !env.WRITE_TOKEN || !env.READ_TOKEN) {
        return json(req, 500, { ok: false, error: "not_configured" });
      }
      if (path === "/ping" && req.method === "GET") {
        if (req.headers.get("Authorization")) {
          if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
          if (!(await tokenOk(req, env.READ_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
          const meta = (await env.HOURS.get("meta", "json")) || {};
          return json(req, 200, { ok: true, last: meta.last || null, at: meta.at || null, store: useD1(env) ? "d1" : "kv", v: 3 });
        }
        return json(req, 200, { ok: true });
      }
      if (path === "/push") {
        if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        if (!(await tokenOk(req, env.WRITE_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return await handlePush(req, env);
      }
      if (path === "/hours") {
        if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        if (!(await tokenOk(req, env.READ_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return await handleHours(req, env, url);
      }
      if (path === "/minutes") {
        if (req.method !== "GET" && req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        const tok = req.method === "POST" ? env.WRITE_TOKEN : env.READ_TOKEN;
        if (!(await tokenOk(req, tok))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return req.method === "POST" ? await handleMinutesPost(req, env) : await handleMinutesGet(req, env, url);
      }
      if (path === "/live") {
        if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        if (!(await tokenOk(req, env.READ_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return await handleLive(req, env, url);
      }
      if (path === "/midea/last") {
        if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        if (!(await tokenOk(req, env.READ_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return await handleMideaLast(req, env);
      }
      if (path === "/midea") {
        if (req.method !== "GET" && req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        const tok = req.method === "POST" ? env.WRITE_TOKEN : env.READ_TOKEN;
        if (!(await tokenOk(req, tok))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        return req.method === "POST" ? await handleMideaPost(req, env) : await handleMideaGet(req, env, url);
      }
      // ===== Sauvegarde automatique de l'appli (ajout v98) : mot de passe de LECTURE ; garde 7 jours + 4 semaines =====
      if (path === "/backup") {
        if (req.method !== "GET" && req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
        if (tooManyFails(req)) return json(req, 429, { ok: false, error: "rate_limited" });
        if (!(await tokenOk(req, env.READ_TOKEN))) { noteFail(req); return json(req, 401, { ok: false, error: "unauthorized" }); }
        if (req.method === "GET") {
          const d = url.searchParams.get("d");
          if (d) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json(req, 400, { ok: false, error: "bad_date" });
            const v = await env.HOURS.get("b:" + d);
            if (v === null) return json(req, 404, { ok: false, error: "not_found" });
            return new Response(v, { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, corsHeaders(req)) });
          }
          const l = await env.HOURS.list({ prefix: "b:" });
          const items = l.keys.map((k) => ({ d: k.name.slice(2), size: k.metadata ? k.metadata.size : null })).sort((a, b) => (a.d < b.d ? 1 : -1));
          return json(req, 200, { ok: true, items });
        }
        const text = await req.text();
        if (text.length > 5000000) return json(req, 413, { ok: false, error: "too_large" });
        try { JSON.parse(text); } catch (e) { return json(req, 400, { ok: false, error: "bad_json" }); }
        const day = parisDate(Math.floor(Date.now() / 1000));
        await env.HOURS.put("b:" + day, text, { metadata: { size: text.length } });
        const days = (await env.HOURS.list({ prefix: "b:" })).keys.map((k) => k.name.slice(2)).sort().reverse();
        const keep = new Set(days.slice(0, 7)), weeks = new Set();
        for (const d of days.slice(7)) {
          const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
          const w = t.toISOString().slice(0, 10);
          if (!weeks.has(w) && weeks.size < 4) { weeks.add(w); keep.add(d); }
        }
        for (const d of days) if (!keep.has(d)) await env.HOURS.delete("b:" + d);
        return json(req, 200, { ok: true, d: day, size: text.length });
      }
      // ===== fin de l'ajout =====
      return json(req, 404, { ok: false, error: "not_found" });
    } catch (e) {
      // D1 en panne ou quota du jour atteint : 503 => la prise / les sondes / le S8 gardent leurs relevés et réessaient
      if (useD1(env) && e && /D1|SQLITE|database/i.test(String(e.message || e))) { console.error("db error"); return json(req, 503, { ok: false, error: "db" }); }
      // pas de détail (ni jeton, ni corps) dans la réponse ou les journaux
      console.error("internal error");
      return json(req, 500, { ok: false, error: "internal" });
    }
  },
};
