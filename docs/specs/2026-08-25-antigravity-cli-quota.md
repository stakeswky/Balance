# Antigravity CLI 余量接入规格

日期：2026-08-25
状态：已实现（官方额度部分）  
扩展规格：`docs/specs/2026-08-25-antigravity-token-usage.md`

## 目标

余量在本机检测到启动命令为 `agy` 的 Antigravity CLI 后，增加 Antigravity 卡片，并显示 Google 官方返回的两组订阅额度：

1. Gemini Models：5 小时窗口、每周窗口。
2. Claude and GPT models：5 小时窗口、每周窗口。
3. 简约模式按 Gemini Models 与 Claude and GPT models 分成两类；每类各自在 5 小时与每周窗口中选择“已用百分比最高”的窗口，并显示独立剩余百分比。
4. 顶部摘要与极客模式主数字继续从两类四池中选择全局最紧的官方额度；极客模式同时显示四个独立额度池的已用百分比与刷新时间。
5. 告警继续分别检查最紧的 5 小时窗口和最紧的周窗口；显示主额度的选择不合并或削弱这两路告警。

## 真实数据源

- CLI：`agy`，本机已核验版本 `1.1.20`，默认路径 `~/.local/bin/agy`。
- 官方 RPC：

  ```text
  POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
  Authorization: Bearer <server-only access token>
  Content-Type: application/json
  User-Agent: antigravity/<agy version> <platform>/<arch>
  Body: {}
  ```

- 当前真实响应：顶层 `groups` 有 `Gemini Models` 与 `Claude and GPT models`；每组有 `weekly` 和 `5h` bucket，字段为 `bucketId`、`displayName`、`window`、`resetTime`、`description`、`remainingFraction`。
- `remainingFraction` 是剩余比例；余量内部统一存储已用百分比：`(1 - remainingFraction) * 100`。

## 认证与隐私

读取顺序：

1. macOS Keychain：service=`gemini`、account=`antigravity`，兼容 `go-keyring-base64:` 包装。
2. `~/.gemini/jetski-standalone-oauth-token`。
3. `~/.gemini/antigravity-cli/antigravity-oauth-token`。
4. `~/.gemini/oauth_creds.json`。

约束：

- token 只存在服务端函数内存，不进入 Zustand、浏览器、日志、错误消息、测试 fixture 或持久化快照。
- 余量不自行保存、覆盖或轮换 Google 凭据。
- access token 返回 401 时，最多执行一次只读的 `agy models`，让官方 CLI 自己刷新 Keychain，再重读凭据并重试一次。
- 不从 `agy` 二进制提取 OAuth client secret，不自行实现 refresh-token 写回。
- 30 秒内复用内存快照；刷新失败时可以展示上次成功快照，但必须标成陈旧数据。
- 内存快照必须按 canonical `agy` 路径与 access token 的不可逆 SHA-256 session identity 隔离；账号或二进制切换后不得短暂展示旧账号余量，identity 不可读时不得取旧快照兜底。

## 检测规则

按以下顺序查找可执行文件：

1. `AGY_BIN` 显式路径。
2. 当前 `PATH` 中的 `agy`。
3. macOS/Linux 的 `~/.local/bin/agy`、`/opt/homebrew/bin/agy`、`/usr/local/bin/agy`。
4. Windows 的 `%LOCALAPPDATA%\\agy\\bin\\agy.exe`。

只有找到真实可执行文件才把 Antigravity 标为可用；仅存在旧配置目录不算已安装。

## 界面行为

- 名称：`Antigravity`。
- 配置提示：`agy · ~/.gemini`。
- 颜色：独立的 Antigravity 蓝紫色主题变量。
- Antigravity 的账户总余量继续来自官方接口；本机逐模型 token、调用次数和公开 API 价格等价金额按扩展规格读取会话数据库。它仍没有日志采集开关、可手选套餐或通用 token 图表。
- 设置页的套餐区域必须显示 Antigravity，但只能明确展示“官方额度自动读取、无需选择套餐”；官方 RPC 或 `agy` 未返回套餐层级时，不得伪造 Free、Pro、Ultra 等选项。
- 初始设置与适配器页显示 `agy` 的检测结果和官方余量说明。
- 手工导入、套餐对比、token 时间线与通用 token 报告继续只接受 Claude、Grok、Codex；Antigravity 在自己的卡片内显示本机逐模型明细。
- 演示模式继续只生成三类有本地 token 协议的 Agent，不虚构 Antigravity 用量。

## 失败与兼容

- Keychain 不可读、文件缺失、JSON 损坏、CLI 不存在、请求超时、401 重试失败、403、429、5xx、响应结构变化都不得让整个官方余量 RPC 失败。
- 新 provider 失败时，Claude、Grok、Codex 仍照常刷新。
- 不认识的 group 或 window 忽略；至少解析出一个 `5h` 或 `weekly` bucket 才生成 Antigravity slice。
- 百分比钳制到 0–100；非法时间不进入刷新倒计时。

## 非目标

- 不根据 Prompt 字符数或会话文本猜 token；只读取官方 CLI 已落盘的 `ModelUsageStats` 数值。
- 不把 `/usage` TUI 文本当稳定协议。
- 不根据额度百分比反推套餐月费或订阅总金额；本机真实 token 只按扩展规格换算公开 API 等价金额。
- 本次不新增 Windows Credential Manager 的 P/Invoke 读取；Windows 调试模式先使用兼容凭据文件，后续桌面打包再补原生凭据读取。

## 验收

1. 纯 parser fixture 精确生成四个额度池，并正确选择最紧的 5h/weekly 主窗口。
2. server 测试证明 Keychain 与文件凭据只在服务端读取，401 只触发一次 `agy models`，请求 headers/body 正确。
3. availability 测试证明 `agy` 存在时检测为 true，只有配置目录时为 false。
4. 浏览器 E2E 在 Antigravity-only fixture 下验证简约模式分别显示 Gemini 与 Claude/GPT 两类剩余百分比，顶部摘要和极客模式主数字使用两类四池的全局最紧值，极客模式显示四个额度池，不显示采集按钮和 API 等价金额。
5. 设置页在检测到 Antigravity 时显示“官方额度（自动读取）”和“无需选择”说明，不出现伪造的可选套餐。
6. 真实应用使用本机 `agy 1.1.20` 启动后，页面数值与同一时刻脱敏直连 RPC 的结果一致。
