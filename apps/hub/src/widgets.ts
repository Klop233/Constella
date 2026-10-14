import type { IntelligentUiLevel } from "@constella/protocol";

// What agents are told about interactive reply blocks (智能界面). The web app renders them
// (apps/web/src/components/Widget.tsx) with the runtime in apps/web/src/lib/widget-runtime.ts;
// keep the class names and the `ui` API listed here in step with that runtime.

const WHEN: Record<Exclude<IntelligentUiLevel, "off">, string> = {
  balanced: `- 只在界面明显比文字更好懂、更好用时才用，一条回复最多一个。适合：
  - 有参数可调的计算和估算（贷款、预算、换算、配速、剂量…），做成计算器；
  - 一组数据的对比、构成或趋势，做成图表；
  - 机制、结构、流程、空间关系（原理示意、步骤演示、时间线、行程路线），做成 SVG 示意图或可切换的分步视图；
  - 学习类问题，在讲解后附一个 3–5 题的小测验；
  - 多个方案的对比，做成可切换或可筛选的对比卡片；
  - 需要主人在多个选项里挑、或填几个参数再让你继续的，做成按钮或小表单（提交时用 ui.send 发回给你）。
- 不要用：简单事实问答、闲聊、写代码或运维任务的结果汇报、主人要求纯文字时、内容本来就是一段话能说清的。拿不准就不用。`,
  rich: `- 主动使用：凡是图表、计算器、示意图、分步视图、小测验、对比卡片、按钮或表单能让回答更好懂、更好用的，都可以做，一条回复可以有多个（分别放在相关段落后面）。适合：可调参数的计算和估算、数据对比和趋势、机制/流程/结构/时间线/行程、学习类问题的小测验、方案对比、需要主人挑选或填参数的地方。
- 仍然不要用：闲聊、写代码或运维任务的结果汇报、主人要求纯文字时。`,
};

const SPEC = `- 写法：在回复正文里放一个代码块，语言标成 ui，后面跟一个简短标题；块里是 HTML 片段（不要 <html>/<head>/<body>），可以有 <style>、<script>、内联 <svg>：
  \`\`\`ui 房贷计算器
  <div class="card">…</div>
  <script>…</script>
  \`\`\`
- 文字仍是主体：界面前面先用一两句话给出结论或说明，界面只做补充；不要在文字里描述“下面是一个界面”。
- 外观：平台已注入和站点一致的基础样式，直接用这些类名，不要自己定义整套配色：
  - 布局 .card（细边框卡片）.row（横排，自动换行）.col（竖排）.grid（自适应网格）.spacer；文字 .muted .small .big .title；
  - 数据 .stat（里面放 <span class="label">标签</span><span class="value">数字</span>）、.badge、.chip（可点的小标签，选中加 .active）、.tabs（里面放 <button>，选中加 .active）、.bar（进度条，用 style="--v:40%"）；
  - 表单 button（默认次要按钮，主操作加 .primary）、input、select、textarea、input[type=range]、label、table、details/summary 都已有样式。
  - 颜色只用 CSS 变量：--text --muted --bg --surface --surface-2 --border --accent --ok --warn --danger，图表分类色依次用 --series-1 … --series-6（也可用 ui.color(i)）。明暗和配色切换会自动跟随，不要写死颜色，界面背景保持透明。
- 图表：全局 Chart（Chart.js 4）直接可用，已按站点主题设好字体、网格和配色；放在 <div class="chart"><canvas></canvas></div> 里（默认高 240px）。简单示意图用内联 SVG，用 currentColor 和上面的变量。
- 交互接口 window.ui：
  - ui.send(文字)：以主人的名义发一条新消息给你，用于“按这个方案展开”“换成…再算一次”“提交答案”这类后续，文字要是完整的一句话并带上界面里的当前取值；只能由主人点击触发。
  - ui.state（对象）和 ui.setState({...})：保存主人在界面里的输入和选择，刷新、换设备后还在；初始化时先读 ui.state 恢复。
  - ui.copy(文字)、ui.open(链接)；ui.color(i) 取第 i 个分类色。
- 限制：没有网络（fetch/XHR 会被拦截），需要的数据直接写进代码；图片只能用 https 或 data: 地址；不用 alert/confirm/prompt；手机宽度（340px）也要能用；源码尽量控制在 15KB 内；所有文字用中文。`;

const EXAMPLE = `- 示例（结构参考，按实际需要改）：
  \`\`\`ui 存款计算器
  <div class="col">
    <label>每月存入 <b id="mv"></b><input id="m" type="range" min="500" max="20000" step="500"></label>
    <label>年化收益 <b id="rv"></b><input id="r" type="range" min="0" max="8" step="0.1"></label>
    <div class="grid"><div class="stat"><span class="label">10 年后</span><span class="value" id="total"></span></div></div>
    <div class="chart"><canvas id="c"></canvas></div>
    <div class="row"><button class="primary" id="go">按这个方案给我理财建议</button></div>
  </div>
  <script>
  const m = document.getElementById("m"), r = document.getElementById("r");
  m.value = ui.state.m ?? 3000; r.value = ui.state.r ?? 3;
  const chart = new Chart(document.getElementById("c"), { type: "line", data: { labels: [], datasets: [{ label: "累计", data: [] }] } });
  function update() {
    const pm = +m.value, rate = +r.value / 100 / 12, pts = [];
    let v = 0; for (let i = 1; i <= 120; i++) { v = v * (1 + rate) + pm; if (i % 12 === 0) pts.push(Math.round(v)); }
    mv.textContent = pm + " 元"; rv.textContent = r.value + "%"; total.textContent = Math.round(v).toLocaleString() + " 元";
    chart.data.labels = pts.map((_, i) => i + 1 + " 年"); chart.data.datasets[0].data = pts; chart.update();
    ui.setState({ m: pm, r: +r.value });
  }
  m.oninput = r.oninput = update; update();
  go.onclick = () => ui.send("我每月存 " + m.value + " 元、年化 " + r.value + "%，10 年后约 " + total.textContent + "，按这个方案给我理财建议");
  </script>
  \`\`\``;

/** The instructions section about interactive replies, or "" when the setting is off. */
export function intelligentUiNote(level: IntelligentUiLevel): string {
  if (level === "off") return "";
  return `# 智能界面（交互式回答）
主人在网页和手机上看你的回复，回复里可以直接嵌入可交互的小界面（图表、计算器、示意图、测验、按钮、表单），会在对话里原位渲染。
${WHEN[level]}
${SPEC}
${EXAMPLE}`;
}
