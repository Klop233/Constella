import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AndroidBackend, DesktopKind } from "@constella/protocol";
import Docker from "dockerode";
import { config } from "./config.ts";

export type ContainerState = "running" | "paused" | "stopped" | "missing" | "starting" | "error";

/** What Docker knows about a container's health beyond running / stopped (for diagnosing instances). */
export interface ContainerInfo {
  state: ContainerState;
  /** Restarts by the restart policy since it was last started on purpose: climbing means it keeps exiting. */
  restartCount: number;
  restarting: boolean;
  startedAt: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  /** Docker health check status, when the image has one. */
  health: string | null;
}

/**
 * Memory the emulator process needs on top of the guest's RAM (QEMU, software GPU rendering). With less, the
 * container keeps hitting its limit and the emulator stalls under load (adb stops answering).
 */
const EMULATOR_OVERHEAD_MB = 2048;
/** The emulator asks for 20 s to shut down cleanly; a hard kill leaves locks that stop the next boot. */
export const ANDROID_STOP_SECONDS = 30;

const LABEL = "dev.constella.role";
const HASH = "dev.constella.spec";

export interface AgentSpec {
  agentId: string;
  env: Record<string, string>;
  hostAccess: boolean;
}

/** An instance with its options resolved against the kind's defaults. */
export interface DesktopSpec {
  desktopId: string;
  kind: DesktopKind;
  width: number;
  height: number;
  dpi: number;
  backend: AndroidBackend;
  armTranslation: boolean;
  googlePlay: boolean;
}

/** Properties that route ARM code through libndk_translation (ARM executables via binfmt_misc stay off: it is host-global). */
const ARM_PROPS = [
  "ro.product.cpu.abilist=x86_64,arm64-v8a,x86,armeabi-v7a,armeabi",
  "ro.product.cpu.abilist64=x86_64,arm64-v8a",
  "ro.product.cpu.abilist32=x86,armeabi-v7a,armeabi",
  "ro.dalvik.vm.isa.arm=x86",
  "ro.dalvik.vm.isa.arm64=x86_64",
  "ro.dalvik.vm.native.bridge=libndk_translation.so",
  "ro.ndk_translation.version=0.2.2",
];

/** Docker lifecycle for agent and desktop containers on the constella network. */
export class Containers {
  readonly docker: Docker;

  constructor(socketPath = "/var/run/docker.sock") {
    this.docker = new Docker({ socketPath });
  }

  agentName(agentId: string): string {
    return `constella-agent-${agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase()}`;
  }

  /** The container serving an instance's screen and control API (for Android: the bridge). */
  desktopName(desktopId: string): string {
    return `constella-desktop-${desktopId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase()}`;
  }

  /** The Android system itself (Redroid or emulator), next to its bridge. */
  androidName(desktopId: string): string {
    return `constella-android-${desktopId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase()}`;
  }

  async ensureNetwork(): Promise<void> {
    const nets = await this.docker.listNetworks({ filters: { name: [config.docker.network] } });
    if (!nets.some((n) => n.Name === config.docker.network)) {
      await this.docker.createNetwork({ Name: config.docker.network, Driver: "bridge", Labels: { [LABEL]: "network" } });
    }
  }

  async state(name: string): Promise<ContainerState> {
    try {
      const info = await this.docker.getContainer(name).inspect();
      if (info.State.Paused) return "paused";
      if (info.State.Running) return info.State.Health?.Status === "starting" ? "starting" : "running";
      return info.State.Status === "dead" ? "error" : "stopped";
    } catch (err: any) {
      if (err?.statusCode === 404) return "missing";
      throw err;
    }
  }

  /** Null when the container doesn't exist. */
  async info(name: string): Promise<ContainerInfo | null> {
    try {
      const i = await this.docker.getContainer(name).inspect();
      const state: ContainerState = i.State.Paused
        ? "paused"
        : i.State.Running
          ? i.State.Health?.Status === "starting"
            ? "starting"
            : "running"
          : i.State.Status === "dead"
            ? "error"
            : "stopped";
      return {
        state,
        restartCount: i.RestartCount ?? 0,
        restarting: !!i.State.Restarting,
        startedAt: i.State.StartedAt && !i.State.StartedAt.startsWith("0001") ? i.State.StartedAt : null,
        exitCode: typeof i.State.ExitCode === "number" ? i.State.ExitCode : null,
        oomKilled: !!i.State.OOMKilled,
        health: i.State.Health?.Status ?? null,
      };
    } catch (err: any) {
      if (err?.statusCode === 404) return null;
      throw err;
    }
  }

