/**
 * Approval policy. Agents are meant to get on with things; only actions that are destructive or
 * hard to undo stop and ask. The classifier is deliberately conservative about *what* it flags
 * (so ordinary work never waits) and liberal about *how* it matches (flags, sudo, paths).
 */

export type ApprovalMode = "ask" | "smart" | "auto";

interface Rule {
  re: RegExp;
  why: string;
}

const RULES: Rule[] = [
  // Deleting a lot, or anything at / , ~ , system dirs, globs at the root of a path.
  { re: /\brm\s+(-[a-zA-Z]+\s+|--[a-z-]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(-[a-zA-Z]+\s+)*("|')?(\/(\s|$|\*)|~\/?(\s|$|\*)|\$HOME\/?(\s|$)|\/(etc|usr|var|boot|bin|sbin|lib|lib64|opt|srv|root|home|workspace)\/?(\s|$|\*)|\*(\s|$)|\.\/?(\s|$)|\.\.)/, why: "递归删除整个目录树" },
  { re: /--no-preserve-root\b/, why: "删除根目录" },
  { re: /\bfind\b[^|;&]*\s-delete\b|\bfind\b[^|;&]*-exec\s+rm\b/, why: "批量删除文件" },
  { re: /\b(shred|wipefs)\b/, why: "擦除数据" },
  // Disks and filesystems.
  { re: /\bmkfs(\.\w+)?\b|\bfdisk\b|\bparted\b|\bsgdisk\b|\bdd\b[^|;&]*\bof=\/dev\//, why: "格式化或改写磁盘" },
  { re: />\s*\/dev\/(sd|nvme|vd|xvd|hd)[a-z0-9]*/, why: "直接写磁盘设备" },
  // Power and init.
  { re: /\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|\bsystemctl\s+(reboot|poweroff|halt|kexec)\b/, why: "关机或重启" },
  { re: /\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd|docker|containerd|networking|NetworkManager|systemd-\w+|tailscaled|cloudflared)\b/, why: "停用关键系统服务" },
  // Containers and their data.
  { re: /\bdocker\s+(system|volume|image|container|network|builder)\s+prune\b|\bdocker\s+volume\s+rm\b/, why: "清理 Docker 数据" },
  { re: /\bdocker\s+(rm|kill)\b|\bdocker\s+compose\s+down\b[^|;&]*(-v|--volumes)/, why: "删除容器或数据卷" },
  // Version control history.
  { re: /\bgit\s+push\b[^|;&]*(\s-f\b|--force\b|--force-with-lease\b|\s\+\S)/, why: "强制推送" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|filter-repo)\b|\bgit\s+branch\s+-D\b/, why: "丢弃 git 历史或改动" },
  // Databases.
  { re: /\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE?|DELETE\s+FROM\s+\w+\s*(;|$))/i, why: "删除数据库数据" },
  { re: /\b(dropdb|redis-cli\b[^|;&]*\bflushall)\b/i, why: "删除数据库数据" },
  // Permissions, users, security-critical config.
  { re: /\bchmod\s+(-R\s+)?[0-7]*7{3}\s+\/|\bchmod\s+-R\b[^|;&]*\s\/(\s|$)|\bchown\s+-R\b[^|;&]*\s\/(etc|usr|var|bin|lib)?(\s|$)/, why: "大范围改权限" },
  { re: /\b(userdel|passwd|chpasswd|visudo)\b|\busermod\b[^|;&]*-[a-zA-Z]*L/, why: "改动账户或密码" },
  { re: /(>|tee\s+(-a\s+)?)\s*\/etc\/(passwd|shadow|sudoers|fstab|ssh\/sshd_config|hosts)\b|\bsed\s+-i\b[^|;&]*\/etc\/(passwd|shadow|sudoers|fstab|ssh\/sshd_config)/, why: "改写系统关键配置" },
  { re: /\b(iptables\s+-F|ufw\s+(disable|reset)|nft\s+flush\s+ruleset)\b/, why: "清空防火墙规则" },
  // Killing everything / package removal.
  { re: /\bkill\s+-9\s+-1\b|\bkillall5\b|\bpkill\s+-9\s+-u\b/, why: "结束所有进程" },
  { re: /\b(apt(-get)?|dnf|yum|pacman|apk)\s+(remove|purge|autoremove|erase|del)\b|\bpacman\s+-R/, why: "卸载系统软件包" },
  // Pipe-to-shell from the internet runs code nobody has read.
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, why: "下载脚本直接执行" },
  // Fork bomb.
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: "fork 炸弹" },
];

/** Extra caution on the host itself: no recursive deletes outside /tmp. */
const HOST_RULES: Rule[] = [
  { re: /\brm\s+(-[a-zA-Z]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(-[a-zA-Z]+\s+)*("|')?(?!\/tmp\/)[\/~$]/, why: "在宿主机上递归删除" },
  { re: /\bmv\s+[^|;&]*\s\/dev\/null\b/, why: "移动到 /dev/null" },
];

/** Why an action looks destructive, or null when it's ordinary work. `host` = runs on the server itself, not an agent container. */
export function destructiveReason(text: string, host = false): string | null {
  const t = text.replace(/^宿主机命令：/, "");
  for (const r of host ? [...RULES, ...HOST_RULES] : RULES) if (r.re.test(t)) return r.why;
  return null;
}

/**
 * Decide an approval request under the configured mode.
 * - ask: always ask.
 * - smart: approve ordinary work; ask for destructive commands. File edits inside an agent's own
 *   container are its workspace, so they're approved.
 * - auto: approve everything.
 */
export function decideApproval(mode: ApprovalMode, kind: string, text: string): { approve: boolean; why: string | null } {
  if (mode === "auto") return { approve: true, why: null };
  if (mode === "ask") return { approve: false, why: null };
  if (kind === "file_change") return { approve: true, why: null };
  const why = destructiveReason(text, kind === "host_access");
  return { approve: !why, why };
}
