import type { AndroidBackend, DesktopKind } from "@constella/protocol";
import type Docker from "dockerode";
import { config, nowIso } from "./config.ts";

export interface Availability {
  ok: boolean;
  /** Why it can't be used (shown to the owner and to agents). */
  reason?: string;
  /** Works, with caveats. */
  warnings?: string[];
}

export interface BackendCaps extends Availability {
  /** ARM apps can run (Redroid: the image ships ndk translation; emulator: built into Google's x86_64 images). */
  arm: boolean;
  /** A Google Play variant of the image is available. */
  googlePlay: boolean;
}

export interface HostCaps {
  checkedAt: string | null;
  checking: boolean;
  kinds: Record<DesktopKind, Availability>;
  android: { setting: AndroidBackendSetting; backend: AndroidBackend | null; redroid: BackendCaps; emulator: BackendCaps };
}

export type AndroidBackendSetting = "auto" | AndroidBackend | "off";

/** Labels the Android images carry to say which optional components they were built with. */
export const LABEL_ARM = "dev.constella.android.arm";
export const LABEL_GAPPS = "dev.constella.android.gapps";

const PROBE_LABEL = { "dev.constella.role": "probe" };
const DOCS = "（见 README「实例类型与宿主要求」）";

interface Probe {
  binder: boolean;
  sysctl: boolean;
  highUid: boolean;
  kvm: "ok" | "missing" | "denied";
  error?: string;
}

/**
 * What this host can run, found out with throwaway containers instead of assumptions: binderfs and writable
 * kernel sysctls for Redroid, a usable /dev/kvm for the emulator, plus which images are built and with what.
 */
