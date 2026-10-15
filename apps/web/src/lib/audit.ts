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
  "run.ending_review": "监督员：复核任务结束",
  "desktop.create": "新建实例",
  "desktop.update": "修改实例",
  "desktop.restart": "重启实例",
  "desktop.bulk": "批量暂停或停止实例",
  "desktop.delete": "删除实例",
  "desktop.takeover": "接管实例",
  "desktop.handback": "交还实例",
  "instance.repair": "修复实例",
  "instance.repair_failed": "修复实例没有成功",
  "instance.reset": "清空重建实例",
  "instance.op_failed": "实例操作没有成功",
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
  "incident.panic": "记录 panic（没做完就停下）",
  "incident.instance": "记录实例故障",
  "incident.help": "记录 agent 求助",
  "incident.diagnosed": "诊断完成",
  "incident.adopt": "采用方案",
  "incident.dismiss": "忽略报告",
  "supervisor.wait": "监督员：继续等待",
  "supervisor.kill": "监督员：结束卡住的进程",
  "supervisor.hint": "监督员：提醒 agent",
  "supervisor.restart": "监督员：重启这一轮",
  "supervisor.rebuild": "监督员：重建 agent 容器",
  "supervisor.escalate": "监督员：请你决定",
  "helper.call": "维修员：处理求助",
  "artifact.create": "保存交互界面为成果",
  "artifact.rename": "重命名成果",
  "artifact.edit": "编辑成果",
  "artifact.restore": "恢复成果的旧版本",
  "artifact.delete": "删除成果",
  "credentials.connection.create": "添加凭据连接",
  "credentials.connection.delete": "删除凭据连接",
  "credentials.settings": "指定凭据审批 agent",
  "credentials.unlock": "解锁密码库",
  "credentials.unlock.failed": "解锁密码库失败",
  "credentials.lock": "锁定密码库",
  "credentials.sync": "同步密码库",
  "credentials.request": "agent 申请凭据",
  "credentials.review.started": "审批 agent 开始审核凭据申请",
  "credentials.approve": "批准凭据访问",
  "credentials.deny": "拒绝凭据访问",
  "credentials.revoke": "撤销凭据访问",
  "credentials.read": "读取凭据",
  "credentials.read.failed": "读取凭据失败",
  "credentials.fill": "agent 登录时填入凭据",
  "credentials.save": "把登录信息存进密码库",
  "credentials.save.failed": "存进密码库失败",
  "secret.provide": "输入了 agent 需要的登录信息",
  "secret.vault": "允许 agent 使用密码库条目登录",
  "secret.decline": "拒绝提供 agent 需要的登录信息",
};

/** Field names in the `fields` / `changes` of settings.update and agent.update details, and other detail keys. */
export const AUDIT_FIELD: Record<string, string> = {
  defaultModel: "默认模型",
  reflectModel: "复盘模型",
  defaultEffort: "默认推理强度",
  autoResume: "自动继续",
  endingReview: "没做完就停下时拉回",
  maxAutoResumes: "连续无进展上限",
  runTimeoutMinutes: "单轮最长运行",
  runWatchdogMinutes: "卡住处理",
  approvalMode: "审批方式",
  permissions: "权限",
  agentIdleMinutes: "agent 闲置休眠",
  desktopIdleMinutes: "实例闲置时间",
  desktopIdleAction: "实例闲置时",
  androidBackend: "安卓运行方式",
  maxInstances: "实例总数上限",
  maxAndroidInstances: "安卓实例上限",
  instanceApproval: "agent 管理实例要我同意",
  autoReflect: "自动复盘",
  reflectMinToolCalls: "复盘门槛",
  browserHtml: "网页读取方式",
  intelligentUi: "智能界面",
  emojiUse: "表情符号用量",
  plainHeadings: "标题不用表情",
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
  desktopPolicy: "实例",
  options: "实例选项",
  agentIds: "分给的 agent",
  hostAccess: "宿主机权限",
  budgetDailyUsd: "每日预算",
  item: "凭据条目",
  connection: "凭据连接",
  requestId: "凭据请求",
  "login.username": "用户名",
  "login.password": "登录密码",
  "login.totp": "验证码",
  purpose: "用途",
  target: "使用目标",
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
  names: "实例",
  op: "操作",
  version: "版本",
  ref: "模型",
  note: "备注",
  error: "错误",
  reason: "原因",
  assessment: "评估",
  problem: "问题",
  diagnosis: "诊断",
  verdict: "结论",
  by: "发起",
  desktopId: "实例编号",
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
  kind: "类型",
  restarted: "已重启",
  wiped: "已清空数据",
  pinnedAgentId: "固定的 agent",
};

