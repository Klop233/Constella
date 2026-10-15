import { CircleX, Code2, Copy, Loader2, Maximize2, MoreHorizontal, RotateCw, Save, Sparkles, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { MenuDivider, MenuItem, Popover, cx, toast } from "./ui";

// The chrome around an interactive block, shared by the component-program blocks (Widget.tsx) and the
// declarative streaming blocks (streamui/Block.tsx), so both look and behave the same.

/** Hover tools for a block (desktop): source, full screen, run again, and more. Blocks have no frame of their own, like ChatGPT. */
export function BlockTools({ code, onCode, onFull, onReload, source, onSave, saving, badge }: { code: boolean; onCode: () => void; onFull: () => void; onReload: () => void; source: string; onSave?: () => void; saving?: boolean; badge?: number }) {
  const copySource = () => void navigator.clipboard.writeText(source).then(() => toast("已复制源码"), () => toast("复制失败", "danger"));
  return (
    <div className={cx("absolute -top-3 right-0 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-sm transition-opacity", "opacity-0 group-hover/block:opacity-100 focus-within:opacity-100 pointer-coarse:hidden", code && "opacity-100")}>
      <ToolButton label={code ? "看界面" : badge ? `看源码（${badge} 处诊断）` : "看源码"} onClick={onCode} active={code}>
        <span className="relative">
          <Code2 className="size-3.5" strokeWidth={1.8} />
          {!!badge && <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-warn" />}
        </span>
      </ToolButton>
      <ToolButton label="全屏" onClick={onFull}>
        <Maximize2 className="size-3.5" strokeWidth={1.8} />
      </ToolButton>
      <Popover
        label="更多"
        side="bottom"
        className="w-44"
        triggerClassName="size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 aria-expanded:bg-surface-2"
        trigger={<MoreHorizontal className="size-3.5" strokeWidth={1.8} />}
      >
        {(close) => (
          <div className="p-1.5">
            <MenuItem icon={<RotateCw className="size-4" strokeWidth={1.8} />} label="重新运行" onClick={() => { close(); onReload(); }} />
            <MenuItem icon={<Copy className="size-4" strokeWidth={1.8} />} label="复制源码" onClick={() => { close(); copySource(); }} />
            {onSave && (
              <>
                <MenuDivider />
                <MenuItem icon={<Save className="size-4" strokeWidth={1.8} />} label={saving ? "保存中…" : "另存为成果"} onClick={() => { close(); onSave(); }} />
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}

export function ToolButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx("size-6 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2", active && "bg-surface-2 text-[var(--text)]")}>
      {children}
    </button>
  );
}

export function ErrorLine({ error, onRetry, onFix }: { error: string; onRetry: () => void; onFix?: () => void }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-danger min-w-0">
      <CircleX className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="truncate">界面出错：{error}</span>
      <span className="flex items-center gap-2 shrink-0 text-xs text-muted">
        <button className="hover:text-[var(--text)]" onClick={onRetry}>重试</button>
        {onFix && <button className="hover:text-[var(--text)]" onClick={onFix}>让 agent 修复</button>}
      </span>
    </div>
  );
}

export function FullScreen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex-1 flex flex-col bg-surface sm:border border-line sm:rounded-2xl shadow-xl overflow-hidden safe-bottom">
        <div className="h-12 shrink-0 flex items-center gap-2 pl-4 pr-2 border-b border-line">
          <Sparkles className="size-4 text-muted" strokeWidth={1.8} />
          <div className="flex-1 min-w-0 truncate font-display font-semibold text-[15px]">{title}</div>
          <button aria-label="关闭" title="关闭" onClick={onClose} className="size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
            <X className="size-4" strokeWidth={1.8} />
          </button>
        </div>
        <div className="flex-1 min-h-0">{children}</div>
      </div>
    </div>
  );
}

/** A block that hasn't produced anything yet: a fixed-height placeholder, so the reply doesn't jump. */
export function WidgetSkeleton({ title, lines }: { title: string; lines: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface overflow-hidden">
      <div className="h-8 flex items-center gap-2 px-3 text-[12.5px] text-muted border-b border-line">
        <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={1.8} />
        <span className="truncate">正在生成{title ? `「${title}」` : "交互界面"}…</span>
        <span className="ml-auto tabular-nums text-[11px]">{lines} 行</span>
      </div>
      <div className="p-3.5 space-y-2.5" aria-hidden>
        {[70, 92, 55].map((w) => (
          <div key={w} className="h-2.5 rounded-full bg-surface-2 pulse-dot" style={{ width: `${w}%` }} />
        ))}
        <div className="h-24 rounded-lg bg-surface-2 pulse-dot" />
      </div>
    </div>
  );
}
