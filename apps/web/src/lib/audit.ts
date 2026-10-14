import type { AuditEntry } from "./types";

/** Readable names for audit actions; unknown ones show as-is. */
export const AUDIT_ACTION: Record<string, string> = {
  "auth.setup": "创建账号",
  "auth.login": "登录",
  "auth.password.change": "修改密码",
  "auth.totp.enable": "开启两步验证",
  "auth.totp.disable": "关闭两步验证",
  "auth.passkey.add": "添加通行密钥",
  "auth.passkey.delete": "删除通行密钥",
  "auth.session.revoke": "下线设备",
  "agent.create": "新建 agent",
  "agent.update": "修改 agent",
  "agent.archive": "删除 agent",
  "agent.secret.set": "设置 agent 密钥",
  "agent.secret.delete": "删除 agent 密钥",
  "agent.newapi_token": "生成 agent 专属令牌",
  "approval.approve": "批准操作",
  "approval.deny": "拒绝操作",
  "decision.answer": "回答 agent 的问题",
  "decision.dismiss": "让 agent 自己判断",
  "run.interrupt": "停止任务",
  "run.auto_resume": "安排自动继续",
  "run.auto_resume_stalled": "自动继续没有进展，已暂停",
  "desktop.create": "新建桌面",
  "desktop.delete": "删除桌面",
  "desktop.takeover": "接管桌面",
  "desktop.handback": "交还桌面",
  "schedule.create": "新建定时任务",
  "schedule.update": "修改定时任务",
  "schedule.delete": "删除定时任务",
  "settings.update": "修改设置",
  "provider.create": "添加 provider",
  "provider.update": "修改 provider",
  "provider.delete": "删除 provider",
  "models.add": "添加模型",
  "models.remove": "移除模型",
  "runner.start_failed": "任务启动失败",
  "runner.repair": "修复 runner（重建容器）",
  "runner.repaired": "修复成功，任务继续",
  "runner.repair_failed": "修复后仍无法启动",
  "runner.revive_failed": "runner 没能自己恢复",
  "incident.start_failure": "记录启动失败",
  "incident.engine_error": "出错，生成诊断报告",
  "incident.stalled": "停滞，生成诊断报告",
  "incident.stuck": "记录任务卡住",
  "incident.diagnosed": "诊断完成",
  "incident.adopt": "采用方案",
  "incident.dismiss": "忽略报告",
  "supervisor.wait": "监督员：继续等待",
  "supervisor.kill": "监督员：结束卡住的进程",
  "supervisor.hint": "监督员：提醒 agent",
  "supervisor.restart": "监督员：重启这一轮",
  "supervisor.rebuild": "监督员：重建 agent 容器",
  "supervisor.escalate": "监督员：请你决定",
};

/** Field names in the `fields` / `changes` of settings.update and agent.update details, and other detail keys. */
export const AUDIT_FIELD: Record<string, string> = {
  defaultModel: "默认模型",
  reflectModel: "复盘模型",
  defaultEffort: "默认推理强度",
  autoResume: "自动继续",
  maxAutoResumes: "连续无进展上限",
  runTimeoutMinutes: "单轮最长运行",
  runWatchdogMinutes: "卡住处理",
  approvalMode: "审批方式",
  agentIdleMinutes: "agent 闲置休眠",
  desktopIdleMinutes: "桌面闲置关闭",
  autoReflect: "自动复盘",
  reflectMinToolCalls: "复盘门槛",
  browserHtml: "网页读取方式",
  notifyOn: "推送事项",
  quietHours: "免打扰",
  backupKeep: "备份保留",
  modelNameFormat: "显示名格式",
  newapiAdminToken: "new-api 管理令牌",
  newapiAdminUserId: "new-api 用户 ID",
  telegramBotToken: "Telegram 机器人",
  telegramChatId: "Telegram 会话",
  name: "名字",
  emoji: "图标",
  template: "模板",
  persona: "人设",
  model: "模型",
  effort: "推理强度",
  approvalPolicy: "命令审批",
  desktopPolicy: "桌面",
  hostAccess: "宿主机权限",
  budgetDailyUsd: "每日预算",
  cron: "时间",
  tz: "时区",
  enabled: "启用",
  payload: "任务内容",
};

/** Detail keys that aren't settings fields: their label when shown under 详情. */
const DETAIL_KEY: Record<string, string> = {
  id: "编号",
  name: "名字",
  title: "标题",
  cron: "时间",
  provider: "提供方",
  count: "数量",
  ref: "模型",
  note: "备注",
  error: "错误",
  reason: "原因",
  assessment: "评估",
  did: "已做的处理",
  option: "方案",
  options: "方案",
  action: "动作",
  answer: "回答",
  steps: "步骤",
  state: "容器状态",
  logs: "容器日志",
  status: "状态",
  attempts: "尝试次数",
  dueAt: "计划时间",
  tokenId: "令牌编号",
  rpID: "站点",
  device: "设备",
  deviceIp: "设备 IP",
  ip: "IP",
  agentId: "agent 编号",
  runId: "任务编号",
  conversationId: "对话编号",
  approvalId: "审批编号",
  pinnedAgentId: "固定的 agent",
};

const SUB_FIELD: Record<string, Record<string, string>> = {
  notifyOn: { approval: "审批和选择", done: "任务完成", failed: "任务失败", stuck: "任务卡住" },
  quietHours: { enabled: "开关", start: "开始", end: "结束" },
  desktopPolicy: { mode: "方式", desktopId: "桌面" },
};

