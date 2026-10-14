# Constella（星座）：自建的多 agent 平台（手机 App + 桌面 + 自学习 + 接入 new-api）

> 状态：已实现（2026-10-13）。实施进度见 [roadmap.md](roadmap.md)，关键决策见 [decisions/](decisions/)。
>
> 实现与原方案的差异：密钥加密用 Node 自带的 AES-256-GCM（不用 libsodium）；桌面控制用容器内的 xdotool 服务（cua-driver 已随 旧工具 删除，见 spikes/desktop.md）；数据库用 Node 自带的 `node:sqlite`；复盘默认模型改为 mimo-v2.5-pro（deepseek 通道不可用，见 spikes/models.md）。

> 项目名：**Constella**。每个 agent 是一颗星，合在一起就是你的星座，也呼应你的主机名 your-machine（hoshi 是日语里的"星"）。
> 项目目录：`/root/constella`；数据目录：`/srv/constella`；容器、镜像和网络统一用 `constella-` 前缀；包名用 `@constella/*`；公网子域名建议 `constella.<你的域名>`。

## Context

现在用的 旧工具 v0.21.5 已有多 profile、自学习、Bot Screen 和 new-api 接入，但你认为它在四方面不理想：管理分散、不稳定、干活效果差、配置复杂。具体问题：
- 桌面画面只能在电脑版 App 里看；
- 网页 dashboard 不是给手机设计的。

目标是一个统一的系统，满足以下需求：
- 手机 App（Android）：同时管理多个 agent，聊天、审批，在 App 里查看并接管桌面；
- 桌面按需分配：不是每个 agent 都有桌面；
- 自学习：保留 旧工具 那样的记忆和技能沉淀，并且看得见、能撤销；
- 模型默认走现有的 new-api，按 agent 统计用量、设置预算；也可以加别的 provider（必须支持 Responses API，Codex 只走这个接口），内置 new-api 的模型直接用模型名，其他 provider 的模型以 `model@provider` 引用；
- 访问方式：Tailscale 加公网（Cloudflare）两条入口；
- 默认隔离运行，必要时再授权；
- 不迁移 旧工具 的任何数据，旧工具 整体删除（2026-10-13 决定）。

设计原则：
- **agent 内核不自己写**，用模型厂商维护的成熟内核（Codex app-server），避开 旧工具 自研循环不稳定的问题；
- 我们自己做的是"管理层"：调度、桌面、自学习、手机 App；
- 配置都放进 App 里的表单，默认值可直接使用，不需要手改 YAML。

## 现状（已核实）

- **new-api**：`calciumion/new-api:v1.0.0-rc.40`，监听 `0.0.0.0:3333`。
  - 通道有 OpenRouter（type 20）、OpenAI 兼容（type 1，经 `responses-fallback-relay`）、Gemini（type 24），**没有 Anthropic 原生通道**。
  - 旧工具 目前通过 `/v1/responses` 调用 `gpt-6-astra`。
- **Tailscale**：已登录，主机名 `your-machine.your-tailnet.ts.net`，没有 serve 配置，443 端口空闲。
- **旧工具 要迁移的数据**：
  - 记忆：`~/.旧工具/memories/{USER,MEMORY}.md`；
  - 人设：`SOUL.md`；
  - profile：`health`、`travel`；
  - 技能：94 个 `SKILL.md`，标准 Agent Skills 格式，可以直接复用；
- **可参考的 旧工具 代码**（MIT 协议，可借鉴或复制）：
  - `旧工具_cli/web_routers/display.py`：一次性 ticket 加 VNC WebSocket 桥接；
  - `tools/bot_desktop/{lease.py,launcher.sh,rfb_filter.py}`：桌面租约和 Xfce 启动；
  - `website/docs/user-guide/features/bot-screen.md`：桌面依赖包清单和内存实测，每台约 1.1–1.5G（含浏览器）。
- **可复用的现成组件**：

## 架构

