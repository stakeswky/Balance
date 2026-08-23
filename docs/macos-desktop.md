# macOS 桌面应用

首个桌面构建面向 Apple Silicon。从 [Releases](https://github.com/stakeswky/Balance/releases/latest) 下载 `Balance_0.3.0_aarch64.dmg`。Node.js、Rust、Docker 和数据库已打包或不需要。从 0.2.0 升级到 0.3.0 是最后一次手动安装。

0.3.0 起可在「设置 → 应用更新」检查仓库最新版。只改界面和采集逻辑时下载 sidecar 包即可；需要更新桌面壳、内置 Node 或能力时，应用会自动下载并安装完整应用。更新完成后必须从菜单栏选择「退出余量」再重新打开（关闭窗口只会藏到菜单栏）。

推送到 `main` 时 CI 会把热更新包 `packVersion` 自动加一（桌面壳版本仍手动升）。客户端用这个号判断有没有新界面包。

当前构建使用 macOS ad-hoc 签名，不是 Apple Developer ID 签名或公证。从网络下载的构建因此可能在首次启动时出现 macOS 安全提示。

应用会在菜单栏常驻。关闭主窗口只是隐藏到菜单栏，sidecar 继续读取本机配额；从「余量 → 退出余量」或菜单栏「退出」才会停止本地服务。点击菜单栏图标打开已监控订阅的周限额仪表盘；从 Dock 图标或菜单「打开余量」重新打开主窗口。

调度任务遵循相同生命周期：关闭主窗口后，原生 Agent 仍会在后台继续；真正退出应用时，Balance 会依次中断任务、终止整棵子进程树、保存“意外中断”状态，再停止 sidecar。重新启动只恢复历史和事件供查看，不会自动续跑。

内部标识已经全部使用 Balance：bundle id `com.balance.desktop`、sidecar `balance-node`、健康检查 `{"app":"balance","mode":"desktop"}`、快照目录 `~/Library/Application Support/Balance`。如果本机还留着旧的 Synq 快照或 `synq-quota-v8`，第一次启动会自动迁到新位置，不覆盖已经存在的 Balance 数据。

## 原生 Agent 总调度

总调度只在本机 macOS 桌面版和本机开发模式工作。它直接启动用户设备上已经登录的 Claude Code、Codex CLI 和 Grok CLI，不内置另一份客户端，也不复制认证文件。首次使用时：

1. 在终端分别完成所需 CLI 的安装与登录。
2. 打开「设置 → Agent 与 CLI」。Balance 会按常见绝对路径自动发现，也可以手动填写可执行文件绝对路径。
3. 点击「保存并检测」，确认版本可读；额度未知的 Agent 默认不会接单，用户可单独允许保底容量。
4. 进入「调度」，校验一个干净的本机 Git 仓库，输入目标并选择自动或手动负责人。
5. 检查计划中的任务说明、依赖、文件范围和验收命令，确认仓库可信后再开始。

每个 Agent 同时只执行一项任务，全局最多三个并行任务。每项任务使用独立 worktree 和隔离的临时 HOME；只有当前 Agent 自己的登录文件会以只读符号链接提供。任务通过预先展示的验收命令后才提交，并逐项合入独立结果分支 `balance/run-*-result`。原仓库的当前分支和 `HEAD` 不会被改动。

调度状态保存在 `~/Library/Application Support/Balance/orchestrator/`，目录权限为 0700，设置、运行快照、事件和能力令牌文件为 0600。能力令牌只通过本机 sidecar 环境和首次页面 URL fragment 传递，浏览器读取后会立即清除 fragment；非 loopback、错误 Host/Origin 或缺少令牌的请求会被拒绝。

常见排障：

- 显示“不可用”：在设置中填写 `which claude`、`which codex` 或 `which grok` 返回的绝对路径，再重新检测。
- 显示“额度未知”：确认 Balance 已采集到该 Agent 的本地用量或官方订阅百分比；也可以显式开启“额度未知时允许分配”。
- 仓库不能开始：提交或移除未提交改动，结束进行中的 merge/rebase，并重新分析计划。
- 计划被拒绝：原生 CLI 连续两次没有返回符合结构的计划；检查 CLI 登录和网络后重新分析。
- 运行显示“意外中断”：应用上次真正退出或异常终止。旧任务不会自动续跑，请检查事件后重新创建计划。
- 端口 4780 被占用：退出残留的 Balance 进程后重新打开；不要把本地服务暴露到非 loopback 地址。

## 本地缓存与隐私

缓存路径为 `~/Library/Application Support/Balance/quota-cache/`，文件权限 0600（仅当前用户可读写）。缓存保留最近 8 天的校准样本与 20k 条展示历史。

**隐私白名单**：缓存字段经过脱敏，只保存以下白名单内容：

- 窗口 ID、时间戳、利用率百分比、累计金额
- 模型族占比、价格版本、覆盖率
- 不保存 prompt、task、cwd、token 原文、account ID 或 access token

**删除后可从本地日志恢复**：用户删除缓存目录后，应用下次启动时会自动从本地 Agent JSONL 日志重建 L1 金额和采样历史。重建期间 L2/L3 暂时不可用（显示"正在重建校准历史"），待累积足够锚点后恢复。删除缓存不会丢失任何不可恢复的数据。

维护者可在 Apple Silicon Mac 上本地构建同一套产物：

```bash
npm ci
npm test
npm run typecheck
npm run desktop:prepare
npm run desktop:test
npm run desktop:build
```

完整应用更新必须用固定私钥签名。维护者本机构建前设置 `TAURI_SIGNING_PRIVATE_KEY` 和空的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；CI 使用同名 GitHub Secret。私钥不得提交到仓库，也必须安全备份：一旦遗失，已经安装的应用将无法验证后续自动更新。

```bash
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/balance-updater.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run desktop:build
```

运行原生验收套件前，先在 macOS **System Settings → Privacy & Security → Accessibility** 中授予启动该套件的终端应用权限。然后用一条命令验收已构建的 app 和 DMG：

```bash
npm run desktop:verify
npm run desktop:verify:updater
```

这会覆盖环境与 auth 隔离、真实 app UI 与正常关闭路径、父进程 `SIGKILL` 后的 sidecar 清理、端口占用时的 `startup-error` 路径、打包 DMG 的 `hdiutil verify`，以及本地签名的 0.3.0 → 0.3.1 完整更新、重启与坏签名拒绝路径。
