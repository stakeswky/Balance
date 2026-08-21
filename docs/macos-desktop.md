# macOS 桌面应用

首个桌面构建面向 Apple Silicon。从 [Releases](https://github.com/stakeswky/Balance/releases/latest) 下载 `Balance_0.1.0_aarch64.dmg`。Node.js、Rust、Docker 和数据库已打包或不需要。

当前构建使用 macOS ad-hoc 签名，不是 Apple Developer ID 签名或公证。从网络下载的构建因此可能在首次启动时出现 macOS 安全提示。

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
