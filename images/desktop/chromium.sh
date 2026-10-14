#!/bin/bash
# The instance's visible Chromium, with CDP on 127.0.0.1:9222 (forwarded to 9223 for the hub). Extra args: URLs.
exec chromium --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check \
  --password-store=basic --test-type --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.config/constella-chromium" --start-maximized "$@"
