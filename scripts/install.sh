#!/usr/bin/env bash
# One-click installer and day-to-day manager for Constella.
# Run from any directory: bash scripts/install.sh [install|office|start|stop|restart|status|logs|update|backup|android ...]
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
  set_env_if_empty CONSTELLA_DATA_DIR "/root/constella_data"
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
  sleep 2
  "${COMPOSE[@]}" ps hub
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
    status) "${COMPOSE[@]}" ps; docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^(constella-(hub|agent|desktop|android-bridge)|onlyoffice/documentserver):' || true ;;
    logs) "${COMPOSE[@]}" logs --tail="${2:-200}" -f hub ;;
    update) prepare_env; build_images; start_hub ;;
    backup)
      note "停止 hub 以生成一致的文件备份"
      "${COMPOSE[@]}" stop hub
      data=$(data_dir)
      mkdir -p "$data/backups" "$data/db" "$data/shared" "$data/agents"
      stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
      parts=(db shared agents)
      [ -d "$data/artifacts" ] && parts+=(artifacts)
      if ! tar -czf "$data/backups/constella-manager-${stamp}.tar.gz" -C "$data" "${parts[@]}"; then
        start_hub
        die "备份失败，hub 已重新启动。"
      fi
      start_hub
      echo "备份完成：$data/backups/constella-manager-${stamp}.tar.gz"
      ;;
    android) shift; [ "$#" -gt 0 ] || die "用法：bash scripts/install.sh android redroid|emulator [参数...]"; "$ROOT/scripts/build-android-images.sh" "$@" ;;
    *) die "未知管理命令：$1" ;;
  esac
}

command=${1:-install}
case "$command" in
  install) install_all ;;
  start|stop|restart|status|logs|update|backup|android) manager "$@" ;;
  help|-h|--help)
    cat <<'EOF'
Constella 一键安装 / 管理

  install                 首次安装：生成配置、构建基础镜像、启动 hub
  office                  手动预拉在线 Office 镜像（向导会按需自动拉取）
  start|stop|restart      启停 hub
  status                  查看服务和基础镜像状态
  logs [行数]             查看 hub 日志
  update                  拉取代码后重新构建基础镜像并启动
  backup                  立即生成备份
  android ...             构建安卓镜像，参数透传给 build-android-images.sh

示例：
  bash scripts/install.sh install
  bash scripts/install.sh android redroid --arm --gapps
EOF
    ;;
  *) die "未知命令：$command（用 help 查看用法）" ;;
esac
