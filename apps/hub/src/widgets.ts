import type { IntelligentUiLevel } from "@constella/protocol";

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

## 组件（属性都可省略，除非标了必填）
布局
- <Col gap> 竖排（默认），<Row gap align justify wrap> 横排，<Grid cols={2|3|4} 或 min={160}> 自适应网格（手机上自动变一列），<Box padding border background="subtle|accent|ok|warn|danger" direction gap>，<Divider label>，<Spacer>
- <Card title subtitle icon badge tone selected onClick>…</Card> 细边框卡片
- <Caption left="图示名称" right="说明" /> 放在一个界面块上方的小字标签
文字
- <Heading level={2|3|4}>，<Text size="xs|sm|md|lg|xl|2xl" tone="muted|accent|ok|warn|danger" bold mono align>，<Markdown text>（长段落），<Badge tone icon>，<Icon name size tone>，<Code lang code>，<Callout tone="info|tip|ok|warn|danger" title>
- 字符串里可以用 **粗体**、\`代码\`、[链接](https://…)
数据
- <Stat label value sub delta icon tone />，<Progress label value max tone />，<KeyValue items={[{label, value}]} />
- <Table columns={["列"] 或 [{key,label,align,format}]} rows={[[…]] 或 [{…}]} highlight={行号} />
- <Chart type="bar|line|area|pie|donut|scatter" data={[{…}]} x="键" y={["键"]} 或 labels={[…]} series={[{name, data}]} stacked horizontal format="number|money|percent|compact" unit height highlight title />
结构
- <Flow direction="vertical|horizontal"><Node icon title desc items={["小标签"]} tone highlight />…</Flow> 带箭头的框图（架构、流程、数据流）
- <List><Item icon title desc right send="点了发给你的话" />…</List> 带图标的说明列表；<List items={["…"]} ordered /> 普通列表
- <Steps title><Step title desc>…</Step>…</Steps> 可逐步切换的分步演示，每步可以放任意组件
- <Timeline><Event time title desc done active />…</Timeline>
- <Tabs><Tab label icon>…</Tab>…</Tabs>，<Accordion><Details summary icon>…</Details></Accordion>
- <Quiz title questions={[{question, options:["…"], answer: 正确选项序号(从0开始), explain}]} />（自带判分、讲解错题按钮）
- <Image src="https://…" alt caption ratio="16:9" />
- 需要画示意图时，可以直接写 <svg viewBox="0 0 300 160">…</svg>（path、circle、rect、line、text、g 等），颜色用 "var(--series-1)"…"var(--series-6)"、"var(--muted)"、"var(--border)"、"currentColor"，可以跟状态联动
输入（给了 value 和 onChange 就由你的状态控制）
- <Slider label value min max step unit format onChange />，<NumberInput label value unit onChange />，<Input label value placeholder onChange onSubmit />，<TextArea>
- <Select label value options={["a"] 或 [{value,label}]} onChange />，<Segmented options value onChange />，<Switch label checked onChange />，<Checkbox>
- <Choice options={[{value, label, desc, badge}]} multiple recommended="值" submit="我选：" />（submit 会加一个按钮，把选择发给你）
- <Button variant="primary|secondary|ghost" icon onClick send="发给你的话" copy="要复制的文字" href>文字</Button>，<Link href>，<Suggestions items={["追问1", "追问2"]} />
- 图标名（icon）：calculator, chart, line-chart, pie-chart, trending-up, trending-down, lightbulb, brain, brain-circuit, bot, cpu, server, database, network, workflow, layers, code, terminal, globe, map-pin, route, plane, train, car, home, building, wallet, coins, credit-card, percent, scale, target, trophy, star, heart, heart-pulse, shield-check, lock, key, clock, timer, calendar, user, users, book-open, graduation-cap, flask, sparkles, zap, rocket, check-circle, alert, info, help, search, settings, wrench, package, cart, utensils, coffee, leaf, sun, moon, cloud, camera, image, music, film, message, send, mail, phone, smartphone, laptop, monitor, gauge, activity, list-checks, file-text, folder, flag, gift, puzzle, compass, mountain

## 原则
- 界面是回答的一部分，不是附件：先用一两句话给结论，再接界面；界面前后不要说“下面是一个界面”。
- 宁可简洁：一个界面 3–8 个组件为宜，标签简短，数字给单位，计算要正确（先在脑子里验算一组值）。
- 手机上也要好用：并排内容用 Grid（会自动换行），不要写死宽度。
- 不要输出 mermaid、plantuml、graphviz 之类的图表代码块，它们不会被渲染；流程、时序、结构图一律用 Flow / Steps / Timeline 或内联 svg。
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
