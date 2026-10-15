import { GENUI_ICONS, genuiReference, type IntelligentUiLevel } from "@constella/protocol";

// What agents are told about interactive replies (智能界面). The web app compiles ```ui blocks and
// runs them isolated (apps/web/src/lib/genui), then renders the result with its own components
// (apps/web/src/components/genui/components.tsx); ```ui-html is the sandboxed-page escape hatch.
// Keep the component list and props here in step with components.tsx and runtime.ts.

const WHEN: Record<Exclude<IntelligentUiLevel, "off">, string> = {
  balanced: `## 什么时候用
回答符合下面任一情况，就把相关部分做成界面，而不是只写文字或表格：
- 有可以变的数字或参数（金额、利率、年限、数量、时长、比例…），或要对比几种参数组合 → 计算器：Slider/NumberInput + Stat + Chart，主人自己调；
- 一组数据的对比、构成、趋势 → Chart、Table、Stat；
- 几个方案、产品、选项的比较 → Grid 里并排的 Card，关键差异用 Badge/Stat，可加 Tabs 或 Segmented 切换视角；
- 原理、流程、协议交互、架构、步骤、时间线 → Flow（带箭头的框图）、Steps（可逐步切换，每步放说明和小图）、Timeline、带图标的 Item 列表；
- 学习、解释概念 → 讲解后加一个 Quiz（3–5 题）；
- 需要主人选择、或填几个参数后你再继续 → Choice（带 submit）、表单 + Button 用 send() 发回给你；
- 合适时在最后放 Suggestions，给 2–3 个下一步可以直接点的追问。
不要用：简单事实问答、闲聊、写代码或运维任务的结果汇报、主人要求纯文字时、一两句话就能说清的内容。一条回复里界面通常一处，内容确实需要时可以两处。`,
  rich: `## 什么时候用
尽量用界面组织回答：凡是数字、对比、结构、流程、步骤、选择、学习内容，都优先做成组件（计算器、图表、并排卡片、Flow 框图、Steps、Timeline、Item 列表、Quiz、Choice），一条回复可以有多处界面，穿插在文字之间；合适时在最后放 Suggestions 给出下一步追问。
仍然不要用：闲聊、写代码或运维任务的结果汇报、主人要求纯文字时。`,
};

