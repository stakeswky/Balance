# 余量 / Balance

余量（Balance）是一个本地优先的 Claude Code、Grok CLI / Grok Build 和 Codex CLI 配额监控面板。它读取本机 Agent 会话日志和供应商官方订阅百分比，把实际模型/token 用量折算成公开 API 价格等价。

> “API 等价金额”表示同样模型与 token 通过公开 API 调用时的理论价格，不是现金余额，也不是供应商承诺的可提现额度。

## 界面预览

亮色与暗色可在应用内切换。

<img src="./screenshots/claude-grok-quota-desktop.png" alt="Balance desktop quota dashboard (light)" width="900">

<img src="./screenshots/claude-grok-quota-desktop-dark.png" alt="Balance desktop quota dashboard (dark)" width="900">

## macOS 应用

打包版目前只提供 **Apple Silicon**。从 [Releases](https://github.com/stakeswky/Balance/releases/latest) 下载 `Balance_0.1.0_aarch64.dmg`，把「余量」拖进「应用程序」。维护者构建与验收见 [macOS 桌面应用](./docs/macos-desktop.md)。

当前构建使用 macOS ad-hoc 签名，尚未经过 Apple 公证。从网络下载后，Gatekeeper 可能提示「无法打开，因为无法确认开发者」，或「已损坏，无法打开」。这是隔离属性导致的，应用本身没有损坏。

### Gatekeeper 临时解决方案

先试图形界面：

1. 把 `Balance.app` 拖到「应用程序」。
2. **不要双击。** 按住 Control 点击图标，选「打开」，再确认「打开」。
3. 若仍被拦截：打开「系统设置 → 隐私与安全性」，下滑到刚才被拦下的应用，点「仍要打开」。

若系统显示「已损坏」，在终端清除隔离属性后再打开：

```bash
xattr -cr /Applications/Balance.app
open /Applications/Balance.app
```

如果还没拷到「应用程序」，对下载的 DMG 做同样处理：

```bash
xattr -cr ~/Downloads/Balance_0.1.0_aarch64.dmg
```

这是公证完成前的临时方案。之后会换成 Developer ID 签名 + notarization，首次打开就不会再被 Gatekeeper 拦截。

## Linux / Windows / Intel Mac

这些平台还没有打包应用，请直接用调试模式跑本地服务。需要 Node.js 22 或更高版本。Apple Silicon Mac 也可以用同一组命令做本地开发。

```bash
git clone https://github.com/stakeswky/Balance.git
cd Balance
npm install
npm run dev
```

打开 <http://localhost:8080>。余量必须运行在保存 Claude / Grok / Codex 本地日志的机器上，才能自动读取真实用量；没有本地数据时仍可使用匿名演示数据，或在「插件」页手动导入 JSON/JSONL。

```bash
npm test
npm run typecheck
npm run build
```

## 数据与隐私

Claude、Grok、Codex 分别读取本机 `~/.claude`、`~/.grok`（或 `$GROK_HOME`）、`~/.codex`（或 `$CODEX_HOME`）中的会话日志，再叠加各供应商官方订阅百分比。金额分层与计价规则见 [订阅配额 API 等价金额算法](./docs/subscription-quota-value-algorithm.md)。

- access token 只在服务端读取，不进入浏览器状态，也不写入持久化样本。
- 不要提交 `~/.claude`、`~/.grok`、`~/.codex`、auth 文件或真实导出日志。
- 远端部署无法读取访问者电脑上的本地 Agent 文件。
- 仓库自带的 Claude 演示数据已经匿名化。

## 许可证

[MIT](./LICENSE)
