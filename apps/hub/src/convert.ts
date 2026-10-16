import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Legacy binary Office formats and the OOXML format each converts to. */
const TARGET: Record<string, "docx" | "xlsx" | "pptx"> = { doc: "docx", xls: "xlsx", ppt: "pptx" };

export function legacyOffice(filename: string): { from: string; to: "docx" | "xlsx" | "pptx" } | null {
  const m = /\.(doc|xls|ppt)$/i.exec(filename);
  return m ? { from: m[1]!.toLowerCase(), to: TARGET[m[1]!.toLowerCase()]! } : null;
}

let office: Promise<string | null> | undefined;
/** LibreOffice's command line, probed once. */
export function findOffice(): Promise<string | null> {
  office ??= (async () => {
    for (const bin of ["soffice", "libreoffice"]) {
      try {
        await run(bin, ["--version"], { timeout: 20_000 });
        return bin;
      } catch {
        // not installed
      }
    }
    return null;
  })();
  return office;
}

/** Converts a legacy Office file to its modern format; returns the new file's bytes. Throws a user-readable Error. */
export async function convertLegacyOffice(file: string, to: "docx" | "xlsx" | "pptx"): Promise<Buffer> {
  const bin = await findOffice();
  if (!bin) throw new Error("服务器上没有安装 LibreOffice，暂时不能转换老格式的 Office 文件");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constella-convert-"));
  try {
    const src = path.join(dir, `in${path.extname(file) || ""}`);
    fs.copyFileSync(file, src);
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    // A private profile per call, so concurrent conversions don't share a lock.
    await run(bin, [`-env:UserInstallation=file://${path.join(dir, "profile")}`, "--headless", "--norestore", "--convert-to", to, "--outdir", out, src], {
      timeout: 120_000,
      env: { ...process.env, HOME: dir },
    }).catch(() => {
      throw new Error("转换失败：文件可能已损坏、设了密码，或太复杂");
    });
    const produced = path.join(out, `in.${to}`);
    if (!fs.existsSync(produced)) throw new Error("转换失败：没有得到结果");
    return fs.readFileSync(produced);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
