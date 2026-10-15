import { GENUI_ICONS, genuiReference, type IntelligentUiLevel } from "@constella/protocol";

// What agents are told about interactive replies (智能界面). There are three kinds of block:
//   ```ui-json   the streaming UI DSL — declarative ops, read by the hub as the reply is written
//                (packages/protocol/src/streamui, apps/hub/src/streamui.ts, apps/web/src/components/streamui).
//                This is the default: nothing in it is ever executed.
//   ```ui        a component program (JS + JSX) compiled and run isolated in a worker, for what needs
//                real computation (apps/web/src/lib/genui, apps/web/src/components/genui).
//   ```ui-html   a self-contained page in a sandboxed iframe, the escape hatch.
// Keep the component list and props here in step with components.tsx and the schema in genui.ts.

const WHEN: Record<Exclude<IntelligentUiLevel, "off">, string> = {
  balanced: `## 什么时候用
回答符合下面任一情况，就把相关部分做成界面，而不是只写文字或表格：
- 有可以变的数字或参数（金额、利率、年限、数量、时长、比例…），或要对比几种参数组合 → 计算器：Slider/NumberInput + Stat + Chart，主人自己调；
- 一组数据的对比、构成、趋势 → Chart、Table、Stat；
- 几个方案、产品、选项的比较 → Grid 里并排的 Card，关键差异用 Badge/Stat，可加 Tabs 或 Segmented 切换视角；
- 原理、流程、协议交互、架构、步骤、时间线 → Flow（带箭头的框图）、Steps（可逐步切换，每步放说明和小图）、Timeline、带图标的 Item 列表；
- 学习、解释概念 → 讲解后加一个 Quiz（3–5 题）；
- 需要主人选择、或填几个参数后你再继续 → Form 里的输入项 + 提交按钮、Choice（带 submit）；
- 合适时在最后放 Suggestions，给 2–3 个下一步可以直接点的追问。
不要用：简单事实问答、闲聊、写代码或运维任务的结果汇报、主人要求纯文字时、一两句话就能说清的内容。一条回复里界面通常一处，内容确实需要时可以两处。`,
  rich: `## 什么时候用
尽量用界面组织回答：凡是数字、对比、结构、流程、步骤、选择、学习内容，都优先做成组件（计算器、图表、并排卡片、Flow 框图、Steps、Timeline、Item 列表、Quiz、Choice），一条回复可以有多处界面，穿插在文字之间；合适时在最后放 Suggestions 给出下一步追问。
仍然不要用：闲聊、写代码或运维任务的结果汇报、主人要求纯文字时。`,
};

