#!/usr/bin/env bash
# Spin up a throwaway hub (own data dir, port 8781), run the e2e suites, then remove everything it created.
# Usage: scripts/e2e/run.sh [--keep]
# Test other images than the live ones with HUB_IMAGE=… and CONSTELLA_*_IMAGE=… (e.g. CONSTELLA_DESKTOP_IMAGE);
# ENV_FILE=… points at another deploy/.env (e.g. from a git worktree).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DATA=/srv/constella-test
NAME=constella-hub-test
PORT=8781
HUB_IMAGE=${HUB_IMAGE:-constella-hub:latest}
# Instance images given by the caller win over deploy/.env.
IMAGE_ENV=$(env | grep -E '^CONSTELLA_[A-Z_]*_IMAGE=' || true)
set -a; . "${ENV_FILE:-$ROOT/deploy/.env}"; set +a
IMAGE_ARGS=()
while IFS= read -r kv; do [ -n "$kv" ] && IMAGE_ARGS+=(-e "$kv"); done <<< "$IMAGE_ENV"
CODE=e2e-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')

cleanup() {
  [ "${1:-}" = "--keep" ] && return
  for c in $(docker ps -aq --filter "label=dev.constella.role"); do
    if docker inspect "$c" --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q "$DATA"; then docker rm -f "$c" >/dev/null; fi
  done
  docker rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$DATA"
}
cleanup
mkdir -p "$DATA"
docker run -d --name "$NAME" --network constella-net -p 127.0.0.1:$PORT:8780 \
  --add-host host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA:$DATA" \
  -e CONSTELLA_DATA_DIR="$DATA" -e CONSTELLA_MASTER_KEY="$CONSTELLA_MASTER_KEY" -e CONSTELLA_SETUP_CODE="$CODE" \
  -e CONSTELLA_ORIGINS="http://localhost:$PORT" \
  -e TZ=Asia/Shanghai \
  -e CONSTELLA_HUB_WS="ws://$NAME:8780/api/runner" -e CONSTELLA_HUB_MCP="http://$NAME:8780/mcp" \
  "${IMAGE_ARGS[@]}" "$HUB_IMAGE" >/dev/null
for i in $(seq 1 30); do curl -fs "localhost:$PORT/api/health" >/dev/null && break; sleep 1; done

status=0
# The upstream is configured through the API (any Responses-compatible address); export it in deploy/.env or the shell.
HUB="http://localhost:$PORT" SETUP_CODE="$CODE" DATA_DIR="$DATA" \
  MODEL_BASE_URL="${MODEL_BASE_URL:-}" MODEL_API_KEY="${MODEL_API_KEY:-}" MODEL_NAME="${MODEL_NAME:-${CONSTELLA_DEFAULT_MODEL:-}}" \
  node "$ROOT/scripts/e2e/api-e2e.mjs" || status=$?
if [ $status -eq 0 ]; then
  # Drive the test desktop's Chromium; inside it, localhost:$PORT is forwarded to the test hub (a secure context).
  DESK=$(docker ps -q --filter label=dev.constella.role=desktop | while read -r c; do
    docker inspect "$c" --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -q "$DATA" && echo "$c"; done | head -1)
  if [ -n "$DESK" ]; then
    docker exec -d -u 0 "$DESK" socat TCP-LISTEN:$PORT,fork,reuseaddr TCP:$NAME:8780
    IP=$(docker inspect "$DESK" --format '{{(index .NetworkSettings.Networks "constella-net").IPAddress}}')
    WS=$(curl -fs "http://$IP:9223/json/version" | python3 -c 'import json,sys;print(json.load(sys.stdin)["webSocketDebuggerUrl"])' | sed "s#ws://[^/]*#ws://$IP:9223#")
    HUB="http://localhost:$PORT" CDP="$WS" SHOTS="${SHOTS:-/tmp/constella-ui}" node "$ROOT/apps/web/e2e/ui.e2e.mjs" || status=$?
  else
    echo "no test desktop running; skipping UI walkthrough"; status=1
  fi
fi
[ $status -ne 0 ] && docker logs "$NAME" 2>&1 | tail -40
cleanup "${1:-}"
exit $status
