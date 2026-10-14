# constella-emulator: the Android SDK emulator, for Android instances on hosts with /dev/kvm (hardware
# virtualization). Google's x86_64 system images (API 30+) translate ARM apps by themselves.
# The SDK and system image are Google's and come under the Android SDK license: building needs
# ACCEPT_ANDROID_SDK_LICENSE=yes, and they are downloaded at build time, never shipped.
#   VARIANT=google_apis            Google APIs, no Play Store
#   VARIANT=google_apis_playstore  with Google Play
# Build through scripts/build-android-images.sh, which tags the variants the hub expects.
ARG BASE_IMAGE=debian:bookworm-slim

FROM ${BASE_IMAGE} AS sdk
ARG ACCEPT_ANDROID_SDK_LICENSE=no
ARG ANDROID_API=34
ARG VARIANT=google_apis
ARG GOOGLE_DL=https://dl.google.com
ARG CMDLINE_TOOLS=commandlinetools-linux-13114758_latest.zip
ARG CMDLINE_TOOLS_SHA256=7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee
RUN test "$ACCEPT_ANDROID_SDK_LICENSE" = yes || { echo "Building this image downloads Google's Android SDK: read its license and pass --build-arg ACCEPT_ANDROID_SDK_LICENSE=yes"; exit 1; }
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN curl -fsSL -o /tmp/tools.zip "$GOOGLE_DL/android/repository/$CMDLINE_TOOLS" \
 && echo "$CMDLINE_TOOLS_SHA256  /tmp/tools.zip" | sha256sum -c - \
 && mkdir -p $ANDROID_SDK_ROOT/cmdline-tools && unzip -q /tmp/tools.zip -d /tmp/t && mv /tmp/t/cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest \
 && yes | $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null \
 && $ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --install emulator platform-tools "system-images;android-$ANDROID_API;$VARIANT;x86_64" >/dev/null \
 && rm -rf $ANDROID_SDK_ROOT/cmdline-tools /tmp/*

FROM ${BASE_IMAGE}
ARG ANDROID_API=34
ARG VARIANT=google_apis
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      socat ca-certificates procps tzdata libc6 libdbus-1-3 libfontconfig1 libgcc-s1 libpulse0 libtinfo6 libx11-6 \
      libxcb1 libxdamage1 libnss3 libxcomposite1 libxcursor1 libxi6 libxext6 libxfixes3 zlib1g libgl1 libxrender1 \
      libxtst6 libxkbfile1 libasound2 libdrm2 libgbm1 libxrandr2 libxkbcommon0 libxshmfence1 libnspr4 libexpat1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=sdk /opt/android-sdk /opt/android-sdk
COPY start-emulator.sh /opt/constella/start-emulator.sh
RUN chmod +x /opt/constella/start-emulator.sh
ENV ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_HOME=/opt/android-sdk ANDROID_AVD_HOME=/data/avd \
    PATH=/opt/android-sdk/emulator:/opt/android-sdk/platform-tools:$PATH \
    ANDROID_API=${ANDROID_API} VARIANT=${VARIANT} WIDTH=720 HEIGHT=1280 DPI=320 MEMORY_MB=3072
# What this image can do; the hub reads these to offer the options.
LABEL dev.constella.android.arm="1" dev.constella.android.variant="${VARIANT}"
EXPOSE 5555
CMD ["/opt/constella/start-emulator.sh"]
