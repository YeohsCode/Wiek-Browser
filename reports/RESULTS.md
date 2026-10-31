# Vek Browser 0.4.0 当前结果

本轮补齐 Agent turn 与 Git 文件快照的关联：项目显式启用后，每轮在真实 provider 执行前后保存状态，展示工作文件和暂存区差异，并通过预览、准确快照名确认和保护快照恢复文件。源码、macOS ARM64 包和原生界面均已验证。

| 验证 | 完成结果与证据 |
|---|---|
| 同源完整 SDK E2E | **Vek 69/69，1248断言；Ego 68/69，1235断言**，两侧0跳过/0未运行；SDK/fixture/cases哈希相同，[对比](comparison.md)、[本轮日志](v040-package-sdk.log) |
| 本地全套 | **156/156**，含原有组件和11项新增真实turn快照测试，[日志](v040-service-tests.log) |
| 最终打包宿主集成 | **53/53**，在既有真实browser/MCP/files/voice/permissions验证上增加项目启用、实际provider文件修改、before/after关联、immutable diff、真正恢复和保护快照，[日志](v040-package-workbench.log) |
| turn快照专项 | **11/11**：真实Git/index/untracked/保护恢复、失败/停止/关闭、超限、并发/lease、导入/fork、HEAD改变、准备期取消、原生turn IDs/去重及实际宿主SIGKILL恢复，[日志](v040-turn-checkpoints.log) |
| 原生UI | 实际本地provider→文件/index diff→错误名称禁止恢复→准确名称确认→磁盘/index恢复，[QA](v040-native-ui-qa.md)、[磁盘核对](v040-native-restore-file-check.json) |
| 打包/上游身份 | **142个文件匹配**，81个上游测试/fixture未改，SDK bundle与两侧测试一致；`node tools/verify-release.mjs`可重现 |
| 保留的验证 | 未变更SDK版本532/532单测、CDP22/22；未冒充本轮重跑 |
| 官方31任务线上模型benchmark | **未运行**，缺本任务专用模型认证与必要站点登录；不计为通过或Ego服务跳过 |

## 行为与范围

- 默认关闭自动快照，按项目显式开启。before捕获失败不启动provider；after捕获失败保留实际provider结果并标partial。
- 受保护的同一项目任务不重叠；恢复占用lease，阻止新run；退出应用时先停止provider并完成捕获，再关闭工作区服务。
- 原生thread/turn IDs关联到本地run。崩溃后只恢复已知before/after引用，不把当前文件猜成结束快照。导入和fork不能获得其他会话的文件恢复权限。
- 工作文件与staged index差异独立显示；会话span只从最早已知before到最新已知after，可包含间隔中的其他项目修改，不代表仅由该Agent造成的变化。
- 文件恢复与对话rollback保持各自的实际语义，恢复前自动保存保护checkpoint。已有同HEAD/普通小仓库限制保持不变。

[完整设计与边界](../analysis/turn-checkpoints-design.md) · [计划进度](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [文档索引](../docs/README.md)

## 剩余工作

**全量功能复刻仍未完成。** 下一步优先原生provider协议与会话完整性（Claude优先）；仍有linked worktree/快照保留策略/远程PR、完整Chrome/Safari/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS跨应用能力与翻译、退出后调度、memory index、Ego专有服务与线上benchmark。

自动快照目前仍要求普通.git仓库、已有HEAD、2MiB/文件、32MiB内容、2000路径、1000 checkpoint refs；不支持linked worktree/子模块/分裂或稀疏index等。外部编辑器和provider Git提交可改变状态；HEAD改变时保留diff但拒绝还原旧HEAD。具体限制见设计，不能称为任意项目完整快照。

包路径：`dist/mac-arm64/Vek Browser.app`。正常用户版与所有测试数据隔离，已重新打开0.4.0。未做付费模型/个人账号操作、远程发布或部署；实际引擎仍为Electron42.11.18 / Chromium148.0.7778.280，不能据69项测试声称等价Ego Chromium156。

[工作文件与index差异界面](v040-native-turn-diff.png) · [恢复成功界面](v040-native-restore-success.png) · [机器可读结果](delivery-summary.json)
