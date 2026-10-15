import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, KeyRound, Loader2, MessageCircleQuestion, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Approval, SecretSpec } from "../lib/types";
import { Badge, Button, Card, cx, inputClass, toast } from "./ui";

const KIND: Record<string, string> = {
  command: "执行命令",
  file_change: "修改文件",
  host_access: "宿主机操作",
  desktop: "实例操作",
  other: "操作",
};

export function ApprovalCard({ approval, showAgent = true, onResolved, className, extra }: { approval: Approval; showAgent?: boolean; onResolved?: () => void; className?: string; extra?: React.ReactNode }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: "approve" | "deny", answer?: string) => {
    setBusy(answer ?? decision);
    try {
      await api.post(`/api/approvals/${approval.id}`, { decision, ...(answer !== undefined ? { answer } : {}) });
      toast(approval.kind === "decision" ? (decision === "deny" ? "已交给它自己判断" : "已回答") : decision === "approve" ? "已批准" : "已拒绝");
      void qc.invalidateQueries({ queryKey: ["overview"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      onResolved?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  const head = (icon: React.ReactNode, label: string) => (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span className="font-medium">{label}</span>
      {showAgent && approval.agent_name && (
        <span className="text-muted truncate">
          · {approval.agent_emoji} {approval.agent_name}
        </span>
      )}
      <span className="ml-auto text-xs text-muted shrink-0">{timeAgo(approval.created_at)}</span>
      {extra}
    </div>
  );

  if (approval.kind === "secret" && approval.secret) {
    return (
      <Card className={cx("p-3.5 border-[color-mix(in_oklab,var(--warn)_45%,transparent)]", className)}>
        {head(<KeyRound className="size-4 text-warn" />, "需要你提供登录信息")}
        <SecretForm approval={approval} spec={approval.secret} onDone={() => {
          void qc.invalidateQueries({ queryKey: ["overview"] });
          void qc.invalidateQueries({ queryKey: ["approvals"] });
          onResolved?.();
        }} />
      </Card>
    );
  }

  if (approval.kind === "decision") {
    return (
      <Card className={cx("p-3.5 border-[color-mix(in_oklab,var(--warn)_45%,transparent)]", className)}>
        {head(<MessageCircleQuestion className="size-4 text-warn" />, "需要你选择")}
        <div className="mt-2 text-sm whitespace-pre-wrap">{approval.summary}</div>
        <DecisionOptions approval={approval} busy={busy} onPick={(answer) => void decide("approve", answer)} />
        <button type="button" disabled={!!busy} onClick={() => void decide("deny")} className="mt-2 text-xs text-muted hover:text-[var(--text)] disabled:opacity-50">
          {busy === "deny" ? "处理中…" : "不选了，让它自己判断"}
        </button>
      </Card>
    );
  }

  return (
    <Card className={cx("p-3.5 border-[color-mix(in_oklab,var(--warn)_45%,transparent)]", className)}>
      {head(<ShieldAlert className="size-4 text-warn" />, `${KIND[approval.kind] ?? "操作"}需要审批`)}
      <pre className="mt-2 text-[13px] font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-lg p-3 max-h-48 overflow-auto">{approval.summary}</pre>
      {approval.detail && <div className="mt-1.5 text-xs text-muted whitespace-pre-wrap">{approval.detail}</div>}
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <Button variant="secondary" loading={busy === "deny"} disabled={!!busy} onClick={() => decide("deny")}>
          拒绝
        </Button>
        <Button variant="primary" loading={busy === "approve"} disabled={!!busy} onClick={() => decide("approve")}>
          批准
        </Button>
      </div>
    </Card>
  );
}

/** The agent's options as one-tap rows, plus a line for answering in your own words. */
function DecisionOptions({ approval, busy, onPick }: { approval: Approval; busy: string | null; onPick: (answer: string) => void }) {
  const [own, setOwn] = useState("");
  return (
    <div className="mt-2.5 space-y-1.5">
      {(approval.options ?? []).map((o, i) => (
        <button
          key={o.label}
          type="button"
          disabled={!!busy}
          onClick={() => onPick(o.label)}
          className={cx(
            "w-full flex items-start gap-2 text-left rounded-lg border px-3 py-2 transition-colors disabled:opacity-60",
            i === approval.recommended ? "border-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]" : "border-line",
            "hover:bg-surface-2",
          )}
        >
          <span className="flex-1 min-w-0">
            <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
              {o.label}
              {i === approval.recommended && <Badge tone="accent">推荐</Badge>}
            </span>
            {o.detail && <span className="block text-xs text-muted mt-0.5">{o.detail}</span>}
          </span>
          {busy === o.label && <Loader2 className="size-4 animate-spin text-muted shrink-0 mt-0.5" />}
        </button>
      ))}
      <form
        className="flex items-center gap-1 rounded-lg border border-line bg-surface pl-3 pr-1 focus-within:border-[var(--color-accent)]"
        onSubmit={(e) => {
          e.preventDefault();
          if (own.trim()) onPick(own.trim());
        }}
      >
        <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder="或者直接写你的回答" className="flex-1 min-w-0 h-8 bg-transparent text-[13.5px] outline-none placeholder:text-muted" />
        <button type="submit" aria-label="发送回答" disabled={!own.trim() || !!busy} className={cx("size-6 grid place-items-center rounded-md shrink-0", own.trim() ? "bg-accent text-white" : "bg-surface-2 text-muted")}>
          <ArrowUp className="size-3.5" strokeWidth={2.4} />
        </button>
      </form>
    </div>
  );
}

/**
 * The inputs for a login the agent needs (nothing typed here goes into the chat record or the model's context:
 * it is sent to the hub, which fills it straight into the page), or one tap to use a matching vault item.
 */
function SecretForm({ approval, spec, onDone }: { approval: Approval; spec: SecretSpec; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"submit" | "vault" | "deny" | null>(null);
  const ready = spec.fields.every((f) => (values[f.name] ?? "") !== "");
  const run = async (kind: "submit" | "vault" | "deny", call: () => Promise<unknown>, done: string) => {
    setBusy(kind);
    try {
      await call();
      toast(done);
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  return (
    <form
      className="mt-2 space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void run("submit", () => api.post(`/api/approvals/${approval.id}/secret`, { values }), "已提供");
      }}
    >
      <div className="text-sm whitespace-pre-wrap">{approval.summary}</div>
      {spec.note && <div className="text-xs text-muted">{spec.note}</div>}
      {spec.vault && (
        <Button
          type="button"
          variant="primary"
          className="w-full"
          loading={busy === "vault"}
          disabled={!!busy}
          onClick={() => void run("vault", () => api.post(`/api/approvals/${approval.id}`, { decision: "approve" }), "已允许")}
        >
          使用密码库里的「{spec.vault.name}」{spec.vault.username ? `（${spec.vault.username}）` : ""}
        </Button>
      )}
      <div className="space-y-2">
        {spec.fields.map((f) => (
          <label key={f.name} className="block space-y-1">
            <span className="text-xs text-muted">{f.label}</span>
            <input
              type={f.secret ? "password" : "text"}
              name={f.name}
              value={values[f.name] ?? ""}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              autoComplete={f.secret ? "new-password" : "off"}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={!!busy}
              className={inputClass}
            />
          </label>
        ))}
      </div>
      <div className="text-xs text-muted">{spec.target ? `用于 ${spec.target}。` : ""}只会填进页面，不会写进聊天记录，也不会给到模型。</div>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="secondary" loading={busy === "deny"} disabled={!!busy} onClick={() => void run("deny", () => api.post(`/api/approvals/${approval.id}`, { decision: "deny" }), "已告诉它不提供")}>
          不提供
        </Button>
        <Button type="submit" variant={spec.vault ? "secondary" : "primary"} loading={busy === "submit"} disabled={!ready || !!busy}>
          提交
        </Button>
      </div>
    </form>
  );
}
