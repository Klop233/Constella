import { ChevronLeft, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useNavigate } from "react-router";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "soft" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent-grad text-white hover:brightness-95 active:brightness-90 disabled:opacity-50",
    secondary: "bg-surface border border-line hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
    soft: "bg-surface-2 hover:bg-[color-mix(in_oklab,var(--text)_12%,transparent)] disabled:opacity-50",
    ghost: "hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
    danger: "bg-[var(--danger)] text-white active:opacity-85 disabled:opacity-50",
  };
  const sizes = { sm: "h-7 px-2.5 text-[13px] rounded-md", md: "h-8 px-3 text-[13.5px] rounded-md", lg: "h-10 px-4 text-sm rounded-lg" };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx("inline-flex items-center justify-center gap-1.5 font-medium transition select-none", styles[variant], sizes[size], className)}
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

export function Header({ title, back, backMobileOnly, right, sub }: { title: ReactNode; back?: boolean | string; backMobileOnly?: boolean; right?: ReactNode; sub?: ReactNode }) {
  const nav = useNavigate();
  return (
    <header className="safe-top sticky top-0 z-20 bg-app/90 backdrop-blur-md">
      <div className="h-12 flex items-center gap-1 px-2">
        {back ? (
          <button aria-label="返回" className={cx("size-8 grid place-items-center rounded-md hover:bg-surface-2 active:bg-surface-2", backMobileOnly && "lg:hidden")} onClick={() => (typeof back === "string" ? nav(back) : history.length > 1 ? nav(-1) : nav("/"))}>
            <ChevronLeft className="size-4" />
          </button>
        ) : (
          <div className="w-2" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-display font-semibold text-[15px] truncate">{title}</div>
          {sub && <div className="text-xs text-muted truncate -mt-0.5">{sub}</div>}
        </div>
        <div className="flex items-center gap-1 pr-1">{right}</div>
      </div>
    </header>
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

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative w-9 h-5 rounded-full transition shrink-0", checked ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_18%,transparent)]")}
    >
      <span className={cx("absolute top-0.5 size-4 rounded-full bg-white shadow transition", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex h-7 p-0.5 rounded-md bg-surface-2 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx("flex-1 h-6 rounded text-[13px] font-medium transition border", value === o.value ? "bg-surface border-line" : "border-transparent text-muted hover:text-[var(--text)]")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center px-1">
        <h2 className="flex-1 text-xs font-medium text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
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

/** A settings section: heading, then rows separated by hairlines. */
export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold pb-1">{title}</h2>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  );
}

/**
 * One setting: title + description on the left, its control on the right (stacks on narrow screens when `wide`).
 * `dense` is for rows in a long list (models, providers, devices) where each row is just a name and a few buttons.
 */
export function SettingRow({ title, desc, children, wide, dense }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; wide?: boolean; dense?: boolean }) {
  return (
    <div className={cx("flex gap-x-4 gap-y-1.5", dense ? "py-1.5" : "py-2.5", wide ? "flex-col sm:flex-row sm:items-center" : "items-center")}>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-medium">{title}</div>
        {desc && <div className="text-xs text-muted mt-px leading-snug">{desc}</div>}
      </div>
      {children != null && <div className="shrink-0 flex items-center gap-1.5">{children}</div>}
    </div>
  );
}

/** Sidebar / settings-nav item: neutral highlight when selected, fainter on hover. */
export function navItemClass(active: boolean): string {
  return cx(
    "flex items-center gap-2.5 px-2.5 rounded-md transition-colors",
    active ? "bg-[color-mix(in_oklab,var(--text)_9%,transparent)] text-[var(--text)]" : "text-[color-mix(in_oklab,var(--text)_80%,transparent)] hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]",
  );
}

/** Underline tabs: different views of the same data (请求日志 / 模型 / …). */
export function Tabs<T extends string>({ value, options, onChange, right }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; right?: ReactNode }) {
  return (
    <div className="flex items-end gap-5 border-b border-line">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("-mb-px pb-2 text-[13.5px] border-b-2 transition-colors", value === o.value ? "border-[var(--color-accent)] font-semibold" : "border-transparent text-muted hover:text-[var(--text)]")}
        >
          {o.label}
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

export const selectClass = "h-8 pl-2.5 pr-7 rounded-lg border border-line bg-surface text-[13px] outline-none hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)]";