const SUB_FIELD: Record<string, Record<string, string>> = {
  notifyOn: { approval: "审批和选择", done: "任务完成", failed: "任务失败", stuck: "任务卡住", panic: "Panic" },
  quietHours: { enabled: "开关", start: "开始", end: "结束" },
  desktopPolicy: { desktopIds: "实例", mode: "方式", desktopId: "实例" },
  instanceApproval: { create: "新建", update: "修改" },
  permissions: { command: "执行命令", file_change: "修改文件", host_access: "在宿主机上执行命令", instance_create: "新建实例", instance_update: "修改实例" },
  options: {
    width: "屏幕宽",
    height: "屏幕高",
    dpi: "屏幕密度",
    backend: "运行方式",
    armTranslation: "ARM 转译",
    googlePlay: "Google Play",
    idleAction: "闲置时",
    idleMinutes: "闲置多久",
  },
};

/** Values of enum-like fields, as the forms label them. */
const VALUE_TEXT: Record<string, Record<string, string>> = {
  approvalMode: { ask: "每次询问", smart: "智能", auto: "全部自动" },
  ...Object.fromEntries(
    ["command", "file_change", "host_access", "instance_create", "instance_update"].map((k) => [`permissions.${k}`, { auto: "自动批准", smart: "危险时问我", ask: "每次问我" }]),
  ),
  intelligentUi: { off: "关闭", balanced: "适度", rich: "丰富" },
  emojiUse: { none: "不用", rare: "少用", some: "适度", free: "不限制" },
  approvalPolicy: { auto: "自动执行（容器内）", ask: "每条都问我" },
  modelNameFormat: { paren: "model (provider)", dash: "model - provider" },
  "desktopPolicy.mode": { none: "不用", on_demand: "按需借用", fixed: "固定一台" },
  effort: { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh" },
  defaultEffort: { low: "Low", medium: "Medium", high: "High", xhigh: "xHigh" },
  kind: { browser: "浏览器", desktop: "Linux 桌面", android: "安卓" },
  desktopIdleAction: { pause: "暂停", stop: "停止", none: "一直运行" },
  "options.idleAction": { pause: "暂停", stop: "停止", none: "一直运行" },
  androidBackend: { auto: "自动", redroid: "Redroid", emulator: "模拟器", off: "关闭" },
  "options.backend": { redroid: "Redroid", emulator: "模拟器" },
  verdict: { completed: "做完了", needs_owner: "停下来等你", gave_up: "没做完就放弃" },
  by: { agent: "agent 求助", review: "监督员复核" },
};

export const APPROVAL_KIND: Record<string, string> = {
  command: "执行命令",
  file_change: "修改文件",
  host_access: "宿主机操作",
  desktop: "实例操作",
  decision: "选择",
  other: "操作",
};

export const INCIDENT_STATUS: Record<string, string> = { analyzing: "分析中", open: "待处理", auto: "已自动处理", adopted: "已采用方案", dismissed: "已忽略" };

export const APPROVAL_STATUS: Record<string, string> = { pending: "待处理", approved: "已批准", denied: "已拒绝" };

/** Credential access requests: the same statuses the 凭据与隐私 page shows. */
export const CREDENTIAL_REQUEST_STATUS: Record<string, string> = { pending: "待审批", approved: "已批准", denied: "已拒绝", expired: "已过期", consumed: "已读取", revoked: "已撤销" };

const ACTOR: Record<string, string> = { system: "系统", supervisor: "监督员", helper: "维修员", watchdog: "超时保护", policy: "自动审批" };

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

const LEAD_KEYS = ["name", "title", "item", "device"];
const TAIL_KEYS = ["problem", "assessment", "diagnosis", "did", "option", "answer", "note", "reason", "error", "ref"];

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
