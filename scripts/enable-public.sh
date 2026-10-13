#!/usr/bin/env bash
# Turn on the public entry through Cloudflare Tunnel.
# Usage: scripts/enable-public.sh constella.example.com
# Prompts for the tunnel token without echoing it, stores it in deploy/.env, adds the origin and restarts.
set -euo pipefail
HOST=${1:?usage: enable-public.sh <public hostname>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/deploy/.env"

read -rsp "粘贴 Cloudflare Tunnel token 后回车: " TOKEN; echo
[ -n "$TOKEN" ] || { echo "token 为空"; exit 1; }

python3 -I - "$ENV" "$HOST" "$TOKEN" <<'EOF'
import re, sys
path, host, token = sys.argv[1:]
s = open(path).read()
def setv(s, k, v):
    return re.sub(rf"^{k}=.*$", f"{k}={v}", s, flags=re.M) if re.search(rf"^{k}=", s, re.M) else s + f"\n{k}={v}\n"
s = setv(s, "CLOUDFLARE_TUNNEL_TOKEN", token)
origins = re.search(r"^CONSTELLA_ORIGINS=(.*)$", s, re.M)
items = [o for o in (origins.group(1).split(",") if origins else []) if o]
if f"https://{host}" not in items:
    items.append(f"https://{host}")
s = setv(s, "CONSTELLA_ORIGINS", ",".join(items))
open(path, "w").write(s)
EOF
chmod 600 "$ENV"
cd "$ROOT/deploy"
docker compose up -d hub
docker compose --profile public up -d cloudflared
echo "等待隧道连接…"
for i in $(seq 1 30); do
  if docker logs constella-cloudflared 2>&1 | grep -q "Registered tunnel connection"; then
    echo "隧道已连接：https://$HOST"
    exit 0
  fi
  sleep 2
done
echo "隧道还没连上，查看日志：docker logs constella-cloudflared"
exit 1
