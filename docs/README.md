# 文档索引

当前版本 **0.19.0**；优先P2/P3，其余Agent集成暂缓。已完成有界Profile归档与P3显式Desktop tools；已补三种执行模式与显式closed-app tick；已补审核式macOS login job/前台接管；已补现代HTTP资源与显式订阅；已补有界工具表单MRTR审阅/取消；已补显式CIMD/客户端身份审核；下一项P3 busy延期/completion，P2明确来源迁移/MCP剩余项仍保留。最新进度只认 [PLAN.md](../PLAN.md)，当前验收只认 [RESULTS.md](../reports/RESULTS.md)。历史调查/设计反映其记录时点，不自动代表当前功能缺失或已通过。

| 用途 | 文档 |
|---|---|
| 启动、构建、模型恢复 | [项目 README](../README.md) |
| 进度、下一阶段与验收标准 | [PLAN.md](../PLAN.md) |
| 当前测试结果与交付边界 | [RESULTS.md](../reports/RESULTS.md)、[结构化结果](../reports/delivery-summary.json) |
| Ego/Vek 同集比较 | [comparison.md](../reports/comparison.md) |
| 产品功能与未完成项 | [feature-parity.md](../analysis/feature-parity.md)；0.3 条目覆盖对应 0.2 时点 |
| 现代HTTP MCP资源/通知流 | [mcp-modern-subscriptions.md](../analysis/mcp-modern-subscriptions.md) |
| 本地 API | [API.md](../skills/vek-browser/API.md) |
| REA 来源、证据与覆盖限制 | [rea-investigation.md](../analysis/rea-investigation.md)、[daemon](../analysis/shipped-daemon-features.md)、[client](../analysis/client-resource-feature-ledger.md) |
| Agent/Codex/附件 | [扩展设计](../analysis/agent-service-extensions.md)、[附件](../analysis/agent-attachments.md) |
| Claude 原生模型目录 | [claude-model-catalogue.md](../analysis/claude-model-catalogue.md) |
| Claude历史/工具结果/子Agent | [claude-history-design.md](../analysis/claude-history-design.md) |
| Codex目录与所选历史 | [codex-capabilities-history.md](../analysis/codex-capabilities-history.md) |
| CLI 停止与重启 | [cli-lifecycle.md](../analysis/cli-lifecycle.md) |
| Codex 历史编辑与实时活动 | [codex-replay-activity.md](../analysis/codex-replay-activity.md) |
| OpenCode ACP与模型目录 | [opencode-acp-design.md](../analysis/opencode-acp-design.md) |
| Claude原生协议 | [claude-native-design.md](../analysis/claude-native-design.md) |
| Agent turn 文件快照 | [turn-checkpoints-design.md](../analysis/turn-checkpoints-design.md) |
| Git checkpoint | [git-checkpoints.md](../analysis/git-checkpoints.md) |
| MCP客户端身份/CIMD | [mcp-client-identity.md](../analysis/mcp-client-identity.md) |
| MCP工具表单MRTR | [mcp-input-continuations.md](../analysis/mcp-input-continuations.md) |
| MCP公共客户端OAuth | [mcp-oauth-design.md](../analysis/mcp-oauth-design.md) |
| MCP资源订阅 / 本地memory索引 | [mcp-resources-memory.md](../analysis/mcp-resources-memory.md) |
| MCP | [stdio/gateway](../analysis/mcp-service-design.md)、[HTTP 与版本差异](../analysis/mcp-http-design.md) |
| macOS后台调度与前台接管 | [background-scheduling.md](../analysis/background-scheduling.md) |
| 自动化执行模式与单次worker | [automation-execution.md](../analysis/automation-execution.md) |
| 时区与调度恢复 | [scheduler-timezone.md](../analysis/scheduler-timezone.md) |
| 权限与 Profile 归属 | [site-permissions.md](../analysis/site-permissions.md)、[browser-shell-v030.md](../analysis/browser-shell-v030.md) |
| OS单次采集与全局快捷键 | [desktop-tools.md](../analysis/desktop-tools.md) |
| 资料 archive | [profile-archive-design.md](../analysis/profile-archive-design.md)、[web storage v2](../analysis/profile-web-storage.md) |
| 语音构建与模型来源 | [whisper-static-build.md](../reports/whisper-static-build.md)、[MODEL-NOTICE.md](../models/MODEL-NOTICE.md) |
| 许可 | [LICENSE](../LICENSE)、[NOTICE.md](../NOTICE.md) |

`references/`、`downloads/`、完整 `analysis/evidence/` 和解包资源主要留在本次本地调查工作区，未随 Git 提交；引用这些路径的历史文档会说明证据身份，不能将它们描述为普通 checkout 已包含的文件。模型权重与最终 `.app` 也单独恢复/构建。
