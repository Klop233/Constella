# Constella 设计

Constella（星座）是一个自建的多 agent 平台：手机上管多个 agent，每个 agent 在自己的 Docker 容器里跑 Codex，需要浏览器、桌面或安卓时按需借用实例，做过的事会复盘成记忆和技能。

这份文档讲整体架构和各模块的设计意图。部署和使用见 [README](../README.md)，代码地图和约定见 [AGENTS.md](../AGENTS.md)，前端规范见 [design-system.md](design-system.md)，关键决策见 [decisions/](decisions/)。文档和代码不一致的地方以代码为准。

## 设计原则

- **agent 内核不自己写**：用模型厂商维护的成熟内核（Codex app-server），避开自研 agent 循环的稳定性问题；Constella 做的是外面那层：调度、实例、记忆、手机端。
- **默认隔离，必要时再授权**：agent 各在自己的容器里，需要动宿主机、读凭据都要单独授权并留记录。
- **配置放进 App**：默认值可直接使用，不需要手改配置文件。
- **出了问题先自己想办法**：系统和 agent 先自己处理，用户只处理真正需要本人或需要拍板的事。
- **在合理的前提下，给用户显示尽可能多的数据**：系统知道的，就不让用户去翻日志或数据库。列表里只放一行摘要，点开能看到记下的全部（时间、谁、从哪台设备、涉及的对象、改前改后的值）。边界：密钥和凭据不显示、不记录明文；很长的内容截断后可展开；不让原始数据淹没默认界面。具体做法见 [design-system.md](design-system.md) 第 1 节。
- **可独立发布**：宿主特有的东西（镜像源、镜像名、端口、内核特性、资源上限）运行时探测或做成可配置并带可用默认值。

## 架构

```
手机 / 浏览器（PWA）
   │  HTTPS / SSE / WSS
   ▼
入口：Cloudflare Tunnel 或 Tailscale Serve（HTTPS 终止在这里）
   │
   ▼  只监听 127.0.0.1:8780
┌──────────────────────────────────────────────────────────────┐
│ hub（管理层）  Node 22 + Fastify + node:sqlite + dockerode     │
│ 认证 / agent / 会话与事件 / 审批 / 定时 / 记忆与技能 / 实例池   │
│ MCP 网关 / 推送 / 模型提供方 / 凭据 / 成果 / 自我维护          │
└──┬───────────────────────────┬───────────────────────────────┘
   │ WS（runner 协议）          │ Docker API，内部网络 constella-net
   ▼                           ▼
agent 容器 × N                 实例容器 × M
（空闲自动休眠）                （浏览器 / Linux 桌面 / 安卓，闲置暂停或停止）
runner + Codex app-server      Xvnc + Xfce + Chromium(CDP) + 控制服务
/home/agent：记忆、技能、配置   持久化 home（浏览器登录态保留）
/workspace：工作目录
   │
   └── 模型请求 → App 里添加的 OpenAI 兼容服务商（Chat Completions 经 hub 转换）
```

三条通信链路：

| 链路 | 协议 | 定义 |
|---|---|---|
| web ↔ hub | REST `/api/*`、SSE `/api/stream`（`Last-Event-ID` 续传）、实例画面 WS（一次性 ticket） | `apps/hub/src/routes.ts` |
| runner ↔ hub | WS `/api/runner` | `packages/protocol/src/runner.ts` |
| agent → hub 工具 | MCP `/mcp`，每个 agent 一个 token | `apps/hub/src/mcp.ts` |

## 1. agent 内核（runner + 引擎适配器）

- 每个 agent 一个容器（镜像 `constella-agent`），里面常驻 `runner`，用 WebSocket 连到 hub，把引擎事件统一成同一种格式。
- **引擎是 Codex app-server**（JSON-RPC over stdio），支持流式输出、审批、中途插话（steer）和中断。每个 agent 有独立的 `CODEX_HOME`，`config.toml` 的 `model_provider` 指向模型提供方，`wire_api = "responses"`。引擎以适配器形式接入（`apps/runner/src/engines/`），其他引擎可以照着加。
- **统一事件格式**在 `packages/protocol`，用 zod 定义（`run.*`、消息增量、推理摘要、工具调用、审批、实例动作、用量、学习事件等）。事件全部写入 SQLite，App 通过 SSE 订阅，靠 `Last-Event-ID` 断线续传，适应手机网络不稳的情况。
- **稳定性**：run 有持久化的状态机（只能按 `canTransition` 迁移）；hub 重启后自动重连 runner；看门狗在一段时间没有事件时提醒或介入；每个 run 有超时；容器 `restart: unless-stopped`。
- **自我维护**（`recovery.ts`）：每次自动处理都留一份报告（incident，状态「已自动处理」），处理不了的带诊断和一键方案进「待处理」。
  - 中断自动继续、卡住时监督员介入（结束卡死的命令、提醒、重启这一轮、重建容器）；
  - 实例巡检：每分钟检查实例的容器和控制服务，反复崩溃或连续几分钟没响应就修复：正常关机 → 清掉强制停止留下的锁 → 启动并等它真的能用 → 不行再重建容器（数据在挂载目录里保留）；
  - 维修员（`get_help`）：agent 看不到容器内部，求助时 hub 先按规则修好坏掉的实例，再让模型结合容器日志、进程和这一轮的记录给出诊断和下一步，只做不丢数据的动作；
  - 结束复核：一轮只能在任务做完时结束。用过工具的 run 以 done 结束时由模型判断是做完了、停下来等用户，还是放弃了。没做完记为 **panic**：记一份报告并推送，再以「［监督员］」消息让 agent 接着做；需要用户本人的步骤让它用 `desktop_request_help` / `ask_user` 在这一轮里等。连续拉回两次仍没做完，才转为待处理。

