# Vek Browser 0.10.0 当前结果

更新：2026-11-01（Asia/Shanghai）。本轮完成 Claude 原生模型目录、声明能力、显式 effort 控制与执行前刷新；0.9 历史/活动与0.9.1关闭契约保留。**全量 Ego 复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| SDK E2E | **Vek 69/69、1248 断言**；同输入哈希的保留 Ego 基准 **68/69、1235 断言**。两侧 0 跳过、0 未运行。[对比](comparison.md)、[本轮日志](v100-package-sdk.log) |
| 本地全套 | **264/264**，本轮新增16项Claude目录/控制测试，原生panel补canonical ID保留和unknown检查。[日志](v100-service-tests.log) |
| Claude 集中专项 | **45/45**，包括新目录、既有native/history/events与实际Electron panel。[日志](v100-claude-tests.log) |
| 打包宿主 | **109/109**，新增目录0执行→alias/canonical选择→fresh initialize→effort确认→输入→owned resume/default清空；既有diff/restore保留。[日志](v100-package-workbench.log) |
| CLI生命周期（源码当前/打包保留0.9.1） | **4/4 源码测试 + 4/4 打包测试**；真实 Electron/provider/Git 快照收尾、同目录三次立即重启、超时不强杀、身份不符和参数拒绝。[打包日志](v091-package-lifecycle-tests.log)、[设计](../analysis/cli-lifecycle.md) |
| 官方 Claude CLI | **2.1.31**，净化HOME/CLAUDE_CONFIG_DIR，只initialize后关闭；3项模型，effort字段未返回，**0 user/0模型调用**。新effort协议由官方SDK类型和peer分层验证，不声称旧CLI已支持。[报告](v100-claude-model-readiness.json)、[协议身份](v100-claude-protocol-identities.json) |
| 保留官方 Codex CLI | **0.142.0**，净化 HOME/CODEX_HOME、无继承认证。实际生成 rollback marker，接受自有合成 replacement / legacy compacted 记录。**0 turn/start、0 模型调用**。空 display turns 不证明回放语义等价。[报告](v090-history-oracle.json)、[匹配源码身份](v090-codex-source-identities.json) |
| 本轮原生 UI | 真实Model发现0run/0user→显示已声明low/high和旧版unknown→保存high→完成本地wire；effort确认先于唯一user。[QA](v100-native-ui-qa.md)、[核对](v100-native-ui-check.json) |
| 保留 0.9 原生 UI | 实际工具输出/退出码/耗时、子消息和 unresolved 展示；系统文件选择器→有效历史预览→idle 0 runs→新会话续接。[QA](v090-native-ui-qa.md)、[独立核对](v090-native-ui-check.json) |
| 打包/上游身份 | **152 文件匹配**，81 上游测试/fixture 未改，SDK bundle 与两侧比较一致。[校验](v100-package-verification.log) |
| 保留验证 | SDK 532/532 单测、CDP 22/22、Claude 2.1.31 / OpenCode 1.19.5 / Codex 目录无推理 readiness、既有文件恢复 UI。本轮没有重新运行这些历史记录；Ego 基准为 2026-10-30 同 hash 完整记录 |
| 官方 31 线上模型任务 | **未运行**；缺任务专用模型配置与必要站点测试登录，不计通过或 Ego 服务跳过 |

Claude目录最多256项，读取实际value/resolvedModel与明确能力，字段缺失保持unknown。执行前刷新后校验，失效模型/effort不发送user；显式effort经apply_flag_settings确认，失败不降级。清空model向新的resume进程明确传default；清空effort不再发送Vek overlay，不声称隐藏配置或组织限额被重置。目录可能bundled/cached，不证明账号权益、当前价格或有效模型预算。详情见[设计](../analysis/claude-model-catalogue.md)。

压缩 replacement_history 替换旧上下文；旧版压缩保留受限用户问题并加入摘要。回滚按实际指令边界移除尾部，TurnContext/task bookkeeping 不计 turn。只复制最终保留的可见文本和惰性工具证据，剔除已删除/替换内容。旧版 tail 超过 Vek 的 80000-byte 保守限制、无明文替代的加密压缩、未知编辑布局仍明确拒绝；不声称原生 token 截断、隐藏指令/window 或源会话迁移等价。

实时 command/diff/MCP/dynamic 工具显示实际输出和终态，最终 command 结果不被晚到 delta 覆盖。父事件宣布子身份后独立记录其 turn/messages；spawn 完成不等于子生命周期完成，缺终态仍 unresolved。共享显示上限 200 工具/100 子 Agent/200 子消息/256 KiB 文字，省略可见。子审批仅接受活动且匹配的 turn，单次 accept/decline/cancel；旧 turn 和 resolved 请求不能发送过时批准。

导入继续沿用 NOFOLLOW/fd、32 MiB 文件、20000 行、4 MiB 帧、1 MiB 每条/8 MiB 总文字、完整 UTF-8/JSON、预览 token 和 inode/hash 复核；0 runs/无 native ID，随后 prompt 才建新 owned session。源 ID、配置、路径或 archive 显示记录不授予执行和文件恢复权限。Codex 目录、默认模型、fresh capability 校验及既有 turn checkpoint 回归仍通过。

本轮完整本地264项、打包109项、原生菜单和完整69项SDK已验证；最终152文件核对一致。CLI生命周期保留0.9.1打包专项，本轮完整本地仍覆盖这4项；未把历史专项或模型调用重复计数。

CLI stop 成功已意味着原 PID 实际退出，包含 provider 终止/快照收尾；默认 30s，超时明确失败且不强杀。此契约不覆盖多个独立 CLI 同时 start。下一项推进剩余五种原生 provider，优先Cursor公开ACP及扩展交互（Cursor/Devin/Antigravity/Grok/Droid）。仍缺源原生迁移/后台任务、自动 MCP 注入、linked worktree/远程 PR、完整资料/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS 跨应用/翻译、退出后调度、memory index 和线上 benchmark。

最终应用 `dist/mac-arm64/Vek Browser.app`；正常资料目录版本见 [status](v100-normal-app-status.json)，没有远程发布。Electron 42.11.18 / Chromium 148.0.7778.280 不等价 Ego Chromium 156 的完整引擎能力。

[设计与限制](../analysis/codex-replay-activity.md) · [计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
