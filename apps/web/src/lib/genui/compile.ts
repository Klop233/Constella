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

export interface Compiled {
  /** Defines `__App`, a component function, for the worker runtime. */
  code: string;
}

export class CompileError extends Error {}

/** Where the statements end and the tree begins. */
export function splitProgram(source: string): { statements: string; tree: string } {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^<[A-Za-z>]/.test(l));
  if (at < 0) {
    // A program that defines its own App (or returns a tree) is fine too.
    if (/\bfunction\s+App\s*\(|\bconst\s+App\s*=/.test(source)) return { statements: `${source}\nreturn h(App, null);`, tree: "" };
    throw new CompileError("没有找到界面内容：组件树要从行首的「<」开始");
  }
  return { statements: lines.slice(0, at).join("\n"), tree: lines.slice(at).join("\n") };
}

let sucrase: Promise<typeof import("sucrase")> | null = null;

export async function compileWidget(source: string): Promise<Compiled> {
  const { statements, tree } = splitProgram(source);
  const body = tree ? `${statements}\nreturn (<>\n${tree}\n</>);` : statements;
  const program = `function __App() {\n${body}\n}`;
  sucrase ??= import("sucrase");
  const { transform } = await sucrase;
  try {
    const out = transform(program, { transforms: ["jsx"], jsxPragma: "h", jsxFragmentPragma: "Fragment", production: true });
    return { code: out.code };
  } catch (err) {
    // Sucrase reports positions in the wrapped program: one line before the block.
    const msg = err instanceof Error ? err.message : String(err);
    throw new CompileError(msg.replace(/\((\d+):(\d+)\)/, (_, l: string, c: string) => `（第 ${Math.max(1, Number(l) - 1)} 行第 ${c} 列）`));
  }
}