const SPEC = `## 怎么写
在回复里放一个代码块，语言写 ui，后面跟一个简短标题。块里先写普通 JS 语句（状态、计算、辅助函数），然后从**行首**的「<」开始写 JSX 组件树（可以有多个并列的根）。界面在主人的页面上用平台自己的原生组件渲染，样式、配色、明暗都由平台负责，你只管选组件和填内容；块会边写边显示。

\`\`\`ui 房贷对比
const [loan, setLoan] = useState(100);       // 万元
const [rate, setRate] = useState(3.5);
const pay = (years) => { const r = rate / 1200, n = years * 12; return r ? loan * 1e4 * r / (1 - (1 + r) ** -n) : loan * 1e4 / n; };
const rows = [20, 30].map((y) => ({ 期限: y + " 年", 月供: Math.round(pay(y)), 总利息: Math.round(pay(y) * y * 12 - loan * 1e4) }));
<Card title="调一调参数" icon="calculator">
  <Slider label="贷款金额" value={loan} min={10} max={500} step={10} unit=" 万" onChange={setLoan} />
  <Slider label="年利率" value={rate} min={2} max={6} step={0.05} unit="%" onChange={setRate} />
</Card>
<Grid cols={2}>
  {rows.map((r) => <Stat key={r.期限} label={r.期限 + "月供"} value={fmt.money(r.月供)} sub={"总利息 " + fmt.compact(r.总利息) + " 元"} />)}
</Grid>
<Chart type="bar" data={rows} x="期限" y={["总利息"]} format="compact" height={200} />
<Suggestions items={["加上提前还款的情况", "按 " + rate + "% 利率给我还款建议"]} />
\`\`\`

## 可用的
- 状态与计算：useState(初值)、useMemo、useRef、useEffect、useInterval(fn, 毫秒)；fmt(n, 小数位) / fmt.money / fmt.pct / fmt.compact（万、亿）/ fmt.date；clamp、range、sum、round。主人在界面里的输入会自动保存，刷新后还在。
- 回到你：send("完整的一句话，带上界面里的当前取值") 以主人的名义发一条新消息（只能在主人点击时触发）；copy(文字)、openUrl(https 链接)。界面里的滑动、切换、输入都在本地完成，不经过你。
- 没有网络，也没有 DOM：数据直接写进代码，不要用 document、fetch、alert。

## 组件（属性都可省略，除非标了必填；不在下面的组件和属性会被忽略）
${genuiReference()}
- 也可以直接写内联 svg 画示意图（path、circle、rect、line、text、g 等），颜色用 "var(--series-1)"…"var(--series-6)"、"var(--muted)"、"var(--border)"、"currentColor"，可以跟状态联动。
- 字符串里可以用 **粗体**、\`代码\`、[链接](https://…)。
- 图标名（icon）：${GENUI_ICONS.join(", ")}

## 更多示例
讲原理（结论 → 框图 → 分步 → 测验）：
\`\`\`ui DNS 解析过程
<Caption left="一次 DNS 查询" right="从浏览器到权威服务器" />
<Flow>
  <Node icon="globe" title="浏览器" desc="先查自己的缓存" />
  <Node icon="server" title="递归解析器" desc="运营商或 8.8.8.8，替你跑完整个查询" tone="accent" highlight />
  <Node icon="network" title="根 → 顶级域 → 权威服务器" items={["根：告诉你 .com 在哪", ".com：告诉你 example.com 在哪", "权威：给出 IP"]} />
</Flow>
<Steps title="逐步看">
  <Step title="1 · 查缓存" desc="浏览器、系统、路由器依次查"><Progress label="命中率" value={80} valueLabel="大多数请求到这里就结束" /></Step>
  <Step title="2 · 递归查询" desc="解析器从根服务器开始问"><List items={["问根服务器 → 得到 .com 的地址", "问 .com → 得到 example.com 的权威服务器", "问权威服务器 → 得到 IP"]} ordered /></Step>
  <Step title="3 · 缓存结果" desc="按 TTL 缓存，下次直接用"><Stat label="典型 TTL" value="300 秒" /></Step>
</Steps>
<Quiz questions={[{ question: "谁替你完成整个查询？", options: ["浏览器", "递归解析器", "根服务器"], answer: 1, explain: "递归解析器一路问到权威服务器再把结果给你。" }]} />
\`\`\`

帮主人做选择（并排对比 → 让主人挑）：
\`\`\`ui 三款耳机怎么选
const items = [
  { id: "a", name: "AirPods Pro 2", price: 1899, good: "降噪好、和苹果设备无缝", bad: "安卓功能少" },
  { id: "b", name: "Sony WF-1000XM5", price: 1699, good: "音质和降噪都强", bad: "体积偏大" },
  { id: "c", name: "小米 Buds 5 Pro", price: 1099, good: "价格低、续航长", bad: "降噪一般" },
];
<Grid cols={3}>
  {items.map((it) => (
    <Card key={it.id} title={it.name} badge={fmt.money(it.price)}>
      <Text size="sm"><Badge tone="ok">优点</Badge> {it.good}</Text>
      <Text size="sm"><Badge tone="warn">不足</Badge> {it.bad}</Text>
    </Card>
  ))}
</Grid>
<Choice label="你更看重什么？" options={[{ value: "anc", label: "降噪" }, { value: "sound", label: "音质" }, { value: "price", label: "价格" }]} multiple submit="我更看重：" />
\`\`\`

## 原则
- 界面是回答的一部分，不是附件：先用一两句话给结论，再接界面；界面前后不要说“下面是一个界面”。
- 宁可简洁：一个界面 3–8 个组件为宜，标签简短，数字给单位，计算要正确（先在脑子里验算一组值）。
- 手机上也要好用：并排内容用 Grid（会自动换行），不要写死宽度。
- 不要输出 mermaid、plantuml、graphviz 之类的图表代码块，它们不会被渲染；流程、时序、结构图一律用 Flow / Steps / Timeline 或内联 svg。
- 想用字符画（\`\`\`text 里的框线、箭头、分支图、示意图）说明结构时，就是该用界面的时候：改用 Flow、Steps（每步一张小图）、Tabs 对比或内联 svg。
- 代码要是合法的 JS：中文可以做对象键，但以数字开头的键要加引号（{"20年月供": 1}），或者换成英文键再用 names 指定显示名。
- 组件不够用（游戏、动画、画布、复杂自定义交互）时才用 \`\`\`ui-html 代码块写一个自包含的 HTML 页面（无网络、颜色用 var(--text)、var(--accent) 等变量）。`;

/** The instructions section about interactive replies, or "" when the setting is off. */
export function intelligentUiNote(level: IntelligentUiLevel): string {
  if (level === "off") return "";
  return `# 智能界面（交互式回答）
主人在网页和手机上看你的回复。回复里可以直接嵌入用平台原生组件渲染的界面：计算器、图表、并排对比卡片、框图、分步演示、测验、选项和按钮。
${WHEN[level]}

${SPEC}`;
}
