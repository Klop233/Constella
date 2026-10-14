import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Badge, Button, Sheet, cx, inputClass, toast } from "./ui";

interface PreviewItem {
  scope: "agent" | "user";
  text: string;
  status: "new" | "duplicate" | "capacity" | "unsafe";
  reason?: string;
  conflict: boolean;
}

interface Preview {
  items: PreviewItem[];
  dropped: { instructions: number; sensitive: number };
  budget: { user: { used: number; limit: number }; agent: { used: number; limit: number } };
}

const MAX_CHARS = 64 * 1024;

/** Run this in the assistant you're moving away from; the answer is what gets pasted back here. */
const EXPORT_PROMPT = `请导出你保存的关于我的所有记忆，以及你从过往对话中了解到的我的背景。尽量保留我的原话，尤其是我明确提过的要求和偏好。

## 按这个顺序分类输出：

1. **要求**：我明确让你今后遵守的规则——语气、格式、风格、"总是…""不要…"，以及我对你的纠正。只写来自已保存记忆的，不要从对话里推断。
2. **身份**：姓名、所在地、教育、语言、兴趣爱好。
3. **职业**：现在和过去的职位、公司、技能方向。
4. **项目**：我认真做过或投入过的项目。每个项目一条，写清它是什么、现在的状态、关键决定，用项目名开头。
5. **偏好**：长期适用的看法、口味和工作习惯。

## 格式：

每个分类用一个标题，每条一行，按时间从早到晚排序，格式：

[YYYY-MM-DD] - 内容

不知道日期就写 [unknown]。

## 输出：
- 把全部内容放进一个代码块里，方便复制。
- 代码块之后说明：这是完整的，还是还有剩余。`;

/**
 * Bring memory over from another assistant (ChatGPT, Claude, Gemini …): get its export, check what would be
 * kept, then add. Import only adds; sensitive details and instruction-like text are left out.
 */
export function MemoryImport({ open, onClose, agentId, agentName }: { open: boolean; onClose: () => void; agentId: string; agentName: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (open) return;
    setText("");
    setPreview(null);
    setPicked(new Set());
  }, [open]);

  const fail = (err: unknown) => toast(err instanceof Error ? err.message : String(err), "danger");

  const analyse = async () => {
    setBusy(true);
    try {
      const p = await api.post<Preview>(`/api/agents/${agentId}/memory/import/preview`, { text });
      setPreview(p);
      setPicked(new Set(p.items.flatMap((i, n) => (i.status === "new" && !i.conflict ? [n] : []))));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const items = preview.items.filter((_, n) => picked.has(n)).map(({ scope, text }) => ({ scope, text }));
      const r = await api.post<{ added: number; skipped: number }>(`/api/agents/${agentId}/memory/import`, { items });
      toast(r.added ? `已导入 ${r.added} 条，可以在「最近的改动」里撤销` : "没有新增内容");
      void qc.invalidateQueries({ queryKey: ["learning"] });
      void qc.invalidateQueries({ queryKey: ["knowledge"] });
      onClose();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(EXPORT_PROMPT);
      toast("已复制，去原来的助手里发送");
    } catch {
      toast("复制失败，请手动选中文字复制", "danger");
    }
  };

  const toggle = (n: number) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <Sheet open={open} onClose={onClose} title="导入记忆">
      {!preview ? (
        <div className="space-y-4">
          <p className="text-[13px] text-muted leading-relaxed">把你在 ChatGPT、Claude、Gemini 等助手里的记忆带过来。只会新增，已有的记忆不会被改动或删除。</p>

          <section className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h3 className="text-[13px] font-medium flex-1">① 在原来的助手里发送这段话</h3>
              <Button size="sm" variant="soft" onClick={copyPrompt}>
                <ClipboardCopy className="size-3.5" /> 复制
              </Button>
            </div>
            <pre className="max-h-32 overflow-y-auto rounded-lg bg-surface-2 p-2.5 text-[12px] leading-relaxed whitespace-pre-wrap">{EXPORT_PROMPT}</pre>
            <p className="text-xs text-muted">ChatGPT 也可以到「设置 → 个性化 → 管理记忆」里直接复制条目，同样可以粘贴到下面。</p>
          </section>

          <section className="space-y-1.5">
            <h3 className="text-[13px] font-medium">② 把它的回复粘贴到这里</h3>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="[2025-03-02] - 在做一个自托管的多 agent 平台…"
              className={cx(inputClass, "min-h-36 max-h-[40dvh] font-mono text-[12.5px]")}
            />
            <div className="flex items-center text-xs text-muted">
              <span className="flex-1">健康、财务、证件、住址等敏感信息，以及针对 AI 的指令不会导入。</span>
              <span className={cx("tabular-nums", text.length > MAX_CHARS && "text-danger")}>{Math.ceil(text.length / 1024)} / 64 KB</span>
            </div>
          </section>

          <Button variant="primary" className="w-full" disabled={!text.trim() || text.length > MAX_CHARS} loading={busy} onClick={analyse}>
            {busy ? "正在整理，可能要半分钟…" : "整理并预览"}
          </Button>
        </div>
      ) : (
        <Review
          preview={preview}
          agentName={agentName}
          picked={picked}
          busy={busy}
          onToggle={toggle}
          onBack={() => setPreview(null)}
          onCommit={commit}
        />
      )}
    </Sheet>
  );
}

