# Antigravity 官方额度运行时修复规格

日期：2026-08-25
状态：待实现
主规格：`docs/specs/2026-08-25-antigravity-cli-quota.md`

## 根因

Antigravity 官方额度在应用中"取不到"，由三个运行时问题共同导致：

1. **`agy models` 非 TTY 挂起**：`execFile` 默认 stdin 为 open pipe，`agy` 等待输入导致 22 秒超时被 kill。`spawn` + `stdio ["ignore","pipe","pipe"]` 可在 7.8 秒内正常完成。Google OAuth token 约 1 小时过期，过期后每个轮询周期都白等 20 秒。
2. **identity 刷新丢数据**：`readAntigravityQuota` 内部刷新凭据后 access token 变化，`keyAfterRefresh !== antigravityKey`，导致刚取到的 `fetched` 被丢弃（`antigravityLive = null`），白等一轮。
3. **四路 provider 串行刷新**：Claude/Grok/Codex/Antigravity 依次 await，健康路径实测总耗时约 7.4 秒，任何一路慢都拖全体；dashboard 每 2.5 秒轮询。

## 约束

- 非 TTY 子进程必须忽略 stdin（`stdio ["ignore","pipe","pipe"]`），不依赖 pipe 被读取。
- CLI 刷新失败后 5 分钟内不再重试 `agy models`（冷却由模块级 Map 按 agy canonical path 追踪）。
- 同账号 token 刷新不得丢弃已取得数据：`readAntigravityQuota` 返回产出数据时使用的凭据 identity，调用方按该 identity 作为缓存 key 存储。
- 四路 provider 并行刷新且互不阻塞，任何一路异常走该路现有降级语义，不允许整体 reject。
- 安全约束沿用主规格：token 不落日志、不进 client、不进测试 fixture、不进持久化快照。

## 验收清单

1. 单测证明子进程 stdin 被忽略：可执行脚本"读 stdin 直到 EOF 才输出"在新实现下快速完成，旧实现挂到 timeout。
2. 单测证明 CLI 刷新冷却：失败后 5 分钟内第二次调用不再执行 `agy models`，5 分钟后恢复。
3. 单测证明 token 刷新后数据保留：identity 从 A 变为 B 时 slice 不被丢弃，后续请求命中新 key 缓存。
4. 单测证明四路并行：确定性屏障法，串行实现死锁（2 秒超时失败），并行实现通过且四路数据齐全。
5. 全量 `npm test`、`npm run typecheck`、`npm run build` 通过。
6. 真实应用启动后 Antigravity 卡片显示官方额度，不出现空白或持续 loading。
