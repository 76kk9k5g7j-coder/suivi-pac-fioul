#!/usr/bin/env bash
# Installe le demarrage automatique du releve Midea. On peut le relancer :
# ca remet les scripts et le chien de garde a jour, sans ecraser midea_releve.py
# s'il est deja en place (tes identifiants restent).

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PAC_DIR="${PAC_DIR:-$HOME/pac}"
# shellcheck source=commun.sh
. "$SRC/commun.sh"

dans_termux=0
case "${PREFIX:-}${HOME:-}" in
  *com.termux*) dans_termux=1 ;;
esac
if [ -d /data/data/com.termux/files ]; then
  dans_termux=1
fi

echo "Installation dans $PAC_DIR"

mkdir -p "$PAC_DIR" "$PAC_DIR/run" "$HOME/.termux/boot"

copier() {
  _src="$1"
  _dest="$2"
  if [ ! -f "$_src" ]; then
    echo "Fichier manquant dans le dossier d'installation : $_src" >&2
    exit 1
  fi
  if [ "$_src" -ef "$_dest" ] 2>/dev/null; then
    return 0
  fi
  cp "$_src" "$_dest"
}

for f in commun.sh lance-midea.sh surveille-midea.sh arrete-midea.sh etat-midea.sh installe-auto.sh desinstalle-auto.sh 01-pac-midea.sh GUIDE-S8-AUTO.md; do
  copier "$SRC/$f" "$PAC_DIR/$f"
done
chmod +x "$PAC_DIR/lance-midea.sh" "$PAC_DIR/surveille-midea.sh" \
  "$PAC_DIR/arrete-midea.sh" "$PAC_DIR/etat-midea.sh" \
  "$PAC_DIR/installe-auto.sh" "$PAC_DIR/desinstalle-auto.sh"

# Script Python : on ne l'ecrase jamais s'il existe deja (identifiants).
if [ -f "$PAC_DIR/midea_releve.py" ]; then
  echo "midea_releve.py est deja dans $PAC_DIR : je le laisse tel quel (tes identifiants restent)."
elif [ -f "$SRC/midea_releve.py" ]; then
  copier "$SRC/midea_releve.py" "$PAC_DIR/midea_releve.py"
  echo "J'ai copie midea_releve.py. Ouvre-le et remplis EMAIL, MDP, URL et TOKEN en haut (les memes que maintenant). Ne les envoie a personne."
else
  echo "Attention : pas de midea_releve.py. Copie le tien dans $PAC_DIR/midea_releve.py avant de lancer."
fi

# Si le script est ailleurs habituel, on le signale (sans le copier par-dessus).
if [ ! -f "$PAC_DIR/midea_releve.py" ]; then
  for autre in "$HOME/midea_releve.py" "$HOME/storage/downloads/midea_releve.py"; do
    if [ -f "$autre" ]; then
      echo "J'ai trouve un script ici : $autre"
      echo "Copie-le avec :  cp \"$autre\" \"$PAC_DIR/midea_releve.py\""
      break
    fi
  done
fi

# Script de boot Termux:Boot (chemin d'interprete Termux, comme dans la doc officielle).
boot="$HOME/.termux/boot/01-pac-midea.sh"
cat > "$boot" << BOOT
#!/data/data/com.termux/files/usr/bin/sh
# Demarre le releve Midea au allumage du telephone (Termux:Boot).
PREFIX="\${PREFIX:-/data/data/com.termux/files/usr}"
HOME="\${HOME:-/data/data/com.termux/files/home}"
export PREFIX HOME
export PATH="\$PREFIX/bin:\$PATH"
PAC_DIR="\${PAC_DIR:-$PAC_DIR}"
BOOT_SLEEP="\${BOOT_SLEEP:-20}"
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi
sleep "\$BOOT_SLEEP"
if [ -x "\$PAC_DIR/surveille-midea.sh" ]; then
  "\$PAC_DIR/surveille-midea.sh"
fi
BOOT
chmod +x "$boot"
echo "Script de demarrage installe : $boot"

# Chien de garde Android (termux-job-scheduler), toutes les 15 min, survit au reboot.
if command -v termux-job-scheduler >/dev/null 2>&1; then
  termux-job-scheduler --cancel --job-id "$JOB_ID" >/dev/null 2>&1 || true
  if termux-job-scheduler \
      --job-id "$JOB_ID" \
      --script "$PAC_DIR/surveille-midea.sh" \
      --period-ms 900000 \
      --persisted true \
      --network none \
      --battery-not-low false \
      --charging false; then
    echo "Chien de garde installe (toutes les 15 min, meme apres un redemarrage)."
  else
    echo "termux-job-scheduler a echoue. Ouvre l'appli Termux:API une fois (meme source que Termux, F-Droid), puis relance : bash $PAC_DIR/installe-auto.sh"
  fi
else
  echo "termux-job-scheduler est introuvable."
  if [ "$dans_termux" -eq 1 ]; then
    echo "Installe Termux:API depuis F-Droid (la meme source que Termux), ouvre-la une fois, puis dans Termux :"
    echo "  pkg install termux-api"
    echo "  bash $PAC_DIR/installe-auto.sh"
  else
    echo "(Normal si tu n'es pas sur le telephone : le chien de garde se mettra en place sur le S8.)"
  fi
fi

# Controles utiles, sans faire echouer l'install.
if choisir_python; then
  echo "Python trouve : $PYTHON"
  if "$PYTHON" -c "import midealocal" 2>/dev/null; then
    echo "Le module midea-local est installe."
  else
    echo "Le module midea-local n'est pas visible. S'il manque : pip install midea-local"
  fi
else
  echo "Python introuvable. Dans Termux : pkg install python"
fi

# Demarre maintenant, sauf si on l'a demande autrement.
if [ "${PAC_NE_PAS_DEMARRER:-}" = "1" ]; then
  echo "Je n'ai pas demarre le releve (PAC_NE_PAS_DEMARRER=1)."
else
  if "$PAC_DIR/surveille-midea.sh"; then
    echo "Le releve tourne. Pour verifier : bash $PAC_DIR/etat-midea.sh"
  else
    echo "Le releve n'a pas demarre. Regarde le journal : tail -30 $PAC_DIR/midea.log"
    exit 1
  fi
fi

echo "Installation terminee."
echo "Il reste les reglages Android (batterie) et d'ouvrir Termux:Boot une fois : tout est dans $PAC_DIR/GUIDE-S8-AUTO.md"
