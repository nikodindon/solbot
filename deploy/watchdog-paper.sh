#!/usr/bin/env bash
# Watchdog du mode paper : moteur en continu + watchlist rafraîchie toutes les 12 h.
#
# Boucle :
#   1. `scan` reconstruit la watchlist (top traded 24 h, filtres config.yaml) ;
#   2. `start --paper --duration 43200` tourne 12 h puis s'arrête proprement ;
#   3. si le moteur meurt avant (crash, coupure réseau…), il est relancé après RETRY_S.
#
# Le redémarrage toutes les 12 h est volontaire : le moteur ne relit la watchlist
# qu'au démarrage, donc c'est ce qui applique le scan. Les positions ouvertes sont
# conservées (base SQLite) et restent gérées même si leur actif sort de la liste
# (le moteur construit son marché avec watchlist ∪ positions).
#
# Arrêt : Ctrl-C dans la session tmux, ou `tmux kill-session -t solbot-continuous`.
# Le kill-switch applicatif `STOP` (commande /kill) coupe les entrées mais ne
# stoppe pas le processus : c'est voulu, les sorties restent gérées.

set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
LOG_DIR="$ROOT/data"
SESSION_LOG="$LOG_DIR/paper-continuous.log"
WATCH_LOG="$LOG_DIR/watchdog.log"
CYCLE_S="${CYCLE_S:-43200}" # 12 h
RETRY_S="${RETRY_S:-30}"

mkdir -p "$LOG_DIR"

log() { printf '%s  %s\n' "$(date -u '+%F %T UTC')" "$*" | tee -a "$WATCH_LOG"; }

# Un seul moteur à la fois : refuse de démarrer si un autre tourne déjà.
if pgrep -f "src/index.ts start" >/dev/null 2>&1; then
  log "un moteur tourne déjà → watchdog non démarré (évite un doublon)"
  exit 1
fi

child=""
cleanup() {
  trap - INT TERM HUP
  if [ -n "$child" ]; then
    log "arrêt demandé → arrêt du moteur"
    kill -TERM "$child" 2>/dev/null || true
    pkill -TERM -f "src/index.ts start" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  log "watchdog terminé"
  exit 0
}
trap cleanup INT TERM HUP

log "watchdog démarré (pid $$) · cycle ${CYCLE_S}s · relance auto ${RETRY_S}s"

while true; do
  log "scan de l'univers (watchlist)"
  npm run --silent solbot -- scan 2>&1 | tee -a "$SESSION_LOG"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    log "scan en échec → on garde la watchlist existante"
  fi

  log "démarrage du moteur paper (durée max ${CYCLE_S}s)"
  npm run --silent solbot -- start --paper --duration "$CYCLE_S" \
    > >(tee -a "$SESSION_LOG") 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""

  log "moteur arrêté (code $code) → relance dans ${RETRY_S}s"
  sleep "$RETRY_S"
done
