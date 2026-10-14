import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MAX_ARCHIVE_ENTRIES = 3000;

export interface ArchiveEntry {
  path: string;
  size: number | null;
  dir: boolean;
  /** ISO-ish "YYYY-MM-DD HH:MM[:SS]" as the archive records it (no time zone). */
  modified: string | null;
  encrypted: boolean;
}
export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** Entries in the archive, which may be more than `entries` holds. */
  total: number;
  truncated: boolean;
  /** Sum of the uncompressed sizes of all entries, when known. */
  totalSize: number | null;
}

const TAR_NAME = /\.(tar|tgz|tbz2?|txz|tzst|tar\.(gz|bz2|xz|zst|lz|lzma|z))$/i;
const OTHER_NAME = /\.(zip|jar|war|apk|7z|rar|r\d\d|cab|iso|wim|arj|lzh|lha|z|cpio|deb|rpm|xar|gz|bz2|xz|zst|lzma)$/i;

export function isArchiveName(filename: string): boolean {
  return TAR_NAME.test(filename) || OTHER_NAME.test(filename);
}

/** First of the 7-Zip family found on this host; probed once. */
let sevenZip: Promise<string | null> | undefined;
function findSevenZip(): Promise<string | null> {
  sevenZip ??= (async () => {
    for (const bin of ["7zz", "7z", "7za", "7zr"]) {
      try {
        await run(bin, ["i"], { timeout: 5000 });
        return bin;
      } catch {
        // not installed
      }
    }
    return null;
  })();
  return sevenZip;
}

/** Lists what is inside an archive without extracting anything. Throws a user-readable Error. */
export async function listArchive(file: string, filename: string): Promise<ArchiveListing> {
  const raw = TAR_NAME.test(filename) ? await listTar(file) : await listSevenZip(file);
  const total = raw.length;
  let totalSize = 0;
  let sizeKnown = false;
  for (const e of raw) {
    if (e.size !== null && !e.dir) {
      totalSize += e.size;
      sizeKnown = true;
    }
  }
  // Folders first within the same parent reads best in a tree, but the client sorts; keep archive order here.
  return { entries: raw.slice(0, MAX_ARCHIVE_ENTRIES), total, truncated: total > MAX_ARCHIVE_ENTRIES, totalSize: sizeKnown ? totalSize : null };
}

const OPTS = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" as const };

function clean(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

async function listTar(file: string): Promise<ArchiveEntry[]> {
  let out: string;
  try {
    ({ stdout: out } = await run("tar", ["--quoting-style=literal", "--full-time", "-tvf", file], OPTS));
  } catch (err) {
    // GNU tar can't do this one (e.g. missing decompressor); 7-Zip may.
    if ((await findSevenZip()) === null) throw new Error("读不出这个压缩包：" + shortError(err));
    return listSevenZip(file);
  }
  const entries: ArchiveEntry[] = [];
  // -rw-r--r-- user/group      1234 2025-10-14 12:00:00 path/to/file [-> target]
  const line = /^(\S)\S*\s+\S+\s+(\d+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?)\s+(.*)$/;
  for (const l of out.split("\n")) {
    const m = line.exec(l);
    if (!m) continue;
    const dir = m[1] === "d";
    let name = m[4]!;
    if (m[1] === "l" || m[1] === "h") name = name.replace(/ -> .*$/, "").replace(/ link to .*$/, "");
    const p = clean(name).replace(/\/$/, "");
    if (!p) continue;
    entries.push({ path: p, size: dir ? null : Number(m[2]), dir, modified: m[3]!, encrypted: false });
  }
  return entries;
}

async function listSevenZip(file: string): Promise<ArchiveEntry[]> {
  const bin = await findSevenZip();
  if (!bin) throw new Error("服务器上没有安装解压工具（7-Zip），暂时不能查看压缩包内容");
  let out: string;
  try {
    ({ stdout: out } = await run(bin, ["l", "-slt", "-ba", "-sccUTF-8", "-scsUTF-8", "-p-", "--", file], OPTS));
  } catch (err) {
    const msg = shortError(err);
    if (/wrong password|encrypted/i.test(msg)) throw new Error("压缩包设了密码，目录也被加密了，不能查看内容");
    throw new Error("读不出这个压缩包：" + msg);
  }
  const entries: ArchiveEntry[] = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const f: Record<string, string> = {};
    for (const l of block.split(/\r?\n/)) {
      const i = l.indexOf(" = ");
      if (i > 0) f[l.slice(0, i)] = l.slice(i + 3);
    }
    if (f.Path === undefined) continue;
    const p = clean(f.Path).replace(/\/$/, "");
    if (!p) continue;
    const dir = f.Folder === "+" || /^D/.test(f.Attributes ?? "");
    const size = f.Size !== undefined && f.Size !== "" ? Number(f.Size) : null;
    entries.push({
      path: p,
      size: dir || size === null || Number.isNaN(size) ? null : size,
      dir,
      modified: f.Modified ? f.Modified.replace(/\.\d+$/, "").slice(0, 19) : null,
      encrypted: f.Encrypted === "+",
    });
  }
  return entries;
}

function shortError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const s = (e.stderr || e.message || String(err)).trim().split("\n").filter((l) => l.trim() && !/^\s*$/.test(l));
  return (s.find((l) => /error|cannot|unsupported|wrong|can not|not /i.test(l)) ?? s[0] ?? "未知错误").slice(0, 200);
}
