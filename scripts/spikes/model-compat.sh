#!/usr/bin/env bash
# Phase 0 spike: run the same multi-step tool task through Codex + new-api for each model.
# Usage: scripts/spikes/model-compat.sh model1 model2 ...   (reads NEWAPI_API_KEY from deploy/.env)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
set -a; . "$ROOT/deploy/.env"; set +a
OUT=${OUT:-$ROOT/docs/spikes/runs/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"
EXPECTED="0,1,1,2,3,5,8,13,21,34,55,89,144,233,377"
TASK='In the current directory: 1) create fib.py that prints the first 15 Fibonacci numbers starting 0,1 as one comma-separated line without spaces; 2) run it with python3; 3) save exactly its stdout into result.txt; 4) run `cat result.txt` to verify. Then reply with the single word DONE.'

run_one() {
  local model=$1 slug=${1//[\/:]/_}
  local dir="$OUT/$slug"; mkdir -p "$dir"
  cat > "$dir/config.toml" <<TOML
model = "$model"
model_provider = "newapi"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[model_providers.newapi]
name = "new-api"
base_url = "http://host.docker.internal:3333/v1"
env_key = "NEWAPI_API_KEY"
wire_api = "responses"
TOML
  local start=$(date +%s)
  timeout 360 docker run --rm --add-host=host.docker.internal:host-gateway \
    -e NEWAPI_API_KEY -v "$dir/config.toml:/home/agent/.codex/config.toml:ro" -v "$dir/ws:/workspace" \
    --user "$(id -u):$(id -g)" -e HOME=/home/agent \
    constella-agent:dev codex exec --skip-git-repo-check --json "$TASK" < /dev/null > "$dir/events.jsonl" 2> "$dir/stderr.log"
  local rc=$? secs=$(( $(date +%s) - start ))
  local got; got=$(tr -d '[:space:]' < "$dir/ws/result.txt" 2>/dev/null)
  local cmds; cmds=$(grep -c '"command_execution"' "$dir/events.jsonl" 2>/dev/null)
  local verdict=FAIL; [ "$got" = "$EXPECTED" ] && verdict=PASS
  local err; err=$(grep -hoE '"(message|error)":"[^"]{0,160}' "$dir/events.jsonl" "$dir/stderr.log" 2>/dev/null | grep -iE 'error|fail|unsupported|invalid' | head -1)
  printf '%s\t%s\t%ss\trc=%s\tcmd_events=%s\t%s\n' "$model" "$verdict" "$secs" "$rc" "$cmds" "$err" | tee "$dir/summary.tsv"
}
for m in "$@"; do run_one "$m" & done; wait
cat "$OUT"/*/summary.tsv > "$OUT/summary.tsv"; echo "results: $OUT"
