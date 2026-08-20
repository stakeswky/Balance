# Synq

Synq 是一个本地优先的 Claude Code、Grok CLI / Grok Build 和 Codex CLI 配额监控面板。它读取本机 Agent 会话日志和供应商官方订阅百分比，把实际模型/token 用量折算成公开 API 价格等价，并给出 5 小时窗、周窗和剩余额度区间。

> “API 等价金额”表示同样模型与 token 通过公开 API 调用时的理论价格，不是现金余额，也不是供应商承诺的可提现额度。

## 界面预览

<img src="./screenshots/claude-grok-quota-desktop.png" alt="Synq desktop quota dashboard" width="900">

<img src="./screenshots/claude-grok-quota-mobile.png" alt="Synq mobile quota dashboard" width="360">

## 功能

- 同时监听 Claude Code、Grok 和 Codex 的本地 JSONL 用量。
- 获取 Claude 5h/7d 官方利用率，并通过 Claude OAuth usage 读取 Claude Max 的 Fable 5 官方周子额度；OAuth 不可用时只保留桌面 5h/7d 后备。同时读取 Grok 共享周池和 Codex 官方订阅百分比。
- 按版本化公开价格计算 L1 已观测 API 等价金额。
- 使用同窗口连续样本估计 L2 整窗价值和 L3 剩余价值区间。
- 显示价格覆盖率、模型组合、置信度、reset 时间、实时会话与路由建议。
- 所有 access token 仅在服务端读取，不进入浏览器状态或持久化样本。

## 数据来源

| Agent | 本地用量 | 官方订阅信息 |
| --- | --- | --- |
| Claude | `~/.claude/projects/**/*.jsonl`、`~/.config/claude/projects/**/*.jsonl` | Claude OAuth `/api/oauth/usage`（含 Fable）；macOS Claude Desktop `plan-usage-history.json` 后备 5h/7d |
| Grok | `$GROK_HOME/sessions/**/updates.jsonl` 或 `~/.grok/sessions/**/updates.jsonl` | Grok billing API；`~/.grok/logs/unified.jsonl` 后备 |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl` 或 `~/.codex/sessions/**/rollout-*.jsonl` | ChatGPT `/wham/usage`；session `rate_limits` 后备 |

## 快速开始

要求 Node.js 22 或更高版本。

```bash
npm install
npm run dev
```

打开 <http://localhost:8080>。Synq 必须运行在保存上述本地日志和认证文件的机器上，才能自动读取真实用量；没有本地数据时仍可使用匿名演示数据或在“插件”页手动导入 JSON/JSONL。

常用验证命令：

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` 会生成 Vercel/Nitro 产物；没有 `DATABASE_URL` 时使用 PGLite fallback。

## 金额口径

- L1：当前官方窗口内，本机日志已观测 token 的 API 等价金额。
- L2：同一窗口连续百分比/本地金额差分推导的整窗价值区间。
- L3：L2 单位斜率乘以官方剩余百分比得到的剩余价值区间。
- Claude/Grok 只显示美元 API 等价；Codex 另外按公开 rate card 显示 credit 等价。
- 百分比来自官方，本地 token 不会覆盖官方利用率。

详细规则见 [订阅配额 API 等价金额算法](./docs/subscription-quota-value-algorithm.md)。

## 隐私与部署边界

- 不要提交 `~/.claude`、`~/.grok`、`~/.codex`、auth 文件或真实导出日志。
- Synq 对本地 JSONL 只读扫描；校准样本不保存 prompt、cwd、access token 或账户 ID。
- 部署到远端 Vercel 的实例无法读取访问者电脑上的本地 Agent 文件；远端部署适合演示、手动导入或与独立 sidecar 集成。
- 仓库自带的 Claude 数据已经匿名化，只用于首次打开时展示界面。
