# Constella

一个跑在自己服务器上的 agent 管理平台。手机上打开就能给好几个 agent 派活，它们在服务器上 24 小时干，需要用浏览器、点网页的时候各自有桌面可用；做过的事情会记下来，下次做得更顺。

名字取自 constellation（星座）：每个 agent 是一颗星。

## 为什么做这个


Constella 的思路是：**干活的部分不自己写**，直接用 OpenAI 开源的 Codex 作为 agent 内核；自己只做外面那层，也就是多 agent 管理、桌面、记忆和手机端。模型统一走 [new-api](https://github.com/QuantumNous/new-api)，不绑定任何一家。

## 能做什么

**手机 / 网页端**
- 可以装到手机主屏幕（PWA），电脑浏览器打开是侧边栏布局
- 同时管理多个 agent，每个都有自己的对话记录
- 回复是流式的，agent 执行的每条命令、调用的每个工具都能展开看
- 任务进行中可以继续发消息补充要求，不想让它做了就点停止
- 危险操作会弹审批，手机收到推送，点一下批准或拒绝
- 登录支持密码、两步验证、指纹 / 面容（通行密钥）

**桌面**
- 每个 agent 可以选：不用桌面、固定用一台、或者需要时临时借一台
- 桌面是 Docker 里跑的 Linux（Xfce + Chromium），闲置 30 分钟自动停
- 在 App 里能实时看到 agent 在桌面上干什么
- 遇到登录、验证码这种得本人来的步骤，agent 会推送叫你，你点「接管」自己操作，弄完点「交还」，还能留句话给它
- agent 操作网页优先按页面结构来（点按钮、填表单），比按坐标点像素靠谱

**记忆和技能**
- 跟它说「记住……」它就记下；关于你本人的信息所有 agent 共享
- 每次任务结束会自动复盘，值得留的经验写进记忆，可复用的流程写成技能（SKILL.md）
- 点 👍 / 👎 也会触发复盘，点踩时它会重点记下哪里做错了
- 所有改动都存在 git 里，「学习」页能看到每次具体改了什么，不满意可以撤销
- 每周自动整理一次，合并重复的、删掉过时的

**其他**
- 定时任务：定时推送提醒，或者定时让 agent 去做某件事。也可以直接对 agent 说「每天早上 8 点提醒我……」
- 推送走浏览器原生的 Web Push，可以再配 Telegram 当备用
- 每个 agent 跑在独立容器里，搞坏了重建就行；需要操作宿主机的（比如运维用的 agent）要单独开权限，非只读命令每条都要你批
- 可以给每个 agent 在 new-api 里单独开令牌，分开统计花费、设每日预算
- 每天自动备份，保留最近 7 份

## 大致结构

```
手机 / 浏览器
    │  HTTPS
    ▼
constella-hub ─────────────── 管理服务：登录、agent、对话、审批、定时、记忆、推送
    │
    ├── constella-agent-xxx ── 每个 agent 一个容器，里面跑 Codex
    │       └── 通过 MCP 调 hub 提供的工具：记忆、桌面、浏览器、定时任务、宿主机命令
    │
    ├── constella-desktop-xxx ─ 桌面容器，按需启动
    │
    └── new-api ────────────── 所有模型请求都走这里
```

数据都放在 `/srv/constella`：数据库、每个 agent 的工作目录和记忆、桌面的用户目录（浏览器登录状态在这里）、备份。

## 部署

需要一台 Linux 服务器，装好 Docker，并且已经有一个能用的 new-api。

**1. 拉代码，写配置**

```bash
git clone <仓库地址> constella
cd constella/deploy
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，至少填这几项：

| 变量 | 说明 |
|---|---|
| `CONSTELLA_MASTER_KEY` | 加密数据库里各种密钥用的主密钥，用 `openssl rand -base64 32` 生成 |
| `CONSTELLA_SETUP_CODE` | 第一次打开网页创建账号时要输入的初始化码，随便设一串 |
| `CONSTELLA_ORIGINS` | 你会用哪些地址访问，逗号分隔，例如 `https://constella.example.com` |
| `NEWAPI_BASE_URL` | new-api 地址。new-api 在同一台机器上的话写 `http://host.docker.internal:端口` |
| `NEWAPI_API_KEY` | 在 new-api 后台给 Constella 建的令牌 |
| `CONSTELLA_DEFAULT_MODEL` | 新建 agent 时默认用的模型 |

其他项都可以留空，比如推送密钥第一次启动会自动生成。

**2. 构建并启动**

```bash
docker compose --profile images build   # 构建 hub、agent、桌面三个镜像，第一次比较慢
docker compose up -d hub
curl http://127.0.0.1:8780/api/health   # 返回 ok 就是起来了
```

hub 只监听本机 `127.0.0.1:8780`，外面要访问得再配一个入口（见下一步）。

**3. 配访问入口**

推送通知和指纹登录要求必须是 HTTPS，所以下面两种至少配一种。

- **Cloudflare Tunnel（公网访问，推荐）**：域名托管在 Cloudflare 的话，运行

  ```bash
  scripts/enable-public.sh constella.你的域名
  ```

  第一次会打印一个 Cloudflare 授权链接，浏览器打开选好域名就行；建隧道、加 DNS、启动 cloudflared 都是脚本自己做。国内服务器连 Cloudflare API 可能需要代理，脚本默认走 `127.0.0.1:7890`，可以用环境变量 `CF_PROXY` 改。

- **Tailscale Serve（只在自己的设备之间访问）**：先在 Tailscale 后台开启 HTTPS 证书和 Serve，然后

  ```bash
  tailscale serve --bg --https=443 http://127.0.0.1:8780
  ```

  如果电脑上开着 Clash / FlClash 一类的 TUN 模式代理，记得把 `ts.net` 和 `100.64.0.0/10` 设成直连，不然打不开。

**4. 第一次使用**

1. 打开你配好的地址，输入 `.env` 里的初始化码，设置名字和密码
2. 进「设置」，添加通行密钥（以后用指纹登录），打开推送，点「发送测试」看能不能收到
3. 手机上用 Chrome 打开，菜单里选「添加到主屏幕」
4. 回首页点「新建」，选个模板建第一个 agent

> 手机推送依赖浏览器自带的推送服务。Android 上要用 Chrome，并且手机得有谷歌服务；Via 这类轻量浏览器不支持。

## 日常使用

- **建 agent**：有四个模板，分别是通用助理、网页办事、运维、研究。选一个，改个名字就能用，其他设置都可以以后再调
- **派活**：进对话直接说。它干活的时候你可以接着补充要求
- **审批**：默认 agent 在自己容器里可以随便执行命令，不打扰你；想每条都过目的，在 agent 设置里把「命令审批」改成「每条都问我」。操作宿主机的命令无论怎么设都要审批
- **看它在干嘛**：对话里每个工具调用都能点开看输入输出；用到桌面时去「桌面」页看实时画面
- **教它东西**：直接说「记住……」；答得好或不好就点 👍 👎。学到的东西在「学习」页，不对就撤销
- **定时**：「任务」页新建，或者在对话里让 agent 自己建
- **密钥**：agent 需要用的 API key、token 放在 agent 的「管理」页，会以环境变量的形式给到容器，不会出现在对话记录里

## 模型

所有模型都通过 new-api 调用，Codex 使用的是 Responses API（`/v1/responses`），所以 new-api 那边对应的通道要支持这个接口。

哪些模型能稳定干活，可以用脚本测：

```bash
scripts/spikes/model-compat.sh gpt-6-astra kimi-k3 glm-5.3
```

它会让每个模型做同一个多步小任务（写脚本、运行、保存结果、检查），然后统计哪些模型完成了。实测能用的模型，在 App 里选模型时会带 ✓。目前只支持走 API，不单独适配各家的 CLI 或订阅。

## 已知问题和没做的

- 只支持一个账号，自己用
- 按 agent 统计费用、每日预算这块需要 new-api 的管理员令牌（在「设置 → new-api」里填），这部分还没在真实环境里验证过
- hub 重启、agent 容器崩溃这类故障场景，恢复逻辑已经写了，但还没专门做过演练
- 用鼠标键盘直接操作桌面的工具，控制接口单独测过；但实测中模型一般都优先用网页工具，这条路径实际跑得少

## 开发

需要 Node 22.18+、pnpm 12、Docker。TypeScript 用 Node 原生运行，不用编译。

```bash
pnpm install
pnpm typecheck
pnpm test              # 单元测试
scripts/e2e/run.sh     # 端到端测试
```

`scripts/e2e/run.sh` 会单独起一个测试用的 hub（端口 8781，数据在 `/srv/constella-test`），用真实模型把主要流程跑一遍：对话、记忆、审批、停止、浏览器、桌面接管、定时、复盘和撤销。然后用桌面容器里的 Chromium 模拟手机和电脑把每个页面点一遍并截图。跑完自动清理，不影响正式数据。

## 目录

| 路径 | 内容 |
|---|---|
| `apps/hub` | 管理服务（Fastify + SQLite） |
| `apps/runner` | agent 容器里的进程，负责驱动 Codex |
| `apps/web` | 前端（React + Tailwind，桌面画面用 noVNC） |
| `packages/protocol` | 前后端共用的事件格式和状态定义 |
| `images` | hub、agent、桌面三个 Docker 镜像 |
| `deploy` | docker-compose 和配置模板 |
| `scripts` | 部署、测试用的脚本 |
| `docs` | 设计文档、开发进度、技术选型记录 |
