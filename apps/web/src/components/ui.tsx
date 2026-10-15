import { Check, ChevronDown, ChevronLeft, CircleAlert, CircleDot, Loader2, Minus, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "soft" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const BUTTON_STYLES: Record<Variant, string> = {
  primary: "bg-accent-grad text-white hover:brightness-95 active:brightness-90 disabled:opacity-50",
  secondary: "bg-surface border border-line hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
  soft: "bg-surface-2 hover:bg-[color-mix(in_oklab,var(--text)_12%,transparent)] disabled:opacity-50",
  ghost: "hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
  danger: "bg-[var(--danger)] text-white active:opacity-85 disabled:opacity-50",
};
const BUTTON_SIZES: Record<Size, string> = { sm: "h-7 px-2.5 text-[13px] rounded-md", md: "h-8 px-3 text-[13.5px] rounded-md", lg: "h-10 px-4 text-sm rounded-lg" };

/** Button looks for something that isn't a <button>, e.g. a download link. */
export function buttonClass(variant: Variant = "secondary", size: Size = "md"): string {
  return cx("inline-flex items-center justify-center gap-1.5 font-medium transition select-none", BUTTON_STYLES[variant], BUTTON_SIZES[size]);
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(buttonClass(variant, size), className)}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cx("bg-surface rounded-xl border border-line", onClick && "hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] active:bg-surface-2 cursor-pointer transition-colors", className)}>
      {children}
    </div>
  );
}