## 2. 实例

三种实例（`desktops.kind`），选项放在 `desktops.options`（屏幕尺寸、闲置处理；安卓另有 DPI、后端、ARM 转译、Google Play）：

- `browser` 纯浏览器：镜像 `constella-desktop`，只跑窗口管理器和 Chromium（关掉会自动重开）；
- `desktop` Linux 桌面：同一个镜像，完整的 Xfce 会话；
- `android` 安卓：两个容器。`constella-android-<id>` 是系统本身（Redroid 或 SDK 模拟器），`constella-desktop-<id>` 是桥接容器（scrcpy 把画面投到 Xvnc，控制接口用 adb 实现），所以查看、接管、截图和 hub 的调用方式与另外两种一样。

要点：

- **宿主能力检测**（`hostcaps.ts`）：hub 用临时容器检测 binder 能否挂载、特权容器能否改内核参数、`/dev/kvm` 能否使用、uid 映射是否够大，以及各镜像是否已构建。不能用的类型在 App 里置灰并写明原因。
- **专有组件**（libndk_translation、MindTheGapps、Android SDK 系统镜像）只在用户本地用 `scripts/build-android-images.sh` 按显式参数下载，不随项目分发。
- **网络**：实例只连内部网络 `constella-net`，不对外暴露端口。
- **agent 与实例**：每个 agent 绑定零个或多个实例（顺序即优先级），一个实例可以绑给多个 agent。agent 能自己新建、修改、修复绑定的实例，不能删除；新建和修改要不要用户同意在「设置 → 权限」里设置，修复（重启、重建容器，数据保留）不需要同意。
- **租约**：持有者只能是 `agent:<id>`、`human` 或空，任何时刻只有一方能操作。用户点「接管」后，agent 的工具调用等待交还，run 进入 `paused_by_user`；点「交还」后 agent 继续，用户可以附一句说明（比如「已登录」）。
- **闲置**：没人租用、没人在看的实例闲置一段时间后暂停（`docker pause`，保留内存，几秒恢复）或停止，全局设置、每个实例可覆盖。暂停或停止前保存最后一帧作为缩略图，打开查看或 agent 用到时自动恢复。
- **查看**：PWA 用 noVNC，连接 `/api/desktops/:id/vnc?ticket=`（一次性 ticket，30 秒有效），由 hub 把 WebSocket 桥接到 TCP。默认只能看；接管后才能操作（hub 解析 RFB 消息，丢弃旁观者的输入）。
- **给 agent 的工具**：hub 的 MCP 网关给每个 agent 一个带 token 的地址，每次调用都检查租约。
  - `browser_*`：Playwright 通过 CDP 连接实例里的 Chromium，走 DOM / 无障碍树，优先使用，比点像素可靠；用户接管时看到的是同一个浏览器，登录状态能延续；
  - `desktop_*`：截图、点击、输入、按键、滚动、拖拽、等待、打开应用、剪贴板。桌面上由容器里的 xdotool 控制服务执行，安卓上由桥接容器用 adb 执行；
  - `android_ui`（界面元素列表）、`android_apps`（列出、安装 APK）。

## 3. 记忆与技能（不依赖具体引擎，可见、可撤销）

- **存储**：记忆是 Markdown，技能是标准 Agent Skills 格式（`SKILL.md`），都放在 git 仓库里，每次变更自动提交：每个 agent 一个仓库（`agents/<id>/home/knowledge/`），再加一个所有 agent 共享的仓库（`shared/`，以只读方式挂进 agent 容器）。
- **加载**：开会话时，hub 把记忆写进 `AGENTS.md`，技能放进 `CODEX_HOME/skills`。
- **即时记忆**：MCP 网关提供 `memory_*`，用户说「记住……」就马上生效。
- **复盘**：run 结束后自动执行，触发条件是工具调用达到阈值，或者用户点了赞 / 踩。用一个便宜的模型（可配置）读这次 run 的摘要，输出结构化 JSON：记忆增删改、新建或修补技能、是否提升到共享库。输出先校验（长度上限、去重、脱敏密钥类内容）再落盘提交。「学习」页能看到 diff，可以一键撤销。
- **整理**：每周一次，合并重复的记忆和技能，下线长期没用的技能（hub 会从工具事件里统计每个技能的使用次数）。

## 4. 模型提供方

