import RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "../components/ui";
import { api, errorMessage } from "./api";

export type VncState = "connecting" | "connected" | "disconnected";

/** Waits before each automatic reconnect after a drop (a proxy hiccup, an instance restarting); then it gives up and asks. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * A view-only VNC connection to an instance, drawn into `screen` while `enabled`.
 * The full instance page and the floating window both use it; callers flip `viewOnly` etc. on `rfb.current`.
 * A dropped connection is retried a few times by itself (waiting while the tab is hidden); `connect()` starts over by hand.
 */
export function useVnc(id: string | undefined, enabled: boolean, screen: RefObject<HTMLDivElement | null>) {
  const rfb = useRef<RFB | null>(null);
  // Bumped on every connect / teardown, so a ticket that arrives late doesn't open a stray connection.
  const gen = useRef(0);
  const alive = useRef(false);
  const attempts = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const cancelWait = useRef<(() => void) | null>(null);
  const [state, setState] = useState<VncState>("connecting");

  const clearRetry = useCallback(() => {
    window.clearTimeout(timer.current);
    cancelWait.current?.();
    cancelWait.current = null;
  }, []);

  const open: () => Promise<void> = useCallback(async () => {
    if (!screen.current || !id) return;
    const mine = ++gen.current;
    clearRetry();
    rfb.current?.disconnect();
    rfb.current = null;
    setState("connecting");

    /** Schedules the next automatic attempt; false when they are used up. */
    const retry = (): boolean => {
      const delay = RETRY_DELAYS_MS[attempts.current];
      if (delay === undefined || !alive.current) return false;
      attempts.current++;
      timer.current = window.setTimeout(() => {
        if (!alive.current || mine !== gen.current) return;
        if (document.visibilityState === "visible") return void open();
        // Hidden tab: reconnect when it comes back instead of holding a connection nobody looks at.
        const on = () => {
          if (document.visibilityState !== "visible") return;
          cancelWait.current?.();
          if (alive.current && mine === gen.current) void open();
        };
        document.addEventListener("visibilitychange", on);
        cancelWait.current = () => document.removeEventListener("visibilitychange", on);
      }, delay);
      return true;
    };

    try {
      const { ticket } = await api.post<{ ticket: string }>(`/api/desktops/${id}/ticket`);
      if (mine !== gen.current || !screen.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(screen.current, `${proto}://${location.host}/api/desktops/${id}/vnc?ticket=${encodeURIComponent(ticket)}`, { shared: true });
      r.scaleViewport = true;
      r.resizeSession = false;
      r.viewOnly = true;
      r.background = "#0b0d18";
      r.addEventListener("connect", () => {
        if (mine !== gen.current) return;
        attempts.current = 0;
        setState("connected");
      });
      r.addEventListener("disconnect", () => {
        if (mine !== gen.current) return;
        // Still "connecting" while attempts remain, so the screen doesn't flash a reconnect button.
        setState(retry() ? "connecting" : "disconnected");
      });
      rfb.current = r;
    } catch (err) {
      if (mine !== gen.current) return;
      if (retry()) return;
      setState("disconnected");
      toast(errorMessage(err), "danger");
    }
  }, [id, screen, clearRetry]);

  /** Connect now, with the automatic attempts counted from zero again. */
  const connect = useCallback(() => {
    attempts.current = 0;
    return open();
  }, [open]);

  useEffect(() => {
    alive.current = enabled;
    if (enabled) void connect();
    return () => {
      alive.current = false;
      gen.current++;
      clearRetry();
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [enabled, connect, clearRetry]);

  return { rfb, state, connect };
}
