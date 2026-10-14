import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Folder, File as FileIcon, Lock, ChevronLeft, Copy, Download, ExternalLink, MessageSquare, MoreHorizontal, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../lib/api";
import { ARCHIVE, bytes, fileUrl, isTextKind, KIND_LABEL, kindIcon, RENDERED_KINDS, useArtifactPanel } from "../lib/artifacts";
import { timeAgo } from "../lib/format";
import type { ArtifactDetail, ArtifactVersion } from "../lib/types";
import { Markdown } from "./Markdown";
import { Badge, Button, buttonClass, Empty, IconButton, inputClass, Loading, MenuDivider, MenuItem, Popover, Segmented, cx, toast } from "./ui";

/** Width of the panel on wide screens; the page content moves aside by the same amount (see Shell). */
const PANEL_W = "min(50vw, 760px)";
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const CSV_ROWS = 1000;
/** Same set as the hub: types the online editor opens. */
const OFFICE = /\.(docx?|dotx?|odt|rtf|xlsx?|xltx?|ods|pptx?|potx?|odp)$/i;

/** The artifact named in the URL, in a side panel (full screen on phones). */
export default function ArtifactViewer() {
  const { openId, version, open, close } = useArtifactPanel();
  if (!openId) return null;
  return <Panel key={openId} id={openId} version={version} onVersion={(v) => open(openId, v)} onClose={close} />;
}

