# 模型兼容测试：Codex + new-api（2026-10-13）

## 测试方法

- 脚本：`scripts/spikes/model-compat.sh <模型...>`
- 镜像：`constella-agent:dev`（node:22-bookworm-slim + Codex CLI 0.162.1）
- 链路：Codex `exec --json` → `wire_api = "responses"` → new-api `http://host.docker.internal:3333/v1`
- 任务：写 `fib.py` → 运行 → 把输出存入 `result.txt` → `cat` 校验
- 判定标准：`result.txt` 内容等于 `0,1,1,2,3,5,8,13,21,34,55,89,144,233,377`
- 原始事件记录在 `docs/spikes/runs/`（不进 git）

## 结果

| 模型 | 结果 | 用时 | 失败原因 |
|---|---|---|---|
| gpt-6-astra | ✅ 通过（测了两次） | 31–41s | |
| gpt-5.6-sol | ✅ 通过 | 86s | |
| mimo-v2.5-pro | ✅ 通过 | 20s | |
| anthropic/claude-opus-5.5 | ❌ 上游故障 | | OpenRouter 通道月度额度已用完 |
| glm-5.3、deepseek-v4-flash | ❌ 上游故障 | | `401 User not found`（new-api 的 OpenAI 类通道，上游账号失效） |
| kimi-k3、minimax-m3 | ❌ 上游故障 | | `404 Model not supported by any configured account in this group` |
| gemini-3.8-flash | ❌ 上游故障 | | 先返回 429，之后变成 `503 No available channel`（通道疑似被自动禁用） |
| gemini-3.1-pro-preview、qwen3.5:cloud | ❌ 上游故障 | | `503 No available channel` |

## 结论

- **Codex + new-api（Responses API）链路可用**。3 个能连通的模型全部完成了多步工具任务，验证了 [ADR 0001](../decisions/0001-engine-codex.md) 的方向。
- 其余失败**都发生在 new-api 的上游通道**（额度、账号、限流），和 Codex 无关；修好通道后重跑脚本即可补全这张表。
- 对 Codex 不认识的模型（例如 gemini），会提示 "Model metadata not found"，然后使用默认参数。正式接入时由 hub 在 `config.toml` 里补上 `model_context_window` 等参数。
- 默认模型暂定 **gpt-6-astra**；复盘用的便宜模型用 mimo-v2.5-pro（deepseek-v4-flash 当时通道不可用，恢复后可再评估）。两者都能在 `deploy/.env` 里改。
