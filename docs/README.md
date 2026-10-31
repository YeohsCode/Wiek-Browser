# 文档索引

当前版本 **0.6.0**；下一项为OpenCode原生会话和模型能力目录。最新进度只认 [PLAN.md](../PLAN.md)，当前验收只认 [RESULTS.md](../reports/RESULTS.md)。历史调查/设计反映其记录时点，不自动代表当前功能缺失或已通过。

| 用途 | 文档 |
|---|---|
| 启动、构建、模型恢复 | [项目 README](../README.md) |
| 进度、下一阶段与验收标准 | [PLAN.md](../PLAN.md) |
| 当前测试结果与交付边界 | [RESULTS.md](../reports/RESULTS.md)、[结构化结果](../reports/delivery-summary.json) |
| Ego/Vek 同集比较 | [comparison.md](../reports/comparison.md) |
| 产品功能与未完成项 | [feature-parity.md](../analysis/feature-parity.md)；0.3 条目覆盖对应 0.2 时点 |
| 本地 API | [API.md](../skills/vek-browser/API.md) |
| REA 来源、证据与覆盖限制 | [rea-investigation.md](../analysis/rea-investigation.md)、[daemon](../analysis/shipped-daemon-features.md)、[client](../analysis/client-resource-feature-ledger.md) |
| Agent/Codex/附件 | [扩展设计](../analysis/agent-service-extensions.md)、[附件](../analysis/agent-attachments.md) |
| Claude历史/工具结果/子Agent | [claude-history-design.md](../analysis/claude-history-design.md) |
| Claude原生协议 | [claude-native-design.md](../analysis/claude-native-design.md) |
| Agent turn 文件快照 | [turn-checkpoints-design.md](../analysis/turn-checkpoints-design.md) |
| Git checkpoint | [git-checkpoints.md](../analysis/git-checkpoints.md) |
| MCP | [stdio/gateway](../analysis/mcp-service-design.md)、[HTTP 与版本差异](../analysis/mcp-http-design.md) |
| 时区与调度恢复 | [scheduler-timezone.md](../analysis/scheduler-timezone.md) |
| 权限与 Profile 归属 | [site-permissions.md](../analysis/site-permissions.md)、[browser-shell-v030.md](../analysis/browser-shell-v030.md) |
| 资料 archive | [profile-archive-design.md](../analysis/profile-archive-design.md) |
| 语音构建与模型来源 | [whisper-static-build.md](../reports/whisper-static-build.md)、[MODEL-NOTICE.md](../models/MODEL-NOTICE.md) |
| 许可 | [LICENSE](../LICENSE)、[NOTICE.md](../NOTICE.md) |

`references/`、`downloads/`、完整 `analysis/evidence/` 和解包资源主要留在本次本地调查工作区，未随 Git 提交；引用这些路径的历史文档会说明证据身份，不能将它们描述为普通 checkout 已包含的文件。模型权重与最终 `.app` 也单独恢复/构建。
