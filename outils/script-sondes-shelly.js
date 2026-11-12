// Ma PAC - script des sondes (Shelly 1 Gen3 + Add-On + 3 sondes DS18B20) - v2b
// Releve les 3 temperatures CHAQUE MINUTE et les envoie au relais Cloudflare toutes les 2 minutes.
// A UTILISER avec le relais v3 branche sur D1 (/ping => "store":"d1"). Avec KV seul : mettre EVERY = 5.
// A REMPLIR : les 2 lignes ci-dessous, avec EXACTEMENT les memes valeurs que dans le script de la prise.
// Ne partage jamais ce script une fois rempli.
let URL_WORKER = "https://TON-RELAIS.workers.dev";
let TOKEN = "TON_TOKEN_ECRITURE";
// numero de chaque sonde (temperature:100, :101, :102) : a verifier avec le guide, etape 2.3
let ID_EXT = 100;  // sonde 1 : exterieur
let ID_IN = 101;   // sonde 2 : entree d'air (aspiration)
let ID_OUT = 102;  // sonde 3 : sortie d'air (soufflage)
// reglages (ne pas toucher)
let EVERY = 2;     // envoi toutes les 2 minutes (a hh:01, :03, :05...)
let LOT = 10;      // lignes max par envoi apres une panne (petit = peu de memoire)
let MMAX = 120;    // lignes gardees en cas de panne internet (2 h), au-dela on oublie les plus anciennes
let RTY = 300;     // apres un echec, nouvel essai au plus toutes les 5 min
let MLATE = 10;    // releve dans les 10 premieres secondes de la minute
let TMO = 20;      // delai HTTP (s)
// etat. Memoire tampon B = "d,in,out,ext;" par minute (d = minutes depuis la ligne d'avant, vide = sonde absente)
let B = "", N = 0, T0 = 0, TL = 0, LM = 0, DUE = 0, BZ = false, BT = 0, LT = 0, S = 0, OK = 0, W = 0, HD = null, SID = 0, RDY = false;
function rd(id) {
let s = Shelly.getComponentStatus("temperature", id);
if (!s || typeof s.tC !== "number" || (s.errors && s.errors.length)) return "";
let c = Math.round(s.tC * 100);
if (c < -5500 || c > 12500 || c === 8500) return "";
let g = c < 0 ? "-" : "";
if (c < 0) c = -c;
let f = c % 100;
return g + Math.floor(c / 100) + "." + (f < 10 ? "0" : "") + f;
}
function nv(v) { return v === "" ? "null" : v; }
function mem() {
let s = Shelly.getComponentStatus("script", SID);
return s ? " mem " + s.mem_free + (typeof s.mem_peak === "number" ? "/" + s.mem_peak : "") : "";
}
function cfg() { return URL_WORKER.indexOf("https://") === 0 && URL_WORKER.indexOf("VOTRE_") < 0 && TOKEN.indexOf("VOTRE_") < 0 && TOKEN.indexOf("TON_TOKEN") < 0 && URL_WORKER.indexOf("TON-RELAIS") < 0; }
function drop() {
B = B.slice(B.indexOf(";") + 1); N--;
if (N > 0) T0 += 60 * Number(B.slice(0, B.indexOf(","))); else { B = ""; N = 0; }
}
function cap() { while (!BZ && N > MMAX) { drop(); if (DUE) DUE--; } }
function onP(r, e) {
BZ = false;
let c = r && r.code ? r.code : 0;
if (e === 0 && (c === 200 || c === 400 || c === 413)) {
for (let i = 0; i < S; i++) drop();
DUE -= S; if (DUE < 0) DUE = 0;
LT = 0; cap();
if (c !== 200) print("SONDES: lot refuse par le relais (" + c + "), ignore");
else { OK += S; if (!DUE) { print("SONDES: envoi OK " + OK + " min, reste " + N + mem()); OK = 0; } }
} else if (c === 401) print("SONDES: mot de passe refuse (401) : TOKEN different de WRITE_TOKEN");
else if (c === 404) print("SONDES: /minutes absent, relais pas a jour");
else print("SONDES: echec envoi " + e + "/" + c + ", " + N + " min gardees, nouvel essai dans 5 min");
}
function send(now) {
if (!DUE || !N || !cfg()) return;
if (BZ) { if (now - BT > TMO + 40) BZ = false; return; }
if (LT && now - LT < RTY) return;
LT = now; BT = now; BZ = true;
S = DUE < LOT ? DUE : LOT;
let b = '{"src":"probes","rows":[', p = 0, t = T0;
for (let i = 0; i < S; i++) {
let e = B.indexOf(";", p), c1 = B.indexOf(",", p), c2 = B.indexOf(",", c1 + 1), c3 = B.indexOf(",", c2 + 1);
if (i) { t += 60 * Number(B.slice(p, c1)); b += ","; }
b += "[" + t + "," + nv(B.slice(c1 + 1, c2)) + "," + nv(B.slice(c2 + 1, c3)) + "," + nv(B.slice(c3 + 1, e)) + "]";
p = e + 1;
}
Shelly.call("HTTP.Request", { method: "POST", url: URL_WORKER + "/minutes", headers: HD, body: b + "]}", timeout: TMO }, onP);
}
function tick() {
if (!RDY) return;
let sy = Shelly.getComponentStatus("sys"), now = sy ? sy.unixtime : 0;
if (!now || now < 1700000000) return;
let mi = Math.floor(now / 60);
if (mi < LM) LM = 0;
if (mi !== LM && now - mi * 60 <= MLATE) {
LM = mi;
let t = mi * 60, a = rd(ID_IN), o = rd(ID_OUT), x = rd(ID_EXT);
if (a === "" || o === "" || x === "") {
if (now - W >= 3600) { W = now; print("SONDES: sonde non lue (vide = null) in=" + nv(a) + " out=" + nv(o) + " ext=" + nv(x)); }
}
if (!N) T0 = t;
B += (N ? (t - TL) / 60 : 0) + "," + a + "," + o + "," + x + ";";
N++; TL = t; cap();
if ((mi + 1) % EVERY === 0) { DUE = N; LT = 0; }
}
send(now);
}
function onWd(r, e) { if (e === 0 && r) { Shelly.call("KVS.Set", { key: "sondes_wd", value: "" + r.id }, null); print("SONDES: relance auto activee, tache " + r.id); } }
function onLW(r, e) {
if (!(e === 0 && r && typeof r.value === "string")) Shelly.call("Schedule.Create", { enable: true, timespec: "40 */5 * * * *", calls: [{ method: "Script.Start", params: { id: SID } }] }, onWd);
RDY = true;
}
while (URL_WORKER.length && URL_WORKER.charAt(URL_WORKER.length - 1) === "/") URL_WORKER = URL_WORKER.slice(0, -1);
HD = { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
SID = typeof Shelly.getCurrentScriptId === "function" ? Shelly.getCurrentScriptId() : 0;
print("SONDES v2b: pret. ext(" + ID_EXT + ")=" + nv(rd(ID_EXT)) + " entree(" + ID_IN + ")=" + nv(rd(ID_IN)) + " sortie(" + ID_OUT + ")=" + nv(rd(ID_OUT)) + mem() + (cfg() ? "" : " - URL/jeton a remplir !"));
if (SID) Shelly.call("KVS.Get", { key: "sondes_wd" }, onLW); else RDY = true;
Timer.set(5000, true, tick);
