import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { useProviders, type Provider } from "../lib/models";
import { API_LABEL } from "../lib/providers";
import { ProviderForm } from "./ProviderForm";
import { Button, Field, StatusText, cx, inputClass, toast } from "./ui";

const refOf = (model: string, provider: string) => (provider === "newapi" ? model : `${model}@${provider}`);

/**
 * Connect a model the way any AI client does: add a service (address + key), pick one of its models, run a real
 * test call, and make it the default. Used by the first-run wizard and the home checklist.
 */
export function ModelConnect({ onDone }: { onDone: (ref: string) => void }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState("");
  const [manual, setManual] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const remote = useQuery({
    queryKey: ["provider-models", provider?.id, provider?.baseUrl, provider?.keyHint],
    queryFn: () => api.get<string[]>(`/api/providers/${provider!.id}/models`),
    enabled: !!provider && !editing,
    retry: false,
  });

  const choose = (p: Provider) => {
    setProvider(p);
    setEditing(false);
    setModel("");
    setManual("");
    setFailure("");
    void qc.invalidateQueries({ queryKey: ["providers"] });
  };

  const name = manual.trim() || model;
  const connect = async () => {
    if (!provider || !name) return;
    setBusy(true);
    setFailure("");
    try {
      await api.post("/api/models", { provider: provider.id, models: [name] });
      const ref = refOf(name, provider.id);
      const r = await api.post<{ ok: boolean; error: string | null }>("/api/models/test", { ref });
      void qc.invalidateQueries({ queryKey: ["models"] });
      if (!r.ok) {
        setFailure(r.error ?? "测试没有通过");
        return;
      }
      await api.patch("/api/settings", { defaultModel: ref });
      void qc.invalidateQueries({ queryKey: ["settings"] });
      toast(`已连接 ${name}`);
      onDone(ref);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!provider || editing) {
    const others = (providers.data ?? []).filter((p) => p.id !== provider?.id);
    return (
      <div className="space-y-4">
        {!editing && others.length > 0 && (
          <Field group label="用已添加的服务商">
            <div className="flex flex-wrap gap-1.5">
              {others.map((p) => (
                <button key={p.id} type="button" onClick={() => choose(p)} className="h-7 px-2.5 rounded-md border border-line text-[13px] hover:bg-surface-2">
                  {p.name}
                </button>
              ))}
            </div>
          </Field>
        )}
        <ProviderForm provider={editing ? provider : null} submitLabel={editing ? "保存并重新读取模型" : "下一步：选模型"} onSaved={(p) => choose(p)} />
        {editing && (
          <button type="button" className="text-[13px] text-muted hover:text-[var(--text)]" onClick={() => setEditing(false)}>
            返回
          </button>
        )}
      </div>
    );
  }

  const list = (remote.data ?? []).filter((m) => m.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-medium">{provider.name}</span>
        <span className="text-muted truncate flex-1">
          {API_LABEL[provider.api]} · <span className="font-mono">{provider.baseUrl}</span>
        </span>
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          修改
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setProvider(null)}>
          换一个
        </Button>
      </div>
      <Field group label="选一个模型" hint="之后每个 agent、每个对话都能换；更多模型在「设置 → 模型」里添加">
        {(remote.data?.length ?? 0) > 8 && (
          <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface">
            <Search className="size-4 text-muted shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型" className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" />
          </label>
        )}
        <div className="max-h-60 overflow-y-auto rounded-lg border border-line divide-y divide-[var(--border)]">
          {remote.isLoading && <div className="px-3 py-2.5 text-[13px] text-muted">正在读取模型列表…</div>}
          {remote.error && <div className="px-3 py-2.5 text-[13px] text-danger">读不到模型列表：{(remote.error as Error).message}。可以在下面直接填模型名。</div>}
          {remote.data && !list.length && <div className="px-3 py-2.5 text-[13px] text-muted">没有列出模型，可以在下面直接填模型名</div>}
          {list.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setModel(m);
                setManual("");
                setFailure("");
              }}
              className={cx("w-full flex items-center gap-2 px-3 h-9 text-left text-[13px] hover:bg-surface-2", model === m && !manual && "bg-[color-mix(in_oklab,var(--text)_9%,transparent)]")}
            >
              <span className="flex-1 font-mono truncate">{m}</span>
              {model === m && !manual && <Check className="size-3.5 text-accent" />}
            </button>
          ))}
        </div>
      </Field>
      <Field label="或直接填模型名">
        <input className={cx(inputClass, "font-mono")} value={manual} onChange={(e) => setManual(e.target.value)} placeholder="deepseek-chat" autoComplete="off" />
      </Field>
      {failure && <StatusText tone="danger">测试没有通过：{failure}</StatusText>}
      <Button variant="primary" className="w-full" loading={busy} disabled={!name} onClick={() => void connect()}>
        {busy ? "正在测试…" : name ? `测试并使用 ${name}` : "测试并使用"}
      </Button>
    </div>
  );
}
