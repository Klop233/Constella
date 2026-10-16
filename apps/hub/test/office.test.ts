import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { editOffice, officeKind, readOffice } from "../src/office.ts";

/** Builds an OOXML package from path → XML text, so the tests need no fixture files on disk. */
const pkg = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])), { level: 6 });

const DOCX = pkg({
  "word/document.xml":
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>Hello World &amp; &lt;you&gt;</w:t></w:r></w:p>` +
    `<w:p/>` +
    `<w:p><w:r><w:t>第三段</w:t></w:r></w:p>` +
    `</w:body></w:document>`,
});

const PPTX = pkg({
  "ppt/slides/slide1.xml": `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>标题</a:t></a:r></a:p><a:p><a:r><a:t>要点一</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
});

const XLSX = pkg({
  "xl/workbook.xml":
    `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="表一" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels":
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`,
  "xl/worksheets/sheet1.xml":
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>名称</t></is></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row>` +
    `</sheetData></worksheet>`,
});

describe("officeKind", () => {
  it("recognizes the modern formats only", () => {
    expect(officeKind("a.docx")).toBe("docx");
    expect(officeKind("a.XLSX")).toBe("xlsx");
    expect(officeKind("a.pptx")).toBe("pptx");
    expect(officeKind("a.doc")).toBeNull();
    expect(officeKind("a.txt")).toBeNull();
  });
});

describe("office editing", () => {
  it("reads and edits docx paragraphs, keeping the rest", () => {
    const doc = readOffice("docx", DOCX);
    expect(doc.groups[0]!.paragraphs.slice(0, 3)).toEqual(["Hello World & <you>", "", "第三段"]);
    const out = editOffice("docx", DOCX, [
      { type: "text", group: 0, index: 0, text: "改过 & <x>" },
      { type: "text", group: 0, index: 1, text: "原来是空的" },
    ]);
    expect(readOffice("docx", out).groups[0]!.paragraphs.slice(0, 3)).toEqual(["改过 & <x>", "原来是空的", "第三段"]);
  });

  it("reads and edits pptx text", () => {
    const doc = readOffice("pptx", PPTX);
    expect(doc.groups[0]!.paragraphs).toContain("标题");
    const i = doc.groups[0]!.paragraphs.indexOf("要点一");
    const out = editOffice("pptx", PPTX, [{ type: "text", group: 0, index: i, text: "要点二" }]);
    expect(readOffice("pptx", out).groups[0]!.paragraphs).toContain("要点二");
  });

  it("edits and adds xlsx cells, and refuses formula cells", () => {
    const s = readOffice("xlsx", XLSX).sheets[0]!;
    expect(s.name).toBe("表一");
    expect(s.rows[0]![0]).toEqual({ v: "名称" });
    expect(s.rows[1]![1]).toMatchObject({ f: true });
    const out = editOffice("xlsx", XLSX, [
      { type: "cell", sheet: 0, row: 1, col: 1, value: "新名称" },
      { type: "cell", sheet: 0, row: 2, col: 3, value: "10.5" },
      { type: "cell", sheet: 0, row: 2, col: 4, value: "插入" },
      { type: "cell", sheet: 0, row: 9, col: 1, value: "新行" },
    ]);
    const r = readOffice("xlsx", out).sheets[0]!.rows;
    expect(r[0]![0]!.v).toBe("新名称");
    expect(r[1]![2]!.v).toBe("10.5");
    expect(r[1]![3]!.v).toBe("插入");
    expect(r[8]![0]!.v).toBe("新行");
    expect(r[1]![1]).toMatchObject({ f: true });
    expect(() => editOffice("xlsx", XLSX, [{ type: "cell", sheet: 0, row: 2, col: 2, value: "1" }])).toThrow(/公式/);
  });
});
