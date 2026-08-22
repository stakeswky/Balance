# macOS 桌面应用

首个桌面构建面向 Apple Silicon。从 [Releases](https://github.com/stakeswky/Balance/releases/latest) 下载 `Balance_0.1.0_aarch64.dmg`。Node.js、Rust、Docker 和数据库已打包或不需要。

当前构建使用 macOS ad-hoc 签名，不是 Apple Developer ID 签名或公证。从网络下载的构建因此可能在首次启动时出现 macOS 安全提示。

应用会在菜单栏常驻。关闭主窗口只是隐藏到菜单栏，sidecar 继续读取本机配额；从「余量 → 退出余量」或菜单栏「退出」才会停止本地服务。点击 Dock 图标或菜单栏图标会重新打开窗口。

内部标识已经全部使用 Balance：bundle id `com.balance.desktop`、sidecar `balance-node`、健康检查 `{"app":"balance","mode":"desktop"}`、快照目录 `~/Library/Application Support/Balance`。如果本机还留着旧的 Synq 快照或 `synq-quota-v8`，第一次启动会自动迁到新位置，不覆盖已经存在的 Balance 数据。

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

运行原生验收套件前，先在 macOS **System Settings → Privacy & Security → Accessibility** 中授予启动该套件的终端应用权限。然后用一条命令验收已构建的 app 和 DMG：

```bash
npm run desktop:verify
```

这会覆盖环境与 auth 隔离、真实 app UI 与正常关闭路径、父进程 `SIGKILL` 后的 sidecar 清理、端口占用时的 `startup-error` 路径，以及打包 DMG 的 `hdiutil verify`。
