import { useState } from "react";
import { KIND_INFO, hasThumbnail } from "../lib/instances";
import type { Desktop } from "../lib/types";
import { cx } from "./ui";

/** Thumbnail of an instance: live while running, the last frame while paused or stopped. */
export function InstanceThumb({ d, width, className }: { d: Desktop; width: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const Icon = KIND_INFO[d.kind].icon;
  const tick = Math.floor(Date.now() / 15000);
  return (
    <div className={cx("bg-surface-2 grid place-items-center overflow-hidden", d.kind === "android" && "bg-[#0b0d18]", className)}>
      {hasThumbnail(d) && !failed ? (
        <img
          src={`/api/desktops/${d.id}/screenshot?width=${width}&t=${d.state === "running" ? tick : d.state}`}
          alt={d.name}
          className={cx("w-full h-full", d.kind === "android" ? "object-contain" : "object-cover", d.state !== "running" && "opacity-60 grayscale")}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon className="size-10 text-muted" />
      )}
    </div>
  );
}
