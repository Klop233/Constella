import { Check } from "lucide-react";
import { IDLE_LABEL, KIND_INFO, KINDS, SIZE_PRESETS } from "../lib/instances";
import type { Agent, DesktopKind, DesktopOptions, HostCaps, IdleAction } from "../lib/types";
import { Field, Segmented, Toggle, cx, inputClass } from "./ui";

export interface InstanceDraft {
  name: string;
  kind: DesktopKind;
  options: DesktopOptions;
  agentIds: string[];
}

/** Fields for creating an instance or changing one (`editing`: kind and Android backend are fixed). */
export function InstanceFields({
  draft,
  onChange,
  caps,
  agents,
  editing,
}: {
  draft: InstanceDraft;
  onChange: (d: InstanceDraft) => void;
  caps: HostCaps | undefined;
  agents: Agent[] | undefined;
  editing?: boolean;
}) {
  const set = (o: Partial<DesktopOptions>) => onChange({ ...draft, options: { ...draft.options, ...o } });
  const presets = SIZE_PRESETS[draft.kind];
  const size = presets.find((p) => p.width === (draft.options.width ?? presets[0]!.width) && p.height === (draft.options.height ?? presets[0]!.height));
  const backend = draft.kind === "android" ? (editing ? draft.options.backend : caps?.android.backend) ?? null : null;
  const bc = backend ? caps?.android[backend] : undefined;
  const avail = caps?.kinds[draft.kind];

  return (
    <div className="space-y-4">
      {!editing && (
        <Field group label="类型">
          <div className="grid grid-cols-1 gap-2">
            {KINDS.map((k) => {
              const info = KIND_INFO[k];
              const a = caps?.kinds[k];
              const disabled = !!caps && !a?.ok;
              return (
                <button
                  key={k}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ ...draft, kind: k, options: { idleAction: draft.options.idleAction } })}
                  className={cx(
                    "flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition disabled:opacity-50",
                    draft.kind === k ? "border-[var(--color-accent)] bg-surface-2" : "border-line hover:bg-surface-2",
                  )}
                >
                  <info.icon className="size-5 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13.5px] font-medium">{info.label}</div>
                    <div className="text-xs text-muted">{disabled ? a?.reason : info.hint}</div>
                  </div>
                  {draft.kind === k && <Check className="size-4 mt-0.5 text-accent" />}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      <Field label="名字">
        <input className={inputClass} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder={KIND_INFO[draft.kind].label} maxLength={40} />
      </Field>
      <Field group label="屏幕">
        <Segmented
          value={size?.label ?? "custom"}
          onChange={(v) => {
            const p = presets.find((x) => x.label === v);
            if (p) set({ width: p.width, height: p.height, ...(draft.kind === "android" ? { dpi: p.dpi } : {}) });
          }}
          options={[
            ...presets.map((p) => ({ value: p.label, label: p.label })),
            ...(size ? [] : [{ value: "custom", label: `${draft.options.width}×${draft.options.height}` }]),
          ]}
        />
      </Field>
      {draft.kind === "android" && (
        <div className="space-y-3">
          <div className="text-xs text-muted">
            {backend ? `由${backend === "redroid" ? " Redroid（容器）" : "模拟器（KVM）"}运行` : (avail?.reason ?? "正在检测这台服务器能否运行安卓")}
            {editing && "，创建后不能更换"}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[13.5px]">ARM 转译</div>
              <div className="text-xs text-muted">
                {backend === "emulator" ? "模拟器自带，始终开启" : bc && !bc.arm ? "镜像里没有，需要先用 --arm 构建" : "运行只有 ARM 版本的 App（多数国内 App 需要）"}
              </div>
            </div>
            <Toggle
              label="ARM 转译"
              checked={backend === "emulator" || (draft.options.armTranslation ?? !!bc?.arm)}
              disabled={backend === "emulator" || !bc?.arm}
              onChange={(v) => set({ armTranslation: v })}
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[13.5px]">Google Play</div>
              <div className="text-xs text-muted">
                {bc && !bc.googlePlay
                  ? "还没有带 Google Play 的镜像，需要先构建"
                  : backend === "emulator" && editing
                    ? "切换会重建这台模拟器，数据会清空"
                    : "Google 服务和应用商店；第一次登录前要在 Google 登记设备"}
              </div>
            </div>
            <Toggle label="Google Play" checked={!!draft.options.googlePlay} disabled={!bc?.googlePlay && !draft.options.googlePlay} onChange={(v) => set({ googlePlay: v })} />
          </div>
          {bc?.warnings?.map((w) => (
            <div key={w} className="text-xs text-warn">
              {w}
            </div>
          ))}
        </div>
      )}
      <Field group label="闲置时" hint="「暂停」冻结实例、保留内存，恢复只要几秒；「停止」释放内存，下次要重新启动">
        <Segmented<IdleAction | "default">
          value={draft.options.idleAction ?? "default"}
          onChange={(v) => set({ idleAction: v === "default" ? undefined : v })}
          options={(["default", "pause", "stop", "none"] as const).map((v) => ({ value: v, label: IDLE_LABEL[v] }))}
        />
      </Field>
      {!!agents?.length && (
        <Field group label="给哪些 agent 用" hint="agent 也可以自己新建实例">
          <div className="flex flex-wrap gap-1.5">
            {agents.map((a) => {
              const on = draft.agentIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onChange({ ...draft, agentIds: on ? draft.agentIds.filter((x) => x !== a.id) : [...draft.agentIds, a.id] })}
                  className={cx("h-7 px-2.5 rounded-full border text-[13px] transition", on ? "border-[var(--color-accent)] bg-surface-2" : "border-line text-muted hover:text-[var(--text)]")}
                >
                  {a.emoji} {a.name}
                </button>
              );
            })}
          </div>
        </Field>
      )}
    </div>
  );
}