- **提供方**：任何 OpenAI 兼容的地址，在 App 里添加，接口格式选 Responses（Codex 直连）或 Chat Completions（hub 的 `chatbridge.ts` 转换，服务商的 Key 不进 agent 容器）。可选的内置 new-api（`.env` 配了 Key 时出现）的模型直接用模型名，其他提供方的模型以 `model@provider` 引用。密钥加密存储，主密钥放在 `deploy/.env`。
- **模型列表**：从 `/v1/models` 拉取，实测过的兼容结果标在模型选择器上。
- **按 agent 记账**（可选）：hub 通过 new-api 管理接口给每个 agent 建独立令牌并设额度，在 App 里显示每个 agent 每天的花费，接近预算时推送提醒。

## 5. 隔离与授权

- agent 容器不挂 `docker.sock`，不用 host 网络，只挂自己的卷（共享记忆只读），可以出网。
- **宿主机访问**（`host_exec`）要在 agent 上单独开启：只读命令直接执行，其余按「设置 → 权限」的策略审批（自动批准 / 危险时问我 / 每次问我，默认自动批准）。它经 hub 在宿主上起一个特权容器执行，等同于宿主 root，所以只给运维类 agent。
- **密钥**：只放加密的 `SecretStore`，以环境变量的形式注入 agent 容器，写进事件和日志前先脱敏。
- **凭据**：密码库（Bitwarden / Vaultwarden）里的条目由指定的审批 agent 审核、限时单次授权，值只在 hub 内存里交给等待的工具，不进模型上下文。见 [credentials.md](credentials.md)。
- 所有审批、接管和授权都记审计日志，详情里能看到改前改后的值（密钥除外）。

## 6. 访问与认证

- hub 默认只监听 `127.0.0.1:8780`，外面通过 Cloudflare Tunnel 或 Tailscale Serve 提供 HTTPS。
- 登录：密码 + TOTP，可加通行密钥（WebAuthn）；登录后是 cookie 会话（有效期随使用顺延），可以在设置里查看和注销每台设备；WebSocket 一律用一次性 ticket；登录相关接口有限流。
- 非 GET 请求要带 `X-Constella: 1`，并检查 `Origin` 在 `CONSTELLA_ORIGINS` 里。
- 只支持一个账号。

## 7. 手机 App（PWA）

- **技术栈**：React 19、Vite、Tailwind v4、TanStack Query；推送用 Web Push（VAPID），Telegram 作备用渠道。
- **页面**：首页（agent 状态、待办）、对话（流式输出，工具调用折叠，审批内联，可中途插话或停止，支持发图片和文件）、实例（缩略图墙，点开查看或接管）、成果、任务、学习、凭据与隐私、性能、审计、设置。
- **智能界面**：agent 回复里的 `ui-json` 块在回复还在写时就按声明式指令渲染成原生组件，模型不写任何可执行代码，交互只能通过声明式动作走 dispatcher；需要界面自己算数时用 `ui` 组件程序，自包含网页用 `ui-html`（沙盒 iframe）。
- **新建 agent 尽量简单**：选模板（通用助理 / 网页办事 / 运维 / 研究），填名字，完成；高级选项默认折叠。

## 代码与数据布局

```
apps/hub/        管理服务（Fastify），镜像 constella-hub
apps/runner/     agent 容器内的 runner（引擎适配器在 src/engines/）
apps/web/        手机 PWA
packages/protocol/  事件、run 状态机、runner 消息的 zod 定义，前后端共用
images/          hub、agent、desktop、android-bridge、android-redroid、android-emulator
deploy/          docker-compose.yml、.env.example
scripts/         部署脚本、端到端测试、模型兼容测试
docs/            本文档、前端规范、凭据说明、路线图、决策记录、实测记录

$CONSTELLA_DATA_DIR（默认 /srv/constella）
  db/                       SQLite
  agents/<id>/{home,workspace}   agent 的 home（含记忆与技能仓库）和工作目录
  shared/                   共享记忆与技能仓库
  desktops/<id>/…           实例的用户目录和安卓数据
  artifacts/                成果文件（不挂进 agent 容器）
  backups/                  每日备份
```

hub 用 Docker Compose 部署（挂 `docker.sock`，只有 hub 能访问），内部网络叫 `constella-net`，通过 `extra_hosts: host-gateway` 访问宿主机上的服务（比如本机的 new-api、Ollama）。数据目录在 hub 容器内外是同一个路径，因为 hub 会把这些路径传给它启动的 agent 和实例容器。

## 验证

- **单元测试**：`pnpm test`（vitest，目前覆盖 hub：事件、run 状态机、租约、复盘校验、凭据、智能界面等）。
- **端到端**：`scripts/e2e/run.sh` 起一个临时 hub，用真实模型把主要流程跑一遍；`apps/web/e2e` 用 Playwright 在手机视口下点遍页面。
- **部署检查**：`docker compose ps`、`curl 127.0.0.1:8780/api/health`。
- **故障演练**：run 进行中 `docker kill` 掉 agent 容器应显示失败并自动恢复；重启 hub，进行中的会话应能续上；断网重连后事件不丢。
