import vm from "node:vm";
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
