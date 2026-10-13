#!/bin/bash
# Minimal Xfce session (no screensaver / power manager / polkit, which lock or prompt on a headless desktop).
for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
xsetroot -solid '#1e2230'
exec dbus-launch --exit-with-session bash -c 'xfsettingsd & xfdesktop & xfce4-panel & exec xfwm4'
