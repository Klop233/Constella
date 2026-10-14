#!/bin/bash
# Mirror the device into the whole X screen once it has booted; supervisord restarts this when the device goes away.
set -u
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
xsetroot -solid '#0b0d18'
until curl -fs http://127.0.0.1:8000/health >/dev/null; do sleep 2; done
W=${GEOMETRY%x*}
H=${GEOMETRY#*x}
exec scrcpy -s "$ANDROID_ADB" --no-audio --window-borderless --window-x=0 --window-y=0 \
  --window-width="$W" --window-height="$H" --render-driver=software --max-fps=30 --video-bit-rate=4M \
  --keyboard=sdk --mouse=sdk --disable-screensaver --no-window-aspect-ratio-lock 2>&1
