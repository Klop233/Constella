#!/bin/bash
# Boot the instance's virtual device (created on first start) and expose its adb on 5555 for the bridge.
set -eu
AVD=/data/avd/constella.avd
mkdir -p "$AVD" "$HOME/.android"
# The bridge uses the same key (shared mount); the emulator authorizes the key in ~/.android on boot.
[ -f "$HOME/.android/adbkey" ] || adb keygen "$HOME/.android/adbkey" >/dev/null 2>&1
chown 1000:1000 "$HOME/.android"/adbkey* 2>/dev/null || true

if [ ! -f /data/avd/constella.ini ]; then
  printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-%s\n' "$AVD" "$ANDROID_API" > /data/avd/constella.ini
  : > "$AVD/config.ini"
fi
cfg="$AVD/config.ini"
set_cfg() { if grep -q "^$1=" "$cfg"; then sed -i "s|^$1=.*|$1=$2|" "$cfg"; else echo "$1=$2" >> "$cfg"; fi; }
# Applied on every boot, so the instance's options (screen size, density) take effect after a restart.
set_cfg AvdId constella
set_cfg avd.ini.displayname constella
set_cfg abi.type x86_64
set_cfg hw.cpu.arch x86_64
set_cfg image.sysdir.1 "system-images/android-$ANDROID_API/$VARIANT/x86_64/"
set_cfg tag.id "$VARIANT"
set_cfg PlayStore.enabled "$([ "$VARIANT" = google_apis_playstore ] && echo true || echo false)"
set_cfg hw.lcd.width "$WIDTH"
set_cfg hw.lcd.height "$HEIGHT"
set_cfg hw.lcd.density "$DPI"
set_cfg hw.ramSize "$MEMORY_MB"
set_cfg hw.keyboard yes
set_cfg hw.gpu.enabled yes
set_cfg hw.gpu.mode swiftshader_indirect
set_cfg disk.dataPartition.size 8G
set_cfg fastboot.forceColdBoot yes

# The emulator's adbd listens on 127.0.0.1:5557; the bridge reaches it on this container's 5555.
socat TCP-LISTEN:5555,fork,reuseaddr TCP:127.0.0.1:5557 &
exec emulator -avd constella -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect \
  -ports 5556,5557 -memory "$MEMORY_MB" -accel on
