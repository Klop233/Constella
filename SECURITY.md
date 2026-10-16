# 安全策略

## 报告漏洞

请不要在公开 issue 里写漏洞细节。用仓库 **Security → Report a vulnerability**（GitHub 私密安全公告）提交，写明影响、复现步骤和你的环境。收到后会尽快确认并给出处理计划。

Please do not open a public issue for security problems; use GitHub's private vulnerability reporting (Security → Report a vulnerability) instead.

支持范围：`main` 分支的最新版本。

## 部署前需要知道的

Constella 的设计决定了它是一个高权限的服务，部署时请按下面几点处理：

- **hub 挂载了 `/var/run/docker.sock`**，等同于宿主机的 root 权限。不要把 hub 的端口直接暴露到公网；默认只监听 `127.0.0.1:8780`，对外通过 Cloudflare Tunnel 或 Tailscale Serve 提供 HTTPS。
- **开了「宿主机访问」的 agent 等同于宿主 root**（`host_exec`），只给确实需要运维的 agent 开。注意：**默认所有操作（包括宿主机命令）都是自动批准的**，部署后建议到「设置 → 权限」把「在宿主机上执行命令」改成「危险时问我」或「每次问我」。
- **agent 执行的是模型生成的命令**。每个 agent 在自己的容器里，没有 `docker.sock`，但可以出网；不要把不该让它碰的凭据放进它的环境变量或工作目录。需要登录时用「凭据与隐私」的限时单次授权，或在实例上自己接管。
- **`CONSTELLA_MASTER_KEY` 要保密并备份**：数据库里的密钥都用它加密，丢了就解不开，泄露了等于密钥库泄露。`deploy/.env` 的权限设为 `600`，不要提交。
- **`CONSTELLA_TRUSTED_PORT` 只用于开发**：这个端口上的请求不需要登录。不要在生产环境设置，更不要发布到公网接口。
- 只支持一个账号；初始化码（`CONSTELLA_SETUP_CODE`）可选、默认关闭，只在创建账号时校验，不设置时第一个打开页面的人就能创建账号，远程部署前要先把访问入口和它一起收好。

## 项目自身的防护

- 非 GET 请求要带自定义头并检查 `Origin`；WebSocket 用一次性 ticket；登录相关接口限流。
- 密钥加密存储（AES-256-GCM），写进事件、知识库和日志前先脱敏。
- 密码库里的凭据值只在 hub 内存里交给等待的工具，不进模型上下文，审批记录和访问历史里只有条目名和字段名。
- 危险操作（删除、破坏性命令、宿主机命令等）由 `apps/hub/src/safety.ts` 统一判定，每种操作可以在「设置 → 权限」里选自动批准、危险时问我或每次问我（默认自动批准）。
