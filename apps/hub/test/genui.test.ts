import vm from "node:vm";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
// The web app's component-block pipeline (compile, streaming repair, isolated runtime), tested here
// because the hub is where the unit tests live; these files have no DOM dependencies.
import { compileWidget, splitProgram } from "../../web/src/lib/genui/compile.ts";
import { cutTree, repairPartial } from "../../web/src/lib/genui/repair.ts";
import { RUNTIME } from "../../web/src/lib/genui/runtime.ts";

type Msg = Record<string, any>;

/** Runs the runtime in a fresh VM context, like the worker does, and collects what it posts. */
function runtime() {
  const out: Msg[] = [];
  let handler: (m: Msg) => void = () => {};
  const ctx: Record<string, unknown> = { setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON, console, addEventListener: () => {} };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${RUNTIME}\n__genui(__post, __listen);`, Object.assign(ctx, { __post: (m: Msg) => out.push(JSON.parse(JSON.stringify(m))), __listen: (fn: (m: Msg) => void) => (handler = fn) }));
  const settle = () => new Promise((r) => setTimeout(r, 40));
  return { out, send: (m: Msg) => handler(m), settle, trees: () => out.filter((m) => m.type === "tree").map((m) => m.tree), ctx };
}

const calculator = `const [rate, setRate] = useState(3);
const pay = Math.round(1000 * (1 + rate / 100));
<Card title="计算">
  <Slider label="利率" value={rate} min={1} max={6} onChange={setRate} />
  <Stat label="结果" value={fmt.money(pay)} />
</Card>
<Text tone="muted">共 {rate} 档</Text>`;

describe("component block program", () => {
  it("splits statements from the tree at the first unindented <", () => {
    expect(splitProgram(calculator).statements).toContain("useState(3)");
    expect(splitProgram(calculator).tree.startsWith("<Card")).toBe(true);
    expect(() => splitProgram("const a = 1;")).toThrow(/组件树/);
  });

  it("compiles JSX into h() calls with several roots in a fragment", async () => {
    const { code } = await compileWidget(calculator);
    expect(code).toContain("function __App()");
    expect(code).toMatch(/h\(Card/);
    expect(code).toMatch(/h\(Fragment/);
  });

  it("reports syntax errors with the block's own line numbers", async () => {
    await expect(compileWidget("const a = ;\n<Text>x</Text>")).rejects.toThrow(/第 1 行/);
  });
});

describe("streaming repair", () => {
  it("closes open elements and keeps partial text", () => {
    expect(cutTree('<Card title="a">\n  <Text>正在写')).toBe('<Card title="a">\n  <Text>正在写</Text></Card>');
  });
  it("cuts before an unfinished tag or expression", () => {
    expect(cutTree('<Col>\n  <Stat label="x" value={fmt.mo')).toBe("<Col>\n  </Col>");
    expect(cutTree("<Col>\n  {items.map((x) => <Text>{x}</Te")).toBe("<Col>\n  </Col>");
    expect(cutTree('<Grid>\n  <Stat label="a" />\n  <Stat lab')).toBe('<Grid>\n  <Stat label="a" />\n  </Grid>');
  });
  it("handles fragments, closing tags and strings with brackets", () => {
    expect(cutTree('<>\n<Text>{"a}b"}</Text>\n<Row>')).toBe('<>\n<Text>{"a}b"}</Text>\n<Row></Row></>');
  });
  it("waits until the statements are written and the tree has started", () => {
    expect(repairPartial("const [a, setA] = useState(1);\nconst b =")).toBeNull();
    expect(repairPartial("const a = 1;\n<Card>\n<Text>hi")).toBe("const a = 1;\n<Card>\n<Text>hi</Text></Card>");
  });
  it("produces something that compiles at every prefix of a real block", async () => {
    for (let n = 40; n <= calculator.length; n += 7) {
      const fixed = repairPartial(calculator.slice(0, n));
      if (fixed) await expect(compileWidget(fixed)).resolves.toBeTruthy();
    }
  });
});

describe("isolated runtime", () => {
  it("renders, runs event handlers by id, re-renders and reports state", async () => {
    const rt = runtime();
    const { code } = await compileWidget(calculator);
    rt.send({ type: "load", code, slots: [] });
    await rt.settle();
    const tree = rt.trees().at(-1);
    expect(tree.t).toBe("Fragment");
    const card = tree.c[0];
    expect(card).toMatchObject({ t: "Card", p: { title: "计算" } });
    const slider = card.c[0];
    expect(slider.p.onChange).toEqual({ $fn: expect.any(Number) });
    expect(card.c[1].p.value).toBe("¥1,030");
    rt.send({ type: "call", id: slider.p.onChange.$fn, args: [5] });
    await rt.settle();
    const next = rt.trees().at(-1);
    expect(next.c[0].c[1].p.value).toBe("¥1,050");
    expect(next.c[1].c.join("")).toBe("共 5 档");
    expect(rt.out.filter((m) => m.type === "state").at(-1)?.slots).toEqual([5]);
  });

  it("restores saved state and keeps it when the program is replaced while streaming", async () => {
    const rt = runtime();
    const { code } = await compileWidget(calculator);
    rt.send({ type: "load", code, slots: [4] });
    await rt.settle();
    expect(rt.trees().at(-1).c[0].c[1].p.value).toBe("¥1,040");
    const { code: more } = await compileWidget(`${calculator}\n<Badge>新</Badge>`);
    rt.send({ type: "load", code: more, slots: [] });
    await rt.settle();
    const t = rt.trees().at(-1);
    expect(t.c).toHaveLength(3);
    expect(t.c[0].c[1].p.value).toBe("¥1,040");
  });

  it("expands the program's own components and passes host actions out", async () => {
    const rt = runtime();
    const { code } = await compileWidget(`function Pair({ a, b }) { return <Row><Text>{a}</Text><Text>{b}</Text></Row>; }\n<Pair a="x" b="y" />\n<Button onClick={() => send("就按这个")}>好</Button>`);
    rt.send({ type: "load", code, slots: [] });
    await rt.settle();
    const t = rt.trees().at(-1);
    expect(t.c[0]).toMatchObject({ t: "Row", c: [{ t: "Text", c: ["x"] }, { t: "Text", c: ["y"] }] });
    rt.send({ type: "call", id: t.c[1].p.onClick.$fn, args: [] });
    expect(rt.out.find((m) => m.type === "send")).toEqual({ type: "send", text: "就按这个" });
  });

  it("treats built-ins used as tags (<Map>, <Date>) as unknown components, not as calls", async () => {
    const rt = runtime();
    const { code } = await compileWidget("<Map center={[1, 2]}>地图</Map>");
    rt.send({ type: "load", code, slots: [] });
    await rt.settle();
    expect(rt.out.filter((m) => m.type === "error")).toEqual([]);
    expect(rt.trees().at(-1).c[0]).toMatchObject({ t: "Map", c: ["地图"] });
  });

  it("reports errors instead of throwing, and has no network", async () => {
    const rt = runtime();
    const { code } = await compileWidget(`const x = typeof fetch;\n<Text>{x}</Text>\n<Text>{missing.value}</Text>`);
    rt.send({ type: "load", code, slots: [] });
    await rt.settle();
    expect(rt.out.find((m) => m.type === "error")?.message).toMatch(/missing/);
    const { code: ok } = await compileWidget(`const x = typeof fetch;\n<Text>{x}</Text>`);
    rt.send({ type: "load", code: ok, slots: [] });
    await rt.settle();
    expect(rt.trees().at(-1).c[0].c).toEqual(["undefined"]);
  });
});

describe("compiler repairs", () => {
  it("quotes object keys that start with a digit", async () => {
    const { quoteKeys } = await import("../../web/src/lib/genui/compile.ts");
    expect(quoteKeys("const r = {\n  利率: 1,\n  20年月供: 2,\n  30年: 3, x: a ? 1 : 2\n};")).toBe('const r = {\n  利率: 1,\n  "20年月供": 2,\n  "30年": 3, x: a ? 1 : 2\n};');
    expect(quoteKeys("{ 20: 1, a: 2 }")).toBe("{ 20: 1, a: 2 }");
  });

  it("drops only the root that doesn't compile", async () => {
    const { compileTolerant } = await import("../../web/src/lib/genui/compile.ts");
    const src = 'const a = 1;\n<Text>ok</Text>\n<Card title="x">\n  <Stat value={a +} />\n</Card>\n<Badge>tail</Badge>';
    const c = await compileTolerant(src);
    expect(c.dropped).toBe(1);
    expect(c.error).toMatch(/第 4 行/);
    expect(c.code).toContain("h(Badge");
    expect(c.code).not.toContain("h(Card");
    await expect(compileTolerant("const a = ;\n<Text>x</Text>")).rejects.toThrow(/第 1 行/);
  });
});

describe("component schema is the one list", async () => {
  const { GENUI_SCHEMA, GENUI_ICONS, GENUI_COMPONENTS } = await import("@constella/protocol");
  const { COMPONENTS } = await import("../../web/src/lib/genui/runtime.ts");

  it("every schema component has a renderer and nothing else does", () => {
    // Read the keys of the renderer map statically (importing it needs a DOM): the names that start
    // each top-level property of the object literal.
    const src = fs.readFileSync(new URL("../../web/src/components/genui/components.tsx", import.meta.url), "utf8");
    const start = src.indexOf("{", src.indexOf("= {", src.indexOf("export const COMPONENTS")));
    const keys: string[] = [];
    let depth = 0;
    let expectKey = true;
    for (let i = start; i < src.length; i++) {
      const ch = src[i]!;
      if (ch === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
      else if (ch === '"' || ch === "'" || ch === "`") i = src.indexOf(ch, i + 1);
      else if ("{([".includes(ch)) (depth++, (expectKey = depth === 1));
      else if ("})]".includes(ch)) {
        if (--depth === 0) break;
      } else if (depth === 1 && ch === ",") expectKey = true;
      else if (depth === 1 && expectKey && /[A-Za-z]/.test(ch)) {
        const name = /^[A-Za-z]\w*/.exec(src.slice(i))![0];
        keys.push(name);
        i += name.length - 1;
        expectKey = false;
      }
    }
    expect(new Set(keys)).toEqual(new Set(Object.keys(GENUI_SCHEMA)));
    expect(COMPONENTS).toEqual(GENUI_COMPONENTS);
  });

  it("every icon name the agent may use renders", async () => {
    const { ICONS } = await import("../../web/src/components/genui/icons.ts");
    expect(new Set(Object.keys(ICONS))).toEqual(new Set(GENUI_ICONS));
  });
});

