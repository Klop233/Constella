import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Folder, File as FileIcon, Lock, ChevronLeft, Copy, Download, ExternalLink, MessageSquare, MoreHorizontal, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, ApiError } from "../lib/api";
import { ARCHIVE, bytes, fileUrl, isTextKind, KIND_LABEL, kindIcon, RENDERED_KINDS, useArtifactPanel } from "../lib/artifacts";
import { timeAgo } from "../lib/format";
import type { ArtifactDetail, ArtifactVersion } from "../lib/types";
import { Markdown } from "./Markdown";
import { Badge, Button, buttonClass, confirmDialog, Empty, IconButton, inputClass, Loading, MenuDivider, MenuItem, Popover, Segmented, cx, toast } from "./ui";

/** Width of the panel on wide screens; the page content moves aside by the same amount (see Shell). */
const PANEL_W = "min(50vw, 760px)";
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const CSV_ROWS = 1000;
/** Modern Office files the built-in editor reads and edits in place. */
const OFFICE = /\.(docx|xlsx|pptx)$/i;
/** Legacy binary formats, converted to the modern format first (LibreOffice on the hub). */
const LEGACY_OFFICE = /\.(doc|xls|ppt)$/i;

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

  const tryClose = async () => {
    if (dirty && !(await confirmDialog({ title: "修改还没保存，确定关闭？", ok: "关闭", danger: true }))) return;
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
      if (!(await confirmDialog({ title: `删除「${a!.title}」？`, body: `它的全部 ${a!.version} 个版本都会删除，聊天里的卡片会显示为已删除。`, ok: "删除", danger: true }))) return;
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
              <Button size="sm" variant="ghost" onClick={async () => (dirty && !(await confirmDialog({ title: "放弃这次修改？", ok: "放弃", danger: true })) ? null : setDraft(null))}>
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
            <Body id={id} ver={ver} latest={latest} baseVersion={a.version} onSaved={onVersion} mode={rendered ? mode : "source"} text={content.data} loading={content.isLoading} error={content.error} />
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

function Body({ id, ver, latest, baseVersion, onSaved, mode, text, loading, error }: { id: string; ver: ArtifactVersion; latest: boolean; baseVersion: number; onSaved: (v: number) => void; mode: "preview" | "source"; text?: { text: string; truncated: boolean }; loading: boolean; error: Error | null }) {
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
      if (LEGACY_OFFICE.test(ver.filename)) return <LegacyOfficeView id={id} ver={ver} latest={latest} onSaved={onSaved} download={download} />;
      if (OFFICE.test(ver.filename)) return <OfficeView id={id} ver={ver} latest={latest} baseVersion={baseVersion} onSaved={onSaved} download={download} />;
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

interface OfficeCell {
  v: string;
  f?: boolean;
}
interface OfficeData {
  kind: "docx" | "xlsx" | "pptx";
  groups: { title: string; paragraphs: string[] }[];
  sheets: { name: string; rows: (OfficeCell | null)[][]; truncated: boolean }[];
}

/** Word / PowerPoint text and Excel cells, editable in place; saved as a new version with the file's formatting kept. */
function OfficeView({ id, ver, latest, baseVersion, onSaved, download }: { id: string; ver: ArtifactVersion; latest: boolean; baseVersion: number; onSaved: (v: number) => void; download: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["artifact-office", id, ver.version], queryFn: () => api.get<OfficeData>(`/api/artifacts/${id}/office?v=${ver.version}`), retry: false, staleTime: Infinity });
  // Pending edits keyed by position; only values that differ from the file are kept.
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [sheet, setSheet] = useState(0);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (q.isLoading) return <Loading />;
  if (q.error || !d) return <Empty title={ver.filename} hint={q.error?.message ?? "读不出这个文件"} action={download} />;
  const canEdit = latest;
  const set = (key: string, orig: string, value: string) =>
    setEdits((m) => {
      const n = new Map(m);
      if (value === orig) n.delete(key);
      else n.set(key, value);
      return n;
    });
  const save = async () => {
    setBusy(true);
    try {
      const list = [...edits].map(([k, value]) => {
        const p = k.split(":").map(Number) as [number, number, number?];
        return d.kind === "xlsx" ? { type: "cell", sheet: p[0], row: p[1], col: p[2]!, value } : { type: "text", group: p[0], index: p[1], text: value };
      });
      const next = await api.post<{ version: number }>(`/api/artifacts/${id}/office`, { base: baseVersion, edits: list });
      setEdits(new Map());
      void qc.invalidateQueries({ queryKey: ["artifact", id] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
      onSaved(next.version);
      toast(`已保存为第 ${next.version} 版`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  const bar = (
    <div className="sticky top-0 z-10 bg-surface flex items-center gap-2 px-3 py-2 border-b border-line">
      <span className="flex-1 min-w-0 truncate text-xs text-muted">
        {!canEdit ? "旧版本只能看，要改请先回到最新版" : edits.size ? `${edits.size} 处未保存的修改` : "直接修改文字或单元格，保存后生成新版本，原有格式保持不变"}
      </span>
      {edits.size > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setEdits(new Map())}>
          放弃
        </Button>
      )}
      <Button size="sm" variant="primary" loading={busy} disabled={!edits.size} onClick={save}>
        <Check className="size-3.5" /> 保存
      </Button>
      {download}
    </div>
  );
  if (d.kind === "xlsx") {
    const s = d.sheets[sheet] ?? d.sheets[0];
    if (!s) return <Empty title="没有工作表" action={download} />;
    const si = d.sheets.indexOf(s);
    const cols = Math.max(4, ...s.rows.map((r) => r.length)) + 2;
    const rows = Math.max(10, s.rows.length + 3);
    return (
      <div className="min-w-0">
        {bar}
        <div className="min-w-max">
          <table className="text-[12.5px] border-collapse">
            <thead className="sticky top-[49px] bg-surface z-[1]">
              <tr>
                <th className="w-10 border-b border-r border-line" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} className="font-medium text-muted px-2 py-1 border-b border-r border-line min-w-28">
                    {colLabel(c + 1)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, r) => (
                <tr key={r}>
                  <th className="text-xs font-normal text-muted px-1 border-b border-r border-line bg-surface">{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => {
                    const cell = s.rows[r]?.[c] ?? null;
                    const key = `${si}:${r + 1}:${c + 1}`;
                    const orig = cell?.v ?? "";
                    const val = edits.get(key) ?? orig;
                    return (
                      <td key={c} className={cx("border-b border-r border-line p-0", edits.has(key) && "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]")}>
                        <input
                          value={val}
                          readOnly={!canEdit || !!cell?.f}
                          title={cell?.f ? "公式单元格，不能在这里修改" : undefined}
                          aria-label={`${colLabel(c + 1)}${r + 1}`}
                          onChange={(e) => set(key, orig, e.target.value)}
                          className={cx("block w-full min-w-28 h-7 px-2 bg-transparent outline-none focus:bg-surface-2 tabular-nums", cell?.f && "italic text-muted")}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {s.truncated && <div className="px-3 py-2 text-xs text-muted">表格较大，只显示了前 500 行、60 列，完整内容请下载。</div>}
        </div>
        {d.sheets.length > 1 && (
          <div className="sticky bottom-0 bg-surface border-t border-line flex gap-1 px-2 py-1.5 overflow-x-auto">
            {d.sheets.map((x, i) => (
              <button key={i} onClick={() => setSheet(i)} className={cx("px-2.5 py-1 rounded-md text-[13px] whitespace-nowrap", i === si ? "bg-surface-2 font-medium" : "text-muted hover:bg-surface-2")}>
                {x.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="min-w-0">
      {bar}
      <div className="px-4 py-3 space-y-5 max-w-3xl">
        {d.groups.map((g, gi) => (
          <section key={gi} className={cx(d.kind === "pptx" && "rounded-lg border border-line p-3")}>
            {d.kind === "pptx" && <h3 className="text-xs text-muted mb-2">{g.title}</h3>}
            <div className="space-y-1">
              {g.paragraphs.map((p, pi) => {
                const key = `${gi}:${pi}`;
                const val = edits.get(key) ?? p;
                // Empty paragraphs are layout; keep them as thin spacers unless being edited.
                return (
                  <textarea
                    key={pi}
                    value={val}
                    rows={Math.max(1, Math.ceil(val.length / 60) + (val.match(/\n/g)?.length ?? 0))}
                    readOnly={!canEdit}
                    aria-label={`第 ${pi + 1} 段`}
                    onChange={(e) => set(key, p, e.target.value)}
                    className={cx("block w-full resize-none rounded-md px-2 py-1 bg-transparent text-sm leading-6 outline-none hover:bg-surface-2 focus:bg-surface-2", !val && "min-h-4 opacity-60", edits.has(key) && "bg-[color-mix(in_oklab,var(--accent)_12%,transparent)]")}
                  />
                );
              })}
            </div>
          </section>
        ))}
        {!d.groups.length && <Empty title="没有可编辑的文字" action={download} />}
      </div>
    </div>
  );
}

/** Old binary .doc / .xls / .ppt can't be read directly; offers to convert them to the modern format first. */
function LegacyOfficeView({ id, ver, latest, onSaved, download }: { id: string; ver: ArtifactVersion; latest: boolean; onSaved: (v: number) => void; download: ReactNode }) {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["artifact-convert", id], queryFn: () => api.get<{ to: string | null; available: boolean }>(`/api/artifacts/${id}/convert`), staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const to = info.data?.to ?? "";
  const convert = async () => {
    setBusy(true);
    try {
      const next = await api.post<{ version: number }>(`/api/artifacts/${id}/convert`);
      void qc.invalidateQueries({ queryKey: ["artifact", id] });
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
      onSaved(next.version);
      toast(`已转换，保存为第 ${next.version} 版`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };
  let hint = `${bytes(ver.size)} · 这是老格式的 Office 文件，要先转换成 .${to || "docx / xlsx / pptx"} 才能查看和编辑`;
  if (info.data && !info.data.available) hint = `${bytes(ver.size)} · 老格式的 Office 文件不能在线预览，服务器上没有安装转换工具，请下载后用 Office 打开`;
  else if (!latest) hint = `${bytes(ver.size)} · 老格式的 Office 文件；转换请先回到最新版`;
  return (
    <Empty
      title={ver.filename}
      hint={hint}
      action={
        <div className="flex items-center gap-2">
          {info.data?.available && latest && (
            <Button size="sm" variant="primary" loading={busy} onClick={convert}>
              转换为 .{to} 并查看
            </Button>
          )}
          {download}
        </div>
      }
    />
  );
}

function colLabel(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
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
