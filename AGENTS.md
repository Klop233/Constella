# Constella：给 agent 的项目地图

自建的多 agent 平台：手机 PWA 管多个 agent，每个 agent 在自己的 Docker 容器里跑 Codex，需要浏览器时按需借桌面容器，做过的事会复盘成记忆和技能。功能和部署见 [README.md](README.md)，设计原文见 [docs/design.md](docs/design.md)（与代码不一致处以代码为准，比如密钥用 AES-256-GCM、数据库用 `node:sqlite`）。

## 三条通信链路

| 链路 | 协议 | 在哪定义 |
|---|---|---|
| web ↔ hub | REST `/api/*`（非 GET 要带 `X-Constella: 1`）、SSE `/api/stream`（`Last-Event-ID` 续传）、桌面画面 WS `/api/desktops/:id/vnc`（一次性 ticket） | `apps/hub/src/routes.ts` |
| runner ↔ hub | WS `/api/runner`，hub→runner 与 runner→hub 的消息类型 | `packages/protocol/src/runner.ts`、`apps/hub/src/app.ts` |
| agent → hub 工具 | MCP `/mcp`，每个 agent 一个 token | `apps/hub/src/mcp.ts` |

一条消息的路径：Codex app-server → `apps/runner/src/engines/codex.ts` 转成 protocol 事件 → hub `RunManager`（`runs.ts`）→ `EventStore`（`events.ts`，落 SQLite，每个 run 有 `seq`，全局有 cursor）→ SSE → `apps/web/src/lib/live.ts`（全站只开一个 EventSource）。

## 目录

| 路径 | 职责 |
|---|---|
| `packages/protocol` | zod 定义的事件、run 状态机（`canTransition`）、runner 消息，前后端和 runner 共用 |
| `apps/hub` | 管理服务（Fastify + `node:sqlite`），所有业务都在这里 |
| `apps/runner` | agent 容器内的进程：连 hub，驱动引擎；引擎适配器在 `src/engines/`（目前只有 `codex.ts`） |
| `apps/web` | PWA（React 19 + Vite + Tailwind v4 + TanStack Query），构建产物由 hub 静态托管 |
| `images/{hub,agent,desktop}` | 三个镜像；桌面镜像里的控制服务是 `images/desktop/control.py` |
| `deploy` | `docker-compose.yml`、`.env.example` |
| `scripts/e2e` | 端到端测试（起一个临时 hub，用真实模型跑） |
| `docs` | `design.md`、`design-system.md`（前端规范）、`credentials.md`（凭据连接与授权边界）、`roadmap.md`、`decisions/`（ADR）、`spikes/` |

### hub（`apps/hub/src`）