```
Android（PWA，装到主屏幕）
   │  HTTPS / SSE / WSS
   ├─ Tailscale Serve  https://your-machine.your-tailnet.ts.net
   └─ Cloudflare Tunnel + Access  https://agent.<你的域名>
                │
        ┌───────▼────────┐  只监听 127.0.0.1:8780
        │   hub（管理层）  │  Node22 + Fastify + SQLite(Drizzle) + dockerode
        │  认证/agent/会话/事件/审批/定时/自学习/桌面池/MCP 网关/推送/new-api
        └──┬──────────┬──┘
   WS(runner协议)   docker API + VNC/CDP（内部网络 constella-net）
           │                     │
  agent 容器 × N（空闲自动休眠）  实例容器 × M（浏览器 / Linux 桌面 / 安卓，闲置暂停或停止）
  runner + Codex app-server     Xvnc+Xfce+Chromium(CDP)+cua-driver
  /home/agent: 记忆/技能/配置    持久化 home（浏览器登录态保留）
  /workspace                          │
           └──── 模型请求 → new-api（宿主机 3333 端口，经 host-gateway 访问）
```

### 1. agent 内核（runner + 引擎适配器）
- 每个 agent 一个容器（镜像 `constella-agent`：Debian + git/python/node + Codex CLI），里面常驻 `runner`。
- runner 用 WebSocket 连到 hub，把引擎事件统一成同一种格式。
- **默认引擎是 Codex app-server**（JSON-RPC over stdio），支持流式输出、审批、中途插话（steer）和中断。
  - 每个 agent 有独立的 `CODEX_HOME`，`config.toml` 中 `model_provider` 指向 new-api，`wire_api="responses"`，和 旧工具 现在的调用方式一致。
- 引擎以接口形式抽象。后续可加 Claude Agent SDK 适配器，前提是有 Anthropic 格式的入口：先验证 new-api 能否转换，不行就走 cliproxyapi 或直连。
- **统一事件格式**放在 `packages/protocol`，用 zod 定义：
  - `run.*`、`message.delta`、`reasoning.summary`；
  - `tool.started/output/completed`；
  - `approval.requested/resolved`；
  - `desktop.action`、`usage`、`learning.*`。
- 事件全部写入 SQLite。App 通过 SSE 订阅，靠 `Last-Event-ID` 断线续传，适应手机网络不稳的情况。
- **稳定性措施**：
  - run 有持久化的状态机：queued / running / waiting_approval / paused_by_user / done / failed / cancelled；
  - hub 重启后自动重新连上 runner；
  - 看门狗：N 分钟没有事件就推送提醒；
  - 每个 run 有超时和 token 上限；
  - 容器设置 `restart: unless-stopped`。

### 2. 实例（桌面池）
- 三种实例（`desktops.kind`），选项放在 `desktops.options`（屏幕尺寸、闲置处理；安卓另有 DPI、后端、ARM 转译、Google Play）：
  - `browser` 纯浏览器：镜像 `constella-desktop`，`CONSTELLA_SESSION=browser`，只跑 xfwm4 和 Chromium（关掉会自动重开）；
  - `desktop` Linux 桌面：同一个镜像，完整的 Xfce 会话；
  - `android` 安卓：两个容器。`constella-android-<id>` 是系统本身（Redroid 或 SDK 模拟器），`constella-desktop-<id>` 是桥接容器（scrcpy 把画面投到 Xvnc，控制接口用 adb 实现），所以查看、接管、截图和 hub 的调用方式与另外两种一样。
