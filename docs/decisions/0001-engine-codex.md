# 0001：agent 内核用 Codex app-server，不基于 旧工具，也不自己写

- 状态：已采纳（2026-10-13）
- 复审条件：阶段 0 模型兼容测试的结果

## 背景

旧工具 v0.21.5 的功能已经很全：多 profile、自学习、每个 agent 一台桌面（Bot Screen）、对接 new-api、提供 API server。但实际用下来有四个问题：

2. 不稳定，bug 多；
3. 干活效果差；
4. 配置复杂。

第 1 条可以在 旧工具 之上加一层客户端解决；第 2、3 条出在它自研的 agent 循环上，加客户端解决不了。

模型现状：new-api 只有 OpenRouter、OpenAI 兼容和 Gemini 三类通道，没有 Anthropic 原生通道。旧工具 目前用的是 `/v1/responses`，默认模型 `gpt-6-astra`。

## 决策

- 管理层（调度、桌面、自学习、手机 App）由 Constella 自己实现；agent 内核用模型厂商维护的成熟引擎。
- 默认引擎采用 **Codex app-server**（JSON-RPC over stdio，支持流式输出、审批、steer、中断），通过 `model_provider` 指向 new-api，`wire_api = "responses"`，和现有调用方式一致。
- 引擎以适配器接口的形式接入 runner（`apps/runner/src/engines/`）。之后可以加 Claude Agent SDK 适配器，前提是有可用的 Anthropic 格式入口。
- 记忆和技能使用与引擎无关的文件格式（Markdown 与 Agent Skills 的 `SKILL.md`），换引擎不会丢失学到的东西。

## 影响

- 好处：
  - agent 循环的质量和稳定性由专门团队维护；
  - 能沿用现有的 new-api 链路；
  - 旧工具 的技能可以直接迁移过来。
- 代价：
  - 非 OpenAI 模型走 Responses API 时效果可能打折，需要阶段 0 实测，并在模型选择器里标注；
  - 依赖 Codex app-server 协议的稳定性。如果不可用，就退回 `@openai/codex-sdk`，审批改由 hub 侧的命令策略处理。
- 旧工具 中值得借鉴的实现（MIT 协议）：VNC ticket 桥接、桌面租约、Xfce 启动脚本，以及 cua-driver 的用法。
