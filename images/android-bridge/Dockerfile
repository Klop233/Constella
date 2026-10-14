# constella-android-bridge: screen, input and control API for one Android instance (Redroid or emulator alike).
# Talks to the device over adb at $ANDROID_ADB; mirrors it with scrcpy into Xvnc (VNC on 5900, same viewer and
# input filtering as the desktop instances) and serves the control API on 8000.
ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}

# Download sources, overridable for mirrors.
ARG GITHUB=https://github.com
ARG SCRCPY_VERSION=5.0.1
ARG SCRCPY_SHA256=9f969d30cc574816077edecda65719c1c70b0aee1df1ba5fa00779ac07b8fd6e
# ADBKeyboard (GPL-2.0): lets adb type any text, Chinese included.
ARG ADBKEYBOARD_PATH=senzhk/ADBKeyBoard/releases/download/v2.4-dev/keyboardservice-debug.apk
ARG ADBKEYBOARD_SHA256=e0d0cf276b710cb34c46121f58720f5285a83ed410b0d45f57a0677b67dc2852

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server x11-utils x11-xserver-utils xclip imagemagick supervisor python3 ca-certificates curl \
      procps tzdata libx11-6 libxext6 libxrandr2 libxcursor1 libxi6 libxfixes3 libxss1 libxinerama1 libxkbcommon0 \
      libudev1 libcap2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -u 1000 -d /home/bridge -s /bin/bash bridge \
 && mkdir -p /opt/constella /opt/scrcpy \
 && curl -fsSL -o /tmp/scrcpy.tgz "$GITHUB/Genymobile/scrcpy/releases/download/v$SCRCPY_VERSION/scrcpy-linux-x86_64-v$SCRCPY_VERSION.tar.gz" \
 && echo "$SCRCPY_SHA256  /tmp/scrcpy.tgz" | sha256sum -c - \
 && tar -xzf /tmp/scrcpy.tgz -C /opt/scrcpy --strip-components=1 && rm /tmp/scrcpy.tgz \
 && ln -s /opt/scrcpy/adb /usr/local/bin/adb && ln -s /opt/scrcpy/scrcpy /usr/local/bin/scrcpy \
 && curl -fsSL -o /opt/constella/ADBKeyboard.apk "$GITHUB/$ADBKEYBOARD_PATH" \
 && echo "$ADBKEYBOARD_SHA256  /opt/constella/ADBKeyboard.apk" | sha256sum -c -

COPY supervisord.conf /etc/supervisor/conf.d/constella.conf
COPY control.py start-scrcpy.sh /opt/constella/
RUN chmod +x /opt/constella/start-scrcpy.sh

ENV DISPLAY=:1 GEOMETRY=720x1280 ANDROID_ADB=localhost:5555 ADB=/opt/scrcpy/adb SCRCPY_SERVER_PATH=/opt/scrcpy/scrcpy-server
EXPOSE 5900 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
