// Compiles a component block (```ui) into the worker program. The block is plain JS statements
// (hooks, helpers, calculations) followed by a JSX tree that starts on an unindented line beginning
// with "<"; everything from there on is the tree, and may have several roots:
//
//   const [rate, setRate] = useState(4);
//   const pay = monthly(100e4, rate, 30);
//   <Card title="月供">
//     <Slider label="年利率" value={rate} min={2} max={6} step={0.1} onChange={setRate} unit="%" />
//     <Stat label="月供" value={fmt.money(pay)} />
//   </Card>
//
// Compiling only rewrites JSX into h() calls (sucrase); nothing runs here. Sucrase is loaded on demand.
// Like ChatGPT's compiler it repairs what it safely can (object keys that aren't identifiers), and
// a root that still doesn't compile can be dropped so the rest of the block shows (see `rootsOf`).

export interface Compiled {
  /** Defines `__App`, a component function, for the worker runtime. */
  code: string;
}

export class CompileError extends Error {
  /** 1-based line in the block, when known. */
  line: number | null;
  constructor(message: string, line: number | null = null) {
    super(message);
    this.line = line;
  }
}

const lines = (s: string) => s.replace(/\r\n?/g, "\n").split("\n");
const ROOT = /^<[A-Za-z>]/;

/** Where the statements end and the tree begins. */
export function splitProgram(source: string): { statements: string; tree: string } {
  const ls = lines(source);
  const at = ls.findIndex((l) => ROOT.test(l));
  if (at < 0) {
    // A program that defines its own App (or returns a tree) is fine too.
    if (/\bfunction\s+App\s*\(|\bconst\s+App\s*=/.test(source)) return { statements: `${source}\nreturn h(App, null);`, tree: "" };
    throw new CompileError("没有找到界面内容：组件树要从行首的「<」开始");
  }
  return { statements: ls.slice(0, at).join("\n"), tree: ls.slice(at).join("\n") };
}

/** The tree's top-level roots, each with the block lines it spans (1-based, inclusive). */
export function rootsOf(source: string): { from: number; to: number }[] {
  const ls = lines(source);
  const starts = ls.flatMap((l, i) => (ROOT.test(l) ? [i] : []));
  return starts.map((s, k) => ({ from: s + 1, to: (starts[k + 1] ?? ls.length) }));
}

/** The block without the given roots (by index into `rootsOf`). */
export function dropRoots(source: string, drop: ReadonlySet<number>): string {
  const ls = lines(source);
  const roots = rootsOf(source);
  const gone = new Set<number>();
  roots.forEach((r, k) => {
    if (drop.has(k)) for (let i = r.from; i <= r.to; i++) gone.add(i);
  });
  return ls.filter((_, i) => !gone.has(i + 1)).join("\n");
}

/**
 * Quotes object keys that aren't identifiers (`20年月供: 1` → `"20年月供": 1`), a mistake models make
 * with Chinese labels. Only keys that start a line or follow `{` / `,`, and only ones that can't be
 * valid JS there (they start with a digit and contain something other than digits).
 */
export function quoteKeys(src: string): string {
  return src.replace(/(^|[{,])(\s*)(\d[^\s:,{}()[\]"'`=<>]*[^\d\s:,{}()[\]"'`=<>][^\s:,{}()[\]"'`=<>]*)(\s*):(?!:)/gm, (_m, pre: string, ws: string, key: string, ws2: string) => `${pre}${ws}"${key}"${ws2}:`);
}

let sucrase: Promise<typeof import("sucrase")> | null = null;

export async function compileWidget(source: string): Promise<Compiled> {
  const fixed = quoteKeys(source);
  const { statements, tree } = splitProgram(fixed);
  const statementLines = tree ? lines(statements).length : Infinity;
  const body = tree ? `${statements}\nreturn (<>\n${tree}\n</>);` : statements;
  const program = `function __App() {\n${body}\n}`;
  sucrase ??= import("sucrase");
  const { transform } = await sucrase;
  try {
    const out = transform(program, { transforms: ["jsx"], jsxPragma: "h", jsxFragmentPragma: "Fragment", production: true });
    return { code: out.code };
  } catch (err) {
    // Sucrase reports positions in the wrapped program: one line before the statements, two before the tree.
    const msg = err instanceof Error ? err.message : String(err);
    const m = /\((\d+):(\d+)\)/.exec(msg);
    const at = m ? Number(m[1]) - 1 : null;
    const line = at === null ? null : at <= statementLines ? Math.max(1, at) : at - 1;
    throw new CompileError(m ? msg.replace(m[0], `（第 ${line} 行第 ${m[2]} 列）`) : msg, line);
  }
}

/** Compiles the block, dropping roots that don't compile (up to all of them). */
export async function compileTolerant(source: string): Promise<Compiled & { dropped: number; error: string | null }> {
  const roots = rootsOf(source);
  const drop = new Set<number>();
  let first: string | null = null;
  for (;;) {
    try {
      const c = await compileWidget(drop.size ? dropRoots(source, drop) : source);
      return { ...c, dropped: drop.size, error: first };
    } catch (err) {
      if (!(err instanceof CompileError)) throw err;
      first ??= err.message;
      // Map the error line back to a root of the original block (lines shift as roots are dropped).
      const kept = roots.map((r, k) => ({ ...r, k })).filter((r) => !drop.has(r.k));
      let offset = 0;
      const statementsEnd = (roots[0]?.from ?? 1) - 1;
      const hit =
        err.line === null || err.line <= statementsEnd
          ? undefined
          : kept.find((r) => {
              const len = r.to - r.from + 1;
              const from = statementsEnd + 1 + offset;
              offset += len;
              return err.line! >= from && err.line! < from + len;
            });
      if (!hit) throw new CompileError(first, err.line);
      drop.add(hit.k);
      if (drop.size >= roots.length) throw new CompileError(first, err.line);
    }
  }
}
