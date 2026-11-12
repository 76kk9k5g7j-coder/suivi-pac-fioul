#!/usr/bin/env bash
# Enleve le demarrage automatique. Le script Python, la file d'attente et le
# journal restent dans ~/pac (rien n'est perdu).

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PAC_DIR="${PAC_DIR:-$HOME/pac}"
# shellcheck source=commun.sh
. "$SRC/commun.sh"

echo "Desinstallation du demarrage automatique..."

if [ -x "$PAC_DIR/arrete-midea.sh" ]; then
  "$PAC_DIR/arrete-midea.sh" || true
elif [ -x "$SRC/arrete-midea.sh" ]; then
  "$SRC/arrete-midea.sh" || true
fi

if command -v termux-job-scheduler >/dev/null 2>&1; then
  termux-job-scheduler --cancel --job-id "$JOB_ID" >/dev/null 2>&1 || true
  echo "Chien de garde (tache 15 min) annule."
fi

boot="$HOME/.termux/boot/01-pac-midea.sh"
if [ -f "$boot" ]; then
  rm -f "$boot"
  echo "Script de demarrage supprime : $boot"
fi

# Pas de cron installe par defaut ; on nettoie une eventuelle ancienne ligne.
if command -v crontab >/dev/null 2>&1; then
  if crontab -l 2>/dev/null | grep -q 'pac-midea-watchdog'; then
    crontab -l 2>/dev/null | grep -v 'pac-midea-watchdog' | crontab - || true
    echo "Ancienne ligne cron retiree."
  fi
fi

echo "C'est fait. $PAC_DIR/midea_releve.py, le journal et la file d'attente sont toujours la."
echo "Pour relancer a la main : python $PAC_DIR/midea_releve.py"
echo "Pour tout remettre en automatique : bash $PAC_DIR/installe-auto.sh"
