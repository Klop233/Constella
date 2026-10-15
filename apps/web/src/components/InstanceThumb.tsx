import { useEffect, useState } from "react";
import { KIND_INFO, hasThumbnail } from "../lib/instances";
import type { Desktop } from "../lib/types";
import { cx } from "./ui";

/** How often a running instance's picture is refreshed (only while the tab is visible). */
const REFRESH_MS = 30_000;

/** Thumbnail of an instance: live while running, the last frame while paused or stopped. */
export function InstanceThumb({ d, width, className }: { d: Desktop; width: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(() => Math.floor(Date.now() / REFRESH_MS));
  const Icon = KIND_INFO[d.kind].icon;

  useEffect(() => {
    if (d.state !== "running") return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") setTick(Math.floor(Date.now() / REFRESH_MS));
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [d.state]);

  // A missing picture (404 while it had none, a hiccup) is tried again when the state or the refresh tick moves on.
  useEffect(() => setFailed(false), [d.state, tick]);

  return (
    // One background class only: `bg-surface-2` is emitted after the arbitrary `bg-[#0b0d18]`
    // in the stylesheet, so passing both would silently drop the dark backdrop for Android.
    <div className={cx("relative grid place-items-center overflow-hidden", d.kind === "android" ? "bg-[#0b0d18]" : "bg-surface-2", className)}>
      {hasThumbnail(d) && !failed ? (
        <img
          src={`/api/desktops/${d.id}/screenshot?width=${width}&t=${d.state === "running" ? tick : d.state}`}
          alt={d.name}
          // Absolutely positioned on purpose: a percentage height can't resolve against a box
          // sized by aspect-ratio, so an in-flow image takes its own ratio and stretches (or
          // gets clipped by) the thumbnail — a portrait Android screen then drags the whole row.
          className={cx("absolute inset-0 w-full h-full", d.kind === "android" ? "object-contain" : "object-cover", d.state !== "running" && "opacity-60 grayscale")}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon className="size-10 text-muted" />
      )}
    </div>
  );
}
