# Claude 原生会话 / Vek 0.5.0

## 功能来源与实现来源

Ego 0.6.1.13 发货 daemon 已有 Claude adapter 消费 Claude Agent SDK 的静态连接证据，见 [发货调查](shipped-daemon-features.md) 的 `run:65604` / `run:67169`；运行和完整 UI 对齐仍未知。本轮没有重新解包或复制闭源实现，也未扩大 REA 已有的覆盖声明。

Vek 的 `app/claude-session.cjs` 是对公开 Claude Code stream-json/control 协议的独立客户端。接口依据：官方 [CLI reference](https://code.claude.com/docs/en/cli-reference)、[会话](https://code.claude.com/docs/en/agent-sdk/sessions)、[权限](https://code.claude.com/docs/en/agent-sdk/permissions)、官方 Python SDK 的 [control transport](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)，以及本地仅作为协议参考的官方 npm `@anthropic-ai/claude-agent-sdk@0.3.316` 类型声明。本轮查阅时间为 2026-10-31；参考包在忽略的 `references/claude-protocol/`，不进入应用或本项目许可证声明。

## 执行与会话归属

- 新协议值 `claude-stream-json`，显式启用；发现已安装的 `claude --help` 只提供禁用配置，不代表已认证或已完成模型请求。
- 使用 argv、无 shell。一般用户填写 `command: claude, args: [], inputMode: stdin, modelArgs: []`；Node 等可执行包装器可保留前缀 argv。
- 运行时生成 print、输入/输出 stream-json、verbose、partial messages、`permission-mode default` 和 stdio permission control flags；拒绝冲突的会话/输入/模型/权限/settings/tool 参数。
- 不加载用户/项目的 settings sources；hooks 禁用，MCP 配置为空且 strict。认证由用户自己的 CLI 正常处理。当前不自动注入 Vek MCP gateway，不宣称这些限制构成 OS sandbox；默认权限规则中的普通读取等也不一定触发 UI 审批。
- 新会话生成 UUID 并通过 `--session-id=<id>` 启动；仅在真实 `system/init` 返回同一 ID 后保存 nativeThreadId。续接用 `--resume=<id>`，只发送本轮 prompt/当前 context/附件，避免重复旧会话。
- 会话绑定 protocol、真实 executable path、配置 argv 和 canonical project path。绑定变更、新 transcript 编辑/rollback、fork、native JSON 导入均不能沿用原生会话。第一次升级缺少绑定的旧 native 会话采用新会话加可见 transcript；无静默随机选择最近会话。
- 每轮仅一个 CLI 子进程和 user message。持久化 nativeUserMessageId；不把它虚称为 provider 的 nativeTurnId。收到明确 user_message_uuid 时验证它归属本轮。
- Claude 的 steer 在工作台排队为下一轮，不伪装成 Codex turn/steer；stop/取消审批发送 interrupt 并有强停时限。退出后按已有逻辑标 interrupted，不自动发送 prompt。

## 消息、工具、附件、用量

- UTF-8 StringDecoder 跨 chunk 解析，NDJSON 每帧最多4 MiB；只接受本轮 session ID。异常 JSON/超限/不同会话/未初始化 result/重复控制 ID 均失败。
- message ID + content index 消除 partial delta 后完整 assistant 的重复；同一完整消息只展示一次，子 Agent 输出不混入父回答。不支持的控制请求明确错误响应。
- 只在本轮明确 result 后完成；提前断连即失败，保留已收到的真实输出。result failure 保留具体错误；stdout/stderr 共用现有真实 byte budget。
- tools 是已收到的完整 tool_use 事件，最多200条、每条输入显示4096字符；literal text 渲染，不将其当可执行命令。未实现完整工具进度、结果/子 Agent 生命周期和模型能力目录。
- 用户已选择并复制的 image/PDF 以标准 base64 content block 发送，文本发送实际 UTF-8 内容；20 MiB/文件和10 active附件沿用，Claude额外限制合计24 MiB，并在spawn前拒绝超限。历史导入不获得任意本地 storedPath 读取权限。
- main-loop input/output/cache tokens 来自 result，标 scope=main-loop-turn；modelUsage保留有界累计计数，total_cost_usd命名为 sessionCostUsd。会话累计估算不跨轮相加，也不是账单。

## 权限与生命周期

`can_use_tool` 请求最多64条。未选择前不发送 allow；Approve this request 返回该 request 的原始 input，且不传 updatedPermissions；Decline 仅拒绝本次，Cancel turn 还停止任务。control_cancel_request/断连/turn结束使未决请求过期；旧请求ID不能再次授权。

协议进程共享 v0.4 的 before→执行→after→settled 生命周期，文件快照仍为项目 opt-in。准备期取消不发送 user message；结束捕获完成前不启动排队 follow-up。恢复 lease、同项目串行及原有Git限制不变。

## 验证层级和仍缺失内容

13项新本地协议测试使用独立 Node peer，实际创建/读写 argv、stdio、文件、进程和持久化数据；不连接模型。全套169/169。打包宿主新增真实 Claude wire→项目文件修改→diff→恢复→resume 检查。实际官方 CLI 的无推理 readiness、打包 SDK 与 UI 验收另列在 [当前结果](../reports/RESULTS.md)，不得从 fixture 推导认证或模型推理成功。

仍缺：Claude原生历史选择导入、完整tool/subagent结果UI、跨原生session fork、更多模型能力、MCP自动注入，以及真实模型turn。其他6种原生provider协议尚未实现；通用CLI支持不等价。当前仍不能宣布全量 Ego 产品复刻完成。