function Panel({ id, version, onVersion, onClose }: { id: string; version?: number; onVersion: (v: number) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const detail = useQuery({ queryKey: ["artifact", id], queryFn: () => api.get<ArtifactDetail>(`/api/artifacts/${id}`), retry: false });
  const a = detail.data;
  const ver = a ? (a.versions.find((x) => x.version === version) ?? a.versions[0]) : undefined;
  const latest = !!a && !!ver && ver.version === a.version;
  const isText = !!ver && isTextKind(ver.kind);
  const content = useQuery({
    queryKey: ["artifact-content", id, ver?.version],
    queryFn: () => api.get<{ text: string; truncated: boolean }>(`/api/artifacts/${id}/content?v=${ver!.version}`),
    enabled: isText,
    // A version never changes.
    staleTime: Infinity,
  });
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [title, setTitle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const dirty = draft !== null && draft !== content.data?.text;

  useLayoutEffect(() => {
    const el = document.documentElement;
    el.style.setProperty("--panel-w", PANEL_W);
    return () => {
      el.style.removeProperty("--panel-w");
    };
  }, []);

  const tryClose = () => {
    if (dirty && !confirm("修改还没保存，确定关闭？")) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes an open menu first, and never throws away an edit.
      if (e.key !== "Escape" || draft !== null || title !== null || panel.current?.querySelector('[aria-expanded="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, title, onClose]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["artifact", id] });
    void qc.invalidateQueries({ queryKey: ["artifacts"] });
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      const next = await api.post<{ version: number }>(`/api/artifacts/${id}/versions`, { content: draft, ...(note.trim() ? { note: note.trim() } : {}) });
      setDraft(null);
      setNote("");
      refresh();
      onVersion(next.version);
      toast(`已保存为第 ${next.version} 版`);
    });
  const restore = () =>
    act(async () => {
      const next = await api.post<{ version: number }>(`/api/artifacts/${id}/versions`, { restore: ver!.version });
      refresh();
      onVersion(next.version);
      toast(`已恢复，成为第 ${next.version} 版`);
    });
  const rename = () =>
    act(async () => {
      if (title?.trim() && title.trim() !== a!.title) {
        await api.patch(`/api/artifacts/${id}`, { title: title.trim() });
        refresh();
      }
      setTitle(null);
    });
  const remove = () =>
    act(async () => {
      if (!confirm(`删除「${a!.title}」和它的全部 ${a!.version} 个版本？聊天里的卡片会显示为已删除。`)) return;
      await api.del(`/api/artifacts/${id}`);
      refresh();
      onClose();
      toast("已删除");
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content.data?.text ?? "");
      toast("已复制");
    } catch {
      toast("复制失败：浏览器不允许访问剪贴板", "danger");
    }
  };

  const Icon = ver ? kindIcon(ver.kind, ver.filename) : null;
  const rendered = !!ver && RENDERED_KINDS.includes(ver.kind);
  const editable = isText && latest && !!content.data && !content.data.truncated;
  const missing = detail.error instanceof ApiError && detail.error.status === 404;

  return (
    <aside ref={panel} aria-label="成果" className="fixed z-40 inset-0 lg:left-auto lg:w-[var(--panel-w)] flex flex-col bg-app lg:bg-surface lg:border-l border-line safe-top">
      <div className="h-12 shrink-0 flex items-center gap-1 px-2">
        <span className="lg:hidden">
          <IconButton label="返回" onClick={tryClose}>
            <ChevronLeft className="size-4" />
          </IconButton>
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2 pl-1">
          {Icon && <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.8} />}
          {title !== null ? (
            <input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") setTitle(null);
              }}
              aria-label="标题"
              className={cx(inputClass, "h-8")}
            />
          ) : (
            <h2 className="font-display font-semibold text-[15px] truncate" title={a?.title}>
              {a?.title ?? (missing ? "成果" : "")}
            </h2>
          )}
        </div>
        {a && ver && (
          <>
            <a
              href={fileUrl(id, ver.version, true)}
              download={ver.filename}
              aria-label="下载"
              title="下载"
              className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2"
            >
              <Download className="size-4" strokeWidth={1.8} />
            </a>
            <Popover
              label="更多操作"
              side="bottom"
              className="w-56 p-1.5"
              triggerClassName="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 aria-expanded:bg-surface-2"
              trigger={<MoreHorizontal className="size-4" strokeWidth={1.8} />}
            >
              {(close) => {
                const run = (fn: () => void) => () => {
                  close();
                  fn();
                };
                return (
                  <>
                    {isText && <MenuItem icon={<Copy />} label="复制内容" onClick={run(copy)} />}
                    {editable && draft === null && <MenuItem icon={<Pencil />} label="编辑" onClick={run(() => setDraft(content.data!.text))} />}
                    {!latest && <MenuItem icon={<RotateCcw />} label={`恢复第 ${ver.version} 版`} onClick={run(restore)} />}
                    <MenuItem icon={<Pencil />} label="重命名" onClick={run(() => setTitle(a.title))} />
                    {a.conversation_id && a.conversation_title && (
                      <MenuItem icon={<MessageSquare />} label="前往对话" hint="›" onClick={run(() => nav(`/c/${a.conversation_id}?artifact=${id}&av=${ver.version}`))} />
                    )}
                    {(ver.kind === "pdf" || ver.kind === "image" || ver.kind === "video" || ver.kind === "audio") && (
                      <MenuItem icon={<ExternalLink />} label="在新标签页打开" hint="↗" onClick={run(() => window.open(fileUrl(id, ver.version), "_blank", "noopener"))} />
                    )}
                    <MenuDivider />
                    <MenuItem icon={<Trash2 />} label="删除" danger onClick={run(remove)} />
                  </>
                );
              }}
            </Popover>
          </>
        )}
        <span className="hidden lg:block">
          <IconButton label="关闭" onClick={tryClose}>
            <X className="size-4" />
          </IconButton>
        </span>
      </div>

      {a && ver && (
        <div className="min-h-10 shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-line">
          {draft !== null ? (
            <>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="改了什么（可选）" aria-label="修改说明" className={cx(inputClass, "h-7 py-0 flex-1 min-w-0")} />
              <Button size="sm" variant="ghost" onClick={() => (dirty && !confirm("放弃这次修改？") ? null : setDraft(null))}>
                取消
              </Button>
              <Button size="sm" variant="primary" loading={busy} disabled={!dirty} onClick={save}>
                <Check className="size-3.5" /> 保存
              </Button>
            </>
          ) : (
            <>
              {rendered && (
                <div className="w-28 shrink-0">
                  <Segmented
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: "preview", label: "预览" },
                      { value: "source", label: "源码" },
                    ]}
                  />
                </div>
              )}
              <VersionPicker versions={a.versions} current={ver.version} onPick={onVersion} />
              <span className="flex-1 min-w-0 truncate text-right text-xs text-muted tabular-nums">
                {[a.agent_name ? `${a.agent_emoji ?? ""} ${a.agent_name}` : null, ver.kind === "code" && ver.language ? ver.language : KIND_LABEL[ver.kind], bytes(ver.size), timeAgo(ver.created_at)]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              {editable && (
                <Button size="sm" variant="soft" onClick={() => setDraft(content.data!.text)} className="shrink-0">
                  <Pencil className="size-3.5" /> 编辑
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {a && ver && !latest && draft === null && (
        <div className="shrink-0 flex items-center gap-2 px-3.5 py-2 border-b border-line text-[13px] bg-[color-mix(in_oklab,var(--warn)_8%,transparent)]">
          <span className="flex-1 min-w-0 truncate">
            正在看第 {ver.version} 版，最新是第 {a.version} 版{ver.note ? `。这一版：${ver.note}` : ""}
          </span>
          <button className="text-muted hover:text-[var(--text)] shrink-0" onClick={() => onVersion(a.version)}>
            看最新
          </button>
          <Button size="sm" variant="secondary" loading={busy} onClick={restore} className="shrink-0">
            <RotateCcw className="size-3.5" /> 恢复此版本
          </Button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {detail.isLoading ? (
          <Loading />
        ) : missing ? (
          <Empty title="这个成果已经删除" hint="聊天里的卡片还在，但文件已经不在了" />
        ) : detail.error ? (
          <Empty title="打不开这个成果" hint={detail.error.message} />
        ) : a && ver ? (
          draft !== null ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              aria-label="编辑内容"
              className="block w-full h-full resize-none bg-transparent p-4 font-mono text-[12.5px] leading-5 outline-none"
            />
          ) : (
            <Body id={id} ver={ver} mode={rendered ? mode : "source"} text={content.data} loading={content.isLoading} error={content.error} />
          )
        ) : null}
      </div>
    </aside>
  );
}

function VersionPicker({ versions, current, onPick }: { versions: ArtifactVersion[]; current: number; onPick: (v: number) => void }) {
  if (versions.length < 2) return <span className="shrink-0 text-[13px] text-muted tabular-nums">第 1 版</span>;
  return (
    <Popover
      label="版本"
      side="bottom"
      align="left"
      className="w-72 max-h-80 overflow-y-auto p-1.5"
      trigger={
        <>
          第 {current} 版 <ChevronDown className="size-3.5" />
        </>
      }
    >
      {(close) =>
        versions.map((v, i) => (
          <button
            key={v.version}
            onClick={() => {
              close();
              onPick(v.version);
            }}
            className={cx("w-full text-left px-2.5 py-1.5 rounded-md hover:bg-surface-2", v.version === current && "bg-surface-2")}
          >
            <span className="flex items-center gap-2 text-[13.5px]">
              <span className="font-medium tabular-nums">第 {v.version} 版</span>
              {i === 0 && <Badge tone="accent">最新</Badge>}
              <span className="flex-1" />
              <span className="text-xs text-muted">{timeAgo(v.created_at)}</span>
            </span>
            <span className="block text-xs text-muted truncate">{[v.author === "user" ? "你编辑的" : null, v.note].filter(Boolean).join(" · ") || "agent 生成"}</span>
          </button>
        ))
      }
    </Popover>
  );
}

function Body({ id, ver, mode, text, loading, error }: { id: string; ver: ArtifactVersion; mode: "preview" | "source"; text?: { text: string; truncated: boolean }; loading: boolean; error: Error | null }) {
  const url = fileUrl(id, ver.version);
  const download = (
    <a href={fileUrl(id, ver.version, true)} download={ver.filename} className={buttonClass("secondary", "sm")}>
      <Download className="size-3.5" /> 下载
    </a>
  );
  switch (ver.kind) {
    case "image":
      return (
        <Centered>
          <img src={url} alt={ver.filename} className="max-w-full max-h-full object-contain rounded" />
        </Centered>
      );
    case "audio":
      return (
        <Centered>
          <audio controls src={url} className="w-full max-w-md" />
        </Centered>
      );
    case "video":
      return (
        <Centered>
          <video controls playsInline src={url} className="max-w-full max-h-full rounded" />
        </Centered>
      );
    case "pdf":
      // Phone browsers don't show PDFs inside a page; open it in the system viewer instead.
      return coarsePointer ? (
        <Empty
          title={ver.filename}
          hint={`${bytes(ver.size)} · 手机浏览器不能在页面里显示 PDF`}
          action={
            <a href={url} target="_blank" rel="noopener" className={buttonClass("primary", "sm")}>
              <ExternalLink className="size-3.5" /> 打开 PDF
            </a>
          }
        />
      ) : (
        <iframe title={ver.filename} src={url} className="block w-full h-full border-0" />
      );
    case "file":
      if (OFFICE.test(ver.filename)) return <OfficeEditor id={id} ver={ver} download={download} />;
      if (ARCHIVE.test(ver.filename)) return <ArchiveView id={id} ver={ver} download={download} />;
      return <Empty title={ver.filename} hint={`${bytes(ver.size)} · 这类文件不能在线预览，下载后用对应的软件打开`} action={download} />;
  }
  if (loading) return <Loading />;
  if (error || !text) return <Empty title="读不出内容" hint={error?.message} action={download} />;
  const cut = text.truncated && <div className="px-4 py-2 text-xs text-muted border-b border-line">内容较长，只显示了开头的 2 MB，完整内容请下载。</div>;
  if (mode === "source" || ver.kind === "code" || ver.kind === "text") {
    return (
      <>
        {cut}
        <pre className={cx("p-4 font-mono text-[12.5px] leading-5", ver.kind === "markdown" || ver.kind === "text" ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>{text.text}</pre>
      </>
    );
  }
  switch (ver.kind) {
    case "markdown":
      return (
        <div className="px-5 py-4 max-w-3xl">
          {cut}
          <Markdown text={text.text} className="font-display text-sm" />
        </div>
      );
    case "html":
      // An opaque origin (no allow-same-origin): the page's scripts run, but can't reach the app or its session.
      return <iframe title={ver.filename} sandbox="allow-scripts allow-popups allow-forms allow-modals" referrerPolicy="no-referrer" srcDoc={text.text} className="block w-full h-full border-0 bg-white" />;
    case "svg":
      return (
        <Centered>
          <img src={url} alt={ver.filename} className="max-w-full max-h-full object-contain" />
        </Centered>
      );
    case "csv":
      return <CsvTable text={text.text} tsv={/\.tsv$/i.test(ver.filename)} />;
  }
  return null;
}

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: unknown) => { destroyEditor(): void } };
  }
}

let docsApiScript: Promise<void> | null = null;
function loadDocsApi(url: string): Promise<void> {
  if (window.DocsAPI) return Promise.resolve();
  docsApiScript ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.onload = () => resolve();
    el.onerror = () => {
      docsApiScript = null;
      reject(new Error("加载不了编辑器，服务可能没有启动"));
    };
    document.head.appendChild(el);
  });
  return docsApiScript;
}

