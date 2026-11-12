#!/usr/bin/env bash
# Superviseur : garde le releve Midea en marche, le relance s'il plante.
# Usage : lance-midea.sh   (reste au premier plan ; surveille-midea.sh le lance en fond)

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=commun.sh
. "$HERE/commun.sh"

export PYTHONUNBUFFERED=1
export PAC_FILE_ATTENTE="${PAC_FILE_ATTENTE:-$PAC_DIR/pac_file_attente.json}"

enfant=""
sortie_propre=0

nettoyer() {
  if [ -n "${enfant:-}" ]; then
    kill "$enfant" 2>/dev/null || true
    wait "$enfant" 2>/dev/null || true
    enfant=""
  fi
  lacher_verrou
  if [ "$sortie_propre" -eq 1 ]; then
    if command -v termux-wake-unlock >/dev/null 2>&1; then
      termux-wake-unlock 2>/dev/null || true
    fi
  fi
}

demander_arret() {
  sortie_propre=1
  log "arret demande, j'arrete le releve."
  nettoyer
  exit 0
}

trap demander_arret INT TERM

if ! prendre_verrou; then
  autre=$(pid_superviseur)
  echo "Deja en cours (pid ${autre:-?}). Rien a faire."
  log "lancement ignore : superviseur deja en cours (pid ${autre:-?})"
  exit 0
fi

mkdir -p "$PAC_DIR"
cd "$PAC_DIR" || {
  echo "Impossible d'ouvrir $PAC_DIR" >&2
  lacher_verrou
  exit 1
}

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>/dev/null || log "termux-wake-lock a echoue (je continue)"
else
  log "termux-wake-lock introuvable : le telephone pourra endormir Termux"
fi

if [ ! -f "$SCRIPT_PY" ]; then
  log "fichier manquant : $SCRIPT_PY"
  echo "Fichier manquant : $SCRIPT_PY" >&2
  sortie_propre=1
  nettoyer
  exit 1
fi

if ! choisir_python; then
  log "python introuvable"
  echo "Python introuvable. Dans Termux : pkg install python" >&2
  sortie_propre=1
  nettoyer
  exit 1
fi

tourner_log
log "superviseur demarre (pid $$), script $SCRIPT_PY, python $PYTHON"

attente="$BACKOFF_START"

while true; do
  tourner_log

  # Si un ancien python tourne encore (superviseur tue sans tuer l'enfant),
  # on n'en lance pas un deuxieme : on attend qu'il se termine.
  orphelins=$(pids_contenant "midea_releve.py")
  if [ -n "$orphelins" ]; then
    log "python deja en cours (pid $orphelins), j'attends au lieu d'en lancer un autre"
    # shellcheck disable=SC2086
    while [ -n "$(pids_contenant "midea_releve.py")" ]; do
      sleep 5
    done
    log "l'ancien python s'est termine, je reprends"
    attente="$BACKOFF_START"
  fi

  debut=$(date +%s)
  log "demarrage du releve"
  "$PYTHON" "$SCRIPT_PY" >> "$LOG" 2>&1 &
  enfant=$!
  wait "$enfant"
  code=$?
  enfant=""
  duree=$(( $(date +%s) - debut ))

  # 0 / 130 (Ctrl+C) / 143 (SIGTERM) : arret volontaire
  if [ "$code" -eq 0 ] || [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    log "releve arrete proprement (code $code, ${duree}s)"
    sortie_propre=1
    nettoyer
    exit 0
  fi

  if [ "$duree" -ge "$STAYED_OK" ]; then
    attente="$BACKOFF_START"
  fi

  log "releve interrompu (code $code, ${duree}s), relance dans ${attente}s"
  sleep "$attente" &
  enfant=$!
  wait "$enfant" || true
  enfant=""

  attente=$(( attente * 2 ))
  if [ "$attente" -gt "$BACKOFF_MAX" ]; then
    attente="$BACKOFF_MAX"
  fi
done