describe("validator", async () => {
  const { validateTree } = await import("../../web/src/components/genui/validate.ts");
  const el = (t: string, p: Record<string, unknown> = {}, c: unknown[] = []) => ({ t, p, c });

  it("converts what it safely can and drops what it can't, with diagnostics", () => {
    const { tree, diagnostics } = validateTree(
      el("Fragment", {}, [
        el("Chart", { type: "radar", height: "200", stacked: "true", data: [] }),
        el("Slider", { value: "abc", onChange: { $fn: 1 }, color: "red" }),
        el("Map", { center: [1, 2] }, ["里面的字"]),
        el("Step", { title: "孤立的一步" }),
        el("Stat", { label: "缺值" }),
        el("svg", { viewBox: "0 0 10 10" }, [el("circle", { r: 2 })]),
      ]),
    );
    const [chart, slider, unknown, , , svg] = tree!.c as any[];
    expect(chart.p).toEqual({ height: 200, stacked: true, data: [] });
    expect(slider.p).toEqual({ onChange: { $fn: 1 } });
    expect(unknown).toEqual({ t: "Fragment", p: {}, c: ["里面的字"] });
    expect(svg.t).toBe("svg");
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Chart 的 type 不能是「radar」/),
        expect.stringMatching(/Slider 的 value 应该是数字/),
        "Slider 没有属性 color",
        expect.stringMatching(/未知组件 Map/),
        "Step 要放在 Steps 里",
        "Stat 缺少 value",
      ]),
    );
  });

  it("accepts aliases, children that stand in for required text, and nested element props", () => {
    const { diagnostics } = validateTree(el("Fragment", {}, [el("Grid", { columns: 3 }), el("Code", {}, ["x = 1"]), el("Table", { data: [], columns: ["a"] }), el("Tabs", {}, [el("Tab", { title: "一" })])]));
    expect(diagnostics).toEqual([]);
  });
});

