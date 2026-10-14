import RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "../components/ui";
import { api } from "./api";

export type VncState = "connecting" | "connected" | "disconnected";

/**
 * A view-only VNC connection to an instance, drawn into `screen` while `enabled`.
 * The full instance page and the floating window both use it; callers flip `viewOnly` etc. on `rfb.current`.
 */
export function useVnc(id: string | undefined, enabled: boolean, screen: RefObject<HTMLDivElement | null>) {
  const rfb = useRef<RFB | null>(null);
  // Bumped on every connect / teardown, so a ticket that arrives late doesn't open a stray connection.
  const gen = useRef(0);
  const [state, setState] = useState<VncState>("connecting");

  const connect = useCallback(async () => {
    if (!screen.current || !id) return;
    const mine = ++gen.current;
    rfb.current?.disconnect();
    rfb.current = null;
    setState("connecting");
    try {
      const { ticket } = await api.post<{ ticket: string }>(`/api/desktops/${id}/ticket`);
      if (mine !== gen.current || !screen.current) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(screen.current, `${proto}://${location.host}/api/desktops/${id}/vnc?ticket=${encodeURIComponent(ticket)}`, { shared: true });
      r.scaleViewport = true;
      r.resizeSession = false;
      r.viewOnly = true;
      r.background = "#0b0d18";
      r.addEventListener("connect", () => mine === gen.current && setState("connected"));
      r.addEventListener("disconnect", () => mine === gen.current && setState("disconnected"));
      rfb.current = r;
    } catch (err) {
      if (mine !== gen.current) return;
      setState("disconnected");
      toast(err instanceof Error ? err.message : String(err), "danger");
    }
  }, [id, screen]);

  useEffect(() => {
    if (enabled) void connect();
    return () => {
      gen.current++;
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [enabled, connect]);

  return { rfb, state, connect };
}
