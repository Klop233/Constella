// The component schema for interactive replies (智能界面): the one list of components, their props
// and where they may appear. It drives three things that must agree:
//   - the names a ui program may use (apps/web/src/lib/genui/runtime.ts),
//   - the validator that checks every tree before it's rendered (apps/web/src/components/genui/validate.ts),
//   - the component reference agents are given (apps/hub/src/widgets.ts).
// The renderers themselves live in apps/web/src/components/genui/components.tsx (one per entry here).

export type PropType = "string" | "number" | "boolean" | "array" | "object" | "function" | "node" | "any";

export interface PropSpec {
  /** Accepted types; strings also accept numbers (shown as text), numbers accept numeric strings. */
  type: PropType | PropType[];
  /** For enumerations: the allowed values. */
  values?: readonly string[];
  required?: boolean;
  /** Shown to agents, keep it short. */
  desc?: string;
  /** Also accepted under these names (kept out of the agent reference). */
  alias?: readonly string[];
}

export interface ComponentSpec {
  group: "布局" | "文字" | "数据" | "结构" | "输入";
  desc: string;
  props: Record<string, PropSpec>;
  /** Only meaningful inside this parent. */
  parent?: string;
  /** Hidden from the agent reference (aliases). */
  hidden?: boolean;
}

const TONE = ["default", "muted", "accent", "ok", "warn", "danger", "info"] as const;
const tone = (desc?: string): PropSpec => ({ type: "string", values: TONE, desc });
const s = (desc?: string, required = false): PropSpec => ({ type: "string", desc, required });
const n = (desc?: string, required = false): PropSpec => ({ type: "number", desc, required });
const b = (desc?: string): PropSpec => ({ type: "boolean", desc });
const fn = (desc?: string): PropSpec => ({ type: "function", desc });
const icon: PropSpec = { type: "string" };
const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
const JUSTIFY = ["start", "center", "end", "between", "around", "evenly"] as const;
const BG = ["surface", "subtle", "muted", "accent", "ok", "warn", "danger"] as const;
const layout = {
  gap: n("0–8"),
  align: { type: "string", values: ALIGN },
  justify: { type: "string", values: JUSTIFY },
  padding: n(),
  border: b(),
  background: { type: "string", values: BG, alias: ["bg"] },
  wrap: b(),
  flex: n(),
} satisfies Record<string, PropSpec>;
const options: PropSpec = { type: "array", required: true, desc: '["a"] 或 [{value, label, desc, icon, badge}]' };

