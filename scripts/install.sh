#!/usr/bin/env bash
# One-click installer and day-to-day manager for Constella.
# Run from any directory: bash scripts/install.sh [install|office|start|stop|restart|status|logs|update|backup|restore|reset-password|android ...]
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
COMPOSE=(docker compose -f "$DEPLOY/docker-compose.yml" --env-file "$ENV_FILE")

die() { echo "错误：$*" >&2; exit 1; }
note() { echo "==> $*"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "没有找到 Docker，请先安装 Docker Engine。"
  docker compose version >/dev/null 2>&1 || die "没有找到 docker compose 插件，请安装 Docker Compose v2。"
  docker info >/dev/null 2>&1 || die "Docker 服务未运行，或当前用户没有访问 Docker 的权限。"
}

set_env_if_empty() {
  local key=$1 value=$2 escaped
  escaped=$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')
  if grep -q "^${key}=" "$ENV_FILE"; then
    if grep -q "^${key}=$" "$ENV_FILE"; then
      sed -i "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
    fi
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

data_dir() {
  awk -F= '$1 == "CONSTELLA_DATA_DIR" {print substr($0, index($0, "=") + 1); found=1} END {if (!found) print "/srv/constella"}' "$ENV_FILE"
}

prepare_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$DEPLOY/.env.example" "$ENV_FILE"
    note "已创建 $ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  command -v openssl >/dev/null 2>&1 || die "安装阶段需要 openssl 来生成加密密钥。"
  set_env_if_empty CONSTELLA_MASTER_KEY "$(openssl rand -base64 32 | tr -d '\n')"
  set_env_if_empty CONSTELLA_DATA_DIR "/srv/constella"
  mkdir -p "$(data_dir)"
  # The template contains a documentation placeholder. Localhost is a safe first-run default; a public URL can
  # be added later in deploy/.env before enabling Cloudflare/Tailscale access.
  if grep -q '^CONSTELLA_ORIGINS=https://your-machine\.your-tailnet\.ts\.net' "$ENV_FILE"; then
    sed -i 's|^CONSTELLA_ORIGINS=.*|CONSTELLA_ORIGINS=http://localhost:8780|' "$ENV_FILE"
  fi
}

build_images() {
  note "构建 hub、agent、浏览器/桌面和 Android 桥接镜像"
  "${COMPOSE[@]}" --profile images build hub agent-image desktop-image android-bridge-image
}

pull_office() {
  note "预拉在线 Office 镜像（OnlyOffice，约 3 GB）"
  "${COMPOSE[@]}" --profile images pull office-image
}

start_hub() {
  note "启动 Constella hub"
  "${COMPOSE[@]}" up -d hub
  wait_healthy
  "${COMPOSE[@]}" ps hub
}

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fs http://127.0.0.1:8780/api/health >/dev/null 2>&1; then
      note "hub 已就绪"
      return 0
    fi
    sleep 1
  done
  echo "hub 60 秒内没有就绪，看看日志：bash scripts/install.sh logs" >&2
}

update_code() {
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
    die "仓库里有未提交的改动，先提交或撤销后再更新（git -C $ROOT status 查看）"
  fi
  note "拉取最新代码"
  git -C "$ROOT" pull --ff-only || die "git pull 失败：本地分支和远端分叉了，请手动处理"
}

backup_now() {
  note "停止 hub 以生成一致的文件备份"
  "${COMPOSE[@]}" stop hub
  local data stamp parts out
  data=$(data_dir)
  mkdir -p "$data/backups" "$data/db" "$data/shared" "$data/agents"
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  parts=(db shared agents)
  [ -d "$data/artifacts" ] && parts+=(artifacts)
  # Not "constella-…": the daily backups rotate by that prefix and would delete it.
  out="$data/backups/manual-constella-${stamp}.tar.gz"
  if ! tar -czf "$out" -C "$data" "${parts[@]}"; then
    start_hub
    die "备份失败，hub 已重新启动。"
  fi
  start_hub
  echo "备份完成：$out"
}

