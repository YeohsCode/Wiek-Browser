# Codex 历史编辑与实时活动（0.9.0）

日期：2026-10-31，Asia/Shanghai。独立实现于 `app/codex-history.cjs`、`codex-events.cjs`、`codex-session.cjs`；没有复制 Ego 闭源代码。此项支持有界可见上下文与显示证据，完整产品 parity 仍未完成。

## 依据与可复现证据

当前 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 与本机 CLI 版本有差异：文档使用较新的 thread/revert、collabToolCall，本机 Codex CLI **0.142.0** schema 仍有 thread/rollback、collabAgentToolCall。本实现兼容两种活动名称；所选 JSONL 回滚以匹配本机版本的 thread_rolled_back 为依据，未知 revert/edit 布局明确拒绝。

本机官方 CLI SHA-256：`b60ad82e66720a84830460b77e00b207536c38e536f64fb5a6af86bcae3a3bff`。生成 schema 位于忽略目录 `references/codex/v0.142.0/`。匹配的 Apache-2.0 官方开源 tag `rust-v0.142.0`，commit `3a76f3ac68c8949d1cac6ea769b6ec7b8953a415`，下载到 `references/codex/source-0.142.0/`；此目录不进入 Vek 发行包或 Git。

源码依据为 protocol/src/protocol.rs 的 CompactedItem / ThreadRolledBackEvent，core/src/session/rollout_reconstruction.rs、context_manager/history.rs 的回放/回滚，以及 core/src/compact.rs 的旧版压缩。只据此确定记录格式和语义，独立实现 JavaScript，不将隐藏原生设置、window 或 token 截断状态冒充为已迁移。

`node tools/probe-codex-history.mjs` 在临时 HOME/CODEX_HOME/project 中启动官方 CLI，创建自有 thread，inject 合成 raw response items，调用 rollback/read，再在自有文件中验证两种合成 compacted 记录的 decoder 接受情况。**0 turn/start、0 compact/start、0 模型调用，无继承认证**。[报告](../reports/v090-history-oracle.json)保留限制：inject 不产生 display turns，thread/read 的空 items **不能**证明回放内容完全等价。实际生成的 rollback marker、源码语义、合成 decoder 接受和 Vek fixture 断言分别记录，不混为模型运行证明。

## 历史有效上下文

- 有 replacement_history 的 compacted 替换之前的有效 response items，再接后续 tail；已替换的消息和工具证据不会进入预览或续接。
- 旧版 compacted 保留非生成上下文的用户问题，移除先前合成摘要，追加 user-role 摘要。保守限制用户 tail JSON 为 80000 bytes；超限明确拒绝，**不模拟原生 20000-token tail 截断**。识别常见官方摘要前缀；未知旧版模板不保证兼容。
- thread_rolled_back 按实际用户/结构化 inter-agent 指令边界移除尾部；TurnContext/task bookkeeping 不算用户 turn。0 为 no-op；超出 turn 数时保留首个边界之前的 prelude。被移除 item 的 ID 不阻止后续合法重用。
- inter-agent 不透明指令只计边界，不复制到可见文本。AGENTS、environment、skills、shell/aborted/subagent/internal/hook 等已知上下文包装排除；不保证识别未来全部包装。
- 加密 compaction 在没有后续明文 replacement 清除时拒绝。未知 history-edit/event/record 不猜测。
- 既有 32 MiB / 20000行 / 4 MiB帧 / 1 MiB每条 / 8 MiB总文本、严格 UTF-8/JSON、NOFOLLOW/fd/hash/inode/预览 token 约束保留。历史工具仅显示，不执行、不读取其中路径。
- UI 显示应用过的压缩/回滚数量；archive 保留经校验的数值来源，无 native session、源指令或文件恢复权限。继续时创建新 owned session，输入最终有效可见文本。

## 实时原生事件

NDJSON transport 独立到 codex-session.cjs；turn/start 待回复期间最多缓冲 512 个事件/4 MiB，得到实际 native turn ID 后再处理。加载期 resume 重放排除，外来 thread/turn、冲突完成、未知终态仍失败。

commandExecution 展示输入、流式输出、最终 aggregatedOutput/exit code/耗时；最终结果不被晚到 delta 覆盖。fileChange 仅显示 provider 给出的 path/diff；MCP/dynamic 工具记录实际文字结果和失败，不解码图片或跟随路径。contextCompaction/webSearch 有明确显示，未知工具终态保持 unresolved。

父 Agent 的 collaboration receiver/agentsStates 或 subAgentActivity 首先宣布子身份，再接其独立 turn 和消息。spawn 工具完成不等于子生命周期完成；需要实际 agentsStates 终态。旧子 turn 事件不覆盖新 turn，子消息不进入主回答。已知但超限的子身份仍记作 omitted，避免内容落到主回答或误判外来事件。

显示上限为 200 工具、100 子 Agent、合计 200 子消息、256 KiB 共享文字；超限有可见标记。停止/失败只将未完成活动标作 interrupted；正常 turn 完成而缺少终态则 unresolved，不捏造成功。

子 command/file-change requestApproval 只在已宣布且活动的同一子 turn 上接受；仅一次 accept/decline/cancel，遵守 availableDecisions。UI 旧请求在子 turn 改变或 serverRequest/resolved 后不能发送过时批准。不会从活动 ID 获得读取其他会话、自动订阅或后台守护权限。

## 验证与剩余范围

本轮新增 21 项回归：8 个 event collector、7 个新增 wire/approval、6 个历史回放/来源测试，现有 panel 断言继续运行。完整本地和打包宿主结果以 [RESULTS](../reports/RESULTS.md) 为准。fixture 只运行合成本地协议进程，不调用真实模型或真实网站账号。

仍缺源 Codex 会话原生迁移、原生 fork、跨文件子历史重建、后台子任务守护、隐藏上下文/窗口/token 等价、Claude 模型目录及其他五种 native provider。CLI 关闭等待、MCP/OS/完整迁移和 31 项线上 benchmark 按 PLAN 继续推进。