/** Word / Excel / PowerPoint (old formats included) in the optional online editor; saves become new versions. */
function OfficeEditor({ id, ver, download }: { id: string; ver: ArtifactVersion; download: ReactNode }) {
  const q = useQuery({
    queryKey: ["artifact-office", id, ver.version],
    queryFn: () => api.get<{ enabled: boolean; editable?: boolean; apiUrl?: string; config?: unknown }>(`/api/artifacts/${id}/office?v=${ver.version}`),
    retry: false,
    // The editor config carries a signed link and the service may have stopped meanwhile.
    staleTime: 0,
    gcTime: 0,
  });
  const qc = useQueryClient();
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const data = q.data;
  useEffect(() => {
    if (!data?.enabled || !data.apiUrl || !host.current) return;
    let editor: { destroyEditor(): void } | null = null;
    let dead = false;
    const el = document.createElement("div");
    el.id = `oo-${id}-${ver.version}`;
    el.style.height = "100%";
    host.current.appendChild(el);
    loadDocsApi(data.apiUrl)
      .then(() => {
        if (dead || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor(el.id, data.config);
      })
      .catch((e: Error) => setFailed(e.message));
    return () => {
      dead = true;
      try {
        editor?.destroyEditor();
      } catch {
        // already gone
      }
      el.remove();
      // The save arrives a few seconds after the editor closes.
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["artifact", id] });
        void qc.invalidateQueries({ queryKey: ["artifacts"] });
      }, 6000);
    };
  }, [data, id, ver.version, qc]);
  if (q.isLoading) {
    return (
      <div className="h-full grid place-items-center p-6 text-center text-sm text-muted">
        <div>
          <Loading />
          正在打开编辑器（服务闲置后首次启动约需 1 分钟）
        </div>
      </div>
    );
  }
  if (q.error || failed) return <Empty title={ver.filename} hint={q.error?.message ?? failed ?? ""} action={download} />;
  if (!data?.enabled) {
    return (
      <Empty
        title={ver.filename}
        hint={`${bytes(ver.size)} · 在线 Office 编辑器没有启用。可以在「设置 → 系统」里启用，或者下载后用本地软件打开`}
        action={
          <div className="flex items-center gap-2">
            <Link to="/settings?s=system" className={buttonClass("primary", "sm")}>
              去启用
            </Link>
            {download}
          </div>
        }
      />
    );
  }
  return (
    <div className="h-full flex flex-col">
      {!data.editable && <div className="shrink-0 px-3 py-1.5 text-xs text-muted border-b border-line">旧版本只能查看；要修改请先回到最新版。</div>}
      <div ref={host} className="flex-1 min-h-0" />
    </div>
  );
}

