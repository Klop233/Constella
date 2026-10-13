import { ChevronLeft, Loader2, X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useNavigate } from "react-router";

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent text-white hover:brightness-95 active:brightness-90 disabled:opacity-50",
    secondary: "bg-surface border border-line hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
    ghost: "hover:bg-surface-2 active:bg-surface-2 disabled:opacity-50",
    danger: "bg-[var(--danger)] text-white active:opacity-85 disabled:opacity-50",
  };
  const sizes = { sm: "h-8 px-3 text-sm rounded-md", md: "h-10 px-4 text-[15px] rounded-lg", lg: "h-12 px-5 text-base rounded-xl" };
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
  return <span className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
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
    <div className="flex flex-col items-center text-center px-8 py-14 gap-2">
      {icon && <div className="text-muted mb-1">{icon}</div>}
      <div className="font-serif text-lg">{title}</div>
      {hint && <div className="text-sm text-muted">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Header({ title, back, right, sub }: { title: ReactNode; back?: boolean | string; right?: ReactNode; sub?: ReactNode }) {
  const nav = useNavigate();
  return (
    <header className="safe-top sticky top-0 z-20 bg-app/90 backdrop-blur-md">
      <div className="h-14 flex items-center gap-1 px-2">
        {back ? (
          <button aria-label="返回" className="size-10 grid place-items-center rounded-lg hover:bg-surface-2 active:bg-surface-2" onClick={() => (typeof back === "string" ? nav(back) : history.length > 1 ? nav(-1) : nav("/"))}>
            <ChevronLeft className="size-6" />
          </button>
        ) : (
          <div className="w-2" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-serif font-medium text-[18px] truncate">{title}</div>
          {sub && <div className="text-xs text-muted truncate -mt-0.5">{sub}</div>}
        </div>
        <div className="flex items-center gap-1 pr-1">{right}</div>
      </div>
    </header>
  );
}

export function IconButton({ label, onClick, children, className }: { label: string; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className={cx("size-10 grid place-items-center rounded-lg text-muted hover:text-[var(--text)] hover:bg-surface-2 active:bg-surface-2", className)}>
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
      <div className="relative w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto bg-surface border border-line shadow-2xl rounded-t-2xl sm:rounded-2xl safe-bottom">
        <div className="sticky top-0 bg-surface flex items-center px-5 pt-4 pb-2 z-10">
          <div className="flex-1 font-serif font-medium text-xl">{title}</div>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="px-5 pb-6">{children}</div>
      </div>
    </div>
  );
}

/** A labelled control. Use `group` when it holds several controls (buttons, segmented), so the label isn't folded into their names. */
export function Field({ label, hint, children, group }: { label: string; hint?: ReactNode; children: ReactNode; group?: boolean }) {
  const body = (
    <>
      <div className="text-sm font-medium">{label}</div>
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
  "w-full rounded-lg bg-surface border border-line hover:border-[color-mix(in_oklab,var(--text)_25%,transparent)] focus:border-[var(--color-accent)] outline-none px-3.5 py-2.5 text-[15px] placeholder:text-muted transition-colors";

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx("relative w-12 h-7 rounded-full transition shrink-0", checked ? "bg-accent" : "bg-[color-mix(in_oklab,var(--text)_18%,transparent)]")}
    >
      <span className={cx("absolute top-0.5 size-6 rounded-full bg-white shadow transition", checked ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex p-1 rounded-lg bg-surface-2 gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx("flex-1 h-8 rounded-md text-sm font-medium transition", value === o.value ? "bg-surface shadow-sm" : "text-muted hover:text-[var(--text)]")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center px-1">
        <h2 className="flex-1 text-[13px] font-medium text-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Row({ title, sub, right, onClick, icon }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; onClick?: () => void; icon?: ReactNode }) {
  return (
    <div onClick={onClick} className={cx("flex items-center gap-3 px-4 py-3", onClick && "hover:bg-surface-2 active:bg-surface-2 cursor-pointer")}>
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