restore_backup() {
  local file=${1:-} data tmp db stamp aside ok dir rel
  data=$(data_dir)
  [ -n "$file" ] || die "用法：bash scripts/install.sh restore <备份文件>（备份在 $data/backups）"
  if [ ! -f "$file" ] && [ -f "$data/backups/$file" ]; then file="$data/backups/$file"; fi
  [ -f "$file" ] || die "找不到备份文件：$file"
  tmp=$(mktemp -d)
  if ! tar -xzf "$file" -C "$tmp"; then
    rm -rf "$tmp"
    die "解不开这个备份文件"
  fi
  # Daily backups hold backups/db-<time>.sqlite; manual ones the database directory itself.
  db=$(find "$tmp/backups" -maxdepth 1 -name 'db-*.sqlite' 2>/dev/null | head -n 1 || true)
  [ -n "$db" ] || db="$tmp/db/constella.db"
  if [ ! -f "$db" ]; then
    rm -rf "$tmp"
    die "备份里没有数据库"
  fi
  echo "将用 $(basename "$file") 恢复 $data 里的数据库、记忆和技能、成果文件。"
  echo "数据库里的密钥用 CONSTELLA_MASTER_KEY 加密，$ENV_FILE 里必须还是备份时的那个主密钥。"
  read -r -p "确认恢复？输入 yes 继续：" ok
  if [ "$ok" != "yes" ]; then
    rm -rf "$tmp"
    die "已取消"
  fi

  note "停止 hub"
  "${COMPOSE[@]}" stop hub
  stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
  aside="$data/backups/before-restore-$stamp"
  mkdir -p "$aside" "$data/db"
  # What gets replaced is moved aside first, so a wrong restore can be undone by hand.
  for f in constella.db constella.db-wal constella.db-shm; do
    [ -f "$data/db/$f" ] && mv "$data/db/$f" "$aside/$f"
  done
  cp "$db" "$data/db/constella.db"
  for dir in shared artifacts; do
    [ -d "$tmp/$dir" ] || continue
    [ -d "$data/$dir" ] && mv "$data/$dir" "$aside/$dir"
    cp -a "$tmp/$dir" "$data/$dir"
  done
  if [ -d "$tmp/agents" ]; then
    # Knowledge repos are replaced whole; anything else of an agent (its workspace) is only added to.
    while IFS= read -r dir; do
      rel=${dir#"$tmp/"}
      if [ -d "$data/$rel" ]; then
        mkdir -p "$aside/$(dirname "$rel")"
        mv "$data/$rel" "$aside/$rel"
      fi
    done < <(find "$tmp/agents" -mindepth 3 -maxdepth 3 -type d -path '*/home/knowledge')
    mkdir -p "$data/agents"
    cp -a "$tmp/agents/." "$data/agents/"
  fi
  rm -rf "$tmp"
  start_hub
  echo "恢复完成。被替换下来的旧数据在 $aside，确认没问题后可以删掉。"
}

reset_password() {
  local flag="" p1 p2
  if [ "${1:-}" = "--disable-totp" ]; then flag="--disable-totp"; fi
  "${COMPOSE[@]}" ps --status running hub 2>/dev/null | grep -q constella-hub || die "hub 没在运行，先执行：bash scripts/install.sh start"
  read -r -s -p "新密码（至少 10 位）：" p1
  echo
  read -r -s -p "再输一遍：" p2
  echo
  [ "$p1" = "$p2" ] || die "两次输入的不一样"
  printf '%s' "$p1" | "${COMPOSE[@]}" exec -T hub node src/cli.ts reset-password $flag
}

install_all() {
  require_docker
  prepare_env
  build_images
  start_hub
  local code
  code=$(awk -F= '$1 == "CONSTELLA_SETUP_CODE" {print substr($0, index($0, "=") + 1)}' "$ENV_FILE")
  cat <<EOF

安装完成。浏览器打开：http://127.0.0.1:8780
EOF
  if [ -n "$code" ]; then
    echo "首次创建账号需要初始化码：$code"
  else
    echo "初始化码默认关闭：第一次打开网页直接创建账号。"
    echo "需要启用时，在 $ENV_FILE 设置 CONSTELLA_SETUP_CODE 后重启 hub。"
  fi
  cat <<EOF
远程访问前，请在 $ENV_FILE 中设置 CONSTELLA_ORIGINS，然后配置 HTTPS 入口。
首次登录后的浏览器向导会询问实例和 Office 组件；勾选 Office 后才会下载约 3 GB 的镜像。
EOF
}

need_env() {
  [ -f "$ENV_FILE" ] || die "还没有 $ENV_FILE，请先运行：bash scripts/install.sh install"
}

manager() {
  require_docker
  need_env
  case "$1" in
    start) start_hub ;;
    office) pull_office ;;
    stop) note "停止 Constella hub"; "${COMPOSE[@]}" stop hub ;;
    restart) note "重启 Constella hub"; "${COMPOSE[@]}" restart hub ;;
    status)
      "${COMPOSE[@]}" ps
      docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^(constella-(hub|agent|desktop|android-bridge)|onlyoffice/documentserver):' || true
      echo "数据目录：$(data_dir)"
      if curl -fs http://127.0.0.1:8780/api/health >/dev/null 2>&1; then echo "健康检查：正常"; else echo "健康检查：没有响应"; fi
      ;;
    logs) "${COMPOSE[@]}" logs --tail="${2:-200}" -f hub ;;
    update)
      update_code
      prepare_env
      build_images
      note "重启 hub：正在进行的任务会被打断，开了「中断后自动继续」的会自己接上"
      start_hub
      ;;
    backup) backup_now ;;
    restore) shift; restore_backup "$@" ;;
    reset-password) shift; reset_password "$@" ;;
    android) shift; [ "$#" -gt 0 ] || die "用法：bash scripts/install.sh android redroid|emulator [参数...]"; "$ROOT/scripts/build-android-images.sh" "$@" ;;
    *) die "未知管理命令：$1" ;;
  esac
}

command=${1:-install}
case "$command" in
  install) install_all ;;
  start|stop|restart|status|logs|update|backup|restore|reset-password|android) manager "$@" ;;
  help|-h|--help)
    cat <<'EOF'
Constella 一键安装 / 管理

  install                 首次安装：生成配置、构建基础镜像、启动 hub
  office                  手动预拉在线 Office 镜像（向导会按需自动拉取）
  start|stop|restart      启停 hub
  status                  查看服务、镜像、数据目录和健康状态
  logs [行数]             查看 hub 日志
  update                  拉取最新代码（git pull），重新构建镜像并重启
  backup                  立即生成备份（manual-constella-<时间>.tar.gz，不会被每日备份轮换删掉）
  restore <备份文件>      从备份恢复；被替换的旧数据先挪到 backups/before-restore-<时间>
  reset-password [--disable-totp]
                          忘了密码时重置，所有设备退出登录；加 --disable-totp 同时关闭两步验证
  android ...             构建安卓镜像，参数透传给 build-android-images.sh

示例：
  bash scripts/install.sh install
  bash scripts/install.sh restore constella-2026-10-16T03-30-00-000Z.tar.gz
  bash scripts/install.sh android redroid --arm --gapps
EOF
    ;;
  *) die "未知命令：$command（用 help 查看用法）" ;;
esac
