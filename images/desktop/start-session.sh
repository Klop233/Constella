#!/bin/bash
# CONSTELLA_SESSION=xfce (default): a minimal Xfce session (no screensaver / power manager / polkit, which lock or
# prompt on a headless desktop). CONSTELLA_SESSION=browser: just a window manager and Chromium, restarted if closed.
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
xsetroot -solid '#1e2230'
if [ "${CONSTELLA_SESSION:-xfce}" = "browser" ]; then
  exec dbus-launch --exit-with-session bash -c 'xfwm4 --compositor=off & while true; do /opt/constella/chromium.sh >/dev/null 2>&1; sleep 1; done'
fi
exec dbus-launch --exit-with-session bash -c 'xfsettingsd & xfdesktop & xfce4-panel & exec xfwm4'
