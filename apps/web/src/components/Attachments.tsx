import { IMAGE_EXT, uploadName } from "@constella/protocol";
import { FileText, Loader2, X } from "lucide-react";
import { useState } from "react";
import { cx, Lightbox } from "./ui";

/** Where the app reads a file the owner uploaded to an agent (`/workspace/uploads/…`). */
export function uploadUrl(agentId: string, path: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/uploads/${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
}

/** The files attached to a sent message, above its bubble: images as thumbnails (tap to enlarge), others as download chips. */
export function MessageAttachments({ agentId, paths }: { agentId: string; paths: string[] }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const images = paths.filter((p) => IMAGE_EXT.test(p));
  const files = paths.filter((p) => !IMAGE_EXT.test(p));
  const single = images.length === 1;
  return (
    <>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((p) => (
            <button key={p} onClick={() => setZoom(p)} aria-label={`查看图片 ${uploadName(p)}`} className="block rounded-xl border border-line overflow-hidden bg-surface-2">
              <img src={uploadUrl(agentId, p)} alt={uploadName(p)} loading="lazy" className={single ? "max-h-60 max-w-full object-contain" : "size-24 object-cover"} />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {files.map((p) => (
            <a key={p} href={uploadUrl(agentId, p)} download={uploadName(p)} title={`下载 ${uploadName(p)}`} className="flex items-center gap-2 max-w-60 h-10 pl-1.5 pr-3 rounded-xl border border-line bg-surface hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]">
              <span className="size-7 shrink-0 grid place-items-center rounded-lg bg-surface-2 text-muted">
                <FileText className="size-3.5" strokeWidth={1.8} />
              </span>
              <span className="truncate text-[13px]">{uploadName(p)}</span>
            </a>
          ))}
        </div>
      )}
      <Lightbox src={zoom && uploadUrl(agentId, zoom)} alt={zoom ? uploadName(zoom) : ""} onClose={() => setZoom(null)} />
    </>
  );
}

/** A file waiting in the composer: uploading (no path yet) or ready to send. */
export interface PendingFile {
  key: string;
  name: string;
  image: boolean;
  /** Local object URL for an image's thumbnail. */
  preview?: string;
  path?: string;
}

/** The composer's attachment row: 56px tiles, image thumbnails or a file card, each with a remove button. */
export function ComposerAttachments({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  const [zoom, setZoom] = useState<PendingFile | null>(null);
  return (
    <div className="flex gap-2 px-2.5 pt-3.5 pb-0.5 overflow-x-auto no-scrollbar">
      {files.map((f) => (
        <div key={f.key} className="relative shrink-0 group/att">
          {f.image && f.preview ? (
            <button onClick={() => setZoom(f)} aria-label={`查看图片 ${f.name}`} className="block size-14 rounded-lg border border-line overflow-hidden bg-surface-2">
              <img src={f.preview} alt={f.name} className="size-full object-cover" />
            </button>
          ) : (
            <div className="flex items-center gap-2 h-14 w-44 pl-2 pr-3 rounded-lg border border-line bg-surface-2" title={f.name}>
              <span className="size-8 shrink-0 grid place-items-center rounded-md bg-surface text-muted">
                <FileText className="size-4" strokeWidth={1.8} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{f.name}</span>
                <span className="block truncate text-[11px] text-muted uppercase">{f.path ? (f.name.match(/\.(\w+)$/)?.[1] ?? "文件") : "上传中…"}</span>
              </span>
            </div>
          )}
          {!f.path && f.image && (
            <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/35 text-white">
              <Loader2 className="size-4 animate-spin" />
            </span>
          )}
          <button
            aria-label={`移除 ${f.name}`}
            onClick={() => onRemove(f.key)}
            className={cx("absolute -top-1.5 -right-1.5 size-5 grid place-items-center rounded-full bg-[var(--text)] text-[var(--bg)] shadow", "[@media(pointer:fine)]:opacity-0 group-hover/att:opacity-100 focus-visible:opacity-100 transition-opacity")}
          >
            <X className="size-3" strokeWidth={2.5} />
          </button>
        </div>
      ))}
      <Lightbox src={zoom?.preview ?? null} alt={zoom?.name ?? ""} onClose={() => setZoom(null)} />
    </div>
  );
}
