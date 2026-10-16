#!/usr/bin/env bash
# Build the images Android instances run on. Which backend works depends on the host (see README「实例类型与宿主要求」):
#   redroid   needs a kernel with binder and privileged containers that may set kernel parameters
#   emulator  needs /dev/kvm
# Optional parts are proprietary and only downloaded here, on your machine, when you ask for them.
#
# Usage:
#   scripts/build-android-images.sh redroid  [--arm] [--gapps]
#   scripts/build-android-images.sh emulator --accept-android-sdk-license [--playstore] [--api 34]
#   scripts/build-android-images.sh bridge
# Options: --github URL (mirror for github.com downloads), --google URL (mirror for dl.google.com)
# Image names follow the hub's settings (CONSTELLA_*_IMAGE in deploy/.env), so the hub finds what you build.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/deploy/.env" ] && { set -a; . "$ROOT/deploy/.env"; set +a; }
BRIDGE=${CONSTELLA_ANDROID_BRIDGE_IMAGE:-constella-android-bridge:latest}
REDROID=${CONSTELLA_REDROID_IMAGE:-constella-redroid:latest}
REDROID_GAPPS=${CONSTELLA_REDROID_GAPPS_IMAGE:-constella-redroid:gapps}
EMULATOR=${CONSTELLA_EMULATOR_IMAGE:-constella-emulator:latest}
EMULATOR_PLAY=${CONSTELLA_EMULATOR_PLAYSTORE_IMAGE:-constella-emulator:playstore}

what=${1:-}; shift || true
arm=0 gapps=0 play=0 license=no api=34 mirror=()
while [ $# -gt 0 ]; do
  case "$1" in
    --arm) arm=1 ;;
    --gapps) gapps=1 ;;
    --playstore) play=1 ;;
    --accept-android-sdk-license) license=yes ;;
    --api) api=$2; shift ;;
    --github) mirror+=(--build-arg "GITHUB=$2"); shift ;;
    --google) mirror+=(--build-arg "GOOGLE_DL=$2"); shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Host network for the same reason as the compose builds: the host's DNS may be unreachable from a bridge.
build() { echo "==> $1"; docker build --network host -t "$1" "${@:2}"; }
bridge() { build "$BRIDGE" "${mirror[@]}" "$ROOT/images/android-bridge"; }

case "$what" in
  bridge) bridge ;;
  redroid)
    if [ $arm = 1 ] || [ $gapps = 1 ]; then
      echo "注意：ARM 转译（libndk_translation）和 Google 应用（MindTheGapps）是专有软件，只在你本机构建时下载，使用时请自行遵守其许可。"
    fi
    bridge
    build "$REDROID" --build-arg WITH_ARM_TRANSLATION=$arm --build-arg WITH_GAPPS=0 "${mirror[@]}" "$ROOT/images/android-redroid"
    [ $gapps = 1 ] && build "$REDROID_GAPPS" --build-arg WITH_ARM_TRANSLATION=$arm --build-arg WITH_GAPPS=1 "${mirror[@]}" "$ROOT/images/android-redroid"
    ;;
  emulator)
    if [ "$license" != yes ]; then
      echo "模拟器镜像会下载 Google 的 Android SDK 和系统镜像。阅读许可（https://developer.android.com/studio/terms）后加 --accept-android-sdk-license 再运行。" >&2
      exit 1
    fi
    bridge
    common=(--build-arg ACCEPT_ANDROID_SDK_LICENSE=yes --build-arg ANDROID_API="$api" "${mirror[@]}")
    build "$EMULATOR" --build-arg VARIANT=google_apis "${common[@]}" "$ROOT/images/android-emulator"
    [ $play = 1 ] && build "$EMULATOR_PLAY" --build-arg VARIANT=google_apis_playstore "${common[@]}" "$ROOT/images/android-emulator"
    ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
echo "完成。到「设置 → 实例」点「重新检测」，hub 就会用上新镜像。"
