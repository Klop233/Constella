# constella-redroid: Android running directly in a container (Redroid), for Android instances on hosts whose kernel
# has binder. Optional, proprietary parts are only downloaded when you build with them (they are never shipped):
#   WITH_ARM_TRANSLATION=1  libndk_translation, so ARM-only apps run on x86_64
#   WITH_GAPPS=1            MindTheGapps (Google Play services and store)
# Build through scripts/build-android-images.sh, which tags the variants the hub expects.
ARG REDROID_IMAGE=redroid/redroid:13.0.0-latest

FROM debian:bookworm-slim AS extras
ARG WITH_ARM_TRANSLATION=0
ARG WITH_GAPPS=0
ARG GITHUB=https://github.com
ARG NDK_PATH=supremegamers/vendor_google_proprietary_ndk_translation-prebuilt/archive/9324a8914b649b885dad6f2bfd14a67e5d1520bf.zip
ARG NDK_SHA256=87089b896ce6fed313dd5c2dd1bf22db857621c27e04471aadda69a1a2795fa1
ARG GAPPS_PATH=MindTheGapps/13.0.0-x86_64/releases/download/MindTheGapps-13.0.0-x86_64-20231025_201203/MindTheGapps-13.0.0-x86_64-20231025_201203.zip
ARG GAPPS_SHA256=2076179bcb6f30e78853d52cf70a4bd1d27502c3852332195e5356816cddfdd9
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /out/system /tmp/x
RUN if [ "$WITH_ARM_TRANSLATION" = 1 ]; then \
      curl -fsSL -o /tmp/ndk.zip "$GITHUB/$NDK_PATH" && echo "$NDK_SHA256  /tmp/ndk.zip" | sha256sum -c - \
      && unzip -q /tmp/ndk.zip -d /tmp/x/ndk && cp -a /tmp/x/ndk/*/prebuilts/. /out/system/ \
      && chmod 0644 /out/system/etc/init/ndk_translation.rc; \
    fi
RUN if [ "$WITH_GAPPS" = 1 ]; then \
      curl -fsSL -o /tmp/gapps.zip "$GITHUB/$GAPPS_PATH" && echo "$GAPPS_SHA256  /tmp/gapps.zip" | sha256sum -c - \
      && unzip -q /tmp/gapps.zip 'system/*' -d /tmp/x/gapps && cp -a /tmp/x/gapps/system/. /out/system/; \
    fi

FROM ${REDROID_IMAGE}
ARG WITH_ARM_TRANSLATION=0
ARG WITH_GAPPS=0
COPY --from=extras /out/ /
# What this image can do; the hub reads these to offer the options.
LABEL dev.constella.android.arm="${WITH_ARM_TRANSLATION}" dev.constella.android.gapps="${WITH_GAPPS}"
