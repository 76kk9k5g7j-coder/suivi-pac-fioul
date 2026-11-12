#!/usr/bin/env bash
# Chien de garde : si le superviseur ne tourne plus, on le relance.
# Appele toutes les 15 min par termux-job-scheduler, et au demarrage.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=commun.sh
. "$HERE/commun.sh"

tourner_log

if superviseur_vivant; then
  exit 0
fi

# Verrou abandonne sans processus : le superviseur le reprendra.
if [ -d "$LOCKDIR" ] && ! superviseur_vivant; then
  log "chien de garde : verrou abandonne, je relance"
  rm -rf "$LOCKDIR"
else
  log "chien de garde : superviseur absent, je relance"
fi

mkdir -p "$PAC_DIR"
if [ ! -x "$SUPERVISEUR" ]; then
  log "chien de garde : $SUPERVISEUR introuvable ou non executable"
  echo "Fichier manquant : $SUPERVISEUR" >&2
  exit 1
fi

# Detache du terminal / de la tache JobScheduler, pour rester en vie ensuite.
nohup bash "$SUPERVISEUR" >/dev/null 2>&1 &
# Laisser le temps au verrou de se poser, pour un second appel tout de suite.
sleep 1
if superviseur_vivant; then
  exit 0
fi
# Petit delai supplementaire au tout premier lancement (lent sur telephone).
sleep 2
if superviseur_vivant; then
  exit 0
fi
log "chien de garde : le superviseur n'a pas demarre"
exit 1