export class HostCapabilities {
  #docker: Docker;
  #setting: () => AndroidBackendSetting;
  #probe: Probe | null = null;
  #images = new Map<string, Record<string, string> | null>();
  #checkedAt: string | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: { docker: Docker; androidBackend: () => AndroidBackendSetting }) {
    this.#docker = deps.docker;
    this.#setting = deps.androidBackend;
  }

  /** Current result; probes first if nothing has been checked yet. */
  async get(): Promise<HostCaps> {
    if (!this.#checkedAt) await this.refresh();
    return this.snapshot();
  }

  /** Re-run every check (images get rebuilt, devices get passed through). */
  refresh(): Promise<void> {
    this.#running ??= this.#check().finally(() => (this.#running = null));
    return this.#running;
  }

  snapshot(): HostCaps {
    const img = (tag: string) => this.#images.get(tag);
    const desktopImage = img(config.docker.desktopImage);
    const bridge = img(config.docker.androidBridgeImage);
    const p = this.#probe;
    const missing = (tag: string) => `镜像 ${tag} 还没有构建${DOCS}`;
    // The probes run in the desktop image, so without it nothing about the host is known.
    const unprobed = this.#checkedAt ? `${missing(config.docker.desktopImage)}，无法检测宿主` : "正在检测";

    const desktop: Availability = desktopImage ? { ok: true } : { ok: false, reason: this.#checkedAt ? missing(config.docker.desktopImage) : "正在检测" };

    const redroid = ((): BackendCaps => {
      const base = img(config.docker.redroidImage);
      const gapps = img(config.docker.redroidGappsImage);
      const caps = { arm: base?.[LABEL_ARM] === "1", googlePlay: !!gapps };
      if (!p) return { ok: false, reason: unprobed, ...caps };
      if (p.error) return { ok: false, reason: `检测失败：${p.error}`, ...caps };
      if (!p.binder) return { ok: false, reason: `宿主内核没有 binder（binderfs），或不允许容器挂载${DOCS}`, ...caps };
      if (!p.sysctl) return { ok: false, reason: `宿主不允许特权容器修改内核参数（常见于非特权 LXC），安卓无法启动${DOCS}`, ...caps };
      if (!bridge) return { ok: false, reason: missing(config.docker.androidBridgeImage), ...caps };
      if (!base && !gapps) return { ok: false, reason: missing(config.docker.redroidImage), ...caps };
      const warnings = p.highUid ? [] : ["宿主的 uid 映射不足 90000，App 里的网页内容（WebView）可能闪退"];
      return { ok: true, warnings, ...caps };
    })();

    const emulator = ((): BackendCaps => {
      const base = img(config.docker.emulatorImage);
      const play = img(config.docker.emulatorPlaystoreImage);
      const caps = { arm: !!(base || play), googlePlay: !!play };
      if (!p) return { ok: false, reason: unprobed, ...caps };
      if (p.kvm === "missing") return { ok: false, reason: `宿主没有 /dev/kvm（需要硬件虚拟化）${DOCS}`, ...caps };
      if (p.kvm === "denied") return { ok: false, reason: `容器无权使用 /dev/kvm${DOCS}`, ...caps };
      if (!bridge) return { ok: false, reason: missing(config.docker.androidBridgeImage), ...caps };
      if (!base && !play) return { ok: false, reason: missing(config.docker.emulatorImage), ...caps };
      return { ok: true, ...caps };
    })();

    const setting = this.#setting();
    const backend: AndroidBackend | null =
      setting === "off" ? null : setting === "auto" ? (redroid.ok ? "redroid" : emulator.ok ? "emulator" : null) : setting;
    const chosen = backend === "redroid" ? redroid : backend === "emulator" ? emulator : null;
    const android: Availability =
      setting === "off"
        ? { ok: false, reason: "安卓实例已在设置里关闭" }
        : chosen?.ok
          ? { ok: true, warnings: chosen.warnings }
          : { ok: false, reason: chosen?.reason ?? redroid.reason ?? emulator.reason };

    return {
      checkedAt: this.#checkedAt,
      checking: !!this.#running,
      kinds: { browser: desktop, desktop, android },
      android: { setting, backend: android.ok ? backend : null, redroid, emulator },
    };
  }

  async #check(): Promise<void> {
    this.#images.clear();
    const d = config.docker;
    for (const tag of [d.desktopImage, d.androidBridgeImage, d.redroidImage, d.redroidGappsImage, d.emulatorImage, d.emulatorPlaystoreImage]) {
      this.#images.set(tag, await this.#docker.getImage(tag).inspect().then((i) => i.Config?.Labels ?? {}, () => null));
    }
    this.#probe = this.#images.get(d.desktopImage) ? await this.#runProbes(d.desktopImage).catch((err) => ({ binder: false, sysctl: false, highUid: false, kvm: "missing" as const, error: String(err?.message ?? err) })) : null;
    this.#checkedAt = nowIso();
  }

  async #runProbes(image: string): Promise<Probe> {
    // Privileged so the checks see what a Redroid container would; nothing here changes host state
    // (kptr_restrict gets its current value written back).
    const script = [
      'd=$(mktemp -d); if mount -t binder binder "$d" 2>/dev/null; then umount "$d"; echo BINDER; fi',
      'v=$(cat /proc/sys/kernel/kptr_restrict 2>/dev/null) && (echo "$v" > /proc/sys/kernel/kptr_restrict) 2>/dev/null && echo SYSCTL',
      "setpriv --reuid=90000 --regid=90000 --clear-groups true 2>/dev/null && echo HIGHUID",
    ].join("\n");
    const out = await this.#run(image, script, { Privileged: true });
    let kvm: Probe["kvm"] = "missing";
    try {
      const k = await this.#run(image, 'python3 -c "import os; os.close(os.open(\'/dev/kvm\', os.O_RDWR))" && echo KVM', {
        Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }],
      });
      kvm = k.includes("KVM") ? "ok" : "denied";
    } catch {
      kvm = "missing"; // creating a container with a device the host doesn't have fails
    }
    return { binder: out.includes("BINDER"), sysctl: out.includes("SYSCTL"), highUid: out.includes("HIGHUID"), kvm };
  }

  async #run(image: string, script: string, host: Docker.HostConfig): Promise<string> {
    const c = await this.#docker.createContainer({
      Image: image,
      Entrypoint: ["sh", "-c"],
      Cmd: [script],
      User: "0",
      Labels: PROBE_LABEL,
      HostConfig: { NetworkMode: "none", AutoRemove: false, ...host },
    });
    try {
      await c.start();
      await Promise.race([c.wait(), new Promise((_, reject) => setTimeout(() => reject(new Error("检测超时")), 30_000))]);
      const logs = (await c.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
      return logs.toString("latin1");
    } finally {
      await c.remove({ force: true }).catch(() => {});
    }
  }
}
