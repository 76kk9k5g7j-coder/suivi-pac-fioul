#!/usr/bin/env bash
# Affiche si le releve tourne, et les dernieres lignes du journal.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=commun.sh
. "$HERE/commun.sh"

echo "Dossier : $PAC_DIR"
if superviseur_vivant; then
  echo "Superviseur : en cours (pid $(pid_superviseur))"
else
  echo "Superviseur : arrete"
fi

py=$(pids_contenant "midea_releve.py")
if [ -n "$py" ]; then
  echo "Releve Python : en cours (pid $py)"
else
  echo "Releve Python : arrete"
fi

if [ -f "$SCRIPT_PY" ]; then
  echo "Script : $SCRIPT_PY"
else
  echo "Script : MANQUANT ($SCRIPT_PY)"
fi

if [ -f "$LOG" ]; then
  echo "Journal : $LOG ($(taille_log) octets)"
  echo "----- dernieres lignes -----"
  tail -n 20 "$LOG"
else
  echo "Journal : pas encore cree"
fi

if command -v termux-job-scheduler >/dev/null 2>&1; then
  echo "----- tache 15 min -----"
  termux-job-scheduler --pending 2>/dev/null || true
fi
