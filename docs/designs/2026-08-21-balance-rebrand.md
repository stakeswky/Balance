# 余量 / Balance 品牌迁移规格

日期：2026-08-21
状态：待执行
目标分支：`feat/balance-rebrand`

## 结论

把当前产品的对外品牌从 Synq 改为“余量 / Balance”，把 macOS 分发名称和 GitHub 仓库名改为 `Balance`，同时保留所有决定旧数据可见性的内部标识。仓库采用 GitHub 原地重命名，不创建第二个仓库，因此完整 commit 历史、分支、Actions 配置和私有可见性均保留。

## 对外命名合同

| 表面             | 新值                                              |
| ---------------- | ------------------------------------------------- |
| 中文品牌         | 余量                                              |
| 英文品牌         | Balance                                           |
| README 标题      | `余量 / Balance`                                  |
| Web/PWA 应用名   | `Balance`                                         |
| 页面标题         | `余量 / Balance — Claude × Grok × Codex 额度监控` |
| Dashboard 顶栏   | `余量`                                            |
| 首次设置         | `余量初始设置`                                    |
| macOS 窗口标题   | `Balance`                                         |
| macOS 应用       | `Balance.app`                                     |
| macOS DMG        | `Balance_0.1.0_aarch64.dmg`                       |
| GitHub artifact  | `Balance-macos-arm64`                             |
| npm package slug | `balance`                                         |
| GitHub 仓库      | `stakeswky/Balance`                               |
| Git 作者         | `Jiamin <stakeswky@gmail.com>`                    |

## 数据连续性合同

下列值是兼容协议，不随品牌变化：

- Tauri identifier：`com.synq.desktop`。
- Web 持久化 key：`synq-quota-v8`；旧 key 清理仍为 `synq-quota-v7`。
- Desktop origin：`http://127.0.0.1:4780`。
- 健康响应：`{"app":"synq","mode":"desktop"}`。
- 官方快照：`~/Library/Application Support/Synq/official-quota.json`。
- Rust crate、主程序与 sidecar：`synq-desktop`、`synq_desktop_lib`、`synq-node`。
- Desktop 资源目录与环境变量：`synq-server`、`SYNQ_DESKTOP`、`SYNQ_PARENT_PID`。
- 数据库表、价格版本和导出兼容名：`synq_settings`、`2026-08-20-synq-3`、`synq-week.*`。

保持 bundle identifier、origin 和 localStorage key，可让升级后的 `Balance.app` 继续使用旧 WebKit profile 中的设置。保持官方快照路径，可继续使用最后一次成功的供应商配额数据。Claude、Grok 与 Codex 的外部日志和认证路径不变。

## 范围

### 包含

- Web 标题、页头、首次设置、设置说明、PWA localhost/IP fallback 名称和 README 品牌文案。
- `package.json` 与 lockfile package 名。
- Tauri `productName`、窗口标题、启动失败页和 capability 描述。
- `.app`、DMG、workflow artifact、验证脚本默认路径和 native UI 断言。
- Onboarding E2E、workflow test、品牌合同测试和兼容合同测试。
- 在真实安装版 `Balance.app` 上验证旧设置/快照路径、官方额度、窗口、sidecar 和退出清理。
- 刷新 README 引用的桌面与手机截图。
- 将 feature branch 以 `--no-ff` 合入 `main`，推送后原地重命名 GitHub 仓库并更新 `origin`。

### 不包含

- 修改 `com.synq.desktop` 或迁移 WebKit profile。
- 修改 localStorage key、固定端口、健康协议或官方快照目录。
- 重命名 Rust crate、可执行文件、sidecar、源码目录或历史文档。
- 新建第二个 GitHub 仓库。
- 改变仓库可见性；仓库继续保持 PRIVATE。
- 创建 GitHub Release、tag、PR 或手动触发 Actions。
- 修改本地主工作区中已有的未提交文档和截图。

## 安装迁移

1. 记录当前 `/Applications/Synq.app` 的 bundle identifier、官方快照和兼容存储目录证据。
2. 构建并验证 `Balance.app` 和 DMG。
3. 把新应用复制到 `/Applications/Balance.app`，不覆盖运行中的应用。
4. 启动新应用，通过真实 WebKit UI 回读旧套餐、阈值、加成和 onboarding 状态；同时验证 identifier 仍为 `com.synq.desktop`、健康响应精确、窗口标题为 `Balance`、官方快照路径仍可用。
5. 完成 native UI、环境隔离、正常退出、崩溃清理和端口占用失败路径。
6. 全部通过后，把旧 `/Applications/Synq.app` 移到废纸篓，保留可恢复性。

## GitHub 原地迁移

1. 在旧仓库名下推送已经验证的 `main`。
2. 记录所有远端 branch SHA、workflow 状态、tag/release 数量和 PRIVATE 可见性。
3. 把 `stakeswky/synq` 原地重命名为 `stakeswky/Balance`。
4. 更新本地 fetch/push origin 为 `https://github.com/stakeswky/Balance`。
5. 核对 branch SHA、历史、作者、workflow、tag/release 数量和可见性与迁移前一致。

## 验收标准

1. 新增品牌合同测试先红后绿，且全量 JavaScript/TypeScript/Rust 测试通过。
2. Web 开发版和生产构建显示“余量 / Balance”，桌面/手机均无横向溢出或浏览器错误。
3. `Balance.app` 和内置 Node 都是 arm64，ad-hoc codesign 与 DMG 校验通过。
4. 原生窗口标题为 `Balance`，主 UI 与 startup-error UI 都能真实渲染。
5. `CFBundleIdentifier` 仍为 `com.synq.desktop`；固定 origin、持久化 key、快照路径和健康响应均未改变，安装前后的非敏感设置子集逐字节一致。
6. 安装版能读取本机 Agent、显示官方额度，退出后无 sidecar 或 4780 监听残留。
7. README 两张公开截图更新为新品牌，且不包含本机路径、账号或真实任务信息。
8. 新提交作者和提交者均为 `Jiamin <stakeswky@gmail.com>`。
9. GitHub 远端最终为 `stakeswky/Balance`，本地与远端 `main` 同步，仓库仍为 PRIVATE。
