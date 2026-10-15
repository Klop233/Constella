# 0001：agent 内核用 Codex app-server，不自己写

- 状态：已采纳

## 背景

要做一个能同时管多个 agent、带桌面实例和记忆的平台。agent 内核（模型调用循环、工具执行、审批、上下文管理）有两条路：自己写，或者用现成的。

自研 agent 循环的稳定性和干活效果都要长期打磨，而这不是平台要解决的问题；平台要解决的是外面那层：多 agent 管理、实例、记忆、手机端。

模型接入方面，常见的网关（new-api、OpenRouter 一类）对 OpenAI Responses API 的支持最普遍，Anthropic 原生接口不一定有。

## 决策

- 管理层（调度、实例、自学习、手机 App）自己实现；agent 内核用模型厂商维护的成熟引擎。
- 默认引擎采用 **Codex app-server**（JSON-RPC over stdio，支持流式输出、审批、steer、中断），通过 `model_provider` 指向模型网关，`wire_api = "responses"`。
- 引擎以适配器接口的形式接入 runner（`apps/runner/src/engines/`），其他引擎可以照着加。
- 记忆和技能使用与引擎无关的文件格式（Markdown 与 Agent Skills 的 `SKILL.md`），换引擎不会丢失学到的东西。

## 影响

- 好处：
  - agent 循环的质量和稳定性由专门团队维护；
  - 沿用 new-api 等网关的现成链路，不绑定某一家模型；
  - 引擎升级时平台只需要跟进适配器。
- 代价：
  - 非 OpenAI 模型走 Responses API 时效果可能打折，所以用 `scripts/spikes/model-compat.sh` 实测，并在模型选择器里标注（实测记录见 [spikes/models.md](../spikes/models.md)）；
  - 依赖 Codex app-server 协议的稳定性。如果不可用，退回 `@openai/codex-sdk`，审批改由 hub 侧的命令策略处理。
