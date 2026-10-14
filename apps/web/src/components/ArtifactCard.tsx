import { Download } from "lucide-react";
import { artifactMeta, fileUrl, kindIcon, useArtifactPanel } from "../lib/artifacts";
import type { ArtifactKind } from "../lib/types";
import { cx } from "./ui";

export interface DeliveredArtifact {
  artifactId: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  filename: string;
  size: number;
  note?: string;
}

/**
 * A file or document the agent delivered, where it delivered it: opens the viewer at that version, with a
 * download button; images also show a thumbnail. A result, so it stays expanded rather than folding into the steps.
 */
export function ArtifactCard({ item }: { item: DeliveredArtifact }) {
  const { open, openId, version } = useArtifactPanel();
  const Icon = kindIcon(item.kind, item.filename);
  const active = openId === item.artifactId && (version ?? 0) === item.version;
  const show = () => open(item.artifactId, item.version);
  return (
    <div className="max-w-md space-y-1.5">
      {item.kind === "image" && (
        <button onClick={show} className="block rounded-lg border border-line overflow-hidden bg-surface-2" aria-label={`查看图片 ${item.title}`}>
          <img src={fileUrl(item.artifactId, item.version)} alt={item.title} loading="lazy" className="max-h-72 max-w-full object-contain" />
        </button>
      )}
      <div
        className={cx(
          "flex items-center gap-3 pl-2.5 pr-1.5 py-2 rounded-xl border bg-surface transition-colors",
          active ? "border-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]" : "border-line hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]",
        )}
      >
        <button onClick={show} className="flex-1 min-w-0 flex items-center gap-3 text-left">
          <span className="size-9 shrink-0 grid place-items-center rounded-lg bg-surface-2 text-muted">
            <Icon className="size-4" strokeWidth={1.8} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-medium">{item.title}</span>
            <span className="block truncate text-xs text-muted tabular-nums">{[artifactMeta(item), item.note].filter(Boolean).join(" · ")}</span>
          </span>
        </button>
        <a
          href={fileUrl(item.artifactId, item.version, true)}
          download={item.filename}
          aria-label={`下载 ${item.filename}`}
          title="下载"
          className="size-8 shrink-0 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2"
        >
          <Download className="size-4" strokeWidth={1.8} />
        </a>
      </div>
    </div>
  );
}
