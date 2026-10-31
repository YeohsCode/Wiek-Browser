# Vek Browser 0.9.0 当前结果

本轮完成 Codex 压缩/回滚后的有效可见历史导入，以及原生实时工具、子 Agent 活动和子 turn 单次审批。**全量 Ego 复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| SDK E2E | **Vek 69/69、1248 断言**；同输入哈希的保留 Ego 基准 **68/69、1235 断言**。两侧 0 跳过、0 未运行。[对比](comparison.md)、[本轮日志](v090-package-sdk.log) |
| 本地全套 | **244/244**，新增 21 项 events / wire / replay 回归；现有 Electron panel 进一步核对 replay 计数。[日志](v090-service-tests.log) |
| Codex 集中专项 | **47/47**，包括现有 native 与实际 Electron panel。[日志](v090-codex-tests.log) |
| 打包宿主 | **99/99**，新增 command/patch/MCP、子活动隔离、压缩/回滚预览→惰性导入→有效文本续接→源文件不变。[日志](v090-package-workbench.log) |
| 官方 Codex CLI | **0.142.0**，净化 HOME/CODEX_HOME、无继承认证。实际生成 rollback marker，接受自有合成 replacement / legacy compacted 记录。**0 turn/start、0 模型调用**。空 display turns 不证明回放语义等价。[报告](v090-history-oracle.json)、[匹配源码身份](v090-codex-source-identities.json) |
| 原生 UI | 实际工具输出/退出码/耗时、子消息和 unresolved 展示；系统文件选择器→有效历史预览→idle 0 runs→新会话续接。[QA](v090-native-ui-qa.md)、[独立核对](v090-native-ui-check.json) |
| 打包/上游身份 | **150 文件匹配**，81 上游测试/fixture 未改，SDK bundle 与两侧比较一致。[校验](v090-package-verification.log) |
| 保留验证 | SDK 532/532 单测、CDP 22/22、Claude 2.1.31 / OpenCode 1.19.5 / Codex 目录无推理 readiness、既有文件恢复 UI。本轮没有重新运行这些历史记录；Ego 基准为 2026-10-30 同 hash 完整记录 |
| 官方 31 线上模型任务 | **未运行**；缺任务专用模型配置与必要站点测试登录，不计通过或 Ego 服务跳过 |

压缩 replacement_history 替换旧上下文；旧版压缩保留受限用户问题并加入摘要。回滚按实际指令边界移除尾部，TurnContext/task bookkeeping 不计 turn。只复制最终保留的可见文本和惰性工具证据，剔除已删除/替换内容。旧版 tail 超过 Vek 的 80000-byte 保守限制、无明文替代的加密压缩、未知编辑布局仍明确拒绝；不声称原生 token 截断、隐藏指令/window 或源会话迁移等价。

实时 command/diff/MCP/dynamic 工具显示实际输出和终态，最终 command 结果不被晚到 delta 覆盖。父事件宣布子身份后独立记录其 turn/messages；spawn 完成不等于子生命周期完成，缺终态仍 unresolved。共享显示上限 200 工具/100 子 Agent/200 子消息/256 KiB 文字，省略可见。子审批仅接受活动且匹配的 turn，单次 accept/decline/cancel；旧 turn 和 resolved 请求不能发送过时批准。

导入继续沿用 NOFOLLOW/fd、32 MiB 文件、20000 行、4 MiB 帧、1 MiB 每条/8 MiB 总文字、完整 UTF-8/JSON、预览 token 和 inode/hash 复核；0 runs/无 native ID，随后 prompt 才建新 owned session。源 ID、配置、路径或 archive 显示记录不授予执行和文件恢复权限。Codex 目录、默认模型、fresh capability 校验及既有 turn checkpoint 回归仍通过。

本轮完整 SDK 回归后只更新打包 API 文档，重新打包并核对全部源码身份；运行时代码保持与通过的测试一致。新增 panel replay 计数断言通过集中专项。没有重复计数 SDK 或模型运行。

下一项补 CLI stop 的实际退出等待及同目录立即 start 回归，然后推进 Claude 模型目录和剩余五种原生 provider（Cursor/Devin/Antigravity/Grok/Droid）。仍缺源原生迁移/后台任务、自动 MCP 注入、linked worktree/远程 PR、完整资料/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS 跨应用/翻译、退出后调度、memory index 和线上 benchmark。

最终应用 `dist/mac-arm64/Vek Browser.app`；正常资料目录版本见 [status](v090-normal-app-status.json)，没有远程发布。Electron 42.11.18 / Chromium 148.0.7778.280 不等价 Ego Chromium 156 的完整引擎能力。

[设计与限制](../analysis/codex-replay-activity.md) · [计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
