import type { ArtifactKind } from "@constella/protocol";
import { File, FileArchive, FileCode, FileText, FileType, Film, Globe, Image, Music, Shapes, Sheet, type LucideIcon } from "lucide-react";
import { useCallback } from "react";
import { useSearchParams } from "react-router";

/** Kinds that are text: shown as source, editable in place. Same list as TextArtifactKind in the protocol. */
export const TEXT_KINDS: readonly ArtifactKind[] = ["markdown", "html", "svg", "csv", "code", "text"];
export const isTextKind = (k: ArtifactKind) => TEXT_KINDS.includes(k);
/** Text kinds with a rendered preview besides the source. */
export const RENDERED_KINDS: readonly ArtifactKind[] = ["markdown", "html", "svg", "csv"];

export const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: "文档",
  html: "网页",
  svg: "SVG 图",
  csv: "表格",
  code: "代码",
  text: "文本",
  image: "图片",
  pdf: "PDF",
  audio: "音频",
  video: "视频",
  file: "文件",
};

/** Same set as the hub's isArchiveName: files whose contents the viewer can list. */
export const ARCHIVE = /\.(zip|jar|war|apk|tar|tgz|tbz2?|txz|tzst|7z|rar|r\d\d|cab|iso|wim|arj|lzh|lha|cpio|deb|rpm|gz|bz2|xz|zst|lzma|z)$/i;

export function kindIcon(kind: ArtifactKind, filename = ""): LucideIcon {
  if (kind === "file" && ARCHIVE.test(filename)) return FileArchive;
  return { markdown: FileText, html: Globe, svg: Shapes, csv: Sheet, code: FileCode, text: FileText, image: Image, pdf: FileType, audio: Music, video: Film, file: File }[kind];
}

/** "文档 · 12 KB · 第 3 版" (the version only once there is more than one). */
export function artifactMeta(a: { kind: ArtifactKind; size: number; version: number; language?: string | null }): string {
  return [a.kind === "code" && a.language ? a.language : KIND_LABEL[a.kind], bytes(a.size), a.version > 1 ? `第 ${a.version} 版` : ""].filter(Boolean).join(" · ");
}

export function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function fileUrl(id: string, version?: number, download = false): string {
  const q = new URLSearchParams();
  if (version) q.set("v", String(version));
  if (download) q.set("download", "1");
  const s = q.toString();
  return `/api/artifacts/${id}/file${s ? `?${s}` : ""}`;
}

/** Filters on the library page. */
export const KIND_GROUPS: { value: string; label: string; kinds: ArtifactKind[] }[] = [
  { value: "all", label: "全部类型", kinds: [] },
  { value: "doc", label: "文档", kinds: ["markdown", "text", "pdf"] },
  { value: "web", label: "网页和图形", kinds: ["html", "svg"] },
  { value: "code", label: "代码", kinds: ["code"] },
  { value: "data", label: "表格", kinds: ["csv"] },
  { value: "media", label: "图片和音视频", kinds: ["image", "audio", "video"] },
  { value: "file", label: "其他文件", kinds: ["file"] },
];

/**
 * The open artifact lives in the URL (?artifact=…&av=…), so any page can open the viewer, the back button
 * closes it on phones, and a link reopens it.
 */
export function useArtifactPanel() {
  const [params, setParams] = useSearchParams();
  const openId = params.get("artifact");
  const version = Number(params.get("av")) || undefined;
  const open = useCallback(
    (id: string, v?: number) => {
      const next = new URLSearchParams(params);
      next.set("artifact", id);
      if (v) next.set("av", String(v));
      else next.delete("av");
      // Switching between artifacts or versions doesn't stack up history.
      setParams(next, { replace: params.has("artifact") });
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("artifact");
    next.delete("av");
    setParams(next, { replace: true });
  }, [params, setParams]);
  return { openId, version, open, close };
}