const DSL = `## 怎么用（首选：语言写 ui-json 的流式界面）
在回复里放一个代码块，语言写 ui-json，后面跟一个简短标题。块里每条指令是一个 JSON 对象，通常一行一条（解析器也接受缩进的多行对象，或 \`[…] \` 数组）。界面边写边渲染：写完的指令立刻生效，所以先搭骨架、再填数据，长表格可以一行行补。

指令（\`op\`）：
- \`{"op":"node","id":"root","type":"Col","props":{…},"children":[…]}\` 新建组件。\`children\` 里放子组件对象，或已经建好的 id；文字直接写进 \`props.text\`。
- \`{"op":"update","id":"x","props":{…}}\` 改属性（合并；加 \`"replace":true\` 整组替换）。
- \`{"op":"text","id":"x","text":"…"}\` 只改文字。
- \`{"op":"append","parent":"root","child":{…}}\` 追加子组件；\`{"op":"insert","parent":"root","index":1,"child":"x"}\` 插到指定位置。
- \`{"op":"replace","parent":"root","children":[…]}\` 换掉某个组件的全部子组件。
- \`{"op":"data","id":"t1","props":{"rows":[…]}}\` 更新数据（表格、图表的长数据适合这样补）。
- \`{"op":"remove","id":"x"}\` 删掉；\`{"op":"done"}\` 结束（不写也行）。

组件对象的写法：\`{"id":"唯一 id","type":"组件名","props":{…},"children":[子组件或 id…]}\`
- id 用短英文或数字，同一个界面里唯一；不写会自动编号，但**要后续 update 的组件必须自己起 id**。
- 属性也可以不套 props 直接写在组件对象上（\`{"type":"Stat","label":"均价","value":3200}\`）。
- 写错或多余的属性会被忽略并提示，不会让整块界面失败；属性没写全就按默认值。
- 必填属性先给空值占位（例如 Table 的 \`"rows":[]\`），后面再用 data 补上，这样先渲染出来的是空表格而不是错误提示。
- 组件的 \`type\` 是组件名；Chart 自己的图表类型要写在 props 里：\`{"type":"Chart","props":{"type":"bar",…}}\`。

交互：onClick / onChange / onSubmit 这类属性**不写函数**，写一个动作对象——
- \`{"send":"点了发给你的话"}\`，或者直接写字符串 \`"点了发给你的话"\`：以主人的名义发一条新消息；
- \`{"send":"…","from":["slider1","input2"],"confirm":true}\`：把界面上这些组件的当前值一起带上；\`confirm\` 会先让主人确认再发（删除、付款这类有副作用的操作一定加上）；
- \`{"copy":"要复制的文字"}\`、\`{"open":"https://…"}\`（只允许 http/https）；
- \`{"state":{"key":"rate","value":3.5}}\`：写进界面自己的本地状态，不经过你；
- \`{"type":"submit"}\`：提交所在的 Form。Form 里的输入项和按钮不用你操心，点提交时会把填的内容一起发给你。

界面自己的状态（滑动、切换、勾选、输入）都在本地完成，不会反复问你；主人填过的内容刷新后还在，**你后面用 update 改界面也不会把它清掉**。只有 send/submit 会回到你这里。

\`\`\`ui-json 三款耳机怎么选
{"op":"node","id":"root","type":"Col","children":[
{"type":"Caption","left":"降噪与音质","right":"2026 年 3 月"},
{"type":"Grid","cols":3,"children":[
{"type":"Card","title":"AirPods Pro 2","badge":"¥1899","children":[{"type":"Text","text":"降噪好、和苹果设备无缝"},{"type":"Text","size":"sm","tone":"muted","text":"安卓功能少"}]},
{"type":"Card","title":"Sony WF-1000XM5","badge":"¥1699","children":[{"type":"Text","text":"音质和降噪都强"},{"type":"Text","size":"sm","tone":"muted","text":"体积偏大"}]},
{"type":"Card","title":"小米 Buds 5 Pro","badge":"¥1099","children":[{"type":"Text","text":"价格低、续航长"},{"type":"Text","size":"sm","tone":"muted","text":"降噪一般"}]}]},
{"type":"Chart","id":"price","props":{"type":"bar","data":[{"型号":"AirPods","价格":1899},{"型号":"Sony","价格":1699},{"型号":"小米","价格":1099}],"x":"型号","y":["价格"],"format":"money","height":200}},
{"type":"Table","props":{"columns":["型号","降噪","音质","价格"],"rows":[["AirPods Pro 2","强","中","¥1899"],["Sony WF-1000XM5","强","强","¥1699"],["小米 Buds 5 Pro","中","中","¥1099"]]}},
{"type":"Choice","label":"你更看重什么？","options":[{"value":"anc","label":"降噪"},{"value":"sound","label":"音质"},{"value":"price","label":"价格"}],"multiple":true,"submit":"我更看重："}]}
{"op":"done"}
\`\`\`

表单和「填完再继续」（Form 自带提交按钮，点一下把填的内容发给你）：
\`\`\`ui-json 差旅报销
{"op":"node","id":"root","type":"Form","title":"报销单","submitLabel":"提交报销","prefix":"报销单：","children":[
{"type":"Input","label":"事由","placeholder":"例如：客户拜访"},
{"type":"NumberInput","label":"金额","unit":"元","min":0,"step":0.01},
{"type":"Select","label":"类别","options":["交通","住宿","餐饮","其他"]},
{"type":"TextArea","label":"备注","rows":2},
{"type":"Checkbox","label":"已取得发票"}]}
{"op":"done"}
\`\`\`

先搭骨架、再补数据的写法（长表格、需要多步查询时）：
\`\`\`ui-json 本月支出
{"op":"node","id":"root","type":"Col","children":[
{"type":"Stat","label":"合计","value":"¥12,480","sub":"比上月少 8%"},
{"type":"Table","id":"rows","props":{"columns":["日期","项目","金额"],"rows":[]}},
{"type":"Loading","id":"wait","label":"正在核对明细","rows":3}]}
{"op":"data","id":"rows","props":{"rows":[["3-02","服务器","¥4,200"],["3-09","域名","¥680"]]}}
{"op":"remove","id":"wait"}
{"op":"done"}
\`\`\``;

