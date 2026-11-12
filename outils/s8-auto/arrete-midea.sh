#!/usr/bin/env bash
# Arrete le superviseur et le releve, sans enlever le demarrage automatique.
# Au prochain allumage (ou dans les 15 min), il peut repartir tout seul.
# Pour l'arreter pour de bon : bash ~/pac/desinstalle-auto.sh

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=commun.sh
. "$HERE/commun.sh"

pid=$(pid_superviseur)
if superviseur_vivant; then
  log "arret manuel du superviseur (pid $pid)"
  kill "$pid" 2>/dev/null || true
  # Attendre que le piege du superviseur nettoie (python + verrou).
  i=0
  while [ "$i" -lt 20 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
else
  echo "Le superviseur ne tourne pas."
fi

# Nettoyer un python encore la (cas orphelin).
for p in $(pids_contenant "midea_releve.py"); do
  log "arret du python orphelin (pid $p)"
  kill "$p" 2>/dev/null || true
  sleep 0.3
  kill -9 "$p" 2>/dev/null || true
done

rm -rf "$LOCKDIR"

if command -v termux-wake-unlock >/dev/null 2>&1; then
  termux-wake-unlock 2>/dev/null || true
fi

echo "Releve arrete. Pour le relancer : bash $PAC_DIR/surveille-midea.sh"
