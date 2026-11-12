# Ma PAC - releve Midea depuis le S8 (Termux) -> relais Cloudflare /midea  (v3 : envoi toutes les 5 min)
# A UTILISER avec le relais v3 branche sur D1 (/ping => "store":"d1"). Avec KV seul, mettre ENVOI_N = 10.
# A REMPLIR (ne partage jamais ces valeurs) : les memes que dans ton script actuel.
EMAIL     = "TON_EMAIL_MIDEA"
MDP       = "TON_MDP_MIDEA"
URL       = "https://TON-RELAIS.workers.dev"
TOKEN     = "TON_TOKEN_ECRITURE"
# reglages
LECTURE_S = 60      # un releve par minute
ENVOI_N   = 5       # envoi toutes les 5 lectures (5 min)
MAX_POST  = 50      # releves au plus par envoi (paquet petit = jamais refuse pour taille)
MAX_TOURS = 6       # envois au plus par tour apres une coupure (6 x 50 = 300 releves rattrapes toutes les 5 min)
MAX_FILE  = 1440    # garde 24 h en cas de coupure internet (au-dela : les plus anciens sont oublies)
# file d'attente : a cote du script, ou chemin donne par PAC_FILE_ATTENTE

import subprocess, sys, time, json, ast, os, urllib.request, urllib.error

SAUVE = os.environ.get("PAC_FILE_ATTENTE") or "pac_file_attente.json"

def lire():
    try:
        r = subprocess.run([sys.executable, "-m", "midealocal.cli", "discover",
                            "--cloud-name", "SmartHome", "--username", EMAIL, "--password", MDP],
                           capture_output=True, text=True, timeout=90)
    except Exception as e:
        print("lecture echec:", e); return None
    out = (r.stdout or "") + (r.stderr or "")
    for line in out.splitlines():
        if "indoor_fan_speed" in line:
            i, j = line.find("{"), line.rfind("}")
            if i >= 0 and j > i:
                try:
                    return ast.literal_eval(line[i:j + 1])
                except Exception:
                    pass
    print("lecture: rien trouve"); return None

def pret():
    return URL.startswith("http") and "VOTRE_" not in URL and "TON-RELAIS" not in URL and "VOTRE_" not in TOKEN and "TON_TOKEN" not in TOKEN and "TON_EMAIL" not in EMAIL

def poster(lot):
    # renvoie le code HTTP (0 = pas de reseau / delai depasse)
    body = json.dumps({"samples": lot}, default=str, separators=(",", ":")).encode()
    req = urllib.request.Request(URL.rstrip("/") + "/midea", data=body, method="POST",
                                 headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "User-Agent": "pac-s8/3.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read()
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        print("envoi echec:", e); return 0

def envoyer(file):
    # envoie la file par paquets de MAX_POST au plus. Renvoie (nombre envoye, dernier code).
    # 200 : retire le paquet. 413 (trop gros) ou 400 (releve refuse) : coupe le paquet en deux et reessaie ;
    # un releve seul encore refuse est le seul oublie. Autre code (401, 404, 5xx, reseau) : on garde TOUT et on reessaie au tour suivant.
    envoye, k, tours, code = 0, min(len(file), MAX_POST), 0, 0
    while file and tours < MAX_TOURS * 3:
        tours += 1
        k = min(k, len(file))
        code = poster(file[:k])
        if code == 200:
            del file[:k]; envoye += k
            if envoye >= MAX_POST * MAX_TOURS: break
            k = min(len(file), MAX_POST)
        elif code in (400, 413):
            if k > 1:
                k = k // 2
            else:
                print("releve refuse", code, "- ce releve seul est oublie"); del file[:1]; k = min(len(file), MAX_POST)
        else:
            break
    return envoye, code

def charger():
    try:
        with open(SAUVE) as f:
            v = json.load(f)
        return [s for s in v if isinstance(s, dict) and isinstance(s.get("t"), int) and isinstance(s.get("d"), dict)][-MAX_FILE:]
    except Exception:
        return []

def sauver(file):
    try:
        if file:
            with open(SAUVE + ".tmp", "w") as f:
                json.dump(file, f, default=str, separators=(",", ":"))
            os.replace(SAUVE + ".tmp", SAUVE)
        elif os.path.exists(SAUVE):
            os.remove(SAUVE)
    except Exception as e:
        print("sauvegarde file echec:", e)

def main():
    file, n = charger(), 0
    garde = bool(file)
    print("Releve Midea v3 demarre (envoi toutes les", ENVOI_N, "min).", len(file), "releves en attente. Ctrl+C pour arreter.")
    if not pret(): print("ATTENTION : URL / TOKEN a remplir en haut du script, rien ne sera envoye")
    while True:
        t0 = time.time()
        try:
            d = lire()
            if d:
                file.append({"t": int(t0), "d": d}); n += 1
                print(time.strftime("%H:%M"), "soufflerie", d.get("indoor_fan_speed"), "tr/min, file", len(file))
            if len(file) > MAX_FILE:
                del file[:len(file) - MAX_FILE]
            if file and n >= ENVOI_N and pret():
                n = 0
                envoye, code = envoyer(file)
                if not file:
                    print("envoi OK", envoye)
                elif code == 200:
                    print("envoi OK", envoye, "- reste", len(file), "(suite au prochain envoi)")
                elif code == 401:
                    print("envoi refuse 401 : TOKEN different de WRITE_TOKEN. File gardee :", len(file))
                elif code == 404:
                    print("envoi refuse 404 : URL du relais fausse ou relais pas a jour. File gardee :", len(file))
                else:
                    print("envoi rate", code, "- file gardee :", len(file), "- nouvel essai dans", ENVOI_N, "min")
                if file or garde:
                    sauver(file); garde = bool(file)
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print("erreur inattendue (le script continue):", e)
        time.sleep(max(5, LECTURE_S - (time.time() - t0)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("arrete.")
