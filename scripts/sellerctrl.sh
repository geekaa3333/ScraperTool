#!/usr/bin/env bash
# SellerCtrl day-to-day control.
#
# One command for everything, so nobody has to remember whether the app is a
# systemd service, a Docker container, or a terminal tab:
#
#   ./scripts/sellerctrl.sh start | stop | restart | status | logs | backup
#
# If the systemd units are not installed this falls back to running the processes
# directly in the background, so the script is useful before setup is complete.
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-4310}"
API_URL="http://127.0.0.1:${PORT}"

API_UNIT=sellerctrl-api.service
WORKER_UNIT=sellerctrl-worker.service

have_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

have_system_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/${API_UNIT}" ]
}

# ---------------------------------------------------------------------------

build() {
  echo "[sellerctrl] building…"
  (cd "$APP_DIR" && npm run build)
}

use_systemd_units() {
  if have_system_systemd; then
    # Stopped without sudo, so this script needs no privileges for the common
    # operations. Only installing the units does.
    systemctl --user stop "$API_UNIT" "$WORKER_UNIT" 2>/dev/null \
      || sudo systemctl stop "$API_UNIT" "$WORKER_UNIT" 2>/dev/null
    return 0
  fi
  return 1
}

wait_for_health() {
  # Up to 30s. The API is only "up" once it answers /api/health, not merely
  # when the port is open — schema application happens during boot.
  for _ in $(seq 1 30); do
    if curl -fsS "${API_URL}/api/health" >/dev/null 2>&1; then
      echo "[sellerctrl] API ready at ${API_URL}"
      return 0
    fi
    sleep 1
  done
  echo "[sellerctrl] API did not become ready in 30s — check: $0 logs"
  return 1
}

start() {
  if have_system_systemd; then
    systemctl --user start "$API_UNIT" "$WORKER_UNIT" 2>/dev/null \
      || sudo systemctl start "$API_UNIT" "$WORKER_UNIT"
    wait_for_health
    return
  fi

  echo "[sellerctrl] systemd units not installed — starting directly"
  build || return 1
  mkdir -p "$APP_DIR/data/logs"

  # nohup + setsid so the processes survive this shell being closed. Without
  # setsid they would receive SIGHUP and die with the terminal.
  ( cd "$APP_DIR" && setsid nohup node dist/server.js >> data/logs/api.log 2>&1 & )
  wait_for_health || return 1
  ( cd "$APP_DIR" && setsid nohup node dist/worker-main.js >> data/logs/worker.log 2>&1 & )
  echo "[sellerctrl] worker started (logs: data/logs/worker.log)"
}

stop() {
  if have_system_systemd; then
    systemctl --user stop "$API_UNIT" "$WORKER_UNIT" 2>/dev/null \
      || sudo systemctl stop "$API_UNIT" "$WORKER_UNIT"
    echo "[sellerctrl] stopped"
    return
  fi
  # SIGTERM, not SIGKILL: the worker finishes the ASIN in flight first.
  pkill -TERM -f "node .*dist/worker-main.js" 2>/dev/null
  pkill -TERM -f "node .*dist/server.js" 2>/dev/null
  sleep 2
  echo "[sellerctrl] stopped"
}

status() {
  echo "=== processes ==="
  if have_system_systemd; then
    systemctl --user status "$API_UNIT" "$WORKER_UNIT" --no-pager 2>/dev/null \
      || sudo systemctl status "$API_UNIT" "$WORKER_UNIT" --no-pager
  else
    pgrep -af "node .*dist/(server|worker-main)\.js" || echo "not running"
  fi

  echo
  echo "=== API health ==="
  curl -fsS "${API_URL}/api/health" 2>/dev/null | head -c 400 || echo "API unreachable at ${API_URL}"
  echo
  echo
  echo "=== queue ==="
  curl -fsS "${API_URL}/api/stats" 2>/dev/null || echo "(unavailable)"
  echo
  echo
  echo "=== free disk ==="
  df -h "$APP_DIR" | tail -1
}

logs() {
  if have_system_systemd; then
    journalctl --user -u "$API_UNIT" -u "$WORKER_UNIT" -n 80 --no-pager 2>/dev/null \
      || sudo journalctl -u "$API_UNIT" -u "$WORKER_UNIT" -n 80 --no-pager
  else
    tail -n 40 "$APP_DIR/data/logs/api.log" 2>/dev/null
    tail -n 40 "$APP_DIR/data/logs/worker.log" 2>/dev/null
  fi
}

case "${1:-status}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    logs ;;
  backup)  "$APP_DIR/scripts/backup-local.sh" ;;
  build)   build ;;
  *) echo "usage: $0 {start|stop|restart|status|logs|backup|build}"; exit 1 ;;
esac