export const GENUI_SCHEMA: Record<string, ComponentSpec> = {
  // 布局
  Col: { group: "布局", desc: "竖排（默认 gap 3）", props: { ...layout } },
  Stack: { group: "布局", desc: "同 Col", props: { ...layout }, hidden: true },
  Row: { group: "布局", desc: "横排，默认换行、垂直居中", props: { ...layout } },
  Grid: { group: "布局", desc: "网格：最多 cols 列、每列至少 min 像素，手机上自动变少", props: { cols: { type: "number", alias: ["columns"], desc: "2–4" }, min: { type: "number", alias: ["minWidth"], desc: "每列最小宽度 px" }, gap: n() } },
  Box: { group: "布局", desc: "通用容器", props: { ...layout, direction: { type: "string", values: ["row", "col", "column"] }, textAlign: { type: "string", values: ["left", "center", "right"] } } },
  Card: { group: "布局", desc: "细边框卡片；可点击、可选中", props: { title: s(), subtitle: s(), icon, badge: s(), badgeTone: tone(), tone: tone(), selected: b(), onClick: fn() } },
  Divider: { group: "布局", desc: "分隔线，可带文字", props: { label: s() } },
  Spacer: { group: "布局", desc: "空白；不给 size 时撑满剩余空间", props: { size: n() } },
  Caption: { group: "布局", desc: "放在一块界面上方的小字标签，左右两端", props: { left: s(), right: s() } },

  // 文字
  Heading: { group: "文字", desc: "标题", props: { level: n("1–4，默认 3") } },
  Text: {
    group: "文字",
    desc: "一段文字，可用 **粗体**、`代码`、[链接](https://…)",
    props: {
      size: { type: "string", values: ["xs", "sm", "md", "lg", "xl", "2xl", "3xl"] },
      tone: { ...tone(), alias: ["color"] },
      bold: b(),
      weight: { type: "string", values: ["normal", "medium", "semibold", "bold"] },
      italic: b(),
      mono: b(),
      truncate: b(),
      align: { type: "string", values: ["left", "center", "right"] },
    },
  },
  Markdown: { group: "文字", desc: "一段 Markdown（长段落、列表）", props: { text: { type: "string", alias: ["content"] } } },
  Code: { group: "文字", desc: "代码块，带复制", props: { code: s(), lang: s() } },
  Callout: { group: "文字", desc: "提示框", props: { tone: { type: "string", values: ["info", "tip", "ok", "warn", "danger", "accent", "muted", "default"] }, title: s(), icon } },
  Badge: { group: "文字", desc: "小徽标", props: { tone: tone(), icon } },
  Icon: { group: "文字", desc: "图标", props: { name: s("图标名", true), size: n(), tone: tone() } },
  Kbd: { group: "文字", desc: "按键", props: {} },

  // 数据
  Stat: { group: "数据", desc: "统计卡：标签 + 大数字", props: { label: s(undefined, true), value: { type: "string", required: true }, sub: s(), delta: { type: ["number", "string"], desc: "变化，正绿负红" }, invert: b("delta 越小越好"), icon, tone: tone() } },
  Progress: { group: "数据", desc: "进度条", props: { value: n(undefined, true), max: n(), label: s(), tone: tone(), showValue: b(), valueLabel: s() } },
  KeyValue: { group: "数据", desc: "键值对列表", props: { items: { type: ["array", "object"], required: true, desc: "[{label, value}] 或 {键: 值}" } } },
  Table: {
    group: "数据",
    desc: "表格，数字列自动右对齐",
    props: {
      columns: { type: "array", desc: '["列名"] 或 [{key, label, align, format, unit}]' },
      rows: { type: "array", alias: ["data"], required: true, desc: "[[…]] 或 [{…}]" },
      highlight: n("高亮第几行（从 0 起）"),
    },
  },
  Chart: {
    group: "数据",
    desc: "图表（SVG，悬停看数值）",
    props: {
      type: { type: "string", values: ["bar", "line", "area", "pie", "donut", "scatter"] },
      data: { type: "array", desc: "[{…}]，配合 x、y" },
      x: s("类别键"),
      y: { type: ["string", "array"], desc: "数值键，一个或多个" },
      names: { type: "object", desc: "{键: 显示名}" },
      labels: { type: "array", desc: "配合 series 用" },
      series: { type: "array", desc: "[{name, data, color}]" },
      stacked: b(),
      horizontal: b(),
      format: { type: "string", values: ["number", "money", "percent", "compact"] },
      unit: s(),
      min: n(),
      max: n(),
      height: n(),
      legend: b(),
      colors: { type: "array" },
      highlight: { type: ["number", "string"], desc: "高亮某个类别" },
      title: s(),
    },
  },

  // 结构
  List: { group: "结构", desc: "列表：放 Item，或用 items 给字符串", props: { items: { type: "array" }, ordered: b(), divided: b() } },
  Item: { group: "结构", desc: "图标块 + 粗体标题 + 说明的一行", props: { icon, title: s(), desc: s(), right: s("右侧小字"), tone: tone(), iconSize: n(), send: s("点击后发给你的话"), onClick: fn() } },
  Flow: { group: "结构", desc: "带箭头的框图：架构、流程、数据流", props: { direction: { type: "string", values: ["vertical", "horizontal", "row"] } } },
  Node: { group: "结构", desc: "Flow 里的一个框", parent: "Flow", props: { icon, title: s(), desc: s(), items: { type: "array", desc: "框里的小标签" }, tone: tone(), highlight: b() } },
  Steps: { group: "结构", desc: "分步演示，可逐步切换", props: { title: s(), initial: n(), variant: { type: "string", values: ["numbers", "dots"] } } },
  Step: { group: "结构", desc: "Steps 里的一步，可放任意组件", parent: "Steps", props: { title: s(), desc: s() } },
  Timeline: { group: "结构", desc: "时间线：放 Event，或用 items", props: { items: { type: "array" } } },
  Event: { group: "结构", desc: "Timeline 里的一项", parent: "Timeline", props: { time: s(), title: s(), desc: s(), done: b(), active: b(), tone: tone() } },
  Tabs: { group: "结构", desc: "标签页：放 Tab", props: { value: s(), onChange: fn() } },
  Tab: { group: "结构", desc: "Tabs 里的一页", parent: "Tabs", props: { label: { type: "string", alias: ["title"] }, icon, value: s() } },
  Accordion: { group: "结构", desc: "折叠面板组：放 Details", props: { open: n("默认展开第几个") } },
  Details: { group: "结构", desc: "可展开的一段", props: { summary: { type: "string", alias: ["title"] }, icon, open: b() } },
  Quiz: { group: "结构", desc: "小测验，自带判分和「讲解错题」", props: { title: s(), questions: { type: "array", required: true, desc: "[{question, options:[…], answer: 正确选项序号(从0起), explain}]" } } },
  Image: { group: "结构", desc: "图片（https 或 data:）", props: { src: s(undefined, true), alt: s(), caption: s(), ratio: { type: "string", alias: ["aspectRatio"], desc: '"16:9"' }, height: n(), fit: { type: "string", values: ["cover", "contain"] } } },
  Suggestions: { group: "结构", desc: "下一步追问，点了直接发给你", props: { items: { type: "array", required: true, desc: '["…"] 或 [{label, text}]' } } },

  // 输入
  Slider: {
    group: "输入",
    desc: "滑块",
    props: { label: s(), value: n(), defaultValue: n(), min: n(), max: n(), step: n(), unit: s(), format: { type: "string", values: ["number", "money", "percent", "compact"] }, display: s("右侧显示的文字"), showRange: b(), minLabel: s(), maxLabel: s(), onChange: fn() },
  },
  NumberInput: { group: "输入", desc: "数字输入", props: { label: s(), value: n(), defaultValue: n(), min: n(), max: n(), step: n(), unit: s(), placeholder: s(), onChange: fn() } },
  Input: { group: "输入", desc: "单行文字输入", props: { label: s(), value: s(), defaultValue: s(), placeholder: s(), onChange: fn(), onSubmit: fn() } },
  TextArea: { group: "输入", desc: "多行文字输入", props: { label: s(), value: s(), defaultValue: s(), placeholder: s(), rows: n(), onChange: fn() } },
  Select: { group: "输入", desc: "下拉选择", props: { label: s(), value: { type: "any" }, defaultValue: { type: "any" }, options, onChange: fn() } },
  Segmented: { group: "输入", desc: "分段选择（二到五选一）", props: { label: s(), value: { type: "any" }, defaultValue: { type: "any" }, options, onChange: fn() } },
  Switch: { group: "输入", desc: "开关", props: { label: s(), desc: s(), checked: b(), value: b(), defaultChecked: b(), onChange: fn() } },
  Checkbox: { group: "输入", desc: "勾选框", props: { label: s(), desc: s(), checked: b(), value: b(), defaultChecked: b(), onChange: fn() } },
  Choice: {
    group: "输入",
    desc: "选项卡片（单选或多选）；submit 会加一个按钮把选择发给你",
    props: { label: s(), options, value: { type: "any" }, multiple: b(), recommended: s(), submit: s("发送时的前缀，如“我选：”"), submitLabel: s(), cols: { type: "number", alias: ["columns"] }, onChange: fn() },
  },
  Button: {
    group: "输入",
    desc: "按钮：onClick，或 send / copy / href 三选一",
    props: { variant: { type: "string", values: ["primary", "secondary", "ghost", "danger"] }, primary: b(), size: { type: "string", values: ["sm", "md"] }, icon, label: s(), disabled: b(), block: b(), onClick: fn(), send: s("点了发给你的话"), copy: s("点了复制的文字"), href: s("https 链接") },
  },
  Link: { group: "输入", desc: "链接", props: { href: s(undefined, true) } },
};

