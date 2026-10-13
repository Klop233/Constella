# 路线图

每个阶段完成后都要能实际使用，并通过验证，然后在这里打勾提交。详细内容见 [design.md](design.md)。

## 第一步：建立项目
- [x] 创建仓库 `/root/constella`，写入设计文档、路线图和 ADR
- [x] monorepo 骨架（pnpm workspace、TS 配置、protocol 包）

## 阶段 0：技术验证（记录写入 `spikes/`）
- [ ] Codex app-server 在容器里经 new-api 运行：gpt-6-astra、anthropic/claude-opus-5.5、kimi-k3、glm-5.3、deepseek-v4-flash，同一个多步工具任务测成功率，形成模型兼容表
- [ ] 桌面容器：Xvnc + Xfce + Chromium(CDP) + cua-driver 在本机 Docker 中运行，noVNC 可查看，截图和点击正常
- [ ] Playwright MCP 通过 CDP 操作桌面里的 Chromium
- [ ] 根据结果确定后备方案（codex-sdk / xdotool）

## 阶段 1：管理层核心 + 手机聊天（Tailscale）
- [ ] 认证：Passkey，密码 + TOTP 作为备用，设备管理
- [ ] agent 增删改，agent 容器生命周期（空闲休眠）
- [ ] runner + Codex 适配器，统一事件流写入 SQLite，SSE 断线续传
- [ ] run 状态机、审批、中途插话 / 停止、看门狗
- [ ] PWA：首页、对话页，Web Push
- [ ] Tailscale Serve 入口

## 阶段 2：桌面
- [ ] 桌面池生命周期、空闲停止、持久化 home
- [ ] 租约与接管 / 交还
- [ ] VNC 桥接（一次性 ticket）、PWA 桌面页（缩放、触控板模式、键盘、剪贴板）
- [ ] MCP 网关：browser（Playwright over CDP）、computer（cua-driver 精选工具）
- [ ] 三种绑定策略：无 / 固定 / 按需借用，以及缩略图

## 阶段 3：自学习
- [ ] 记忆与技能存储（git 版本化），共享技能库
- [ ] 即时记忆工具（remember / forget / list）
- [ ] run 结束后复盘 → 校验 → 落盘 → 学习动态
- [ ] 每周整理任务，技能使用统计
- [ ] PWA 学习页：diff、撤销、置顶、停用

## 阶段 4：管理完善 + 公网 + 迁移
- [ ] 定时任务与执行历史
- [ ] new-api：按 agent 建令牌、统计用量、预算提醒，模型兼容标注
- [ ] agent 模板、导出 / 导入，健康与监控页，自动备份
- [ ] Cloudflare Tunnel + Access 公网入口
- [ ] （可选）Claude 引擎适配器

## 阶段 5：切换
- [ ] 经你确认后停用 旧工具 的提醒和 gateway
