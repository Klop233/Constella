import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { splitWidgets, stripWidgets } from "@constella/protocol";
import { describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constella-widgets-"));
process.env.CONSTELLA_DATA_DIR = tmp;
process.env.CONSTELLA_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const { config } = await import("../src/config.ts");
if (config.dataDir !== tmp) throw new Error(`test data dir leaked to ${config.dataDir}; refusing to run against real data`);
const { openDb, kvSet } = await import("../src/db.ts");
const { Settings } = await import("../src/app.ts");
const { SecretBox, SecretStore } = await import("../src/secrets.ts");
const { ModelRegistry } = await import("../src/models.ts");
const { intelligentUiNote } = await import("../src/widgets.ts");
const { transcriptFor } = await import("../src/learning.ts");

describe("splitWidgets", () => {
  it("leaves replies without ui blocks as one markdown part", () => {
    expect(splitWidgets("就是巴黎。")).toEqual([{ kind: "md", text: "就是巴黎。" }]);
  });

  it("splits prose and titled ui blocks in order", () => {
    const text = "先看结论。\n\n```ui 房贷计算器\n<div class=\"card\">x</div>\n```\n\n然后是说明。\n~~~ui\n<p>2</p>\n~~~";
    expect(splitWidgets(text)).toEqual([
      { kind: "md", text: "先看结论。\n" },
      { kind: "ui", title: "房贷计算器", source: '<div class="card">x</div>', closed: true, format: "html" },
      { kind: "md", text: "\n然后是说明。" },
      { kind: "ui", title: "", source: "<p>2</p>", closed: true, format: "components" },
    ]);
  });

  it("marks a block still being streamed as open", () => {
    expect(splitWidgets("结论\n```ui 图表\n<canvas>")).toEqual([
      { kind: "md", text: "结论" },
      { kind: "ui", title: "图表", source: "<canvas>", closed: false, format: "components" },
    ]);
  });

  it("keeps ui fences inside other code blocks as code, and needs a closing fence at least as long", () => {
    const nested = "````md\n```ui x\n<p/>\n```\n````";
    expect(splitWidgets(nested)).toEqual([{ kind: "md", text: nested }]);
    expect(splitWidgets("````ui t\n```\n<p/>\n````")).toEqual([{ kind: "ui", title: "t", source: "```\n<p/>", closed: true, format: "components" }]);
  });

  it("tells component programs from html pages", () => {
    const [comp] = splitWidgets("```ui 计算器\nconst [a, setA] = useState(1);\n<Card><Slider value={a} onChange={setA} /></Card>\n```");
    expect(comp).toMatchObject({ kind: "ui", format: "components" });
    const [page] = splitWidgets("```ui-html 小游戏\n<canvas id=c></canvas>\n```");
    expect(page).toMatchObject({ kind: "ui", title: "小游戏", format: "html" });
    const [legacy] = splitWidgets('```ui 旧界面\n<div class="card">x</div>\n<script>1</script>\n```');
    expect(legacy).toMatchObject({ format: "html" });
  });

  it("does not take other languages that start with ui", () => {
    const t = "```uikit\nx\n```";
    expect(splitWidgets(t)).toEqual([{ kind: "md", text: t }]);
  });

  it("replaces blocks with a placeholder for prompts", () => {
    expect(stripWidgets("算好了：\n```ui 计算器\n<script>long()</script>\n```\n就这样")).toBe("算好了：\n\n［交互界面：计算器］\n\n就这样");
    expect(stripWidgets("纯文字")).toBe("纯文字");
  });
});

describe("intelligent UI setting", () => {
  const settings = () => {
    const db = openDb(":memory:");
    const secrets = new SecretStore(db, new SecretBox(Buffer.alloc(32, 7)));
    return { db, s: new Settings(db, secrets, new ModelRegistry({ db, secrets })) };
  };

  it("defaults to balanced and ignores unknown values", () => {
    const { db, s } = settings();
    expect(s.intelligentUi()).toBe("balanced");
    kvSet(db, "settings.intelligentUi", "rich");
    expect(s.intelligentUi()).toBe("rich");
    expect(s.view().intelligentUi).toBe("rich");
    kvSet(db, "settings.intelligentUi", "loud");
    expect(s.intelligentUi()).toBe("balanced");
  });

  it("tells agents about ui blocks only when on, and how much to use them", () => {
    expect(intelligentUiNote("off")).toBe("");
    const balanced = intelligentUiNote("balanced");
    const rich = intelligentUiNote("rich");
    for (const note of [balanced, rich]) {
      expect(note).toContain("```ui");
      expect(note).toContain("send(");
      expect(note).toContain("<Slider");
      expect(note).toContain("ui-html");
    }
    expect(balanced).toContain("计算器");
    expect(balanced).toContain("通常一处");
    expect(rich).toContain("多处界面");
  });

  it("keeps ui source out of reflection transcripts", () => {
    const t = transcriptFor({ prompt: "算房贷", status: "done", error: null }, [
      { type: "message.completed", runId: "r", messageId: "m", text: "月供约 5300 元。\n```ui 房贷\n<script>" + "x".repeat(5000) + "</script>\n```", id: "e", agentId: "a", seq: 0, ts: "t" },
    ] as any);
    expect(t).toContain("［交互界面：房贷］");
    expect(t).not.toContain("<script>");
  });

  it("has a table for block states", () => {
    const { db } = settings();
    db.prepare("INSERT INTO widget_state (key, conversation_id, data, updated_at) VALUES ('r:m:0', 'cv', '{\"a\":1}', 'now')").run();
    expect(db.prepare("SELECT data FROM widget_state WHERE conversation_id = 'cv'").get()).toEqual({ data: '{"a":1}' });
  });
});