export const GENUI_COMPONENTS = Object.keys(GENUI_SCHEMA);

/** Icons a ui program may name (rendered by apps/web/src/components/genui/icons.ts). */
export const GENUI_ICONS = [
  "activity", "alarm-clock", "alert", "alert-triangle", "warning", "archive", "arrow-down", "arrow-left", "arrow-right", "arrow-up", "award", "bar-chart", "chart",
  "battery", "bell", "bike", "book", "book-open", "bot", "brain", "brain-circuit", "briefcase", "bug", "building", "calculator", "calendar", "camera", "car", "check",
  "check-circle", "chef-hat", "chevron-right", "circle", "clock", "cloud", "code", "coffee", "coins", "compass", "cpu", "credit-card", "database", "dollar", "download",
  "droplet", "dumbbell", "eye", "file", "file-text", "film", "filter", "flag", "flame", "flask", "folder", "gamepad", "gauge", "gift", "git-branch", "globe",
  "graduation-cap", "hammer", "heart", "heart-pulse", "help", "history", "home", "hourglass", "image", "info", "key", "laptop", "layers", "layout", "leaf", "lightbulb",
  "idea", "line-chart", "link", "list", "list-checks", "lock", "mail", "map", "map-pin", "message", "message-circle", "mic", "monitor", "moon", "mouse-pointer-click",
  "click", "mountain", "music", "network", "package", "palette", "pen", "percent", "phone", "pie-chart", "plane", "play", "plug", "plus", "puzzle", "rocket", "route",
  "scale", "school", "search", "send", "server", "settings", "shield", "shield-check", "cart", "shopping-cart", "smartphone", "sparkles", "star", "sun", "target",
  "terminal", "thermometer", "thumbs-down", "thumbs-up", "timer", "train", "trending-down", "trending-up", "trophy", "truck", "user", "users", "utensils", "wallet",
  "wand", "wifi", "wind", "workflow", "wrench", "x", "x-circle", "zap",
] as const;

