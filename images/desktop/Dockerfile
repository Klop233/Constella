# constella-desktop: an Xfce desktop (or, with CONSTELLA_SESSION=browser, just Chromium) an agent or you can drive;
# VNC on 5900, control API on 8000, CDP on 9223.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfce4-terminal dbus-x11 \
      x11-xserver-utils x11-utils xauth xdotool xclip imagemagick chromium socat supervisor python3 \
      fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core locales ca-certificates curl procps tzdata \
 && sed -i 's/# zh_CN.UTF-8/zh_CN.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -d /home/desktop -s /bin/bash desktop

COPY supervisord.conf /etc/supervisor/conf.d/constella.conf
COPY control.py /opt/constella/control.py
COPY start-session.sh chromium.sh /opt/constella/
RUN chmod +x /opt/constella/start-session.sh /opt/constella/chromium.sh

ENV DISPLAY=:1 GEOMETRY=1280x800 CONSTELLA_SESSION=xfce
EXPOSE 5900 8000 9223
HEALTHCHECK --interval=15s --timeout=5s CMD curl -fs http://127.0.0.1:8000/health || exit 1
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