interface ArchiveEntry {
  path: string;
  size: number | null;
  dir: boolean;
  modified: string | null;
  encrypted: boolean;
}
interface TreeNode {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
  modified: string | null;
  encrypted: boolean;
  children: TreeNode[];
}

function buildTree(entries: ArchiveEntry[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, size: null, modified: null, encrypted: false, children: [] };
  const index = new Map<string, TreeNode>([["", root]]);
  const ensureDir = (path: string): TreeNode => {
    const hit = index.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : path.slice(0, cut));
    const node: TreeNode = { name: path.slice(cut + 1), path, dir: true, size: null, modified: null, encrypted: false, children: [] };
    parent.children.push(node);
    index.set(path, node);
    return node;
  };
  for (const e of entries) {
    if (e.dir) {
      const n = ensureDir(e.path);
      n.modified = e.modified;
      continue;
    }
    const cut = e.path.lastIndexOf("/");
    const parent = ensureDir(cut < 0 ? "" : e.path.slice(0, cut));
    parent.children.push({ name: e.path.slice(cut + 1), path: e.path, dir: false, size: e.size, modified: e.modified, encrypted: e.encrypted, children: [] });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "zh"));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

/** The contents of a compressed file, listed on the hub without extracting anything. */
function ArchiveView({ id, ver, download }: { id: string; ver: ArtifactVersion; download: ReactNode }) {
  const q = useQuery({
    queryKey: ["artifact-archive", id, ver.version],
    queryFn: () => api.get<{ entries: ArchiveEntry[]; total: number; truncated: boolean; totalSize: number | null }>(`/api/artifacts/${id}/archive?v=${ver.version}`),
    retry: false,
    staleTime: Infinity,
  });
  const tree = useMemo(() => (q.data ? buildTree(q.data.entries) : []), [q.data]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <Empty title={ver.filename} hint={q.error?.message ?? "读不出压缩包"} action={download} />;
  const d = q.data;
  const files = d.entries.filter((e) => !e.dir).length;
  const needle = filter.trim().toLowerCase();
  const hits = needle ? d.entries.filter((e) => !e.dir && e.path.toLowerCase().includes(needle)) : [];
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(p)) n.add(p);
      return n;
    });
  const row = (n: { name: string; dir: boolean; size: number | null; modified: string | null; encrypted: boolean }, depth: number, onClick?: () => void, expanded = false, key?: string) => (
    <div
      key={key}
      role={onClick ? "button" : undefined}
      onClick={onClick}
      className={cx("flex items-center gap-2 py-1.5 pr-3 text-[13px] border-b border-line/60", onClick && "cursor-pointer hover:bg-surface-2")}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      {n.dir ? <ChevronRight className={cx("size-3.5 shrink-0 text-muted transition-transform", expanded && "rotate-90")} /> : <span className="size-3.5 shrink-0" />}
      {n.dir ? <Folder className="size-4 shrink-0 text-muted" strokeWidth={1.8} /> : <FileIcon className="size-4 shrink-0 text-muted" strokeWidth={1.8} />}
      <span className="flex-1 min-w-0 truncate" title={n.name}>
        {n.name}
      </span>
      {n.encrypted && <Lock className="size-3 shrink-0 text-muted" aria-label="已加密" />}
      <span className="shrink-0 text-xs text-muted tabular-nums w-16 text-right">{n.size !== null && !n.dir ? bytes(n.size) : ""}</span>
      <span className="shrink-0 text-xs text-muted tabular-nums w-28 text-right hidden sm:block">{n.modified?.slice(0, 16) ?? ""}</span>
    </div>
  );
  const render = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((n) => {
      const isOpen = open.has(n.path);
      return [row(n, depth, n.dir ? () => toggle(n.path) : undefined, isOpen, n.path), ...(n.dir && isOpen ? render(n.children, depth + 1) : [])];
    });
  return (
    <div className="min-w-0">
      <div className="sticky top-0 z-10 bg-surface flex items-center gap-2 px-3 py-2 border-b border-line">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="在压缩包里找文件" aria-label="筛选文件" className={cx(inputClass, "h-8 flex-1 min-w-0")} />
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {files} 个文件{d.totalSize !== null ? ` · 解压后 ${bytes(d.totalSize)}` : ""}
        </span>
        {download}
      </div>
      {d.truncated && <div className="px-4 py-2 text-xs text-muted border-b border-line">共 {d.total} 项，只列出了前 {d.entries.length} 项。</div>}
      {needle ? (hits.length ? hits.slice(0, 500).map((e) => row({ ...e, name: e.path }, 0, undefined, false, e.path)) : <Empty title="没有匹配的文件" />) : d.entries.length ? render(tree, 0) : <Empty title="空的压缩包" />}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-48 grid place-items-center p-4 bg-[color-mix(in_oklab,var(--text)_4%,transparent)]">{children}</div>;
}

function CsvTable({ text, tsv }: { text: string; tsv: boolean }) {
  const rows = useMemo(() => parseCsv(text, tsv || (!text.split("\n", 1)[0]!.includes(",") && text.includes("\t")) ? "\t" : ",", CSV_ROWS + 1), [text, tsv]);
  if (!rows.length) return <Empty title="空表格" />;
  const [head, ...body] = rows;
  return (
    <div className="min-w-max">
      <table className="text-[12.5px] tabular-nums border-collapse">
        <thead className="sticky top-0 bg-surface">
          <tr>
            {head!.map((h, i) => (
              <th key={i} className="text-left font-medium px-2.5 py-1.5 border-b border-line whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, CSV_ROWS - 1).map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-2.5 py-1.5 border-b border-line whitespace-nowrap max-w-xs truncate" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > CSV_ROWS && <div className="px-2.5 py-2 text-xs text-muted">只显示前 {CSV_ROWS - 1} 行，完整内容请下载。</div>}
    </div>
  );
}

/** RFC 4180-ish: quoted fields with "" escapes and embedded line breaks; stops after `maxRows`. */
export function parseCsv(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= maxRows) return rows;
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