  async ensureAgent(spec: AgentSpec): Promise<void> {
    const name = this.agentName(spec.agentId);
    const base = path.join(config.agentsDir, spec.agentId);
    for (const d of ["home", "workspace"]) fs.mkdirSync(path.join(base, d), { recursive: true });
    chownTree(base, 1000);
    const env = Object.entries({
      ...spec.env,
      CONSTELLA_AGENT_ID: spec.agentId,
      CONSTELLA_HUB_WS: config.docker.hubWsUrl,
      TZ: config.timezone,
    }).map(([k, v]) => `${k}=${v}`);
    const binds = [
      `${path.join(base, "home")}:/home/agent`,
      `${path.join(base, "workspace")}:/workspace`,
      `${path.join(config.dataDir, "shared")}:/shared:ro`,
    ];
    const createOpts: Docker.ContainerCreateOptions = {
      name,
      Image: config.docker.agentImage,
      Env: env,
      Hostname: spec.agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 60),
      Labels: { [LABEL]: "agent", "dev.constella.agent": spec.agentId },
      HostConfig: {
        Binds: binds,
        NetworkMode: config.docker.network,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 4 * 1024 ** 3,
        PidsLimit: 1024,
        CapDrop: ["NET_RAW", "MKNOD", "AUDIT_WRITE"],
        SecurityOpt: ["no-new-privileges"],
      },
    };
    await this.#ensure(name, createOpts);
  }

  async ensureDesktop(spec: DesktopSpec): Promise<void> {
    const dir = path.join(config.desktopsDir, spec.desktopId);
    const name = this.desktopName(spec.desktopId);
    const labels = { [LABEL]: "desktop", "dev.constella.desktop": spec.desktopId, "dev.constella.kind": spec.kind };
    if (spec.kind !== "android") {
      const home = path.join(dir, "home");
      fs.mkdirSync(home, { recursive: true });
      chownTree(dir, 1000);
      await this.#ensure(name, {
        name,
        Image: config.docker.desktopImage,
        Env: [`TZ=${config.timezone}`, `CONSTELLA_SESSION=${spec.kind === "browser" ? "browser" : "xfce"}`, `GEOMETRY=${spec.width}x${spec.height}`],
        Labels: labels,
        HostConfig: {
          Binds: [`${home}:/home/desktop`],
          NetworkMode: config.docker.network,
          RestartPolicy: { Name: "unless-stopped" },
          ShmSize: 1024 ** 3,
          Memory: config.instanceMemoryMb[spec.kind] * 1024 ** 2,
          PidsLimit: 2048,
        },
      });
      return;
    }
    // The device first, then the bridge that connects to it over adb (port 5555 on the device container).
    const adbDir = path.join(dir, "adb");
    fs.mkdirSync(adbDir, { recursive: true });
    const android = this.androidName(spec.desktopId);
    await this.#ensure(android, spec.backend === "emulator" ? this.#emulatorSpec(spec, android, dir, labels) : this.#redroidSpec(spec, android, dir, labels));
    chownTree(adbDir, 1000);
    await this.#ensure(name, {
      name,
      Image: config.docker.androidBridgeImage,
      Env: [`TZ=${config.timezone}`, `ANDROID_ADB=${android}:5555`, `GEOMETRY=${spec.width}x${spec.height}`],
      Labels: labels,
      HostConfig: {
        Binds: [`${adbDir}:/home/bridge/.android`],
        NetworkMode: config.docker.network,
        RestartPolicy: { Name: "unless-stopped" },
        Memory: 1024 ** 3,
        PidsLimit: 512,
      },
    });
  }

  #redroidSpec(spec: DesktopSpec, name: string, dir: string, labels: Record<string, string>): Docker.ContainerCreateOptions {
    const data = path.join(dir, "data");
    fs.mkdirSync(data, { recursive: true });
    return {
      name,
      Image: spec.googlePlay ? config.docker.redroidGappsImage : config.docker.redroidImage,
      Cmd: [
        `androidboot.redroid_width=${spec.width}`,
        `androidboot.redroid_height=${spec.height}`,
        `androidboot.redroid_dpi=${spec.dpi}`,
        "androidboot.redroid_gpu_mode=guest",
        ...(spec.armTranslation ? ARM_PROPS : []),
      ],
      Labels: { ...labels, [LABEL]: "android" },
      HostConfig: {
        Binds: [`${data}:/data`],
        Privileged: true,
        NetworkMode: config.docker.network,
        RestartPolicy: { Name: "unless-stopped" },
        Memory: config.instanceMemoryMb.android * 1024 ** 2,
      },
    };
  }

  #emulatorSpec(spec: DesktopSpec, name: string, dir: string, labels: Record<string, string>): Docker.ContainerCreateOptions {
    const avd = path.join(dir, "avd");
    fs.mkdirSync(avd, { recursive: true });
    const guestMb = Math.max(1024, config.instanceMemoryMb.android - 1024);
    return {
      name,
      Image: spec.googlePlay ? config.docker.emulatorPlaystoreImage : config.docker.emulatorImage,
      Env: [`TZ=${config.timezone}`, `WIDTH=${spec.width}`, `HEIGHT=${spec.height}`, `DPI=${spec.dpi}`, `MEMORY_MB=${guestMb}`],
      Labels: { ...labels, [LABEL]: "android" },
      HostConfig: {
        Binds: [`${avd}:/data/avd`, `${path.join(dir, "adb")}:/root/.android`],
        Devices: [{ PathOnHost: "/dev/kvm", PathInContainer: "/dev/kvm", CgroupPermissions: "rwm" }],
        NetworkMode: config.docker.network,
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 512 * 1024 ** 2,
        Memory: (guestMb + EMULATOR_OVERHEAD_MB) * 1024 ** 2,
      },
    };
  }

  /** Freeze a container's processes (memory stays allocated); no-op unless it is running. */
  async pause(name: string): Promise<void> {
    if ((await this.state(name).catch(() => "error")) !== "running") return;
    await this.docker.getContainer(name).pause();
  }

  async unpause(name: string): Promise<void> {
    if ((await this.state(name).catch(() => "error")) !== "paused") return;
    await this.docker.getContainer(name).unpause();
  }

  /** Stop, giving it `seconds` to shut down before it is killed. */
  async stop(name: string, seconds = 10): Promise<void> {
    await this.unpause(name).catch(() => {});
    try {
      await this.docker.getContainer(name).stop({ t: seconds });
    } catch (err: any) {
      if (err?.statusCode !== 304 && err?.statusCode !== 404) throw err;
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).remove({ force: true });
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
  }

  async restart(name: string): Promise<void> {
    await this.unpause(name);
    await this.docker.getContainer(name).restart({ t: 10 });
  }

  async stats(name: string): Promise<{ memoryMb: number } | null> {
    try {
      const s: any = await this.docker.getContainer(name).stats({ stream: false });
      return { memoryMb: Math.round((s.memory_stats?.usage ?? 0) / 1024 / 1024) };
    } catch {
      return null;
    }
  }

  /** Run a command inside a running container (used by the supervisor to look at and stop stuck processes). */
  async exec(name: string, cmd: string[], opts: { user?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number; output: string }> {
    const exec = await this.docker.getContainer(name).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, User: opts.user ?? "" });
    const stream = await exec.start({ hijack: true, stdin: false });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error("命令超时"));
      }, opts.timeoutMs ?? 15_000);
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    const info = await exec.inspect();
    return { exitCode: info.ExitCode ?? -1, output: demux(Buffer.concat(chunks)) };
  }

  /** Last lines of a container's log (empty when it doesn't exist). */
  async logs(name: string, tail = 80): Promise<string> {
    try {
      const buf = (await this.docker.getContainer(name).logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer;
      return demux(buf);
    } catch (err: any) {
      if (err?.statusCode === 404) return "";
      throw err;
    }
  }

  /** Run a command in the host's namespaces (for agents granted host access). */
  async hostExec(command: string, timeoutMs = 120_000): Promise<{ exitCode: number; output: string }> {
    const container = await this.docker.createContainer({
      Image: config.docker.agentImage,
      User: "0",
      Cmd: ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "bash", "-lc", command],
      Labels: { [LABEL]: "host-exec" },
      HostConfig: { PidMode: "host", Privileged: true, AutoRemove: false, NetworkMode: "host" },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await container.start();
      const result = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("命令超时")), timeoutMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      const logs = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
      return { exitCode: result.StatusCode, output: demux(logs).slice(-20000) };
    } finally {
      clearTimeout(timer);
      await container.remove({ force: true }).catch(() => {});
    }
  }

  async #ensure(name: string, opts: Docker.ContainerCreateOptions): Promise<void> {
    const hash = createHash("sha256").update(JSON.stringify(opts)).digest("hex").slice(0, 16);
    opts.Labels = { ...opts.Labels, [HASH]: hash };
    let info: Docker.ContainerInspectInfo | null = null;
    try {
      info = await this.docker.getContainer(name).inspect();
    } catch (err: any) {
      if (err?.statusCode !== 404) throw err;
    }
    // Recreate when the spec (image, env, mounts) changed; the volumes keep all state.
    const imageId = await this.docker
      .getImage(opts.Image!)
      .inspect()
      .then((image) => image.Id)
      .catch((err: any) => {
        if (err?.statusCode === 404) throw new Error(`缺少 ${opts.Image} 镜像，请在项目根目录执行 scripts/install.sh 完成部署`);
        throw err;
      });
    if (info && (info.Config.Labels?.[HASH] !== hash || info.Image !== imageId)) {
      await this.remove(name);
      info = null;
    }
    if (!info) await this.docker.createContainer(opts);
    const c = this.docker.getContainer(name);
    if (info?.State.Paused) await c.unpause();
    else if (!info?.State.Running) {
      try {
        await c.start();
      } catch (err: any) {
        if (err?.statusCode !== 304) throw err;
      }
    }
  }
}

function chownTree(dir: string, uid: number): void {
  try {
    const st = fs.statSync(dir);
    if (st.uid === uid) return;
    const walk = (p: string) => {
      fs.lchownSync(p, uid, uid);
      if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    };
    walk(dir);
  } catch (err) {
    console.error(`chown ${dir} failed`, err);
  }
}

/** Docker multiplexed log stream → text. */
function demux(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return out.length ? Buffer.concat(out).toString("utf8") : buf.toString("utf8");
}