function Review({
  preview,
  agentName,
  picked,
  busy,
  onToggle,
  onBack,
  onCommit,
}: {
  preview: Preview;
  agentName: string;
  picked: Set<number>;
  busy: boolean;
  onToggle: (n: number) => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const left = preview.dropped.instructions + preview.dropped.sensitive;
  const groups: { scope: "user" | "agent"; title: string }[] = [
    { scope: "user", title: "关于你（所有 agent 共享）" },
    { scope: "agent", title: `${agentName} 的记忆` },
  ];
  if (!preview.items.length) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-dashed border-line px-3.5 py-3 text-[13px] text-muted">
          没有整理出可以导入的内容{left ? `（略过了 ${left} 条敏感或指令类内容）` : ""}。确认粘贴的是记忆导出，或分成几次导入。
        </div>
        <Button className="w-full" onClick={onBack}>
          返回
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="text-[13px] leading-relaxed">
        整理出 <b>{preview.items.length}</b> 条，已选 <b>{picked.size}</b> 条。
        {left > 0 && <span className="text-muted"> 另外按设计略过了 {left} 条敏感或像指令的内容。</span>}
      </div>

      {groups.map(({ scope, title }) => {
        const rows = preview.items.map((it, n) => ({ it, n })).filter(({ it }) => it.scope === scope);
        if (!rows.length) return null;
        const b = preview.budget[scope];
        return (
          <section key={scope} className="space-y-1.5">
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-medium flex-1 truncate">{title}</h3>
              <span className="text-xs text-muted tabular-nums">
                已用 {b.used} / {b.limit} 字
              </span>
            </div>
            <div className="space-y-1.5">
              {rows.map(({ it, n }) => {
                const ok = it.status === "new";
                return (
                  <label key={n} className={cx("flex items-start gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] leading-snug", ok ? "bg-surface cursor-pointer hover:bg-surface-2" : "bg-surface-2 text-muted")}>
                    <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={picked.has(n)} disabled={!ok} onChange={() => onToggle(n)} />
                    <span className="flex-1 min-w-0">{it.text}</span>
                    <span className="shrink-0 flex gap-1">
                      {it.conflict && ok && <Badge tone="warn">与现有记忆冲突</Badge>}
                      {it.status === "duplicate" && <Badge>已有</Badge>}
                      {it.status === "capacity" && <Badge tone="warn">容量已满</Badge>}
                      {it.status === "unsafe" && <Badge tone="danger">{it.reason ?? "已拦截"}</Badge>}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
        );
      })}

      <div className="flex gap-2">
        <Button className="flex-1" onClick={onBack} disabled={busy}>
          返回
        </Button>
        <Button variant="primary" className="flex-[2]" disabled={!picked.size || busy} onClick={onCommit}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          导入 {picked.size} 条
        </Button>
      </div>
    </div>
  );
}
