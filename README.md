# Constella

自建的多 agent 平台：在手机上管理一群 agent，它们 24 小时在服务器上干活，需要时使用独立的桌面，越用越会。

> 每个 agent 是一颗星，合在一起就是你的星座。

## 功能

- **手机 App**（PWA，Android 用 Chrome 添加到主屏幕）
  - 管理多个 agent：对话、流式输出、工具调用卡片、内联审批、中途追加指示、停止
  - 在 App 里实时查看 agent 的桌面，一键接管，操作完再交还
- **桌面按需分配**：每个 agent 可以不用桌面、固定绑定一台，或按需从桌面池借用；闲置 30 分钟自动停止
- **自学习**
  - 即时记忆工具；每次任务结束后自动复盘，沉淀记忆和技能（SKILL.md）；每周自动整理
  - 每次变更都是一次 git 提交，App 里能看到 diff，也能一键撤销
- **接入 new-api**
  - 模型列表直接来自 new-api，已实测可用的模型带 ✓ 标记
  - 可以为每个 agent 生成专属令牌，单独统计费用、设置每日预算
- **默认隔离**：每个 agent 跑在自己的容器里；操作宿主机要单独授权，非只读命令都要在手机上审批
- **定时任务**：推送提醒，或定时让 agent 执行任务；agent 也能在对话中自己创建定时任务
- **通知**：Web Push，Telegram 作为可选的备用渠道
- **访问入口**：Tailscale Serve（内网）+ Cloudflare Tunnel（公网，可再加 Access 保护）；登录支持通行密钥、密码和两步验证

## 架构

```
手机 PWA ──HTTPS/SSE/WSS──► constella-hub（Fastify + SQLite，127.0.0.1:8780）
                              ├─ WebSocket ──► constella-agent-*（runner + Codex app-server，每个 agent 一个容器）
                              │                   └─ MCP（memory / desktop / browser / schedule / host_exec）──► hub
                              ├─ HTTP / CDP / VNC ──► constella-desktop-*（Xvnc + Xfce + Chromium，按需启动）
                              └─ 模型请求 ──► new-api（宿主机 :3333）
```

完整设计见 [docs/design.md](docs/design.md)；进度见 [docs/roadmap.md](docs/roadmap.md)；关键决策见 [docs/decisions/](docs/decisions/)；技术验证记录见 [docs/spikes/](docs/spikes/)。

## 部署

```bash
cd deploy
cp .env.example .env && chmod 600 .env   # 填 CONSTELLA_MASTER_KEY、CONSTELLA_SETUP_CODE、NEWAPI_API_KEY 等
docker compose --profile images build    # 构建 hub / agent / desktop 三个镜像
docker compose up -d hub
```

- **内网入口**（需先在 tailnet 后台开启 Serve）：`tailscale serve --bg --https=443 http://127.0.0.1:8780`
- **公网入口**：先在 Cloudflare Zero Trust 建一个 Tunnel，把 Public Hostname 指向 `http://constella-hub:8780`，然后执行 `scripts/enable-public.sh constella.你的域名`
- **初始化**：第一次打开页面时，用 `deploy/.env` 里的 `CONSTELLA_SETUP_CODE` 创建账号；登录后到「设置」里添加通行密钥、开启推送

数据都在 `/srv/constella`：数据库、各 agent 的 home 与 workspace、桌面 home、共享知识库，以及备份（每天 03:30 自动备份，保留 7 份）。

## 开发与测试

```bash
pnpm install
pnpm typecheck
pnpm test                      # hub 单元测试
scripts/e2e/run.sh             # 临时起一个独立的 hub（端口 8781），用真实模型跑完整的 API + 手机界面测试，结束后自动清理
scripts/spikes/model-compat.sh gpt-6-astra kimi-k3   # 测试模型经 new-api 的可用性
```

需要 Node 22.18 及以上版本、pnpm 12（`npm i -g pnpm@12.11.2`），以及 Docker。

## 目录

| 路径 | 内容 |
|---|---|
| `apps/hub/` | 管理层：认证、agent、会话与事件、审批、定时任务、自学习、桌面池、MCP 网关、推送、new-api |
| `apps/runner/` | agent 容器内的 runner；引擎适配器在 `src/engines/`（Codex app-server） |
| `apps/web/` | 手机 PWA（React + Tailwind + noVNC）；界面测试在 `e2e/` |
| `packages/protocol/` | 事件、run 状态机和 runner 协议（zod），前后端共用 |
| `images/` | hub / agent / desktop 三个镜像 |
| `deploy/` | Docker Compose 和环境变量模板 |
| `scripts/` | 端到端测试、模型测试、公网开通脚本 |
