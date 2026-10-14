import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Docker from "dockerode";
import { config } from "./config.ts";

export type ContainerState = "running" | "stopped" | "missing" | "starting" | "error";

const LABEL = "dev.constella.role";
const HASH = "dev.constella.spec";

export interface AgentSpec {
  agentId: string;
  env: Record<string, string>;
  hostAccess: boolean;
}

export interface DesktopSpec {
  desktopId: string;
}

/** Docker lifecycle for agent and desktop containers on the constella network. */
export class Containers {
  readonly docker: Docker;

  constructor(socketPath = "/var/run/docker.sock") {
    this.docker = new Docker({ socketPath });
  }

  agentName(agentId: string): string {
    return `constella-agent-${agentId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase()}`;
  }

  desktopName(desktopId: string): string {
    return `constella-desktop-${desktopId.replace(/[^a-zA-Z0-9_.-]/g, "-").toLowerCase()}`;
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
      if (info.State.Running) return info.State.Health?.Status === "starting" ? "starting" : "running";
      return info.State.Status === "dead" ? "error" : "stopped";
    } catch (err: any) {
      if (err?.statusCode === 404) return "missing";
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
    const name = this.desktopName(spec.desktopId);
    const home = path.join(config.desktopsDir, spec.desktopId, "home");
    fs.mkdirSync(home, { recursive: true });
    chownTree(path.dirname(home), 1000);
    await this.#ensure(name, {
      name,
      Image: config.docker.desktopImage,
      Env: [`TZ=${config.timezone}`],
      Labels: { [LABEL]: "desktop", "dev.constella.desktop": spec.desktopId },
      HostConfig: {
        Binds: [`${home}:/home/desktop`],
        NetworkMode: config.docker.network,
        RestartPolicy: { Name: "unless-stopped" },
        ShmSize: 1024 ** 3,
        Memory: 3 * 1024 ** 3,
        PidsLimit: 2048,
      },
    });
  }

  async stop(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).stop({ t: 10 });
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
    try {
      await container.start();
      const result = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("命令超时")), timeoutMs)),
      ]);
      const logs = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
      return { exitCode: result.StatusCode, output: demux(logs).slice(-20000) };
    } finally {
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
    const imageId = (await this.docker.getImage(opts.Image!).inspect()).Id;
    if (info && (info.Config.Labels?.[HASH] !== hash || info.Image !== imageId)) {
      await this.remove(name);
      info = null;
    }
    if (!info) await this.docker.createContainer(opts);
    const c = this.docker.getContainer(name);
    if (!info?.State.Running) {
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