/** Values of enum-like fields, as the forms label them. */
const VALUE_TEXT: Record<string, Record<string, string>> = {
  approvalMode: { ask: "每次询问", smart: "智能", auto: "全部自动" },
  approvalPolicy: { auto: "自动执行（容器内）", ask: "每条都问我" },
  modelNameFormat: { paren: "model (provider)", dash: "model - provider" },
  "desktopPolicy.mode": { none: "不用", on_demand: "按需借用", fixed: "固定一台" },
  effort: { low: "低", medium: "中", high: "高", xhigh: "极高" },
  defaultEffort: { low: "低", medium: "中", high: "高", xhigh: "极高" },
};

export const APPROVAL_KIND: Record<string, string> = {
  command: "执行命令",
  file_change: "修改文件",
  host_access: "宿主机操作",
  desktop: "桌面操作",
  decision: "选择",
  other: "操作",
};

export const INCIDENT_STATUS: Record<string, string> = { analyzing: "分析中", open: "待处理", auto: "已自动处理", adopted: "已采用方案", dismissed: "已忽略" };

export const APPROVAL_STATUS: Record<string, string> = { pending: "待处理", approved: "已批准", denied: "已拒绝" };

const ACTOR: Record<string, string> = { system: "系统", supervisor: "监督员", watchdog: "超时保护", policy: "自动审批" };

export interface AuditChange {
  from?: unknown;
  to?: unknown;
  secret?: boolean;
}

/** Entry detail, parsed; `{}` when there is none or it isn't an object. */
export function auditDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const d = JSON.parse(detail);
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function auditAction(action: string): string {
  return AUDIT_ACTION[action] ?? action;
}

/** Who did it: the owner, the hub itself, or an agent (looked up by id). */
export function auditActor(actor: string, agents: { id: string; name: string }[] = []): string {
  if (ACTOR[actor]) return ACTOR[actor]!;
  if (actor.startsWith("us_") || actor === "anonymous") return "你";
  const id = actor.startsWith("agent:") ? actor.slice(6) : actor;
  return agents.find((a) => a.id === id)?.name ?? (actor.startsWith("agent:") ? "agent" : actor);
}

/** Label of a settings / agent field; `notifyOn.done` reads 「推送事项 · 任务完成」. */
export function fieldLabel(key: string): string {
  if (AUDIT_FIELD[key]) return AUDIT_FIELD[key]!;
  const [head, ...rest] = key.split(".");
  if (!rest.length) return DETAIL_KEY[key] ?? key;
  const tail = rest.join(".");
  return `${AUDIT_FIELD[head!] ?? head} · ${SUB_FIELD[head!]?.[tail] ?? tail}`;
}

export function detailKeyLabel(key: string): string {
  return DETAIL_KEY[key] ?? AUDIT_FIELD[key] ?? key;
}

/** One value the way a person reads it. `field` picks the enum labels (approvalMode, desktopPolicy.mode, …). */
export function auditValue(v: unknown, field?: string): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "开" : "关";
  if (typeof v === "string") return (field && VALUE_TEXT[field]?.[v]) || v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((x) => auditValue(x)).join("、");
  return JSON.stringify(v);
}

/** The recorded changes of an entry, in the order they were saved; empty for older entries that only list fields. */
export function auditChanges(detail: Record<string, unknown>): [string, AuditChange][] {
  const c = detail.changes;
  return c && typeof c === "object" ? (Object.entries(c as Record<string, AuditChange>)) : [];
}

export function auditVia(detail: Record<string, unknown>): { ip?: string; device?: string } | null {
  const v = detail.via;
  return v && typeof v === "object" ? (v as { ip?: string; device?: string }) : null;
}

const LEAD_KEYS = ["name", "title", "device"];
const TAIL_KEYS = ["assessment", "did", "option", "answer", "note", "reason", "error", "ref"];

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The one line under an entry's name in a list: what it was about and, for a change, what it became. */
export function auditSummary(e: Pick<AuditEntry, "detail" | "action">): string {
  const d = auditDetail(e.detail);
  const parts: string[] = [];
  const str = (k: string) => (typeof d[k] === "string" && d[k] ? clip(d[k] as string) : null);
  for (const k of LEAD_KEYS) {
    const v = str(k);
    if (v) parts.push(v);
  }
  const changes = auditChanges(d);
  if (changes.length === 1) {
    const [key, c] = changes[0]!;
    parts.push(c.secret ? `${fieldLabel(key)}：${c.to ? "已设置" : "已清除"}` : `${fieldLabel(key)}：${clip(auditValue(c.from, key))} → ${clip(auditValue(c.to, key))}`);
  } else if (changes.length) {
    parts.push([...new Set(changes.map(([k]) => fieldLabel(k)))].join("、"));
  } else if (Array.isArray(d.fields)) {
    parts.push([...new Set((d.fields as string[]).map(fieldLabel))].join("、"));
  }
  for (const k of TAIL_KEYS) {
    const v = str(k);
    if (v) parts.push(v);
  }
  if (Array.isArray(d.options)) parts.push(clip((d.options as unknown[]).join("、")));
  if (typeof d.ip === "string") parts.push(d.ip);
  else if (e.action.startsWith("provider.") && typeof d.id === "string") parts.push(d.id);
  return parts.join(" · ");
}