describe("prompt examples are valid programs", () => {
  it("every ui example in the instructions compiles, renders and has no diagnostics", async () => {
    const { intelligentUiNote } = await import("../src/widgets.ts");
    const { validateTree } = await import("../../web/src/components/genui/validate.ts");
    const note = intelligentUiNote("rich");
    const blocks = [...note.matchAll(/```ui [^\n]*\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const src of blocks) {
      const rt = runtime();
      const { code } = await compileWidget(src);
      rt.send({ type: "load", code, slots: [] });
      await rt.settle();
      expect(rt.out.filter((m) => m.type === "error")).toEqual([]);
      expect(validateTree(rt.trees().at(-1)).diagnostics).toEqual([]);
    }
  });

  it("every ui-json example in the instructions builds a clean tree", async () => {
    // The declarative examples are the ones the model copies: if one of them trips the validator, the
    // instructions themselves are wrong, so they are held to the same standard as the programs.
    const { intelligentUiNote } = await import("../src/widgets.ts");
    const { GENUI_SCHEMA, emptyDoc, isUiOp, reduceOps, scanJsonValues } = await import("@constella/protocol");
    const note = intelligentUiNote("rich");
    const blocks = [...note.matchAll(/```ui-json[^\n]*\n([\s\S]*?)\n```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    for (const src of blocks) {
      const scan = scanJsonValues(src, 0);
      expect(scan.bad).toBe(0);
      const entries: { seq: number; op: unknown }[] = [];
      for (const value of scan.values) if (isUiOp(value)) entries.push({ seq: entries.length + 1, op: value });
      expect(entries.length).toBeGreaterThan(0);
      const doc = reduceOps(emptyDoc(), entries);
      expect(doc.issues).toEqual([]);
      expect(doc.roots.length).toBeGreaterThan(0);
      expect(doc.status).toBe("done");
      for (const node of Object.values(doc.nodes)) {
        expect(Object.keys(GENUI_SCHEMA)).toContain(node.type);
        // Every action in an example must be one the dispatcher knows how to run.
        for (const [key, value] of Object.entries(node.props)) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          if (typeof (value as { type?: unknown }).type !== "string") continue;
          if (!["send", "copy", "open", "state", "submit", "reset"].includes((value as { type: string }).type)) continue;
          expect(key, `an action belongs on a prop that can run it`).toMatch(/^on[A-Z]/);
        }
      }
    }
  });
});

describe("interrupted replies", () => {
  it("render the part that was written", async () => {
    const cut = calculator.slice(0, calculator.indexOf("<Stat"));
    const fixed = repairPartial(cut)!;
    const rt = runtime();
    rt.send({ type: "load", code: (await compileWidget(fixed)).code, slots: [] });
    await rt.settle();
    expect(rt.trees().at(-1).c[0]).toMatchObject({ t: "Card", c: [{ t: "Slider" }] });
  });
});
