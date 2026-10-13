# 桌面容器与浏览器实测（2026-10-13）

## 镜像

`images/desktop`：
- 基础：Debian bookworm + Xfce 精简组件（xfwm4 / xfce4-panel / xfdesktop4 / xfsettingsd）+ TigerVNC `Xvnc :1`
- 浏览器：Chromium，开启 CDP（127.0.0.1:9222，经 socat 转发到 9223）
- 字体：Noto CJK / Emoji
- 控制服务：`control.py`，只用 Python 标准库，靠 xdotool、xclip、ImageMagick 操作 X

## 结果

| 项目 | 结果 |
|---|---|
| 启动到可用 | 约 10 秒；空闲内存约 370 MB |
| 截图（`/screenshot`，JPEG） | ✅ 1280×800，中文显示正常 |
| 点击 / 输入 / 快捷键 / 滚动（`/action`） | ✅ 在地址栏输入 URL 并跳转、滚动页面都正常 |
| 剪贴板 | ✅ 中文读写正常。xclip 写入时不能等待它的 stdout，已修复 |
| CDP + Playwright | ✅ hub 用 `connectOverCDP` 连接，`ariaSnapshot` 和点击、填表都正常 |
| VNC → WebSocket 桥接 | ✅ hub 内部做 RFB 过滤：只看模式下丢弃键鼠输入，一次性 ticket 不能复用 |

## 结论

- **不使用 cua-driver**：它随 旧工具 一起删除了，而且它的 60 个工具对模型来说太多。改为容器内的 xdotool 控制服务（计划中的后备方案）；对 agent 只开放一组精选工具，由 hub 的 MCP 网关提供。
- 网页任务优先走 `browser_*`（DOM / 无障碍树），需要像素级操作时再用 `desktop_*`。端到端测试中，模型只靠 `browser_open` 加 `browser_snapshot` 就完成了网页任务。
