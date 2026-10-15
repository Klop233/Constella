# Constella

一个跑在自己服务器上的 agent 管理平台。手机上打开就能给好几个 agent 派活，它们在服务器上 24 小时干，需要用浏览器、桌面程序或安卓 App 的时候各自有实例可用；做过的事情会记下来，下次做得更顺。

名字取自 constellation（星座）：每个 agent 是一颗星。

> **English summary**: Constella is a self-hosted platform for running several agents from your phone. Each agent runs [Codex](https://github.com/openai/codex) in its own Docker container; browsers, Linux desktops and Android devices are lent out on demand and you can take over when a step needs a human; what agents learn is kept as git-versioned memory and skills. Models go through [new-api](https://github.com/QuantumNous/new-api) or any OpenAI Responses-compatible provider. The app and docs are Chinese-only for now. Licensed under AGPL-3.0.

## 为什么做这个

手机上管 agent，常见做法是靠聊天机器人，桌面画面只能在电脑客户端看，配置项又多，出了问题得自己翻日志。

Constella 的思路是：**干活的部分不自己写**，直接用 OpenAI 开源的 Codex 作为 agent 内核；自己只做外面那层，也就是多 agent 管理、实例、记忆和手机端。模型默认走 [new-api](https://github.com/QuantumNous/new-api)，也可以在设置里再加别的 provider（任何支持 OpenAI Responses API 的地址），不绑定任何一家。

## 能做什么

**手机 / 网页端**
- 可以装到手机主屏幕（PWA），电脑浏览器打开是侧边栏布局
- 同时管理多个 agent，每个都有自己的对话记录
- 回复是流式的，agent 执行的每条命令、调用的每个工具都能展开看
- 任务进行中可以继续发消息补充要求，不想让它做了就点停止
- 危险操作会弹审批，手机收到推送，点一下批准或拒绝
- 登录支持密码、两步验证、指纹 / 面容（通行密钥）

**实例**
- 三种实例：**纯浏览器**（只有一个 Chromium，最省资源）、**Linux 桌面**（Xfce + Chromium，能运行别的程序）、**安卓**（能装 App，可选 ARM 转译和 Google Play）
- 每个 agent 可以分到零个或多个实例，类型不限；agent 需要时也能自己新建、修改实例，要不要你同意在设置里定；实例卡住时它可以直接修（重启、重建容器，数据保留），不用等你批
- 闲置的实例可以暂停（冻结、保留内存，几秒恢复）或停止，全局设置，每个实例也能单独设
- 在 App 里能实时看到 agent 在实例上干什么
- 遇到登录、验证码、扫码这种得本人来的步骤，agent 会推送叫你，你点「接管」自己操作，弄完点「交还」，还能留句话给它
- agent 操作网页优先按页面结构来（点按钮、填表单），安卓上先读界面元素再点，比按坐标点像素靠谱

**文件和成果**
- agent 做出的报告、表格、图片、PDF、压缩包会直接发到聊天里，点开就能预览，也能下载
- 较长的文档、单页网页、代码、SVG、CSV 会作为「成果」生成，像 ChatGPT / Claude 的 Artifacts：在侧边面板里预览（网页在沙箱里运行）、看源码、直接编辑
- 每次修改都留一个版本，可以切换查看、恢复旧版本；agent 能读到你改过的版本，接着在上面改
- 「成果」页按 agent、类型、标题检索所有交付过的东西；文件单独存放，随每日备份一起备份

**记忆和技能**
- 跟它说「记住……」它就记下；关于你本人的信息所有 agent 共享
- 每次任务结束会自动复盘，值得留的经验写进记忆，可复用的流程写成技能（SKILL.md）
- 点 👍 / 👎 也会触发复盘，点踩时它会重点记下哪里做错了
- 所有改动都存在 git 里，「学习」页能看到每次具体改了什么，不满意可以撤销
- 每周自动整理一次，合并重复的、删掉过时的

**其他**
- 定时任务：定时推送提醒，或者定时让 agent 去做某件事。也可以直接对 agent 说「每天早上 8 点提醒我……」
- 推送走浏览器原生的 Web Push，可以再配 Telegram 当备用
- 每个 agent 跑在独立容器里，搞坏了重建就行；需要操作宿主机的（比如运维用的 agent）要单独开权限，非只读命令按「设置 → 权限」里的策略审批（默认自动批准，建议改成「危险时问我」）
- 「设置 → 模型」：添加多个 provider，每个模型绑定一个 provider，显示成 `model (provider)`；同名模型可以挑一个省略 provider；每个模型一键测试连通；用量按模型、provider、agent 拆开看
- 可以给每个 agent 在 new-api 里单独开令牌，分开统计花费、设每日预算
- 「性能」页看这台服务器：CPU、内存、交换、负载、运行时间、磁盘和实时网速，带最近 1 小时 / 24 小时的曲线；下面按实例、agent 和 hub 服务列出各自占用的 CPU、内存、网络和进程数，点开是每个容器的明细；打开某个实例时也能看到它自己的性能曲线
- 「凭据与隐私」：连接 Bitwarden（美国 / 欧洲 / 第三方与自托管，如 Vaultwarden，支持自签名证书）之后，agent 需要密码、用户名或验证码时向你在设置里指定的审批 agent 申请，批准后 10 分钟内只能读取一次；主密码只在解锁时用，审批记录和访问历史里只有条目名和字段名。见 [docs/credentials.md](docs/credentials.md)
- 每天自动备份，默认保留最近 7 份；自动继续、单轮时长、卡住处理、闲置休眠、推送事项、免打扰等都能在设置里调

**出了问题它先自己想办法**
- 任务中断了自动接着做；卡住没动静时监督员介入（结束卡死的命令、提醒、重启这一轮、重建容器）
- 实例巡检：实例反复崩溃或长时间没响应，系统自己修（正常关机、清掉强制停止留下的锁、重启，必要时重建容器，数据保留）
- agent 遇到自己看不到、修不了的环境问题，可以找平台「维修员」：它能看到实例的容器状态和日志，修好坏掉的实例、结束卡死的进程，再告诉 agent 下一步
- 任务只有做完才能结束：每轮结束时监督员复核，没做完就停下（「暂时没装成，建议稍后重试」「要不要继续？」）的记为 **panic** 并推送给你，同时让它接着做（需要你本人的步骤让它在任务里等你）；连续拉回两次仍没做完，才生成报告请你决定
- 以上每次自动处理都记在「审计」里；处理不了的放在「待处理」，带诊断和一键方案

## 快速开始

已经有一台装好 Docker 的 Linux 服务器、一个能用的 [new-api](https://github.com/QuantumNous/new-api) 的话，十分钟左右能跑起来：

```bash
git clone https://github.com/Klop233/Censtella.git constella
cd constella/deploy
cp .env.example .env && chmod 600 .env
# 编辑 .env：至少填 CONSTELLA_MASTER_KEY、CONSTELLA_SETUP_CODE、CONSTELLA_ORIGINS、NEWAPI_BASE_URL、NEWAPI_API_KEY
docker compose --profile images build
docker compose up -d hub
curl http://127.0.0.1:8780/api/health
```

然后在服务器本机打开 `http://localhost:8780`（远程的话先 `ssh -L 8780:127.0.0.1:8780 你的服务器`；`CONSTELLA_ORIGINS` 里要保留 `http://localhost:8780`），输入初始化码建账号、新建 agent，就能开始派活。要在手机上用、收推送，还得配一个 HTTPS 入口，见下面的「部署」。

## 大致结构

```
手机 / 浏览器
    │  HTTPS
    ▼
constella-hub ─────────────── 管理服务：登录、agent、对话、审批、定时、记忆、推送
    │
    ├── constella-agent-xxx ── 每个 agent 一个容器，里面跑 Codex
    │       └── 通过 MCP 调 hub 提供的工具：记忆、发文件 / 成果、桌面、浏览器、定时任务、宿主机命令
    │
    ├── constella-desktop-xxx ─ 实例：浏览器 / Linux 桌面（安卓实例在这里跑画面和控制）
    ├── constella-android-xxx ─ 安卓实例的系统本身（Redroid 或模拟器）
    │
    └── new-api ────────────── 所有模型请求都走这里
```

数据都放在 `/srv/constella`：数据库、每个 agent 的工作目录和记忆、成果文件（`artifacts/`，不挂进 agent 容器）、桌面的用户目录（浏览器登录状态在这里）、备份。

## 部署

**需要准备**

| 项目 | 要求 |
|---|---|
| 服务器 | x86_64 的 Linux（物理机、云主机、VM、特权 LXC 都行） |
| Docker | Docker Engine 带 `docker compose` 插件；hub 要挂载 `/var/run/docker.sock`，由它按需启动 agent 和实例容器 |
| 内存 | hub 和每个闲着的 agent 各一两百 MB；实例另算，见「实例类型与宿主要求」。只用浏览器实例的话 4 GB 够用 |
| 磁盘 | 基础镜像（hub、agent、桌面、安卓桥接）一共约 4.5 GB；安卓模拟器镜像再加 7–8 GB |
| 模型 | 一个 [new-api](https://github.com/QuantumNous/new-api)，通道要支持 Responses API（`/v1/responses`）。别的 provider 可以之后在 App 里加 |
| HTTPS 入口 | 手机推送和指纹登录要求 HTTPS：一个托管在 Cloudflare 的域名，或者 Tailscale |

数据目录固定在宿主的 `/srv/constella`，第一次启动时自动创建。

**1. 拉代码，写配置**

```bash
git clone https://github.com/Klop233/Censtella.git constella
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
docker compose --profile images build   # 构建 hub、agent、桌面和安卓桥接镜像，第一次比较慢
docker compose up -d hub
curl http://127.0.0.1:8780/api/health   # 返回 ok 就是起来了
```

hub 只监听本机 `127.0.0.1:8780`，外面要访问得再配一个入口（见下一步）。

构建时 npm 默认走国内镜像 `registry.npmmirror.com`，海外服务器想用官方源的话：`docker compose --profile images build --build-arg NPM_REGISTRY=https://registry.npmjs.org`。

「性能」页要报告整台机器（而不只是 hub 容器）的 CPU、内存和网速，hub 得只读地看到宿主的 `/proc` 和 `/sys/fs/cgroup`：`docker-compose.yml` 已经把这两个目录挂到容器里的 `/host/proc` 和 `/host/sys/fs/cgroup`，挂载的上级目录可以用 `CONSTELLA_HOST_ROOT` 改（默认 `/host`）。在 LXC 这类容器里跑、或者没挂上时，页面会写明它看到的是 cgroup 还是 hub 容器自己的数字，读不到的指标显示成空，不会当成 0。

要用安卓实例的话，再按机器的情况构建一种（见下面「实例类型与宿主要求」）：

```bash
scripts/build-android-images.sh redroid --arm --gapps                          # 内核带 binder 的机器
scripts/build-android-images.sh emulator --accept-android-sdk-license --playstore  # 有 /dev/kvm 的机器
```

**3. 配访问入口**

推送通知和指纹登录要求必须是 HTTPS，所以下面两种至少配一种。

- **Cloudflare Tunnel（公网访问，推荐）**：域名托管在 Cloudflare 的话，运行

  ```bash
  scripts/enable-public.sh constella.你的域名
  ```

  服务器上要先装好 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。第一次会打印一个 Cloudflare 授权链接，浏览器打开选好域名就行；建隧道、加 DNS、把域名写进 `.env` 的 `CONSTELLA_ORIGINS`、启动 cloudflared 容器都是脚本自己做。国内服务器连 Cloudflare API 可能需要代理，用环境变量指定：`CF_PROXY=http://127.0.0.1:7890 scripts/enable-public.sh …`。

- **Tailscale Serve（只在自己的设备之间访问）**：先在 Tailscale 后台开启 HTTPS 证书和 Serve，然后

  ```bash
  tailscale serve --bg --https=443 http://127.0.0.1:8780
  ```

  再把 `https://<主机名>.<tailnet>.ts.net` 加进 `.env` 的 `CONSTELLA_ORIGINS`，`docker compose up -d hub` 重启生效。

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
- **审批**：默认 agent 的所有操作都自动批准，不打扰你。想过目的，在「设置 → 权限」里给每种操作（执行命令、修改文件、在宿主机上执行命令、新建和修改实例）分别选自动批准、危险时问我或每次问我
- **看它在干嘛**：对话里每个工具调用都能点开看输入输出；用到实例时去「实例」页看实时画面
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

## 实例类型与宿主要求

hub 启动时会用临时容器检测这台机器能跑什么，结果在「设置 → 实例」里；建不了的类型会写明原因。改了宿主设置或构建了新镜像后，点那里的「检测」。

| 类型 | 需要 | 大约占用内存 |
|---|---|---|
| 纯浏览器 | 只要 Docker | 0.3–1 GB |
| Linux 桌面 | 只要 Docker | 0.4–1.5 GB |
| 安卓 · Redroid | 宿主内核带 binder（binderfs），Docker 能起特权容器，并且特权容器能改内核参数 | 2–4 GB |
| 安卓 · 模拟器 | 宿主有 `/dev/kvm`（硬件虚拟化） | 3–4 GB |

两种安卓都支持时，默认用 Redroid（更轻、启动更快）；在「设置 → 实例 → 运行方式」里可以指定。

**Redroid**
- Ubuntu：`sudo apt install linux-modules-extra-$(uname -r) && sudo modprobe binder_linux devices=binder,hwbinder,vndbinder`，再把 `binder_linux` 写进 `/etc/modules-load.d/` 让它开机加载。Debian 等别的发行版要确认内核开了 `CONFIG_ANDROID_BINDERFS`。
- 安卓启动时会设置几个全局内核参数（例如 `kernel.kptr_restrict`），所以它会改到宿主；非特权的 LXC 容器（比如 Proxmox 默认的 CT）不允许这样做，安卓起不来。这种情况用模拟器，或把 CT 改成特权容器。
- 宿主的 uid 映射小于 90000 时（非特权 LXC 常见），App 里的网页内容（WebView）可能闪退，检测结果里会提示。
- `--arm` 会下载 libndk_translation（Google 专有组件），让只有 ARM 版本的 App 能跑；`--gapps` 会下载 MindTheGapps。它们只在你本机构建时下载，不随项目分发。

**模拟器**
- 用 Google 的 Android SDK 模拟器和 x86_64 系统镜像（自带 ARM 转译）；构建时要加 `--accept-android-sdk-license`，表示你接受 [Android SDK 许可](https://developer.android.com/studio/terms)。
- 在 Proxmox 的 LXC 里用：在宿主上 `pct set <CT 编号> --dev0 /dev/kvm,mode=0666`（Proxmox VE 8.1 起），重启 CT 后生效。

**Google Play**：这些安卓都不是 Google 认证设备，第一次登录 Play 商店前，要在 [google.com/android/uncertified](https://www.google.com/android/uncertified/) 登记设备 ID。实例页面「更多 → Google 设备登记」里能看到这个 ID。

**国内 App**：大多只有 ARM 版本，需要开 ARM 转译；银行、支付类 App 可能检测到模拟环境后拒绝运行。

## 升级、备份与恢复

**升级**

```bash
cd constella && git pull
cd deploy
docker compose --profile images build
docker compose up -d hub
```

agent 和实例容器不用手动处理：hub 发现镜像变了，会在下次启动它们时用新镜像重建，数据都在挂载目录里，不会丢。重启 hub 会打断正在跑的任务，开了「中断后自动继续」的会自己接上。

**备份**：每天 3:30 自动备份到 `/srv/constella/backups/constella-<时间>.tar.gz`，里面有数据库、所有记忆和技能、成果文件；保留份数在「设置」里改。实例里的浏览器登录状态、agent 工作目录里的文件不在备份里，需要的话自己再备份整个 `/srv/constella`。

**恢复**：数据库里的密钥是用 `CONSTELLA_MASTER_KEY` 加密的，恢复时 `.env` 里必须是原来那个主密钥。

```bash
cd constella/deploy && docker compose stop hub
mkdir /tmp/restore && tar -xzf /srv/constella/backups/constella-<时间>.tar.gz -C /tmp/restore
cp /tmp/restore/backups/db-*.sqlite /srv/constella/db/constella.db && rm -f /srv/constella/db/constella.db-wal /srv/constella/db/constella.db-shm
cp -a /tmp/restore/shared /tmp/restore/agents /tmp/restore/artifacts /srv/constella/ 2>/dev/null
docker compose up -d hub
```

## 常见问题

- **操作报 `origin not allowed` / 「不允许的来源」**：浏览器地址栏里的地址（协议 + 域名 + 端口）要写进 `CONSTELLA_ORIGINS`，改完重启 hub。
- **收不到推送**：必须通过 HTTPS 地址打开；Android 用 Chrome 且手机有谷歌服务；iPhone 要先「添加到主屏幕」，再从主屏幕图标打开后开启推送。
- **agent 一直不回复或报模型错误**：在「设置 → 模型」里点该模型的「测试」；多半是 new-api 那边的通道不支持 `/v1/responses`，或者令牌没有这个模型的权限。容器里的日志：`docker logs constella-agent-<id>`。
- **某种实例建不了**：「设置 → 实例」里会写明缺什么，补上后点「检测」。
- **hub 起不来**：`docker logs constella-hub`。最常见的是 `.env` 没填 `CONSTELLA_MASTER_KEY`。
- **忘了密码**：目前没有找回功能，建议登录后马上加一个通行密钥，多一种登录方式。

## 已知问题和没做的

- 只支持一个账号，自己用
- 按 agent 统计费用、每日预算这块需要 new-api 的管理员令牌（在「设置 → 模型 → new-api → 管理令牌」里填），这部分还没在真实环境里验证过
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

`scripts/e2e/run.sh` 会单独起一个测试用的 hub（端口 8781，数据在 `/srv/constella-test`），用真实模型把主要流程跑一遍：对话、记忆、审批、停止、agent 自己新建实例、浏览器、暂停和重启实例、接管、定时、复盘和撤销（机器能跑安卓时也测安卓）。要测还没上线的镜像，用 `HUB_IMAGE=…`、`CONSTELLA_DESKTOP_IMAGE=…` 这类环境变量指定。然后用桌面容器里的 Chromium 模拟手机和电脑把每个页面点一遍并截图。跑完自动清理，不影响正式数据。

## 目录

| 路径 | 内容 |
|---|---|
| `apps/hub` | 管理服务（Fastify + SQLite） |
| `apps/runner` | agent 容器里的进程，负责驱动 Codex |
| `apps/web` | 前端（React + Tailwind，桌面画面用 noVNC） |
| `packages/protocol` | 前后端共用的事件格式和状态定义 |
| `images` | hub、agent、桌面（浏览器 / Linux），以及安卓的桥接、Redroid、模拟器镜像 |
| `deploy` | docker-compose 和配置模板 |
| `scripts` | 部署、测试用的脚本 |
| `docs` | 设计文档、前端规范、凭据说明、路线图、决策记录、实测记录 |

## 安全

hub 挂载了 `docker.sock`（等同宿主 root），agent 执行的是模型生成的命令，而且默认所有操作自动批准。部署前请读一遍 [SECURITY.md](SECURITY.md)，发现漏洞也请按里面的方式私下报告。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)；代码地图和约定在 [AGENTS.md](AGENTS.md)。

## 许可证

[AGPL-3.0](LICENSE)。可以自由使用、修改和分发；改过的版本如果拿去给别人提供服务（包括通过网络），也要把改动后的源码公开给用户。
