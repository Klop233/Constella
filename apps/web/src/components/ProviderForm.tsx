import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Provider, ProviderApi } from "../lib/models";
import { API_LABEL, PROVIDER_PRESETS } from "../lib/providers";
import { Button, Field, Segmented, cx, inputClass, toast } from "./ui";

const BLANK = { name: "", baseUrl: "", apiKey: "", api: "chat" as ProviderApi };

/** Add or edit a model service: pick a preset (or 自定义), fill in the address and key, choose the API format. */
export function ProviderForm({ provider, onSaved, submitLabel }: { provider: Provider | null; onSaved: (p: Provider, created: boolean) => void; submitLabel?: string }) {
  const isNew = !provider;
  const [preset, setPreset] = useState<string>("custom");
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPreset("custom");
    setForm(provider ? { name: provider.name, baseUrl: provider.baseUrl, apiKey: "", api: provider.api } : BLANK);
  }, [provider]);

  const chosen = PROVIDER_PRESETS.find((p) => p.id === preset);
  const pick = (id: string) => {
    setPreset(id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    setForm((f) => (p ? { ...f, name: p.name, baseUrl: p.baseUrl, api: p.api } : { ...BLANK, apiKey: f.apiKey }));
  };
  const submit = async () => {
    setBusy(true);
    try {
      const body = isNew ? form : { name: form.name, baseUrl: form.baseUrl, api: form.api, ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
      const p = isNew ? await api.post<Provider>("/api/providers", body) : await api.patch<Provider>(`/api/providers/${provider.id}`, body);
      onSaved(p, isNew);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {isNew && (
        <Field group label="服务商">
          <div className="flex flex-wrap gap-1.5">
            {[...PROVIDER_PRESETS, { id: "custom", name: "自定义" }].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pick(p.id)}
                className={cx(
                  "h-7 px-2.5 rounded-md border text-[13px] transition-colors",
                  preset === p.id ? "border-[var(--color-accent)] bg-[color-mix(in_oklab,var(--text)_9%,transparent)]" : "border-line text-muted hover:text-[var(--text)]",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
        </Field>
      )}
      <Field label="名称" hint="会出现在模型显示名里，比如 deepseek-chat (DeepSeek)">
        <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={40} placeholder="我的服务" />
      </Field>
      <Field
        label="地址"
        hint={
          chosen?.local
            ? "和 Constella 在同一台服务器上时，用 host.docker.internal 代替 localhost；端口按你的实际部署改"
            : "OpenAI 兼容的 API 地址，一般以 /v1 结尾"
        }
      >
        <input className={cx(inputClass, "font-mono")} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" autoComplete="off" />
      </Field>
      <Field
        label="API Key"
        hint={
          <>
            {isNew ? (chosen?.local ? "没有可以留空" : "只保存在服务器上，加密存储") : `留空不修改${provider.keyHint ? `（当前 ${provider.keyHint}）` : ""}`}
            {chosen?.keyUrl && (
              <a href={chosen.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 ml-2 text-accent hover:underline">
                获取 Key <ExternalLink className="size-3" />
              </a>
            )}
          </>
        }
      >
        <input className={cx(inputClass, "font-mono")} type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="off" />
      </Field>
      <Field group label="接口格式" hint="大多数服务用 Chat Completions；OpenAI 官方和支持它的网关可以选 Responses，工具调用更原生。不确定就保持预设，测试不通过再换">
        <Segmented<ProviderApi>
          value={form.api}
          onChange={(v) => setForm({ ...form, api: v })}
          options={(["chat", "responses"] as const).map((v) => ({ value: v, label: API_LABEL[v] }))}
        />
      </Field>
      <Button variant="primary" className="w-full" loading={busy} disabled={!form.name.trim() || !form.baseUrl.trim()} onClick={() => void submit()}>
        {submitLabel ?? (isNew ? "添加" : "保存")}
      </Button>
    </div>
  );
}
