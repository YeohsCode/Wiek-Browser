# Vek Browser 0.5.0 当前结果

本轮新增显式启用的Claude原生stream-json会话：流式回复、绑定项目/配置的重启续接、逐次权限审批与取消、原生工具事件、实际image/PDF/text附件，以及有明确scope的用量。现有Agent turn文件快照生命周期已接入该协议。**全量Ego功能复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| 最终包同源SDK E2E | **Vek 69/69，1248断言**；沿用同SDK/fixture/case哈希的Ego完整基准 **68/69，1235断言**，两侧0跳过/0未运行。[对比](comparison.md)、[本轮日志](v050-package-sdk.log) |
| 本地全套 | **169/169**，包含13项新增Claude协议和11项turn快照测试。[日志](v050-service-tests.log) |
| 最终打包宿主集成 | **59/59**，包含Claude wire真实改文件→before/after→diff→恢复→第二轮resume，以及既有browser/MCP/files/voice/permissions。[日志](v050-package-workbench.log) |
| Claude协议专项 | **13/13**：真实Node子进程NDJSON、UTF-8/去重、附件、重启、请求审批/撤销、取消/排队、断连/坏帧/超限/错误session、失败结果、配置变更和导入隔离。[日志](v050-claude-tests.log) |
| 官方Claude CLI readiness | **2.1.31 initialize成功**；隔离HOME、无继承认证，0user messages/0model calls。只证明本地握手。[报告](v050-claude-readiness.json) |
| 原生UI | 实际composer发起→等待审批无回复→点击Decline→恰好一次deny→完成，展开实际工具输入和累计费用/用量。[QA](v050-native-ui-qa.md)、[磁盘核对](v050-native-ui-check.json) |
| 打包/上游身份 | **143个文件匹配**，81个上游测试/fixture未改，SDK bundle与两侧比较一致。[校验](v050-package-verification.log) |
| 保留验证 | 未变SDK版本532/532单测、CDP22/22；未冒充本轮重跑。v0.4文件恢复UI记录保留，相关实现本轮仍在全套/宿主中通过 |
| 官方31任务线上模型benchmark | **未运行**，缺本任务专用模型认证与必要站点测试登录；不计通过或Ego服务跳过 |

## 行为与范围

Claude配置通常为 `command: claude, args: [], inputMode: stdin, modelArgs: [], protocol: claude-stream-json`。发现已安装CLI时默认禁用；运行时生成会话/格式/权限参数，不加载user/project settings或hooks，当前MCP配置为空。默认权限规则可能自行允许普通操作，这不是OS sandbox，也不宣称每个tool_use都会弹审批。

每轮一个CLI进程和一条user message，正确session/init后才持久化原生ID。重启用明确resume ID；配置/项目改变、编辑/rollback/fork/import不会误接旧原生会话。Claude的steer排队到下一轮。未决审批不会自动批准；allow仅针对本次原始input，不发送持久权限变更。

消息按ID/content index去重，子Agent文本不混入父回答。只有明确result才完成，提前断连/不同session/坏帧/超限均失败。main-loop tokens与provider累计model totals分开；sessionCostUsd是会话累计估算，不能跨轮相加当作账单。附件发送实际内容，Claude合计24MiB限制在spawn前检查。

最新官方SDK 0.3.316类型声明用于协议参考；该版可选native运行时下载未完成并已停止，其部分文件没有被作为readiness证据。完整官方CLI 2.1.31来自npm并只执行无推理握手；真实模型turn、认证和最新版完整兼容均未验证。源码与打包应用的protocol代码相同，参考包不进入发行包。

[设计](../analysis/claude-native-design.md) · [计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [文档索引](../docs/README.md)

## 剩余工作

下一步优先Claude原生历史选择导入、完整工具结果/子Agent展示和会话完整性，再逐项补其他6种原生provider。另有linked worktree/快照保留/远程PR、完整Chrome/Safari/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS跨应用能力与翻译、退出后调度、memory index、Ego专有服务与线上benchmark。

自动快照仍为项目opt-in、普通.git/已有HEAD/同HEAD恢复、2MiB每文件/32MiB总内容/2000路径/1000refs；linked worktree等不支持。文件恢复保留预览、准确名称确认、状态指纹与保护checkpoint；不等于仅回滚对话。[v0.4设计](../analysis/turn-checkpoints-design.md)。

包：`dist/mac-arm64/Vek Browser.app`，正常用户版已重新打开并实际报告0.5.0。无远程发布。引擎仍为Electron42.11.18 / Chromium148.0.7778.280；Ego为Chromium156，不能据69项测试声称引擎全面等价。

[待审批](v050-native-approval.png) · [工具与用量](v050-native-tools-usage.png) · [机器可读结果](delivery-summary.json)