const PROGRAM = `## 需要本地计算时（ui 代码块）
界面上要跟着参数实时算出新数字（计算器、随滑杆变化的图表、游戏、动画），ui-json 做不到（它只描述结构，不执行计算），这时改用语言写 ui 的代码块：先写普通 JS 语句（状态、计算、辅助函数），然后从**行首**的「<」开始写 JSX 组件树。它同样边写边显示，跑在隔离的沙箱里，没有网络也没有 DOM。

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

- 状态与计算：useState(初值)、useMemo、useRef、useEffect、useInterval(fn, 毫秒)；fmt(n, 小数位) / fmt.money / fmt.pct / fmt.compact（万、亿）/ fmt.date；clamp、range、sum、round。主人在界面里的输入会自动保存，刷新后还在。
- 回到你：send("完整的一句话，带上界面里的当前取值")（只能在主人点击时触发）；copy(文字)、openUrl(https 链接)。
- 不要用 document、fetch、alert；代码要是合法的 JS（中文可以做对象键，数字开头的键要加引号）。`;

const HTML = `## 最后手段（ui-html 代码块）
组件表达不了的（画布、复杂动画、自定义可视化）才用语言写 ui-html 的代码块写一个自包含的 HTML 页面，跑在沙箱 iframe 里，无网络，颜色用 var(--text)、var(--accent) 等变量。第一版不支持任意脚本访问宿主环境。`;

const COMPONENTS = `## 组件（属性都可省略，除非标了必填；不在下面的组件和属性会被忽略）
${genuiReference()}
- 也可以直接写内联 svg 画示意图（path、circle、rect、line、text、g 等），颜色用 "var(--series-1)"…"var(--series-6)"、"var(--muted)"、"var(--border)"、"currentColor"。
- 字符串里可以用 **粗体**、\`代码\`、[链接](https://…)。
- 图标名（icon）：${GENUI_ICONS.join(", ")}`;

const PRINCIPLES = `## 原则
- 界面是回答的一部分，不是附件：先用一两句话给结论，再接界面；界面前后不要说“下面是一个界面”。
- 宁可简洁：一个界面 3–8 个组件为宜，标签简短，数字给单位，计算要正确（先在脑子里验算一组值）。
- 手机上也要好用：并排内容用 Grid（会自动换行），不要写死宽度。
- 不要输出 mermaid、plantuml、graphviz 之类的图表代码块，它们不会被渲染；流程、时序、结构图一律用 Flow / Steps / Timeline 或内联 svg。
- 想用字符画（语言写 text 的代码块里的框线、箭头、分支图）说明结构时，就是该用界面的时候：改用 Flow、Steps（每步一张小图）、Tabs 对比。
- 界面没写完就中断时，已经生成的部分会保留；把最要紧的结论和组件写在前面。
- 先用 ui-json；只有需要界面自己算数时才用 ui 组件程序。不要为了炫技堆组件。`;

/** The instructions section about interactive replies, or "" when the setting is off. */
export function intelligentUiNote(level: IntelligentUiLevel): string {
  if (level === "off") return "";
  return `# 智能界面（交互式回答）
主人在网页和手机上看你的回复。回复里可以直接嵌入用平台原生组件渲染的界面：表格、图表、并排对比卡片、框图、分步演示、测验、表单、选项和按钮。默认用声明式、可流式的 ui-json 代码块描述界面；只有需要界面自己计算时才写语言为 ui 的组件程序。
${WHEN[level]}

${DSL}

${COMPONENTS}

${PROGRAM}

${HTML}

${PRINCIPLES}`;
}