- **宿主能力检测**（`hostcaps.ts`）：hub 用临时容器检测 binder 能否挂载、特权容器能否改内核参数、`/dev/kvm` 能否使用、uid 映射是否够大，以及各镜像是否已构建、带了哪些组件（镜像 LABEL）。不能用的类型在 App 里置灰并写明原因；安卓后端在设置里选「自动 / Redroid / 模拟器 / 关闭」，每台安卓实例创建时定下后端，以后不变。
- 专有组件（libndk_translation、MindTheGapps、Android SDK 系统镜像）只在用户本地用 `scripts/build-android-images.sh` 构建时按显式参数下载，不随项目分发。
- 只连接内部网络 `constella-net`，不对外暴露任何端口。
- **agent 和实例**：每个 agent 绑定零个或多个实例（`agents.desktop_policy = {desktopIds}`，顺序即优先级），一个实例可以绑给多个 agent。agent 能用 `instance_create` / `instance_update` / `instance_restart` 自己新建（自动绑定给自己）、修改、重启绑定的实例，不能删除；新建和修改是否要主人同意在设置里分别开关，开着时一律交给主人，不走审批方式的自动判断。
- **当前实例**：每个任务记住 desktop_* 和 browser_* 各自正在操作的实例；没有时按「本任务已租用 → 绑定顺序里第一个空闲」挑选，browser_* 只用带浏览器的实例并优先纯浏览器。`instance_use` 切换。一个任务可以同时租用多个实例。
- **租约**：持有者只能是 `agent:<id>`、`human` 或空，任何时刻只有一方能操作。
  - 你在 App 里点"接管"后，agent 的工具调用等你交还，run 进入 `paused_by_user`。
  - 点"交还"后 agent 继续，你可以附一句说明，比如"已登录"。
- **闲置**：没人租用、没人在看的实例闲置一段时间后暂停（`docker pause`，保留内存，几秒恢复）或停止，全局设置、每个实例可覆盖。暂停或停止前保存最后一帧作为缩略图；打开查看或 agent 用到时自动恢复。任何时候都能手动重启。
- **查看**：PWA 用 `@novnc/novnc`，连接 `wss://…/api/desktops/:id/vnc?ticket=`（一次性 ticket，30 秒有效），由 hub 把 WebSocket 桥接到 TCP，做法参考 旧工具 的 `display.py`。
  - 默认只能看；接管后才能操作（hub 解析 RFB 消息，丢弃旁观者的输入）。
  - 手机端支持双指缩放、触控板模式、键盘、剪贴板、横屏；安卓实例的工具栏是返回、主页、多任务，中文经输入法直接输入。
  - 实例列表显示定时刷新的缩略图。
- **给 agent 的工具**：hub 的 MCP 网关给每个 agent 一个带 token 的地址，每次调用都检查租约。
  - `browser_*`：Playwright 通过 CDP 连接实例里的 Chromium。走 DOM 操作，优先使用，比点像素可靠；你接管时看到的是同一个浏览器，登录状态能延续。
  - `desktop_*`：截图、点击、输入、按键、滚动、拖拽、等待、打开应用、剪贴板。桌面上由容器里的 xdotool 服务执行，安卓上由桥接容器用 adb 执行（点击是点按、拖动是滑动，中文经 ADBKeyboard 输入）。
  - `android_ui`（界面元素列表，类似 browser_snapshot）、`android_apps`（列出、从网址或工作目录安装 APK）。

### 3. 自学习（不依赖具体引擎，可见、可撤销）
- **存储**：
  - 每个 agent 的 `/home/agent/memory/{USER.md,MEMORY.md}` 和 `/home/agent/skills/<name>/SKILL.md`；
  - 共享技能库 `/srv/constella/shared-skills`，以只读方式挂载；
  - 以上都是 git 仓库，每次变更自动提交。
- **加载**：开会话时，hub 把记忆写进 AGENTS.md，技能放进 `CODEX_HOME/skills`。
- **即时记忆**：MCP 网关提供 `memory.remember/forget/list`，你说"记住…"就马上生效。
- **复盘**：run 结束后自动执行，触发条件是工具调用达到阈值，或者你在 App 里点了赞/踩。
  - 用 new-api 上的便宜模型（可配置，默认 `deepseek-v4-flash`）读这次 run 的摘要，输出结构化 JSON：记忆增删改、新建或修补技能、是否提升到共享库。
  - 输出要先校验：长度上限、去重、脱敏密钥类内容，然后落盘并提交 git。
  - 同时推送 `learning.event`，App 的"学习"页能看到 diff，可以一键撤销、置顶或停用。
- **整理（curator）**：每周一次定时任务，合并重复记忆和技能，下线长期没用的技能（hub 会从工具事件中统计每个技能的使用次数）。

