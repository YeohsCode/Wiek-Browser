# 0.9.0 原生 UI 验收

2026-10-31（Asia/Shanghai）。最终 macOS ARM64 应用，隔离 `data/v090-native-ui`，自建项目、本地 Node app-server wire fixture 与合成 JSONL。0 真实模型调用、0 外部账号操作。

1. 在真实 Agents composer 粘贴 `[activity]` 并发送，任务完成。先前使用自动输入时方括号未进入输入框，普通文字轮次未触发 fixture；核对实际 prompt 后用粘贴纠正，不将那个普通轮次算作活动验收。
2. Native activity history → Turn 2，展开 Command 和子 Agent。原生 AX 显示 `Actual command output`、`[exit 0]`、1.5 seconds reported；子生命周期 completed，消息 Child-only final result。未观察完成的 nested command 为 unresolved。[活动截图](v090-native-activity.png)。独立 wire/服务读取确认子消息未进入 root stdout。
3. 点击 Import Codex history，经 macOS 文件选择器 Go to Folder 选定自建 `v090-selected-replayed.jsonl`，没有扫描个人会话目录。系统输入框的剪贴板读取第一次超时，改用原生 setValue 完成选定。
4. 预览显示 2 messages，1 compaction、1 rollback marker；只含 Effective retained question / Retained summary answer，不含 Superseded question / Rolled back question。未来 provider 明确选 Local Codex wire fixture。[预览截图](v090-native-replay-preview.png)。
5. Save 后 idle；独立 API 读取确认 0 runs、无 nativeThreadId。随后在 composer 发送 Continue effective history，实际新建 owned session 并完成。wire 输入包含保留的问题和摘要，两个删除片段不在输入中，源文件 SHA-256 不变。[续接截图](v090-native-replay-continuation.png)、[机器核对](v090-native-ui-check.json)。
6. QA host 停止后，人工脚本等待原 PID 实际消失，再启动正常资料目录应用；实际版本见 [status](v090-normal-app-status.json)。CLI 本身的退出等待仍是下一项工作。

原生 UI 验证使用合成协议，不代表真实模型推理、付费服务或外部账号行为通过。原生审批时序由 wire 专项和现有 panel disabled 状态测试覆盖，本次没有把它描述为手动 UI 点选证明。
