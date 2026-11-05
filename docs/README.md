# 文档索引

当前开发检查点 **Wiek Browser 0.21.0**（原 Vek Browser）。已更新橙白标识、linked worktree checkpoint、中英/中西翻译和完整V2框架adapter；当前包本地验收通过，新增CI步骤待远端验证（上版CI已通过）；P3实机系统边界继续验收；P1 其他 Agent 集成继续暂缓，P2 剩余项与 P4 线上模型基准仍未完成。进度见 [PLAN.md](../PLAN.md)，分版本验收见 [RESULTS.md](../reports/RESULTS.md)。历史调查和报告保留其原有名称及版本证据。

| 用途 | 文档 |
|---|---|
| 启动、构建、模型恢复 | [English](../README.md)、[简体中文](../README.zh-CN.md) |
| 进度、下一阶段与验收标准 | [PLAN.md](../PLAN.md) |
| 当前测试结果与交付边界 | [RESULTS.md](../reports/RESULTS.md)、[结构化结果](../reports/delivery-summary.json) |
| Ego/Wiek 同集比较 | [comparison.md](../reports/comparison.md) |
| 产品功能与未完成项 | [feature-parity.md](../analysis/feature-parity.md)；0.3 条目覆盖对应 0.2 时点 |
| 现代HTTP MCP资源/通知流 | [mcp-modern-subscriptions.md](../analysis/mcp-modern-subscriptions.md) |
| 独立标识与可重复图标构建 | [wiek-brand-assets.md](../analysis/wiek-brand-assets.md) |
| 干净CI排查与最终通过证据 | [ci-clean-checkout.md](../analysis/ci-clean-checkout.md) |
| P4 V2共享控制与Stage A剩余设计 | [benchmark-sdk-v2-design.md](../analysis/benchmark-sdk-v2-design.md) |
| 共享SDK修改与回归边界 | [sdk-changes.md](../analysis/sdk-changes.md) |
| 本地 API | [API.md](../skills/wiek-browser/API.md) |
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
| 桌面选区/录制真实验收 | [p3-desktop-acceptance.md](../analysis/p3-desktop-acceptance.md) |
| 改名与兼容范围 | [wiek-rebrand.md](../analysis/wiek-rebrand.md) |
| OS单次采集与全局快捷键 | [desktop-tools.md](../analysis/desktop-tools.md) |
| 资料 archive | [profile-archive-design.md](../analysis/profile-archive-design.md)、[web storage v2](../analysis/profile-web-storage.md) |
| 语音构建与模型来源 | [whisper-static-build.md](../reports/whisper-static-build.md)、[MODEL-NOTICE.md](../models/MODEL-NOTICE.md) |
| 许可 | [LICENSE](../LICENSE)、[NOTICE.md](../NOTICE.md) |

`references/`、`downloads/`、完整 `analysis/evidence/` 和解包资源主要留在本次本地调查工作区，未随 Git 提交；引用这些路径的历史文档会说明证据身份，不能将它们描述为普通 checkout 已包含的文件。模型权重与最终 `.app` 也单独恢复/构建。
