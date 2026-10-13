import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import type { Approval } from "../lib/types";
import { Button, Card, toast } from "./ui";

const KIND: Record<string, string> = {
  command: "执行命令",
  file_change: "修改文件",
  host_access: "宿主机操作",
  desktop: "桌面操作",
  other: "操作",
};

export function ApprovalCard({ approval, showAgent = true, onResolved }: { approval: Approval; showAgent?: boolean; onResolved?: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const decide = async (decision: "approve" | "deny") => {
    setBusy(decision);
    try {
      await api.post(`/api/approvals/${approval.id}`, { decision });
      toast(decision === "approve" ? "已批准" : "已拒绝");
      void qc.invalidateQueries({ queryKey: ["overview"] });
      onResolved?.();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-4 border-[color-mix(in_oklab,var(--warn)_45%,transparent)]">
      <div className="flex items-center gap-2 text-sm">
        <ShieldAlert className="size-4 text-warn" />
        <span className="font-medium">{KIND[approval.kind] ?? "操作"}需要审批</span>
        {showAgent && approval.agent_name && (
          <span className="text-muted truncate">
            · {approval.agent_emoji} {approval.agent_name}
          </span>
        )}
        <span className="ml-auto text-xs text-muted shrink-0">{timeAgo(approval.created_at)}</span>
      </div>
      <pre className="mt-2 text-[13px] font-mono whitespace-pre-wrap break-all bg-surface-2 rounded-xl p-3 max-h-48 overflow-auto">{approval.summary}</pre>
      {approval.detail && <div className="mt-1.5 text-xs text-muted whitespace-pre-wrap">{approval.detail}</div>}
      <div className="mt-3 grid grid-cols-2 gap-2">
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
