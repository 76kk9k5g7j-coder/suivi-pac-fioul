# Variables et fonctions communes du redemarrage automatique S8.
# A sourcer, pas a executer. Aucun mot de passe ici.

PAC_DIR="${PAC_DIR:-$HOME/pac}"
LOG="${LOG:-$PAC_DIR/midea.log}"
LOCKDIR="${LOCKDIR:-$PAC_DIR/run/lance.lock}"
MAX_LOG="${MAX_LOG:-262144}"
BACKOFF_START="${BACKOFF_START:-10}"
BACKOFF_MAX="${BACKOFF_MAX:-300}"
STAYED_OK="${STAYED_OK:-120}"
BOOT_SLEEP="${BOOT_SLEEP:-20}"
JOB_ID="${JOB_ID:-121}"
# Utilisees par les scripts qui sourcent ce fichier.
# shellcheck disable=SC2034
SUPERVISEUR="$PAC_DIR/lance-midea.sh"
# shellcheck disable=SC2034
SCRIPT_PY="$PAC_DIR/midea_releve.py"

choisir_python() {
  if [ -n "${PYTHON:-}" ] && command -v "$PYTHON" >/dev/null 2>&1; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
  elif command -v python >/dev/null 2>&1; then
    PYTHON=python
  else
    PYTHON=""
    return 1
  fi
}

ligne_cmd() {
  { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null || true
}

pids_contenant() {
  # Affiche les PID dont la ligne de commande contient le texte donne.
  _aiguille="$1"
  _liste=""
  for _dir in /proc/[0-9]*; do
    [ -f "$_dir/cmdline" ] || continue
    _pid=${_dir#/proc/}
    case "$(ligne_cmd "$_pid")" in
      *"$_aiguille"*) _liste="$_liste $_pid" ;;
    esac
  done
  printf '%s' "${_liste# }"
}

log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

taille_log() {
  if [ -f "$LOG" ]; then
    wc -c < "$LOG" | tr -d '[:space:]'
  else
    printf '0'
  fi
}

tourner_log() {
  # Tronque sur place (meme inode) pour que Python, ouvert en append, continue
  # d'ecrire a la fin du nouveau contenu.
  [ -f "$LOG" ] || return 0
  _sz=$(taille_log)
  if [ "$_sz" -gt "$MAX_LOG" ]; then
    _keep=$((MAX_LOG / 2))
    tail -c "$_keep" "$LOG" > "$LOG.tmp" || return 0
    {
      printf '%s rotation du journal (depassait %s octets, on garde %s)\n' \
        "$(date '+%Y-%m-%d %H:%M:%S')" "$MAX_LOG" "$_keep"
      cat "$LOG.tmp"
    } > "$LOG"
    rm -f "$LOG.tmp"
  fi
}

pid_superviseur() {
  if [ -f "$LOCKDIR/pid" ]; then
    cat "$LOCKDIR/pid" 2>/dev/null || true
  fi
}

superviseur_vivant() {
  _pid=$(pid_superviseur)
  [ -n "$_pid" ] || return 1
  kill -0 "$_pid" 2>/dev/null || return 1
  case "$(ligne_cmd "$_pid")" in
    *lance-midea.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

python_vivant() {
  _p=$(pids_contenant "midea_releve.py")
  [ -n "$_p" ]
}

prendre_verrou() {
  mkdir -p "$(dirname "$LOCKDIR")" || return 1
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ > "$LOCKDIR/pid"
    return 0
  fi
  if superviseur_vivant; then
    return 1
  fi
  # Verrou abandonne (crash, coupure) : on le reprend.
  rm -rf "$LOCKDIR"
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ > "$LOCKDIR/pid"
    return 0
  fi
  return 1
}

lacher_verrou() {
  _pid=$(pid_superviseur)
  if [ -n "$_pid" ] && [ "$_pid" != "$$" ]; then
    return 0
  fi
  rm -rf "$LOCKDIR"
}
