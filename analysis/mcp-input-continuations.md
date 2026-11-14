# MCP 工具输入续传（0.18）

2026-11-02，Asia/Shanghai。独立实现公开协议；不是 Ego 同后端运行等价证明。P1 不同 Agent 集成继续暂缓。

## 用户流程与范围

现代 HTTP（显式 `2026-07-28`）的本地工具任务可进入 `awaiting_input`。Connected tools → Tool tasks → Review input 显示请求服务器、完整 endpoint、工具、项目/线程、轮次和原任务截止时间。表单可编辑，逐项选择提供/拒绝/不作选择；也可 Decline all 或 Cancel task。关闭审阅窗口不发送输入，任务仍可再次审阅。服务器消息/标签只作为文本显示。

支持有界平面表单：字符串、数值/整数、布尔、单选 enum/带标题 oneOf、多选 enum/anyOf，默认值、必填、数值和长度边界、email/URI/date/date-time格式。URI字段不触发导航。每轮最多8个表单，每表单32字段、枚举64项；最多8轮审阅。复杂/未知schema、异常default、额外属性、危险对象键明确拒绝。email使用有界常见格式检查，不宣称完整RFC邮箱校验。缺省可选文本空值省略，必填文本允许schema规定的空字符串；空字符串enum选择仍受该输入方式限制。

依据[公开 MRTR 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)与[表单 elicitation 规范](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)（本日核对）：每次明确提交以新JSON-RPC ID续传原工具和参数，`requestState`只做不透明字符串原样回送，`inputResponses`只属于当前请求/当前轮。只有接受此流程的tool请求声明form能力。纯state响应也停留在明确审阅，不自动轮询。

没有URL elicitation、sampling、roots、资源读取/提示词续传、现代stdio或完整task extension。没有付费模型/真实账号调用。paired-client/gateway工具请求不声明表单能力，未引入其他Agent的新集成。

## 生命周期和数据

审阅使用随机review ID，按任务/项目/线程严格绑定，验证成功后一次消费；重复、旧轮次、跨scope提交在发网前拒绝。验证失败保留当前审阅供修改。Decline/dismiss是发送给服务器的明确响应；Cancel task结束整个任务，不发送续传。

任务原截止时间包含连接、等待输入和续传，不重新计时。取消/断开/配置变更/关闭结束相关任务，取消在途POST。HTTP断流、认证失败和不确定结果不自动重放。重连/重启不恢复表单。崩溃残留的awaiting_input历史标记interrupted。

审阅、schema/default、提交值与opaque state只存在内存；不写MCP state.json，不加入Agent上下文。交互最终结果可能回显输入，因此也仅在当前进程保留（最多500条，单条沿用结果大小上限），历史标记`resultRetained:false`。交互失败保留固定说明，避免远端错误回显输入进磁盘。这里的“不持久化”指Vek MCP历史，不替远端服务作存储承诺；表单不应用于密码/API key/支付凭证。

## 实现与证据

- `app/mcp-input.cjs`校验输入请求和响应；HTTP client只对明确允许的tools/call返回未改写opaque状态。
- 服务在active task中持有review，snapshot只暴露form；磁盘状态没有review或内容。面板通过原有隔离IPC提交。
- 新增16协议/服务测试，1实际Electron面板测试（13内部检查）；实际宿主新增11检查。覆盖原状态回送、ID/参数、scope/重复提交、typed defaults/验证、decline/dismiss、纯state、取消等待/在途、超时、断连、轮次上限、sampling拒绝、丢失POST不重试及重启清理。
- 当前完整验收与原生截图见[RESULTS](../reports/RESULTS.md)。这些离线fixture证明本实现边界，不替代Ego同功能运行对测或31项线上模型任务。

下一步P2核对现代OAuth的CIMD/身份机制，随后继续明确来源迁移与P3剩余验收。MRTR资源读取/URL模式仍是缺口；P1继续暂缓。


## 0.29 资源、提示与 URL 输入

MCP 2026-07-28 的资源和提示面板提供带输入的读取入口。普通读取继续直接显示结果。交互式读取沿用工具任务的审核、取消、过期和轮次上限，同一服务收到原 URI 或提示参数、新请求 ID、本轮输入和原样的 requestState。资源内容、回答和 URL 路径只在本次会话中使用，资源读取状态保留订阅的原始修订号。

URL 模式只在有桌面交互的调用中声明。面板展示 HTTPS 来源，用户主动点击后由系统浏览器打开；输入回复只携带 accept、decline 或 cancel。接受需要先成功打开，并由用户在完成网页操作后提交；服务端判断网页流程是否完成。收据、路径和查询参数留在主进程。连接断开或请求过期会结束审核。参见 [MCP 规范发布说明](https://blog.modelcontextprotocol.io/posts/2026-07-28/) 和 [官方 SDK 的输入流程](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation)。
