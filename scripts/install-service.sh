#!/usr/bin/env bash
# Install the SellerCtrl systemd services.
#
# WHAT THIS DOES NOT DO
# ---------------------
# It does not enable the services at boot. Starting software automatically on
# every login is a separate decision, and bundling it into an installer is how
# that decision gets made by accident. It is printed as the next step instead.
#
# It needs sudo once, because the unit files belong in /etc/systemd/system.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$APP_DIR/deploy/systemd"
UNIT_DIR="/etc/systemd/system"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not available on this system."
  echo "Use ./scripts/sellerctrl.sh instead — it runs both processes directly."
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs sudo to install system units:"
  echo "  sudo $0"
  exit 1
fi

echo "[install] project directory: $APP_DIR"

if [ ! -f "$APP_DIR/dist/server.js" ] || [ ! -f "$APP_DIR/dist/worker-main.js" ]; then
  echo "[install] building first — the services run the compiled output"
  (cd "$APP_DIR" && npm run build)
fi

# The unit files hardcode this path in WorkingDirectory. If the project lives
# somewhere else, fix them now rather than having the service fail to start
# with a confusing error later.
if [ ! -d "$APP_DIR" ]; then
  echo "[install] project directory not found: $APP_DIR" >&2
  exit 1
fi

echo "[install] copying units to $UNIT_DIR"
install -m 0644 "$UNIT_SRC/sellerctrl-api.service" "$UNIT_DIR/sellerctrl-api.service"
install -m 0644 "$UNIT_SRC/sellerctrl-worker.service" "$UNIT_DIR/sellerctrl-worker.service"

systemctl daemon-reload
echo "[install] reloaded systemd"

cat <<'NEXT'

Installed. Nothing has been started yet.

  Start now, this session only:
      sudo systemctl start sellerctrl-api sellerctrl-worker

  Also start automatically at boot:
      sudo systemctl enable --now sellerctrl-api sellerctrl-worker

  Check:
      systemctl status sellerctrl-api sellerctrl-worker
      curl -fsS http://127.0.0.1:4310/api/health

  Live worker log:
      journalctl -u sellerctrl-worker -f

NEXT