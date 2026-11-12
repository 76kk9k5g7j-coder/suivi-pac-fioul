// Ma PAC — script de la prise Shelly (envoi des Wh heure par heure + minutes au relais Cloudflare) — v3c : minutes toutes les 2 min
// A UTILISER SEULEMENT avec le relais v3 branche sur D1 (/ping => "store":"d1"). Avec KV seul : garder l'ancien script (10 min).
// A REMPLIR : les 2 lignes ci-dessous (adresse de TON relais et TON mot de passe d'ecriture WRITE_TOKEN).
// Ne partage jamais ce mot de passe.
let URL_WORKER = "https://TON-RELAIS.workers.dev";
let TOKEN = "TON_TOKEN_ECRITURE";
// reglages (ne pas toucher, sauf MIN_EVERY plus bas)
let SW = 0;      // id de la prise
let MRG = 5;     // lecture horaire a hh:00:05 au plus tot
let LATE = 120, RLATE = 420; // apres hh:02:00 (hh:07 juste apres une relance) : heure non envoyee
let RTY = 600;   // essai horaire au plus toutes les 10 min apres echec
let MAXQ = 48;   // heures gardees en cas de panne
let CH = 12;     // heures par cle KVS
let NCH = 4;     // 4 x 12 = 48
let SMAX = 6;    // heures par envoi
let TMO = 20;    // delai HTTP (s)
let MMAX = 120;  // lignes minute gardees (2 h)
let MRTY = 300;  // essai minutes au plus toutes les 5 min apres echec
let MLATE = 10;  // releve minute dans les 10 premieres secondes
let LOT = 10;    // lignes minute par envoi au plus (2 en temps normal, 10 pour rattraper apres une panne)
// envoi des minutes toutes les MIN_EVERY minutes (2 = a hh:01, :03, :05...)
let MIN_EVERY = 2;
let st = null, qS = "", qN = 0, sv = ["", "", "", ""], rdy = false, bz = false, lt = 0, snd = 0;
let rq = [], rb = false, HD = null, SID = 0, bt = 1;
let mB = "", mN = 0, mT = 0, mL = 0, mLM = 0, mBz = false, mDue = 0, mLT = 0, mS = 0, mOK = 0;
function p2(n) { return n < 10 ? "0" + n : "" + n; }
function dfc(y, m, d) {
y = m <= 2 ? y - 1 : y;
let e = Math.floor(y / 400), x = y - e * 400, p = m > 2 ? m - 3 : m + 9;
let o = Math.floor((153 * p + 2) / 5) + d - 1;
return e * 146097 + x * 365 + Math.floor(x / 4) - Math.floor(x / 100) + o - 719468;
}
function cfd(z) {
z += 719468;
let e = Math.floor(z / 146097), o = z - e * 146097;
let x = Math.floor((o - Math.floor(o / 1460) + Math.floor(o / 36524) - Math.floor(o / 146096)) / 365);
let y = x + e * 400, dy = o - (365 * x + Math.floor(x / 4) - Math.floor(x / 100));
let p = Math.floor((5 * dy + 2) / 153), d = dy - Math.floor((153 * p + 2) / 5) + 1, m = p < 10 ? p + 3 : p - 9;
return [m <= 2 ? y + 1 : y, m, d];
}
function lsun(y, m) { let d = dfc(y, m, 31), w = (d + 4) % 7; if (w < 0) w += 7; return d - w; }
function poff(u) {
let y = cfd(Math.floor(u / 86400))[0];
return (u >= lsun(y, 3) * 86400 + 3600 && u < lsun(y, 10) * 86400 + 3600) ? 7200 : 3600;
}
function pk(u) {
let l = u + poff(u), c = cfd(Math.floor(l / 86400));
return c[0] + "-" + p2(c[1]) + "-" + p2(c[2]) + "T" + p2(Math.floor((l % 86400) / 3600));
}
function rpc(m, p, cb) { rq.push([m, p, cb]); rnx(); }
function rdn(r, e) {
let j = rq[0]; rq.splice(0, 1); rb = false;
if (j[2]) j[2](r, e);
rnx();
}
function rnx() { if (rb || !rq.length) return; rb = true; Shelly.call(rq[0][0], rq[0][1], rdn); }
function cfg() { return URL_WORKER.indexOf("https://") === 0 && TOKEN.indexOf("VOTRE_") < 0 && TOKEN.indexOf("TON_TOKEN") < 0 && URL_WORKER.indexOf("TON-RELAIS") < 0; }
function post(path, b, cb) { rpc("HTTP.Request", { method: "POST", url: URL_WORKER + path, headers: HD, body: b, timeout: TMO }, cb); }
function mem() {
let s = Shelly.getComponentStatus("script", SID);
return s ? " mem " + s.mem_free + (typeof s.mem_peak === "number" ? "/" + s.mem_peak : "") : "";
}
// file horaire : "AAMMJJHH=wh;" (meme format que les cles KVS de la v2)
function qp(n) {
let p = 0;
for (let i = 0; i < n; i++) { let e = qS.indexOf(";", p); if (e < 0) return qS.length; p = e + 1; }
return p;
}
function svQ() {
for (let i = 0; i < NCH; i++) {
let s = qS.slice(qp(i * CH), qp((i + 1) * CH));
if (s.length) s = s.slice(0, -1);
if (s !== sv[i]) { sv[i] = s; rpc("KVS.Set", { key: "pac_q" + i, value: s }, null); }
}
}
function svS() { rpc("KVS.Set", { key: "pac_st", value: JSON.stringify(st) }, null); }
function enq(k, wh) {
k = k.slice(2, 4) + k.slice(5, 7) + k.slice(8, 10) + k.slice(11, 13);
let i = (";" + qS).indexOf(";" + k + "=");
if (i >= 0) { let e = qS.indexOf(";", i); qS = qS.slice(0, i) + k + "=" + wh + qS.slice(e); return; }
qS += k + "=" + wh + ";"; qN++;
while (qN > MAXQ) { qS = qS.slice(qS.indexOf(";") + 1); qN--; }
}
function qDrop(n) { qS = qS.slice(qp(n)); qN -= n; if (qN < 0) qN = 0; }
function onS(r, e) {
bz = false;
let c = r && r.code ? r.code : 0;
if (e === 0 && (c === 200 || c === 400 || c === 413)) {
qDrop(snd); svQ();
print(c === 200 ? "PAC: heure OK " + snd + ", reste " + qN : "PAC: heures refusees " + c);
if (c === 200) lt = 0;
} else print("PAC: echec heure " + e + "/" + c);
}
function fl(now) {
if (bz || !qN || !cfg() || rq.length) return;
if (lt && now - lt < RTY) return;
lt = now; bz = true;
snd = qN < SMAX ? qN : SMAX;
let b = '{"items":[', p = 0;
for (let i = 0; i < snd; i++) {
let e = qS.indexOf(";", p), k = qS.slice(p, p + 8);
b += (i ? "," : "") + '{"h":"20' + k.slice(0, 2) + "-" + k.slice(2, 4) + "-" + k.slice(4, 6) + "T" + k.slice(6, 8) + '","wh":' + qS.slice(p + 9, e) + "}";
p = e + 1;
}
post("/push", b + "]}", onS);
}
// minutes : mB = "d,wh,w;" par ligne, d = minutes depuis la ligne precedente, mT = t de la 1re ligne
function f2(x) { let c = Math.round(x * 100), i = Math.floor(c / 100), f = c - i * 100; return i + "." + (f < 10 ? "0" : "") + f; }
function mDrop() {
mB = mB.slice(mB.indexOf(";") + 1); mN--;
if (mN > 0) mT += 60 * Number(mB.slice(0, mB.indexOf(","))); else mB = "";
}
function mCap() { while (!mBz && mN > MMAX) { mDrop(); if (mDue) mDue--; } }
function mOn(r, e) {
mBz = false;
let c = r && r.code ? r.code : 0;
if (e === 0 && (c === 200 || c === 400 || c === 413)) {
for (let i = 0; i < mS; i++) mDrop();
mDue -= mS; if (mDue < 0) mDue = 0;
mLT = 0; mCap();
if (c !== 200) print("PAC: minutes refusees " + c);
else { mOK += mS; if (!mDue) { print("PAC: minutes OK " + mOK + mem()); mOK = 0; } }
} else print(c === 404 ? "PAC: /minutes absent, Worker pas a jour" : "PAC: echec minutes " + e + "/" + c);
}
function mFl(now) {
if (!mDue || mBz || !mN || !cfg() || rq.length || bz || (qN && !lt)) return;
if (mLT && now - mLT < MRTY) return;
mLT = now; mBz = true;
mS = mDue < LOT ? mDue : LOT;
let b = '{"src":"plug","rows":[', p = 0, t = mT;
for (let i = 0; i < mS; i++) {
let e = mB.indexOf(";", p), c = mB.indexOf(",", p);
if (i) { t += 60 * Number(mB.slice(p, c)); b += ","; }
b += "[" + t + mB.slice(c, e) + "]";
p = e + 1;
}
post("/minutes", b + "]}", mOn);
}
function mTk(now, s) {
let mi = Math.floor(now / 60);
if (mi < mLM) mLM = 0;
if (mi !== mLM && now - mi * 60 <= MLATE) {
mLM = mi;
let t = mi * 60, w = typeof s.apower === "number" && s.apower > 0 ? Math.round(s.apower) : 0;
if (!mN) mT = t;
mB += (mN ? (t - mL) / 60 : 0) + "," + f2(s.aenergy.total) + "," + w + ";";
mN++; mL = t; mCap();
if ((mi + 1) % MIN_EVERY === 0) { mDue = mN; mLT = 0; }
}
mFl(now);
}
function tick() {
if (!rdy) return;
let sy = Shelly.getComponentStatus("sys"), now = sy ? sy.unixtime : 0;
if (!now || now < 1700000000) return;
let hb = Math.floor(now / 3600), sec = now - hb * 3600;
let s = Shelly.getComponentStatus("switch", SW);
if (!s || !s.aenergy || typeof s.aenergy.total !== "number") return;
let tot = s.aenergy.total;
mTk(now, s);
if (st === null) { st = { t: tot, b: hb, p: sec > LATE ? 1 : 0, k: "", w: 0 }; svS(); bt = 0; return; }
if (hb === st.b) { bt = 0; fl(now); return; }
if (hb < st.b) { st.b = hb; st.t = tot; st.p = 1; svS(); return; }
if (sec < MRG) return;
let lim = bt ? RLATE : LATE; bt = 0;
if (hb - st.b === 1 && st.p === 0 && sec <= lim) {
let d = tot >= st.t ? tot - st.t : tot, k = pk((hb - 1) * 3600);
let wh = Math.round(((k === st.k) ? st.w + d : d) * 10) / 10;
if (wh > 4000) wh = 4000;
enq(k, wh); st.k = k; st.w = wh; svQ();
print("PAC: heure " + k + " = " + wh + " Wh" + (sec > LATE ? " (lue a +" + sec + " s)" : ""));
} else print("PAC: heure incomplete, non envoyee " + pk((hb - 1) * 3600));
st.t = tot; st.b = hb; st.p = sec > lim ? 1 : 0;
svS(); lt = 0; fl(now);
}
let li = 0;
function onWd(r, e) { if (e === 0 && r) { rpc("KVS.Set", { key: "pac_wd", value: "" + r.id }, null); print("PAC: relance auto activee, tache " + r.id); } }
function onLW(r, e) {
if (!(e === 0 && r && typeof r.value === "string")) rpc("Schedule.Create", { enable: true, timespec: "30 */5 * * * *", calls: [{ method: "Script.Start", params: { id: SID } }] }, onWd);
}
function onLQ(r, e) {
if (e === 0 && r && typeof r.value === "string" && r.value.length) {
sv[li] = r.value; qS += r.value + ";";
for (let i = 0; i < r.value.length; i++) if (r.value.charAt(i) === ";") qN++;
qN++;
}
li++;
if (li < NCH) { rpc("KVS.Get", { key: "pac_q" + li }, onLQ); return; }
while (qN > MAXQ) { qS = qS.slice(qS.indexOf(";") + 1); qN--; }
rdy = true;
print("PAC v3c: pret, " + qN + " h en attente" + (st ? ", derniere lecture " + pk(st.b * 3600) : "") + mem() + (cfg() ? "" : " - URL/jeton a remplir !"));
if (SID) rpc("KVS.Get", { key: "pac_wd" }, onLW);
tick();
}
function onLS(r, e) {
if (e === 0 && r && typeof r.value === "string") { st = JSON.parse(r.value); if (!st || typeof st.t !== "number") st = null; }
rpc("KVS.Get", { key: "pac_q0" }, onLQ);
}
while (URL_WORKER.length && URL_WORKER.charAt(URL_WORKER.length - 1) === "/") URL_WORKER = URL_WORKER.slice(0, -1);
HD = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
SID = typeof Shelly.getCurrentScriptId === "function" ? Shelly.getCurrentScriptId() : 0;
rpc("KVS.Get", { key: "pac_st" }, onLS);
Timer.set(5000, true, tick);