| 文件 | 职责 |
|---|---|
| `app.ts` | `createHub` 装配全部部件；`RunnerGateway`（runner 连接）；`Settings`（App 里可改的运行时设置，env 是默认值）；`bootHub` 启动流程 |
| `routes.ts` | 全部 REST / SSE / WS 路由，按资源分段 |
| `runs.ts` | `RunManager`：run 生命周期、插话/中断、看门狗、自动继续、可重试错误 |
| `recovery.ts` | 自我维护：runner 容器修复、incident（诊断 + 一键选项）、supervisor、实例巡检与修复记录、维修员（`get_help`）、结束复核（没做完就收工时拉回） |
| `events.ts` | 追加式事件日志与实时总线 |
| `agents.ts` | agent 配置、凭据、引擎配置文件、注入给 agent 的 instructions |
| `containers.ts` | dockerode：agent / desktop 容器的创建、重建、休眠 |
| `desktops.ts` | 桌面池、租约（同一时刻只有一方操作）、接管/交还、VNC 桥接与输入过滤、实例健康诊断（`diagnose`）与修复（`repair`） |
| `mcp.ts` | 给 agent 的工具：`memory_*`、`ask_user`、`get_help`、`notify_user`、`schedule_*`、`send_file`、`artifact_*`、`desktop_*`、`browser_*`、`credentials_*`、`host_exec` |
| `credentials.ts` / `credential-provider.ts` / `credential-routes.ts` | 凭据与隐私：密码库连接与解锁会话、agent 的访问申请、指定审批 agent 的审核与限时单次授权、`/api/credentials`；provider 接口的 Bitwarden 实现在 `credential-provider.ts`（见 [docs/credentials.md](docs/credentials.md)） |
| `artifacts.ts` | 成果：agent 交付到对话里的文件和文档，带版本，可预览、可原地编辑 |
| `knowledge.ts` / `learning.ts` / `reflect.ts` | 记忆与技能（git，可撤销；含从别的助手导入记忆）/ 复盘与每周整理 / 回顾统计 |
| `models.ts` / `newapi.ts` / `catalog.ts` | 模型提供方与 `model@provider` 引用 / new-api 管理接口 / 各模型支持的推理强度 |
| `auth.ts` / `secrets.ts` / `safety.ts` / `trusted.ts` | 登录与 ticket / 加密存储与脱敏 / 审批策略 / 开发用免登录入口 |
| `scheduler.ts` / `notify.ts` / `usage.ts` | 定时任务 / Web Push + Telegram / 用量统计 |
| `perf.ts` | 性能采样：宿主机（`CONSTELLA_HOST_ROOT` 下的 /proc 与 cgroup）和每个容器的 CPU、内存、网络，内存里保留一天历史 |
| `audit.ts` / `request-source.ts` | 审计详情：把记录里的 ID 解析成对象、算改动的前后值 / 当前请求的设备和 IP（`audit()` 自动附进 `via`） |
| `db.ts` / `config.ts` | 迁移与 `kv` / 环境变量与目录布局 |
| `widgets.ts` | 智能界面（回复里的 `ui` 块）：给 agent 的说明，按设置分关闭 / 适度 / 丰富；块本身的解析在 `packages/protocol/src/widgets.ts` |

### web（`apps/web/src`）