export function Badge({ tone = "muted", children, className }: { tone?: "muted" | "ok" | "warn" | "danger" | "accent"; children: ReactNode; className?: string }) {
  const tones = {
    muted: "bg-surface-2 text-muted",
    ok: "bg-[color-mix(in_oklab,var(--ok)_15%,transparent)] text-ok",
    warn: "bg-[color-mix(in_oklab,var(--warn)_15%,transparent)] text-warn",
    danger: "bg-[color-mix(in_oklab,var(--danger)_15%,transparent)] text-danger",
    accent: "bg-accent-soft text-accent",
  };
  return <span className={cx("inline-flex items-center gap-1 rounded px-1.5 py-px text-[11.5px] font-medium", tones[tone], className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-muted", className)} />;
}

export function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-10 gap-1.5">
      {icon && <div className="text-muted mb-1">{icon}</div>}
      <div className="font-display text-base font-medium">{title}</div>
      {hint && <div className="text-sm text-muted">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * Page top bar. Top-level pages (no `back`) get a large page title on wide screens, like Claude's pages:
 * it scrolls away with the page instead of sticking, with the description under it and actions on the right.
 * Phones and pages with a back button keep the compact 48px sticky bar.
 */
export function Header({ title, back, backMobileOnly, right, sub }: { title: ReactNode; back?: boolean | string; backMobileOnly?: boolean; right?: ReactNode; sub?: ReactNode }) {
  const nav = useNavigate();
  const large = !back;
  return (
    <header className={cx("safe-top sticky top-0 z-20 bg-app/90 backdrop-blur-md", large && "lg:static lg:bg-transparent lg:backdrop-blur-none")}>
      <div className={cx("h-12 flex items-center gap-1 px-2", large && "lg:h-auto lg:items-end lg:gap-3 lg:px-4 lg:pt-8 lg:pb-6")}>
        {back ? (
          <button aria-label="返回" className={cx("size-8 grid place-items-center rounded-md hover:bg-surface-2 active:bg-surface-2", backMobileOnly && "lg:hidden")} onClick={() => (typeof back === "string" ? nav(back) : history.length > 1 ? nav(-1) : nav("/"))}>
            <ChevronLeft className="size-4" />
          </button>
        ) : (
          <div className="w-2 lg:hidden" />
        )}
        <div className="flex-1 min-w-0">
          <h1 className={cx("font-display font-semibold text-[15px] truncate", large && "lg:text-2xl lg:font-medium lg:leading-tight")}>{title}</h1>
          {sub && <div className={cx("text-xs text-muted truncate -mt-0.5", large && "lg:mt-1 lg:text-[13px]")}>{sub}</div>}
        </div>
        <div className={cx("flex items-center gap-1 pr-1", large && "lg:gap-2 lg:pr-0")}>{right}</div>
      </div>
    </header>
  );
}

/**
 * A page's main action in the top bar (新建实例、新建任务…): an icon button on phones, a labelled
 * secondary button next to the large page title on wide screens. `wide` keeps the label on phones
 * too, for actions an icon alone doesn't explain (导入记忆).
 */
export function HeaderButton({ icon, label, onClick, wide }: { icon: ReactNode; label: string; onClick: () => void; wide?: boolean }) {
  return (
    <button
      type="button"
      aria-label={wide ? undefined : label}
      title={wide ? undefined : label}
      onClick={onClick}
      className={cx(
        "h-8 rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 active:bg-surface-2 [&_svg]:size-4",
        wide ? "inline-flex items-center gap-1.5 px-2 text-[13px]" : "w-8 grid place-items-center",
        "lg:w-auto lg:inline-flex lg:items-center lg:gap-1.5 lg:px-3 lg:border lg:border-line lg:bg-surface lg:text-[var(--text)] lg:text-[13.5px] lg:font-medium",
      )}
    >
      {icon}
      <span className={wide ? undefined : "hidden lg:inline"}>{label}</span>
    </button>
  );
}

export function IconButton({ label, onClick, children, className }: { label: string; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx("size-8 grid place-items-center rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2 active:bg-surface-2", className)}>
      {children}
    </button>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto bg-surface border border-line shadow-xl rounded-t-2xl sm:rounded-2xl safe-bottom">
        <div className="sticky top-0 bg-surface flex items-center px-4 pt-3 pb-1.5 z-10">
          <div className="flex-1 font-display font-semibold text-[15px]">{title}</div>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-4 pb-5">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  /** The confirming button's text, a verb (删除、重启、继续). */
  ok?: string;
  /** Red confirming button: the action deletes or throws something away. */
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
let confirming: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();
const setConfirming = (next: ConfirmRequest | null) => {
  confirming = next;
  for (const l of confirmListeners) l();
};

/** Ask before doing something hard to undo; resolves true when confirmed. Use instead of window.confirm. */
export function confirmDialog(request: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    confirming?.resolve(false);
    setConfirming({ ...request, resolve });
  });
}

/** Renders `confirmDialog` requests; mounted once at the app root. */
export function ConfirmHost() {
  const req = useSyncExternalStore(
    (l) => {
      confirmListeners.add(l);
      return () => confirmListeners.delete(l);
    },
    () => confirming,
  );
  const done = (ok: boolean) => {
    req?.resolve(ok);
    setConfirming(null);
  };
  useEffect(() => {
    if (!req) return;
    // Capture phase, so Esc cancels only this dialog and not the sheet or panel under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      req.resolve(false);
      setConfirming(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);
  if (!req) return null;
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4" role="alertdialog" aria-modal="true" aria-label={req.title}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => done(false)} />
      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface shadow-xl p-5">
        <div className="font-display text-[15px] font-semibold">{req.title}</div>
        {req.body && <div className="mt-1.5 text-[13.5px] text-muted leading-relaxed">{req.body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => done(false)}>取消</Button>
          <Button autoFocus variant={req.danger ? "danger" : "primary"} onClick={() => done(true)}>
            {req.ok ?? "确定"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** An image shown full-screen over the page; click anywhere or Esc closes it. */
export function Lightbox({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);
  if (!src) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 safe-bottom" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg" />
      <button aria-label="关闭" onClick={onClose} className="absolute top-3 right-3 size-8 grid place-items-center rounded-full bg-black/50 text-white hover:bg-black/70">
        <X className="size-4" />
      </button>
    </div>
  );
}

/** A labelled control. Use `group` when it holds several controls (buttons, segmented), so the label isn't folded into their names. */
export function Field({ label, hint, children, group }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  const body = (
    <>
      <div className="text-[13px] font-medium">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </>
  );
  return group ? (
    <div role="group" aria-label={label} className="block space-y-1.5">
      {body}
    </div>
  ) : (
    <label className="block space-y-1.5">{body}</label>
  );
}

export const inputClass =
  "w-full rounded-lg bg-surface border border-line hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] focus:border-[var(--color-accent)] outline-none px-3 py-1.5 text-[13.5px] placeholder:text-muted transition-colors";

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative w-9 h-5 rounded-full transition shrink-0 disabled:opacity-40",
        checked ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_18%,transparent)]",
      )}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

/** `label` may be an icon; give such options a `title` so they keep an accessible name. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 p-0.5 rounded-md bg-surface-2 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          aria-label={o.title}
          onClick={() => onChange(o.value)}
          className={cx("flex-1 h-6 rounded text-[13px] font-medium transition border grid place-items-center", value === o.value ? "bg-surface border-line" : "border-transparent text-muted hover:text-[var(--text)]")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A block of a page under its heading (15px, like a settings group); blocks stack with `space-y-8`.
 * `small` is for blocks inside a sheet or panel, where the heading is a 12px muted label.
 */
export function Section({ title, action, children, small }: { title: string; action?: ReactNode; children: ReactNode; small?: boolean }) {
  return (
    <section className={small ? "space-y-1.5" : "space-y-2.5"}>
      <div className={cx("flex items-center gap-2", small ? "px-1" : "min-h-7")}>
        <h2 className={cx("flex-1", small ? "text-xs font-medium text-muted" : "text-[15px] font-semibold")}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A quiet text action at the right of a section heading (查看全部、新建…). */
export function SectionLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-[13px] text-muted hover:text-[var(--text)] [&_svg]:size-3.5">
      {children}
    </button>
  );
}

export function Row({ title, sub, right, onClick, icon }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; icon?: ReactNode }) {
  return (
    <div onClick={onClick} className={cx("flex items-center gap-3 px-3.5 py-2.5", onClick && "hover:bg-surface-2 active:bg-surface-2 cursor-pointer")}>
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="flex-1 min-w-0">
        <div className="truncate">{title}</div>
        {sub && <div className="text-xs text-muted truncate mt-0.5">{sub}</div>}
      </div>
      {right && <div className="shrink-0 text-muted">{right}</div>}
    </div>
  );
}

export function toast(message: string, tone: "ok" | "danger" = "ok"): void {
  window.dispatchEvent(new CustomEvent("constella:toast", { detail: { message, tone } }));
}

/**
 * A trigger that opens a floating panel (above it by default); closes on outside click or Escape.
 * `trigger` is the button's content; pass `triggerClassName` to restyle the button itself.
 */
export function Popover({
  label,
  trigger,
  children,
  className,
  triggerClassName,
  side = "top",
  align = "right",
}: {
  label: string;
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
  triggerClassName?: string;
  side?: "top" | "bottom";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={
          triggerClassName ??
          cx("flex items-center gap-1 h-7 px-1.5 rounded-md text-[13px] text-muted hover:text-[var(--text)] hover:bg-surface-2 tabular-nums", open && "bg-surface-2 text-[var(--text)]")
        }
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={cx(
            "absolute z-40 rounded-xl border border-line bg-surface shadow-xl",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A row in a dropdown menu: 16px icon, label, optional right-side hint. */
export function MenuItem({ icon, label, hint, onClick, danger }: { icon?: ReactNode; label: ReactNode; hint?: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cx("w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-left text-[13.5px] hover:bg-surface-2", danger && "text-danger")}>
      {icon && <span className="text-muted shrink-0 [&_svg]:size-4">{icon}</span>}
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="text-xs text-muted shrink-0">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-[var(--border)]" />;
}

/** A settings section: heading, then rows separated by hairlines. Sections stack with `space-y-8`. */
export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[15px] font-semibold pb-1.5">{title}</h2>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  );
}

/**
 * One setting: title + description on the left, its control on the right (stacks on narrow screens when `wide`).
 * `dense` is for rows in a long list (models, providers, devices) where each row is just a name and a few buttons.
 * With `onClick` the whole row opens something (an entry's details): hover tint, keyboard-activatable.
 */
export function SettingRow({ title, desc, children, wide, dense, onClick }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; wide?: boolean; dense?: boolean; onClick?: () => void }) {
  const press = onClick && {
    role: "button" as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
  };
  return (
    <div
      {...press}
      className={cx(
        "flex gap-x-6 gap-y-2",
        dense ? "py-2" : "py-3",
        wide ? "flex-col sm:flex-row sm:items-center" : "items-center",
        onClick && "-mx-2 px-2 rounded-md cursor-pointer hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="text-[13px] text-muted mt-0.5 leading-5">{desc}</div>}
      </div>
      {children != null && <div className="shrink-0 flex items-center gap-1.5">{children}</div>}
    </div>
  );
}

/**
 * Read-only state (可用 / 不可用 / 正常 / 进行中 / 已批准…): muted text after a small icon, no tinted chip.
 * ✓ ok, — muted, spinner busy, ● warn (needs you), ⚠ danger (text turns red too). `icon` swaps the glyph (🔒 for a locked vault).
 */
export function StatusText({ tone = "muted", icon, children, className }: { tone?: "ok" | "muted" | "warn" | "danger" | "busy"; icon?: ReactNode; children: ReactNode; className?: string }) {
  const Icon = { ok: Check, muted: Minus, warn: CircleDot, danger: CircleAlert, busy: Loader2 }[tone];
  const color = { ok: "text-ok", muted: "", warn: "text-warn", danger: "", busy: "" }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap", tone === "danger" ? "text-danger" : "text-muted", className)}>
      {icon ? (
        <span className={cx("shrink-0 [&_svg]:size-3.5", color)}>{icon}</span>
      ) : (
        <Icon className={cx("size-3.5 shrink-0", color, tone === "busy" && "animate-spin")} strokeWidth={2} />
      )}
      {children}
    </span>
  );
}

/**
 * Presence (在线 / 休眠 / 空闲 / 使用中 / 你在操作): a 6px dot, then muted text. `busy` pulses in the accent color;
 * `off` is a muted dot. Without children it is just the dot, with the state as its tooltip (`label`).
 */
export function StatusDot({ tone = "off", children, label, className }: { tone?: "ok" | "busy" | "warn" | "danger" | "off"; children?: ReactNode; label?: string; className?: string }) {
  const dot = {
    ok: "bg-[var(--ok)]",
    busy: "bg-accent pulse-dot",
    warn: "bg-[var(--warn)]",
    danger: "bg-[var(--danger)]",
    off: "bg-[color-mix(in_oklab,var(--muted)_70%,transparent)]",
  }[tone];
  if (children == null) return <span title={label} aria-label={label} role={label ? "img" : undefined} className={cx("size-1.5 rounded-full shrink-0", dot, className)} />;
  return (
    <span className={cx("inline-flex items-center gap-1.5 min-w-0 text-muted", className)}>
      <span className={cx("size-1.5 rounded-full shrink-0", dot)} />
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Checkbox drawn the same everywhere (the native one follows the OS theme): 16px, accent fill with a check when on. */
export function Checkbox({ checked, onChange, disabled, label, className }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        "size-4 shrink-0 grid place-items-center rounded border transition-colors disabled:opacity-45",
        checked ? "bg-accent border-transparent text-white" : "bg-surface border-[color-mix(in_oklab,var(--text)_30%,transparent)] hover:border-[color-mix(in_oklab,var(--text)_50%,transparent)]",
        className,
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </button>
  );
}

/** Sidebar / settings-nav item: neutral highlight when selected, fainter on hover. */
export function navItemClass(active: boolean): string {
  return cx(
    "flex items-center gap-2.5 px-2.5 rounded-md transition-colors",
    active ? "bg-[color-mix(in_oklab,var(--text)_9%,transparent)] text-[var(--text)]" : "text-[color-mix(in_oklab,var(--text)_80%,transparent)] hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]",
  );
}

/**
 * Underline tabs: different views of the same data (请求日志 / 模型 / …) or the parts of one object (对话 / 成果 / 管理).
 * `count` is shown as a muted number after the label (待处理 3). Labels keep one weight so switching doesn't shift them.
 */
export function Tabs<T extends string>({ value, options, onChange, right }: { value: T; options: { value: T; label: string; count?: number }[]; onChange: (v: T) => void; right?: ReactNode }) {
  return (
    <div role="tablist" className="flex items-end gap-5 border-b border-line">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("-mb-px pb-2 text-[13.5px] font-medium border-b-2 transition-colors whitespace-nowrap", value === o.value ? "border-[var(--color-accent)]" : "border-transparent text-muted hover:text-[var(--text)]")}
        >
          {o.label}
          {o.count != null && <span className="ml-1.5 text-muted font-normal tabular-nums">{o.count}</span>}
        </button>
      ))}
      {right && <div className="ml-auto pb-2 text-xs text-muted">{right}</div>}
    </div>
  );
}

/** A metric tile: small muted label on top, number below. */
export function StatTile({ label, value, sub, size = "lg" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; size?: "lg" | "sm" }) {
  return (
    <div className={cx("rounded-xl border border-line bg-surface min-w-0", size === "lg" ? "px-3.5 py-3" : "px-3.5 py-2.5")}>
      <div className="text-xs text-muted truncate">{label}</div>
      <div className={cx("tabular-nums truncate", size === "lg" ? "text-2xl font-semibold mt-1" : "text-base font-semibold mt-0.5")}>{value}</div>
      {sub && <div className="text-[11.5px] text-muted mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export interface SelectOption<T> {
  value: T;
  label: ReactNode;
  /** Options sharing a group are listed under its name (in order; keep a group's options together). */
  group?: string;
  disabled?: boolean;
}

/**
 * Dropdown: a bordered trigger with a chevron; the menu floats over the page (so sheets don't clip it), opens
 * above when there's no room below, and marks the current value with a check. Focus stays on the trigger
 * (select-only combobox): arrows / Home / End move, Enter or Space picks, Esc closes.
 * Give it a width with `className` (`w-36` in settings rows, `w-full` in forms); `label` names it when no <label> does.
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
  disabled,
  size = "md",
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  label?: string;
  className?: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  const show = () => {
    if (disabled || !options.length) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  const hide = () => {
    setOpen(false);
    setPos(null);
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    hide();
    if (o.value !== value) onChange(o.value);
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (!options[i]!.disabled) return i;
    return from;
  };

  // Place the menu under the trigger (above when it doesn't fit), left edges aligned unless that runs off screen.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      const m = menu.current;
      if (!r || !m) return;
      const h = m.offsetHeight;
      const w = Math.max(m.offsetWidth, r.width);
      const up = r.bottom + 4 + h > innerHeight - 8 && r.top - 4 - h >= 8;
      const left = r.left + w > innerWidth - 8 ? Math.max(8, r.right - w) : r.left;
      setPos({ left, top: up ? r.top - 4 - h : r.bottom + 4, width: r.width });
    };
    place();
    const onScroll = (e: Event) => !menu.current?.contains(e.target as Node) && place();
    const onDown = (e: PointerEvent) => !btn.current?.contains(e.target as Node) && !menu.current?.contains(e.target as Node) && hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((a) => step(a, 1)),
      ArrowUp: () => setActive((a) => step(a, -1)),
      Home: () => setActive(step(-1, 1)),
      End: () => setActive(step(options.length, -1)),
      Enter: () => pick(active),
      " ": () => pick(active),
      Escape: hide,
    };
    if (e.key === "Tab") hide();
    else if (keys[e.key]) {
      e.preventDefault();
      e.stopPropagation(); // Esc closes the menu, not the sheet around it
      keys[e.key]!();
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKey}
        onKeyUp={(e) => e.key === " " && e.preventDefault()}
        className={cx(
          "inline-flex items-center gap-2 border border-line bg-surface text-left outline-none transition-colors disabled:opacity-50",
          "hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] focus-visible:border-[var(--color-accent)]",
          open && "border-[color-mix(in_oklab,var(--text)_25%,transparent)]",
          size === "sm" ? "h-7 pl-2 pr-1.5 rounded-md text-xs" : "h-8 pl-3 pr-2 rounded-lg text-[13.5px]",
          className,
        )}
      >
        <span className={cx("flex-1 min-w-0 truncate", !current && "text-muted")}>{current?.label ?? "选择…"}</span>
        <ChevronDown className="size-4 shrink-0 text-muted" strokeWidth={1.8} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="listbox"
            aria-label={label}
            onMouseDown={(e) => e.preventDefault()}
            style={pos ? { left: pos.left, top: pos.top, minWidth: pos.width } : { left: 0, top: 0, visibility: "hidden" }}
            className="fixed z-[60] w-max max-w-[min(24rem,calc(100vw-16px))] max-h-72 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl p-1"
          >
            {options.map((o, i) => (
              <div key={String(o.value)}>
                {o.group != null && o.group !== options[i - 1]?.group && <div className={cx("px-2.5 pb-1 text-xs text-muted truncate", i > 0 ? "pt-2.5" : "pt-1.5")}>{o.group}</div>}
                <div
                  id={`${id}-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => pick(i)}
                  className={cx(
                    "flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-md text-[13.5px] select-none",
                    o.disabled ? "opacity-45" : "cursor-pointer",
                    i === active && !o.disabled && "bg-surface-2",
                  )}
                >
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                  <Check className={cx("size-4 shrink-0", o.value !== value && "invisible")} strokeWidth={1.8} />
                </div>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

