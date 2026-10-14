import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isArchiveName, listArchive } from "../src/archive.ts";

describe("archive listing", () => {
  it("recognises archive names", () => {
    for (const n of ["a.zip", "a.RAR", "a.7z", "a.tar.gz", "a.tgz", "a.tar.xz", "a.iso"]) expect(isArchiveName(n)).toBe(true);
    for (const n of ["a.txt", "a.docx", "zip"]) expect(isArchiveName(n)).toBe(false);
  });

  it("lists a tar.gz without extracting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "constella-archive-"));
    fs.mkdirSync(path.join(dir, "src/sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src/a.txt"), "hello");
    fs.writeFileSync(path.join(dir, "src/sub/中文.md"), "x".repeat(2000));
    const out = path.join(os.tmpdir(), `constella-${Date.now()}.tar.gz`);
    execFileSync("tar", ["-czf", out, "-C", dir, "src"]);
    const l = await listArchive(out, "x.tar.gz");
    expect(l.entries.map((e) => e.path).sort()).toEqual(["src", "src/a.txt", "src/sub", "src/sub/中文.md"]);
    expect(l.entries.find((e) => e.path === "src/sub/中文.md")).toMatchObject({ size: 2000, dir: false });
    expect(l.entries.find((e) => e.path === "src")).toMatchObject({ dir: true });
    expect(l.totalSize).toBe(2005);
  });
});
