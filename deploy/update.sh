#!/usr/bin/env bash
# Pulls the latest main from GitHub and restarts the bot if anything changed.
# Runs as root on the server: every 5 minutes via food-bot-update.timer, or by hand.
set -euo pipefail

APP_DIR=/opt/food-bot
APP_USER=foodbot
cd "$APP_DIR"

as_app() { runuser -u "$APP_USER" -- env HOME="$APP_DIR" "$@"; }

as_app git fetch --quiet origin main
if [ "$(as_app git rev-parse HEAD)" = "$(as_app git rev-parse origin/main)" ]; then
  exit 0
fi

old_lock=$(sha256sum package-lock.json)
as_app git merge --ff-only --quiet origin/main
if [ "$old_lock" != "$(sha256sum package-lock.json)" ]; then
  as_app npm ci --omit=dev --no-audit --no-fund
fi

# Pick up changes to the unit files themselves.
install -m 644 deploy/food-bot.service deploy/food-bot-update.service deploy/food-bot-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart food-bot
echo "Updated to $(as_app git log -1 --format='%h %s')"
