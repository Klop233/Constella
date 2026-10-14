#!/usr/bin/env bash
# Turn on the public entry through a Cloudflare Tunnel managed from this server.
# Usage: scripts/enable-public.sh constella.example.com
# First run asks you to open a Cloudflare authorization link and pick the domain.
# Set CF_PROXY (e.g. http://127.0.0.1:7890) if Cloudflare's API needs a proxy from here.
set -euo pipefail
HOST=${1:?usage: enable-public.sh <public hostname>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV="$ROOT/deploy/.env"
DIR=/srv/constella/cloudflared
NAME=constella
if [ -n "${CF_PROXY:-}" ]; then export HTTPS_PROXY=$CF_PROXY HTTP_PROXY=$CF_PROXY; fi
command -v cloudflared >/dev/null || { echo "需要先在这台机器上安装 cloudflared"; exit 1; }

[ -f ~/.cloudflared/cert.pem ] || cloudflared tunnel login
ID=$(cloudflared tunnel list -o json 2>/dev/null | python3 -c "import json,sys;print(next((t['id'] for t in json.load(sys.stdin) if t['name']=='$NAME'),''))")
[ -n "$ID" ] || ID=$(cloudflared tunnel create "$NAME" | grep -oE '[0-9a-f-]{36}' | tail -1)
cloudflared tunnel route dns "$NAME" "$HOST" || true

mkdir -p "$DIR"
cp ~/.cloudflared/"$ID".json "$DIR/creds.json"
cat > "$DIR/config.yml" <<EOF
tunnel: $ID
credentials-file: /etc/cloudflared/creds.json
ingress:
  - hostname: $HOST
    service: http://constella-hub:8780
  - service: http_status:404
EOF
chmod 644 "$DIR"/*

python3 -I - "$ENV" "$HOST" <<'EOF'
import re, sys
path, host = sys.argv[1:]
s = open(path).read()
m = re.search(r"^CONSTELLA_ORIGINS=(.*)$", s, re.M)
items = [o for o in (m.group(1).split(",") if m else []) if o]
if f"https://{host}" not in items:
    items.append(f"https://{host}")
s = re.sub(r"^CONSTELLA_ORIGINS=.*$", "CONSTELLA_ORIGINS=" + ",".join(items), s, flags=re.M) if m else s + f"\nCONSTELLA_ORIGINS=https://{host}\n"
open(path, "w").write(s)
EOF
chmod 600 "$ENV"

cd "$ROOT/deploy"
docker compose up -d hub
docker compose --profile public up -d cloudflared
for i in $(seq 1 30); do
  curl -fs "https://$HOST/api/health" >/dev/null && { echo "公网入口可用：https://$HOST"; exit 0; }
  sleep 2
done
echo "还没通，查看日志：docker logs constella-cloudflared"; exit 1
