# Claude history、工具结果与子 Agent / Vek 0.6.0

## 来源与证据层级

Ego的Claude adapter和多provider历史导入有既存发货静态证据，见 [daemon调查](shipped-daemon-features.md) 的run:65604、67169、129017、129160起。静态可达不等于Ego全部UI已运行。此次属于独立源码实现，未新增闭源反编译、未复制发货实现、未扩大REA覆盖。

JSONL接口依据2026-10-31查阅的官方 [会话文档](https://code.claude.com/docs/en/agent-sdk/sessions)、官方Python SDK的 [sessions.py](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py)，以及已下载官方`@anthropic-ai/claude-agent-sdk@0.3.316`的事件类型声明。Vek只实现有界解析和独立数据模型，不使用官方SDK的目录扫描，也不读取真实个人Claude历史。

## 选择、预览、导入

- 原生“Import Claude history”打开文件选择器。API `agents:claude:preview {path}`只读取明确给定的绝对JSONL路径，不扫描home、相邻目录或子Agent目录。
- 使用O_NOFOLLOW/O_NONBLOCK和打开文件的stat检查，必须普通文件。32MiB文件、20000行、4MiB单行；读取分配上限固定，外部增长/修改时拒绝。UTF-8、完整JSON、UUID、同一main session、重复冲突及所有main parent循环均检查；坏尾不静默丢掉。
- parentUuid恢复选定链顺序。多分支明确列出，最多256分支；预览切换后实际更新选中内容。sidechain/team/meta不混入主对话，missing parent作为明确边界，不跟随logicalParentUuid强拼压缩前内容。
- 并行tool_result可能是主链旁的兄弟记录。仅当tool ID已见于选定链、parent assistant也在选定链、API message ID相符时，作为该工具结果恢复；不会拼入任意兄弟prompt/answer。已被继续的并行工具结果不单列为独立回答分支。
- 预览token仅在当前服务内存中，最多4个、15分钟。Cancel显式释放；重启不保留。提交重新读取来源，要求相同device/inode和SHA-256；token仅成功导入一次。
- 提交必须选择已有project/provider。导入为新本地对话、0个执行run，不启动CLI、不激活settings/hook/MCP、不授予checkpoint恢复权；保留sourceName/hash/source session/branch作为只读来源信息。
- 源图像/PDF只保留“未导入”占位，外部路径不读取；未知元数据不执行。工具命令和输出只显示literal文本。每条可见消息1MiB、选中消息合计8MiB，超限拒绝，不暗中截短聊天上下文。
- 用户以后发送prompt时建立新的原生session，使用选中可见transcript作文本上下文；后续轮正常resume这个新session。**它不是源CLI会话的原生resume/fork，也不包含其全部隐藏上下文或压缩状态。** 源session ID只是来源，不能从导入文件获得会话读取/执行权限。

## 实时工具与子 Agent

`app/claude-events.cjs`归一化display evidence，历史和实时共用。tool_use、tool_result、tool_progress保留input/result/status/duration，支持结果先到、并行工具和父/子同名ID隔离。同一API message分成多个content block的assistant消息不会因共享message ID丢掉第二个工具。

初始化请求开启forwardSubagentText，若CLI提供，则按parent_tool_use_id记录子消息，不混入父stdout；task_started/progress/notification展示已观察状态/summary/usage。同task不同run_id按官方字典序规则忽略旧run迟到事件。output_file不自动读、不变成任意文件打开链接。

上限：200工具、100子活动、200子消息、256KiB显示文本budget；input4096字符、result/子消息16384字符，超限显式truncated。完整输出可能因这些限制被截断，不称“无限完整日志”。原始image/document二进制不存入活动记录。

每轮结束时，缺少terminal事件的工具/子任务标unresolved；失败/取消/崩溃标interrupted。显式completed/failed/stopped保持真实状态。当前仍是每轮单进程、明确result结束本轮；不会保持后台子Agent在result之后运行，也不宣称实现完整Claude后台任务守护。未发出的事件不会被推断成成功。

所有历史run活动均可展开，不仅最新一轮；原生JSON导出/导入保留有界、白名单化的工具/子消息/来源字段。导入不恢复pending审批/native session binding/fileChanges权限。

## 验证与边界

- 新增9项历史、4项事件专项和2项真实协议进程测试；连同既有专项/真实Electron panel总29项。全套184项。
- 测试仅用自有JSONL、临时文件/Git、实际Node子进程和隔离Electron；包含分支/并行/乱序/字节不变、inode替换/符号链接、TTL/token、坏UTF-8/尾/循环/混合session、limits、导出再导入、新会话建立/续接、实时子Agent停止与父回答隔离。
- 最终包宿主新增历史preview/import→owned turn、并行结果、子Agent状态与stale-source拒绝；实际UI和SDK gate见 [当前结果](../reports/RESULTS.md)。官方Claude CLI2.1.31只测试无认证initialize；没有真实模型turn。

仍缺源CLI原生resume/fork迁移、目录/多文件子历史关联、所有Claude新类型和后台任务、其他6种native provider、模型能力目录与原生MCP注入。全量Ego复刻仍未完成。
