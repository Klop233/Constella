import { randomBytes } from "node:crypto";
import path from "node:path";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

const dataDir = env("CONSTELLA_DATA_DIR", "/srv/constella");

export const config = {
  dataDir,
  dbPath: path.join(dataDir, "db", "constella.db"),
  agentsDir: path.join(dataDir, "agents"),
  desktopsDir: path.join(dataDir, "desktops"),
  sharedSkillsDir: path.join(dataDir, "shared-skills"),
  /** Files of artifacts, one directory per artifact holding one file per version; never mounted into agents. */
  artifactsDir: path.join(dataDir, "artifacts"),
  backupsDir: path.join(dataDir, "backups"),
  listenHost: env("CONSTELLA_HOST", "0.0.0.0"),
  listenPort: Number(env("CONSTELLA_PORT", "8780")),
  /** Dev-only port whose requests count as the owner without login (0 = off). Publish it on private interfaces only. */
  trustedPort: Number(env("CONSTELLA_TRUSTED_PORT", "0")),
  /** Origins the PWA is served from (Tailscale, public); used for WebAuthn and CSRF checks. */
  origins: env("CONSTELLA_ORIGINS", "http://localhost:8780")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),
  masterKey: env("CONSTELLA_MASTER_KEY"),
  setupCode: env("CONSTELLA_SETUP_CODE"),
  newapi: {
    baseUrl: env("NEWAPI_BASE_URL", "http://host.docker.internal:3333").replace(/\/$/, ""),
    apiKey: env("NEWAPI_API_KEY"),
    adminToken: env("NEWAPI_ADMIN_TOKEN"),
    adminUserId: env("NEWAPI_ADMIN_USER_ID", "1"),
  },
  defaultModel: env("CONSTELLA_DEFAULT_MODEL", "gpt-6-astra"),
  reflectModel: env("CONSTELLA_REFLECT_MODEL", "mimo-v2.5-pro"),
  vapid: { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY"), subject: env("VAPID_SUBJECT", "mailto:admin@constella.local") },
  telegram: { botToken: env("TELEGRAM_BOT_TOKEN"), chatId: env("TELEGRAM_CHAT_ID") },
  docker: {
    network: env("CONSTELLA_DOCKER_NETWORK", "constella-net"),
    agentImage: env("CONSTELLA_AGENT_IMAGE", "constella-agent:latest"),
    desktopImage: env("CONSTELLA_DESKTOP_IMAGE", "constella-desktop:latest"),
    /** Android instances: the bridge (screen, input, control API) plus one backend image per variant. */
    androidBridgeImage: env("CONSTELLA_ANDROID_BRIDGE_IMAGE", "constella-android-bridge:latest"),
    redroidImage: env("CONSTELLA_REDROID_IMAGE", "constella-redroid:latest"),
    redroidGappsImage: env("CONSTELLA_REDROID_GAPPS_IMAGE", "constella-redroid:gapps"),
    emulatorImage: env("CONSTELLA_EMULATOR_IMAGE", "constella-emulator:latest"),
    emulatorPlaystoreImage: env("CONSTELLA_EMULATOR_PLAYSTORE_IMAGE", "constella-emulator:playstore"),
    /** How agent containers reach the hub. */
    hubWsUrl: env("CONSTELLA_HUB_WS", "ws://constella-hub:8780/api/runner"),
    hubMcpUrl: env("CONSTELLA_HUB_MCP", "http://constella-hub:8780/mcp"),
  },
  officeImage: env("CONSTELLA_OFFICE_IMAGE", "onlyoffice/documentserver:latest"),
  /** How the Office Document Server reaches the hub (file download and save callbacks). */
  hubInternalUrl: env("CONSTELLA_HUB_INTERNAL_URL", "http://constella-hub:8780").replace(/\/$/, ""),
  agentIdleMinutes: Number(env("CONSTELLA_AGENT_IDLE_MINUTES", "30")),
  desktopIdleMinutes: Number(env("CONSTELLA_DESKTOP_IDLE_MINUTES", "30")),
  /** Memory limit per instance container, by kind (MB). */
  instanceMemoryMb: {
    browser: Number(env("CONSTELLA_MEM_BROWSER_MB", "2048")),
    desktop: Number(env("CONSTELLA_MEM_DESKTOP_MB", "3072")),
    android: Number(env("CONSTELLA_MEM_ANDROID_MB", "4096")),
  },
  runWatchdogMinutes: Number(env("CONSTELLA_RUN_WATCHDOG_MINUTES", "10")),
  runTimeoutMinutes: Number(env("CONSTELLA_RUN_TIMEOUT_MINUTES", "120")),
  timezone: env("TZ", "Asia/Shanghai"),
  /** Where the host's /proc and /sys/fs/cgroup are mounted read-only (performance stats); missing = the hub's own view. */
  hostRoot: env("CONSTELLA_HOST_ROOT", "/host"),
  secureCookies: env("CONSTELLA_SECURE_COOKIES", "true") !== "false",
};

/** Random id with a readable prefix, e.g. `ag_x7…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