### 4. 接入 new-api
- **提供方配置**：`new-api / OpenAI 兼容 / Anthropic` 三类，填 base_url、key，以及可选的 new-api 管理令牌。
  - 密钥用 libsodium 加密后存入数据库，主密钥放在 `deploy/.env`（权限 0600）。
- **模型列表**：从 `/v1/models` 拉取。阶段 0 的实测结果标在模型选择器上（✓ / ⚠ 加原因）。
- **每个 agent 一个 new-api 令牌**（可选，推荐）：hub 通过 new-api 管理 API 创建 `constella-<agent>` 令牌并设额度，再拉取日志 API，在 App 里显示每个 agent 每天的花费，接近预算时推送提醒。
- 兼容其他 OpenAI 或 Anthropic 兼容网关，比如 one-api、OpenRouter、LiteLLM。

### 5. 隔离与授权
- agent 容器的限制：不挂 docker.sock，不用 host 网络，只挂自己的卷；可以出网。
- **运维类 agent**需要单独授权"宿主机访问"，hub 会为它配一个 SSH key。默认策略是每条宿主机命令都在 App 里审批，可以对只读命令设白名单。
- 每个 agent 有自己的密钥库，以环境变量或工具的形式注入，并在事件流里脱敏。
- 所有审批、接管和授权都记审计日志。

### 6. 访问与认证
- hub 只监听 `127.0.0.1:8780`。
- **Tailscale 入口**：`tailscale serve --bg --https=443 http://127.0.0.1:8780`。
- **公网入口**：用 `cloudflared` 容器跑 Tunnel，前面加 Cloudflare Access（邮箱一次性验证码）。
- **App 自身的登录**：
  - Passkey（WebAuthn）为主，密码加 TOTP 作为备用；
  - 短期 access token + refresh token，可以管理和吊销已登录的设备；
  - 所有 WebSocket 连接都用一次性 ticket；
  - 有限流。

### 7. 手机 App（PWA）
- **技术栈**：React 19、Vite、TS、Tailwind v4、shadcn 风格组件、TanStack Query、Zustand、vite-plugin-pwa。
  - 推送用 Web Push（VAPID，hub 端用 `web-push` 库）；Telegram 作为备用通知渠道，复用 旧工具 现有的 bot token。
- **页面**：
  - **首页**：所有 agent 的状态、待审批、最近对话；
  - **对话**：流式输出，工具调用折叠成卡片，审批直接内联，可以中途插话或停止，支持发图片和文件、语音输入；
  - **桌面**：缩略图墙，点开全屏查看或接管；
  - **任务**：定时任务和执行历史；
  - **学习**：动态流、diff、撤销；
  - **设置**：模型、new-api、用量和预算、设备、访问方式。
- **新建 agent 尽量简单**：选模板（通用助理 / 运维 / 网页办事 / 研究），填名字，选模型，完成。高级选项默认折叠。agent 可以导出或导入成单个文件。
- 以后需要的话，可以用 Bubblewrap 打包成 APK（TWA），这次不做。

## 代码与数据布局

```
/root/constella/                     git 仓库，pnpm monorepo
  README.md                          项目简介、快速开始、目录说明
  docs/
    design.md                        本方案全文（架构、各模块设计）
    roadmap.md                       分阶段计划和进度勾选
    decisions/0001-engine-codex.md   关键决策记录（ADR），比如为什么不用 旧工具 内核
    spikes/                          阶段 0 的验证记录（模型兼容表、桌面实测）
  apps/hub/                          管理层服务（Fastify），镜像 constella-hub
  apps/web/                          手机 PWA
  apps/runner/                       agent 容器内的 runner（引擎适配器在 src/engines/）
  packages/protocol/                 事件和 API 的 zod schema，前后端共用
  images/agent/Dockerfile            镜像 constella-agent
  images/desktop/Dockerfile          镜像 constella-desktop
  deploy/docker-compose.yml          compose 项目名 constella
  deploy/.env.example                deploy/.env（0600，密钥，不进 git）
  scripts/                           migrate-旧工具.ts、backup.sh 等
/srv/constella/{db,agents/<id>/{home,workspace},desktops/<id>/{home,data,avd,adb},shared-skills,backups}
```