- `pages/`：一个文件一个页面，路由在 `main.tsx`（页面按需加载）。
- `components/ui.tsx`：通用组件（Button、Card、Sheet、Field…），新页面优先用它，不重新发明。
- `components/RunView.tsx`：把一个 run 的事件流渲染成对话（工具调用折叠、审批内联、成果卡片）。
- `pages/Artifacts.tsx`、`components/Artifact*.tsx`、`lib/artifacts.ts`：成果库与预览/编辑。
- `pages/Credentials.tsx`：凭据与隐私页（`/credentials`）：密码库连接、解锁、审批 agent、访问请求与访问历史。
- `pages/Performance.tsx`、`components/PerfChart.tsx`、`lib/perf.ts`：性能页（宿主机 + 实例/agent/服务）；`components/LineChart.tsx`：时间序列曲线。
- `lib/audit.ts`、`components/AuditDetail.tsx`：操作记录的动作/字段中文名、一行摘要，和点开的详情面板（设置页与审计页共用）。
- `lib/api.ts`：fetch 封装；`lib/live.ts`：SSE；`lib/types.ts`：前端用的类型（事件类型从 protocol 引）；`sw.ts`：Service Worker 与推送。
- `components/Widget.tsx`、`lib/widget-runtime.ts`：回复正文里的 ` ```ui ` 块（智能界面）——拆分、沙盒 iframe、主题同步、给界面的样式与桥接运行时（`ui.send` / `ui.state` / `Chart`）。

## 改什么去哪里

| 想做的事 | 要动的地方 |
|---|---|
| 新增或修改 agent 事件类型 | `packages/protocol/src/index.ts` → runner 的 `engines/codex.ts`（产生）→ hub `runs.ts`（处理）→ web `RunView.tsx`（渲染） |
| 给 agent 加工具 | `apps/hub/src/mcp.ts`；如需提示词说明，在 `app.ts` 的 `startPayload` 或 `agents.ts` 的 `instructions` |
| 加一个 API | `routes.ts`（对应分段）→ web `lib/api.ts` 的调用处和 `lib/types.ts` |
| 加一项设置 | `app.ts` 的 `Settings` → `routes.ts` 的 `/api/settings` → `pages/Settings.tsx` |
| agent 往对话里交付文件或文档 | `artifacts.ts`（存储与版本）、`mcp.ts` 的 `send_file` / `artifact_*`、protocol 的 `artifact` 事件、web 的 `Artifact*` 组件 |
| 新增会写审计的操作 | 调用处 `audit(db, actor, action, detail)`：`detail` 里记对象的名字，改动类再加 `changes: changesOf(前, 后, 字段)`（不记密钥明文）；中文名登记到 web `lib/audit.ts`；新的对象类型在 `audit.ts` 的 `auditRefs` 里加解析 |
| 加表或列 | `db.ts`，见下面的「数据库迁移」 |
| 改智能界面（交互式回复块） | 解析 `packages/protocol/src/widgets.ts` → 给 agent 的说明 `apps/hub/src/widgets.ts` → 渲染 `apps/web/src/components/Widget.tsx` + `lib/widget-runtime.ts`；设置项 `intelligentUi` |
| 接新的凭据提供方（别的密码库） | 实现 `apps/hub/src/credential-provider.ts` 的 `CredentialProvider`（连接状态、解锁/锁定、同步、条目摘要、按字段读取），在 `credentials.ts` 里注册；申请、审批和授权消费不用改 |
| 接新的 agent 引擎 | `apps/runner/src/engines/` 新增适配器，事件统一成 protocol 事件 |
| 改桌面镜像或桌面控制 | `images/desktop/`；hub 侧在 `desktops.ts` 和 `mcp.ts` 的 `desktop_*` |
| 改前端样式 | 先读 `docs/design-system.md`，新的通用样式写回规范 |

## 命令

```bash
pnpm install
pnpm typecheck                         # protocol / hub / runner / web
pnpm test                              # 目前只有 hub 有单测（vitest）
pnpm --filter @constella/hub exec vitest run test/recovery.test.ts   # 单个测试文件
pnpm --filter @constella/web dev       # 前端开发服务器
pnpm --filter @constella/web build
scripts/e2e/run.sh                     # 端到端：需要 Docker、deploy/.env 和真实模型，端口 8781
```

Node 22.18+，pnpm 12。TypeScript 由 Node 直接运行（`node src/index.ts`），没有编译步骤。

## 约定

- **TS**：import 带 `.ts` 后缀；`erasableSyntaxOnly`，不用 `enum`、`namespace`、构造器参数属性（私有字段用 `#`）；`noUncheckedIndexedAccess` 已开。
- **语言**：界面文案和给 agent 的提示词用中文，代码注释用英文。
- **数据库迁移**：`db.ts` 里已有的迁移不改，也不在 `MIGRATIONS` 里抢新编号（多个分支并行时会撞号）。新增表写进 `ENSURE`（`CREATE TABLE IF NOT EXISTS`）；给旧表加列，照 `openDb` 末尾的做法：先 `PRAGMA table_info` 判断，缺了再 `ALTER`。
- **密钥**：只放 `SecretStore`（加密），写进事件、知识库、日志之前先过 `redact`。
- **审批**：什么算「危险操作」由 `safety.ts` 决定，保守地标记、宽松地匹配；不要在别处另写一套判断。
- **`approvals` 表里不只有审批**：agent 的选择题（`ask_user`，`kind = 'decision'`）也存在这里。
- **run 状态**只能按 `canTransition` 允许的路径迁移。
- **前端**：同一种东西全站一种做法；颜色走主题变量，不写死色值。
- **可独立发布**：宿主特有的东西（镜像源、镜像名、端口、内核特性、资源上限）要运行时探测或做成可配置并带可用默认值，不写死当前这台机器的情况。
- 公开文档和注释里不出现具体的主机名、IP、域名。

## 运行时数据（`CONSTELLA_DATA_DIR`，默认 `/srv/constella`）

`db/constella.db`、`agents/<id>/home/knowledge/`（该 agent 的记忆与技能，git 仓库）、`shared/`（共享记忆与技能，git 仓库）、`desktops/<id>/home/`（浏览器登录态）、`backups/`。hub 容器内外挂载同一路径，因为 hub 会把这些路径传给 agent 和桌面容器。

## 本机约定

只适用于某台机器的内容（重建容器的命令、免登录开发入口、并行会话的部署规矩）写在 `AGENTS.local.md`，该文件已在 `.gitignore`，不进仓库。它存在时一并遵守。