/** Plain HTML and SVG tags a ui program may use besides the components (attributes are filtered when rendered). */
export const GENUI_HTML_TAGS = ["b", "strong", "i", "em", "u", "s", "del", "br", "code", "small", "sub", "sup", "mark", "span", "div", "p", "ul", "ol", "li", "h1", "h2", "h3", "h4", "hr", "blockquote", "pre", "table", "thead", "tbody", "tr", "th", "td"] as const;
export const GENUI_SVG_TAGS = ["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop", "marker", "title", "clipPath", "mask", "pattern", "use", "symbol"] as const;

/** The component reference for agents, generated from the schema, grouped. */
export function genuiReference(): string {
  const groups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(GENUI_SCHEMA)) {
    if (spec.hidden) continue;
    const props = Object.entries(spec.props).map(([p, ps]) => {
      const values = ps.values ? `="${ps.values.filter((v) => v !== "default").join("|")}"` : "";
      return `${p}${values}${ps.required ? "（必填）" : ""}${ps.desc ? `（${ps.desc}）` : ""}`;
    });
    const where = spec.parent ? `，只能放在 ${spec.parent} 里` : "";
    const line = `- <${name}${props.length ? ` ${props.join(" ")}` : ""}>：${spec.desc}${where}`;
    groups.set(spec.group, [...(groups.get(spec.group) ?? []), line]);
  }
  return [...groups].map(([g, lines]) => `${g}\n${lines.join("\n")}`).join("\n");
}
