import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { editOffice, readOffice } from "../src/office.ts";

const dir = "/tmp/claude-0/office/";
const have = fs.existsSync(dir + "a.docx");

describe.skipIf(!have)("office editing", () => {
  it("edits docx paragraphs and keeps the rest", () => {
    const buf = fs.readFileSync(dir + "a.docx");
    const doc = readOffice("docx", buf);
    expect(doc.groups[0]!.paragraphs.slice(0, 3)).toEqual(["Hello World & <you>", "", "第三段"]);
    const out = editOffice("docx", buf, [
      { type: "text", group: 0, index: 0, text: "改过 & <x>" },
      { type: "text", group: 0, index: 1, text: "原来是空的" },
    ]);
    expect(readOffice("docx", out).groups[0]!.paragraphs.slice(0, 3)).toEqual(["改过 & <x>", "原来是空的", "第三段"]);
  });
  it("edits pptx text", () => {
    const buf = fs.readFileSync(dir + "a.pptx");
    const doc = readOffice("pptx", buf);
    expect(doc.groups[0]!.paragraphs).toContain("标题");
    const i = doc.groups[0]!.paragraphs.indexOf("要点一");
    const out = editOffice("pptx", buf, [{ type: "text", group: 0, index: i, text: "要点二" }]);
    expect(readOffice("pptx", out).groups[0]!.paragraphs).toContain("要点二");
  });
  it("edits and adds xlsx cells, refuses formulas", () => {
    const buf = fs.readFileSync(dir + "a.xlsx");
    const s = readOffice("xlsx", buf).sheets[0]!;
    expect(s.name).toBe("表一");
    expect(s.rows[0]![0]).toEqual({ v: "名称" });
    expect(s.rows[2]![1]).toMatchObject({ f: true });
    const out = editOffice("xlsx", buf, [
      { type: "cell", sheet: 0, row: 1, col: 1, value: "新名称" },
      { type: "cell", sheet: 0, row: 2, col: 2, value: "10.5" },
      { type: "cell", sheet: 0, row: 2, col: 3, value: "插入" },
      { type: "cell", sheet: 0, row: 9, col: 1, value: "新行" },
    ]);
    const r = readOffice("xlsx", out).sheets[0]!.rows;
    expect(r[0]![0]!.v).toBe("新名称");
    expect(r[1]![1]!.v).toBe("10.5");
    expect(r[1]![2]!.v).toBe("插入");
    expect(r[8]![0]!.v).toBe("新行");
    expect(r[2]![1]).toMatchObject({ f: true });
    expect(() => editOffice("xlsx", buf, [{ type: "cell", sheet: 0, row: 3, col: 2, value: "1" }])).toThrow(/公式/);
  });
});
