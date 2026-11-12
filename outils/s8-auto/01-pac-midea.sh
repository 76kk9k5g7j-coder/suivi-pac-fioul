#!/data/data/com.termux/files/usr/bin/sh
# Demarre le releve Midea au allumage du telephone (Termux:Boot).
# Ce fichier est installe dans ~/.termux/boot/01-pac-midea.sh

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME="${HOME:-/data/data/com.termux/files/home}"
export PREFIX HOME
export PATH="$PREFIX/bin:$PATH"

PAC_DIR="${PAC_DIR:-$HOME/pac}"
BOOT_SLEEP="${BOOT_SLEEP:-20}"

# En premier, pour empecher Android d'endormir le telephone juste apres le boot.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

# Laisser le wifi se connecter.
sleep "$BOOT_SLEEP"

if [ -x "$PAC_DIR/surveille-midea.sh" ]; then
  "$PREFIX/bin/bash" "$PAC_DIR/surveille-midea.sh"
fi
