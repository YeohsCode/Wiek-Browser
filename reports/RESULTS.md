# Vek Browser 0.3.0 当前结果

计划更新：2026-10-31。[PLAN.md](../PLAN.md) 记录当前检查点和下一阶段验收；[文档索引](../docs/README.md) 区分当前结果与历史设计。下列测试数字来自已完成的 0.3.0 验证，本次文档整理没有重新执行它们。

已继续复刻并构建 macOS ARM64 应用：`dist/mac-arm64/Vek Browser.app`。本轮新增远程 MCP、本地 Git 检查点、IANA 时区/DST 调度、细分网站权限、下载暂停/继续和原生网页右键菜单，并修复书签/历史/下载及资料迁移的 Profile 归属。当前已打开正常用户版 0.3.0；测试 profile 与用户版数据隔离。

| 验证 | 完成结果与证据 |
|---|---|
| 同源完整浏览器 SDK E2E | **Vek 69/69，1248断言；Ego 68/69，1235断言**；两侧0跳过/0未运行；SDK/fixture/cases哈希一致，[完整对比](comparison.md)、[本轮日志](v030-package-sdk.log) |
| 本地服务/协议/CLI/解析/界面组件测试 | **145/145**，[本轮原始日志](v030-service-tests.log) |
| 打包版真实宿主集成 | **48/48**：provider→CLI→SDK→网页、实际Git恢复/保护checkpoint、MCP scope/接管/撤销、文件冲突、主题/布局、窗口/Space、真实PNG/Whisper/可信输入录制、Profile数据与权限、2MiB真实文件暂停/继续，[日志](v030-package-workbench.log) |
| SDK单元测试 | 532/532，沿用未变更SDK版本，[日志](sdk-unit-tests.log)；本轮源码和bundle身份再次核对 |
| 上游测试/fixture完整性 | **81个文件逐字节未改**，[身份清单](upstream-test-integrity.json) |
| 打包内容 | **141个文件身份匹配**（app/CLI/SDK/skills/model/NOTICE）；无downloads/references/analysis/reports/data/tests/tools；可重现 `node tools/verify-release.mjs` |
| 原生界面 | 实际右键菜单→新标签→真实页面、权限原生模态框→阻止结果→保存规则与Agent移交、相机/麦克风分离；[QA记录](v030-native-ui-qa.md) |
| 官方31项线上模型benchmark | **未运行**：缺独立模型认证与必要站点登录；不计为通过，也不冒充Ego服务跳过 |

## 本轮具体变化

- Git checkpoint 保存真实 staged index、unstaged 和 untracked 内容；预览并明确确认恢复；自动保留恢复前的保护快照。原生面板和真实临时仓库验证通过。[协议与限制](../analysis/git-checkpoints.md)
- 远程 MCP 使用显式 HTTPS 和环境凭据引用，支持 legacy session/JSON/SSE/断线恢复/取消，也提供显式选择的现代工具协议模式；没有静默重放工具 POST。[协议与限制](../analysis/mcp-http-design.md)
- Cron 持久化 IANA 时区，跳过 DST 缺失分钟、重复分钟只执行首次；spawn 前持久预约，防重启重复。应用关闭后不调度；预约后、spawn 前崩溃可丢失一次执行。[时钟与恢复策略](../analysis/scheduler-timezone.md)
- 网站权限按 Profile/顶层来源/请求来源/能力隔离，相机和麦克风独立。修复过期弹窗复用 key、ask/reset、opaque origin 和 RPC Space 归属的实际竞态，并增加回归。[权限设计](../analysis/site-permissions.md)
- 书签/历史/下载及资料导入导出按当前 Profile 归属；下载支持 live native item 暂停/继续；新增实际页面原生右键菜单。[浏览器改动与失败尝试](../analysis/browser-shell-v030.md)

## 仍未完成的部分

**这仍不是整款 Ego 的全量功能复刻。** 其他七种 provider 原生协议、完整 Chrome/Safari 会话/web storage/扩展迁移、定制 Chromium 等价、自动 Agent turn checkpoint/远程 PR、MCP OAuth/MRTR/订阅、OS 跨应用选择/截图/录制及翻译、退出后的 OS 调度、完整 memory index、Ego 专有服务，以及31项线上基准仍有缺口。[逐项差距清单](../analysis/feature-parity.md)

Git checkpoint 当前仅适用于同HEAD的普通小仓库（2MiB/文件、32MiB总内容），不支持linked worktree/子模块等。MCP现代模式是工具调用子集。离线Whisper等0.2能力继续保留；模型真实付费生成没有测试，provider流式和审批仍以本地协议fixture验证。

Vek实测Electron42.11.18 / Chromium148.0.7778.280 / Node24.19.0；参考Ego为Chromium156.0.8078.48。69-case兼容不代表全部Web平台或定制Chromium行为等价。REA保留daemon/client两个有界Evidence；本轮复用已有功能证据，不把未分析代码说成完整覆盖。

源码 `npm start`；打包版打开上述`.app`；`node cli/vek-browser.mjs api help`查看接口。未发布或部署。[可机读结果](delivery-summary.json) · [原生权限界面](v030-native-site-permissions.png) · [上一版结果](v020/RESULTS.md)
