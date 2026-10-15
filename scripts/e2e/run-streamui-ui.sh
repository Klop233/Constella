#!/bin/bash
# Run the streaming-UI browser check against the live hub, driving a desktop container's Chromium over CDP.
# Usage: CONV=cv-… bash /tmp/run-streamui-ui.sh
set -u
WT=/root/constella/.claude/worktrees/intelligent-ui-dsl-4b7e2c
CONV=${CONV:?CONV (conversation id) required}
DESK=$(docker ps --format '{{.Names}}' | grep '^constella-desktop-' | head -1)
if [ -z "$DESK" ]; then
  echo "no desktop container running; starting one"
  curl -s -X POST -H 'X-Constella: 1' -H 'content-type: application/json' \
    -d '{"kind":"browser","name":"ui-check"}' http://127.0.0.1:8790/api/desktops >/dev/null
  sleep 8
  DESK=$(docker ps --format '{{.Names}}' | grep '^constella-desktop-' | head -1)
fi
echo "desktop=$DESK"
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$DESK")
VER=$(curl -s --max-time 8 "http://$IP:9223/json/version" || true)
if [ -z "$VER" ]; then echo "no CDP on $IP:9223"; exit 2; fi
WS=$(printf '%s' "$VER" | python3 -c 'import json,sys; print(json.load(sys.stdin)["webSocketDebuggerUrl"])')
HOSTIP=$(ip -4 addr show docker0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
HOSTIP=${HOSTIP:-172.17.0.1}
echo "cdp=$WS base=http://$HOSTIP:8790"
cd "$WT" || exit 1
ln -sfn "$WT/apps/web/node_modules" "$WT/scripts/e2e/node_modules"
CDP="$WS" BASE="http://$HOSTIP:8790" CONV="$CONV" SHOTS=/tmp/constella-streamui \
  node scripts/e2e/streamui-ui.mjs 2>&1 | tail -30
rm -f "$WT/scripts/e2e/node_modules"
echo "--- shots ---"
ls -la /tmp/constella-streamui 2>/dev/null