## 分阶段实施（每阶段结束都能实际用、都要验证）

**第一步：建立项目**
- 创建 `/root/constella`，执行 `git init`；
- 写入 `README.md`、`docs/design.md`（本方案）、`docs/roadmap.md`、`docs/decisions/0001-engine-codex.md`；
- 搭好 monorepo 骨架（pnpm workspace、TS 配置、`.gitignore` 排除 `deploy/.env` 和数据目录）；
- 第一次提交。之后每个阶段完成时，在 `roadmap.md` 里打勾并提交。

**阶段 0：技术验证（先做，结果决定后备方案；记录写入 `docs/spikes/`）**
1. 在容器里用 Codex app-server 经 new-api 跑 `gpt-6-astra`、`anthropic/claude-opus-5.5`、`kimi-k3`、`glm-5.3`、`deepseek-v4-flash`。用同一个"多步工具任务"测试，记录成功率和问题，作为模型兼容表的初始数据。
   - 如果 app-server 不可用，退回 `@openai/codex-sdk`，审批改由 hub 侧的命令策略处理。
2. 在这个 LXC 的 Docker 里跑起桌面容器：noVNC 能看到画面，cua-driver 截图和点击正常，Playwright MCP 能通过 CDP 操作浏览器。
   - 如果 cua-driver 在容器内不稳定，就在容器里用 xdotool 加截图写一个小服务替代。

**阶段 1：管理层核心 + 手机聊天（只走 Tailscale）**
- 认证（Passkey）、agent 增删改、runner 加 Codex 适配器、事件流和断线续传、审批、PWA 首页和对话页、Web Push、Tailscale Serve。

**阶段 2：桌面**
- 桌面池生命周期、租约、VNC 桥接、MCP 网关（browser / computer）、三种绑定策略、接管和交还的完整交互、缩略图。

**阶段 3：自学习**
- 记忆和技能存储（git）、即时记忆工具、复盘、每周整理、学习页（diff / 撤销）、技能使用统计。

**阶段 4：管理完善 + 公网**
- 定时任务、new-api 按 agent 建令牌和统计用量预算、模板、导出导入、健康和监控页、自动备份 `/srv/constella`。
- Cloudflare Tunnel + Access。
- （可选）Claude 引擎适配器。

**阶段 5：清理 旧工具**
- 不迁移数据，直接卸载 旧工具（`~/.旧工具`、`/usr/local/lib/旧工具-agent`、相关进程和文件）。

## 验证方式
- **自动化测试**：
  - `pnpm -r test`：vitest 单元测试，覆盖事件 schema、run 状态机、租约、复盘 JSON 校验、new-api 客户端；
  - 引擎契约测试：mock 引擎加一个真实模型的冒烟测试；
  - `pnpm --filter web e2e`：Playwright 在 Pixel 7 视口下测试登录 → 建 agent → 对话 → 审批 → 打开桌面 → 接管 / 交还。
- **部署检查**：`docker compose ps` 全部 healthy，`curl 127.0.0.1:8780/api/health` 正常。
- **故障演练**：
  - run 进行中 `docker kill` 掉 agent 容器，App 应显示失败并自动恢复；
  - 重启 hub，进行中的会话应能续上；
  - 断网后重连，事件不应丢失。
- **手机验收**：
  - 通过 Tailscale 地址和公网地址都能安装 PWA；
  - 公网地址必须经过 Access 和 Passkey 两道验证；
  - 桌面任务"打开浏览器查某事并截图"能完成，中途接管和交还正常；
  - 需要审批时手机收到推送；
  - 同类任务做第二次时，学习页出现新技能，并且能撤销；

## 需要你做的（集中在下面几步，其余由我完成）
1. **new-api**：在 new-api 后台给 hub 建一个令牌，另外可选提供管理员 access token（用于按 agent 建令牌）。到时在 App 设置页或 0600 权限的文件里填写，不在聊天里发。
2. **Cloudflare**：在 Zero Trust 里建一个 Tunnel，拿到 token，告诉我用哪个子域名。
3. **手机**：装 Tailscale 并登录同一个 tailnet；第一次打开 App 时注册 Passkey。
