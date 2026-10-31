# OpenCode ACP v1（0.7）

Vek独立实现stdio ACP JSON-RPC客户端，未复制Ego闭源代码。Ego静态provider注册表中的OpenCode是本阶段对齐目标；本实现协议依据公开官方文档，不能据此宣称Ego全部交互已等价。

## 依据与验证层次

- [OpenCode ACP](https://dev.opencode.ai/v2/docs/cli/acp/)：`opencode acp`，网站v2文档中的wire协议仍为ACP v1。
- [ACP初始化](https://agentclientprotocol.com/protocol/v1/initialization)、[会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[配置选项](https://agentclientprotocol.com/protocol/v1/session-config-options)、[工具调用](https://agentclientprotocol.com/protocol/v1/tool-calls)、[schema](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json)。
- 合成Node子进程覆盖实际wire、生命周期和错误；不调用模型。
- npm官方`opencode-darwin-arm64@1.19.5`已下载至忽略目录`references/opencode/`。执行文件SHA-256 `feaafead8cd563af0c2dcb386b0757e4355e327ebb6bd1aaad5440fe2f83596c`。隔离HOME/XDG、净化env、禁用项目配置/default plugins/external skills，只做版本、initialize和session/new；返回9项模型选项、selector为model。0 prompt/0模型调用；[readiness报告](../reports/v070-opencode-readiness.json)不证明认证或模型可用。

## 会话与模型

配置必须显式启用：`protocol:opencode-acp`、`args:["acp"]`、stdin、空modelArgs。进程无shell，在选定project运行。会话身份绑定protocol/executable/argv/project；对话修订、fork、配置变化、archive导入不能移交原生权限。

`discover-models`占现有并发槽和project lease，后台initialize/new或load，不创建执行run或用户消息，也不生成turn checkpoint。支持停止；重启中的discovery标interrupted，不自动发送prompt。UI在发现期间禁用发送。Agent自身仍可能读写其本地会话/配置，故“未推理”不代表没有进程副作用。

模型来自当前session的configOptions（支持分组）或legacy models，展示限256项。选择模型后，下次prompt前重新检查新目录；优先set_config_option并核对返回currentValue，只有advertised legacy selector才用set_model。空选择保持Agent当前模型；模型目录不代表凭证或服务可用性。

只有已绑定的session可load，未advertise load时拒绝而不暗中换新会话。load响应可以不含sessionId；重放的历史文本/工具不计入新turn。模型发现创建的空原生会话尚无本地对话，首次prompt仍发送可见历史；后续只发送本轮文字。nativeContextSent只在实际发送时持久化，并随原生身份一起失效/从export删除。

## 内容、权限与停止

图片/PDF/UTF-8文本从已选定的私有附件副本发送实际内容，合计24MiB上限，检查advertised image/embeddedContext。工具部分更新保留input/result/diff，文件路径仅展示，不触发额外读取。子消息用OpenCode child-session元数据隔离，超出100子记录也不会混入主回答；200工具/256KiB活动文本上限。没有terminal的子活动标unresolved，失败/停止标interrupted，不伪造completed。usage分别标主session prompt tokens、context容量和session累计费用。

客户端不advertise fs/terminal/auth代理；未知server request返回-32601。权限只支持allow_once/reject_once；没有allow_once时禁用批准，永不选allow_always。停止先把全部pending request回答cancelled，再发session/cancel通知，必要时终止进程。审批数64、server request身份10000、每帧4MiB；握手每请求20秒，prompt不设固定超时。断线、错误版本/身份、坏JSON、未知stopReason不能变成成功。

OpenCode会运行自己的项目配置、插件和MCP；Vek不把空mcpServers描述为禁用了Agent自己的能力，也不宣称提供OS沙箱。真实readiness专门使用隔离目录和净化环境。

## 尚未完成

外部OpenCode历史导入/原生fork、后台子任务守护、client fs/terminal/auth委托、自动注入Vek MCP、真实认证及模型推理未验证。目录只覆盖ACP；Codex/Claude仍未提供同样的session目录。仍有5种Ego原生provider待逐项调查/接入，完整产品parity为false。
