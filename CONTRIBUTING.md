# 参与贡献

欢迎提 issue 和 PR。动手之前建议先看 [AGENTS.md](AGENTS.md)：里面有目录说明、「想改什么去哪里」的对照表和代码约定，人和 AI 助手都按它来。

## 开发环境

需要 Node 22.18+、pnpm 12、Docker（只有跑端到端测试和起 agent / 实例容器时才用得到）。

```bash
pnpm install
pnpm typecheck
pnpm test                              # 单元测试（vitest，在 apps/hub）
pnpm --filter @constella/web dev       # 前端开发服务器
```

端到端测试 `scripts/e2e/run.sh` 需要 Docker、`deploy/.env` 和真实模型，见 [README](README.md#开发)。

## 提交前

- `pnpm typecheck` 和 `pnpm test` 通过；改了前端再跑一次 `pnpm --filter @constella/web build`。
- 新功能带测试；改 agent 工具、事件类型、数据库表时，按 AGENTS.md 的对照表把相关位置一起改。
- 数据库迁移不改已有的，新表写进 `ENSURE`，给旧表加列先 `PRAGMA table_info` 判断再 `ALTER`。
- 界面文案和给 agent 的提示词用中文，代码注释用英文；颜色走主题变量，通用样式先看 [docs/design-system.md](docs/design-system.md)。
- 不要提交密钥、主机名、IP、域名等只属于你自己环境的内容；本机特有的约定写进 `AGENTS.local.md`（已被 `.gitignore` 忽略）。

## 许可

提交的代码按本项目的许可证 [AGPL-3.0](LICENSE) 授权。
