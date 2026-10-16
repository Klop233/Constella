# 路线图

设计见 [design.md](design.md)。这里只记大的方向：已经做到的、已知的缺口、暂时不做的。更细的已知问题在 [README](../README.md) 的「已知问题和没做的」。

## 已完成

- **管理层**：登录（密码、TOTP、通行密钥）、agent 增删改与模板、事件流与 SSE 断线续传、run 状态机、审批、插话 / 停止、看门狗与自动继续
- **引擎**：Codex app-server 适配器；模型来自 App 里添加的任意 OpenAI 兼容服务商（`model@provider`），Chat Completions 接口由 hub 转换成 Codex 用的 Responses API
- **实例**：纯浏览器、Linux 桌面、安卓（Redroid / 模拟器）；租约与接管 / 交还；VNC 桥接与输入过滤；闲置暂停；宿主能力检测
- **工具**：`browser_*`（Playwright over CDP）、`desktop_*`、`android_*`、`memory_*`、`notify_user`、`schedule_*`、`send_file`、`artifact_*`、`credentials_*`、`host_exec`
- **记忆与技能**：git 版本化、即时记忆、复盘、每周整理、「学习」页 diff 与撤销、共享库、从别的助手导入记忆
- **成果**：agent 交付的文件和文档，带版本，可预览、可原地编辑
- **凭据与隐私**：Bitwarden 连接（官方区、第三方 / 自托管）、审批 agent、限时单次授权、登录时填入
- **自我维护**：中断自动继续、监督员、实例巡检与修复、维修员、结束复核、待处理与一键方案
- **智能界面**：回复里的 `ui-json` 流式界面、`ui` 组件程序、`ui-html` 退路
- **运维**：定时任务、用量与按 agent 预算、性能页、审计、每日备份、Web Push 与 Telegram；`scripts/install.sh` 的安装、更新、备份、恢复、重置密码
- **公网入口**：Cloudflare Tunnel（`scripts/enable-public.sh`）、Tailscale Serve

## 已知缺口

- 只支持一个账号
- 按 agent 记账和每日预算依赖 new-api 管理令牌，真实环境验证还不够
- hub 重启、agent 容器崩溃等故障的恢复逻辑已实现，缺专门的演练
- 直接操作桌面（`desktop_*`）的路径实测较少，模型一般优先用 `browser_*`
- 界面和给 agent 的提示词只有中文

## 暂不做

- Claude 等其他引擎适配器：目前只通过 OpenAI 兼容的 API 调用模型，Claude 模型也走这条路
- 打包成 APK（TWA）：PWA 已够用
