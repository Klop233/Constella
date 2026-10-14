# 路线图

每个阶段完成后都要能实际使用，并通过验证，然后在这里打勾提交。详细内容见 [design.md](design.md)。

## 第一步：建立项目
- [x] 创建仓库 `/root/constella`，写入设计文档、路线图和 ADR
- [x] monorepo 骨架（pnpm workspace、TS 配置、protocol 包）

## 阶段 0：技术验证（记录写入 `spikes/`）
- [x] Codex 在容器里经 new-api 运行（见 spikes/models.md；runner 使用 app-server 协议）：gpt-6-astra、anthropic/claude-opus-5.5、kimi-k3、glm-5.3、deepseek-v4-flash，同一个多步工具任务测成功率，形成模型兼容表
- [x] 桌面容器：Xvnc + Xfce + Chromium(CDP) 在本机 Docker 中运行，可查看，截图和点击正常（见 spikes/desktop.md）
- [x] Playwright（playwright-core）通过 CDP 操作桌面里的 Chromium
- [x] 根据结果确定后备方案：引擎用 Codex app-server（已实测审批流程）；桌面控制用 xdotool

## 阶段 1：管理层核心 + 手机聊天（Tailscale）
- [x] 认证：密码 + TOTP、设备管理；Passkey 已在 Android 手机和 Windows 电脑上真机注册并登录成功（2026-10-13）
- [x] agent 增删改，agent 容器生命周期（空闲休眠）
- [x] runner + Codex 适配器，统一事件流写入 SQLite，SSE 断线续传
- [x] run 状态机、审批、中途插话 / 停止、看门狗
- [x] PWA：首页、对话页；Web Push 已在 Windows Edge 和 Android Chrome 真机收到通知（2026-10-13）
- [x] 临时内网入口 http://<Tailscale IP>:8780（仅 tailnet，可用聊天和桌面；推送和通行密钥需要 HTTPS）
- [x] Tailscale Serve HTTPS 入口：https://<主机名>.<tailnet>.ts.net（2026-10-13 开通，证书有效）

## 阶段 2：桌面
- [x] 桌面池生命周期、空闲停止、持久化 home
- [x] 租约与接管 / 交还
- [x] VNC 桥接（一次性 ticket、只看模式过滤输入）、PWA 桌面页（适应屏幕/原始大小、触控手势、键盘、粘贴）
- [x] MCP 网关：browser_*（Playwright over CDP）、desktop_*（xdotool 精选工具）、memory_*、notify_user、schedule_*、host_exec
- [x] 三种绑定策略：无 / 固定 / 按需借用，以及缩略图

## 阶段 3：自学习
- [x] 记忆与技能存储（git 版本化），共享技能库
- [x] 即时记忆工具（remember / forget / list）
- [x] run 结束后复盘 → 校验 → 落盘 → 学习动态
- [x] 每周整理任务，技能使用统计
- [x] PWA 学习页：diff、撤销；技能查看、共享、删除

## 阶段 4：管理完善 + 公网
- [x] 定时任务与执行历史
- [x] new-api：模型列表与兼容标注、按 agent 统计 token（已测）；专属令牌、费用统计、每日预算限制已实现，需要你提供管理令牌后实测
- [x] agent 模板、导出 / 导入，健康与监控页，自动备份
- [x] Cloudflare Tunnel 公网入口：https://constella.<你的域名>（2026-10-13 开通；由 App 自身登录保护，未另加 Cloudflare Access）
- [~] （可选）Claude 引擎适配器：不做（2026-10-13 决定）。只支持通过 API（new-api）调用模型，Claude 模型也走这条路

## 阶段 5：清理 旧工具
