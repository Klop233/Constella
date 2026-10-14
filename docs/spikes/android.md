# 安卓实例实测（2026-10-14）

测试机：Proxmox VE 上的非特权 LXC（内核 6.8.12-pve，uid 映射 `0 100000 65536`，没有 `/dev/kvm`，宿主已加载 `binder_linux`），Docker 29.6。

## Redroid

| 项目 | 结果 |
|---|---|
| 特权容器里挂载 binderfs | ✅ `mount -t binder` 成功，有 binder / hwbinder / vndbinder |
| Redroid 14（64only）启动 | ❌ init 写 `/proc/sys/kernel/kptr_restrict` 失败后主动重启（`InitFatalReboot`），容器退出码 129 |
| 绕过 kptr_restrict | ❌ 在容器里用文件覆盖它没用：init 第一阶段会重新挂载 `/proc`；init 之前也没有 shell 可用（安卓二进制依赖 `/apex` 里的 linker） |
| 切换到 uid 90000 | ❌ `setresuid` 返回 EINVAL（映射只到 65535）；安卓给 WebView 等隔离进程用 90000 以上的 uid |

结论：
- `kernel.kptr_restrict` 不分命名空间，非特权 LXC（用户命名空间）里的容器改不了，所以 **Redroid 不能在非特权 LXC 里运行**。普通 Docker 宿主（裸机、虚拟机）或特权 LXC 可以；代价是安卓会把几个全局内核参数改到宿主上。
- hub 的能力检测因此检查三项：binder 能挂载、特权容器能写回 `kptr_restrict`（写入当前值，不改变宿主）、能切换到 uid 90000（不能时只给警告）。
- 调试方法：init 的日志写在 `/dev/kmsg`，LXC 里读不了 dmesg；把一个普通文件挂到容器的 `/dev/kmsg`（`-v file:/dev/kmsg`）就能看到。

镜像（`images/android-redroid`）：
- 基于 `redroid/redroid:13.0.0-latest`（带 32 位，ARM 转译需要）。
- ARM 转译：supremegamers 打包的 libndk_translation 0.2.2（Android 11 模拟器里的那份）。只设置 native bridge 相关属性，**不**设置 `ro.enable.native.bridge.exec=1`：否则安卓会往宿主全局的 binfmt_misc 里注册 ARM 解释器。
- Google 应用：MindTheGapps 13.0.0 x86_64。

## 模拟器

| 项目 | 结果 |
|---|---|
| 镜像构建（cmdline-tools 19.0，emulator 37.2.12，`system-images;android-34;google_apis;x86_64`） | ✅ 约 2.0 GB，构建时不需要 KVM |
| 启动脚本生成 AVD、写入屏幕尺寸和密度、生成并共享 adb 密钥 | ✅ |
| 启动 | ⏸ 走到「System requirements … are met」，然后因为没有 `/dev/kvm` 报 `x86_64 emulation currently requires hardware acceleration`；这里验证不了实际运行 |

- 模拟器的 adbd 只监听 127.0.0.1，用 `-ports 5556,5557` 加 socat 暴露到 5555；Google Play 镜像要求 adb 授权，启动脚本生成密钥放在实例的 `adb/` 目录，模拟器和桥接容器共用。
- 切换 Google Play 要换系统镜像，旧的虚拟设备数据不能沿用，所以会清空数据（App 里要二次确认）。

## 桥接容器（两种后端共用）

- scrcpy 5.0.1 的 Linux 静态包只依赖 libc、libm、libudev、libcap，SDL 运行时再加载 X11 库；用 `--render-driver=software` 在 Xvnc 里显示，不需要 GPU。
- 中文输入：ADBKeyboard（`am broadcast -a ADB_INPUT_B64`）；`input text` 只能输入 ASCII。
- 界面结构：`uiautomator dump`，精简成「类型、文字、描述、resource-id、可点、中心坐标」。

## 其他

- `docker pause` / `unpause` 在这台 LXC 里正常（cgroup v2 freezer），实例的闲置暂停用它。
- 纯浏览器模式（`CONSTELLA_SESSION=browser`）：只有 xfwm4 和 Chromium，Chromium 被关掉后 1 秒内重开；`/launch` 拒绝启动其他程序。
