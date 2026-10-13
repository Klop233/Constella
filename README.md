# Constella

自建的多 agent 平台：手机上管理一群 agent，它们 24 小时在服务器上干活，按需使用独立桌面，越用越会。

> 每个 agent 是一颗星，合在一起就是你的星座。

## 能做什么

- **手机 App**（Android PWA）：同时管理多个 agent，支持聊天、审批、推送通知，在 App 里直接查看和接管 agent 的桌面
- **桌面按需分配**：agent 可以没有桌面，也可以固定绑定一台，或在需要时从桌面池借用；随时可以接管，操作完再交还
- **自学习**：记忆和技能自动沉淀，每次变更都能在 App 里看到 diff，一键撤销
- **接入 new-api**：模型统一走 new-api（也兼容其他 OpenAI 或 Anthropic 兼容网关），按 agent 统计用量、设置预算
- **默认隔离**：每个 agent 跑在自己的容器里；操作宿主机需要单独授权，危险操作要在 App 里审批
- **两条访问入口**：Tailscale 内网入口，以及 Cloudflare Tunnel + Access 公网入口

## 当前状态

方案已确定，正在按 [路线图](docs/roadmap.md) 推进。完整设计见 [docs/design.md](docs/design.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `docs/design.md` | 完整设计：架构、各模块、实施阶段、验证方式 |
| `docs/roadmap.md` | 分阶段计划与进度 |
| `docs/decisions/` | 关键决策记录（ADR） |
| `docs/spikes/` | 技术验证记录（模型兼容表、桌面实测） |
| `apps/hub/` | 管理层服务：认证、agent、会话、事件、审批、定时、自学习、桌面池、MCP 网关、推送、new-api |
| `apps/runner/` | agent 容器内的 runner，引擎适配器放在 `src/engines/` |
| `apps/web/` | 手机 PWA |
| `packages/protocol/` | 事件与 API 的 schema（zod），前后端共用 |
| `images/agent/`、`images/desktop/` | agent 与桌面的容器镜像 |
| `deploy/` | Docker Compose 部署与环境变量模板 |
| `scripts/` | 旧工具 迁移、备份等脚本 |

数据目录：`/srv/constella`（数据库、各 agent 的 home 与 workspace、桌面 home、共享技能库、备份）。

## 开发

```bash
pnpm install
pnpm typecheck
```

需要 Node 22 及以上版本，以及 pnpm 12（`npm i -g pnpm@12.11.2`）。
