# Vek Browser 0.7.0 当前结果

本轮接入OpenCode ACP v1原生会话和session模型目录，支持无prompt发现、模型选择确认、owned session续接/重放隔离、单次权限审批/取消、工具结果与子消息、实际附件和usage；沿用turn文件快照及恢复。**全量Ego复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| SDK E2E | **Vek 69/69，1248断言**；同输入哈希的保留Ego基准 **68/69，1235断言**；两侧0跳过/0未运行。[对比](comparison.md)、[本轮日志](v070-package-sdk.log) |
| 当前本地全套 | **202/202**，新增18项ACP回归，现有Electron panel扩展模型发现/选择和审批状态检查。[最终日志](v070-service-tests.log) |
| 打包宿主 | **79/79**，新增模型发现0执行→选择→owned load→实际文件编辑/diff/恢复→审批→停止，保留browser/MCP/files/voice/permissions与Claude历史测试。[日志](v070-package-workbench.log) |
| ACP与真实Electron panel专项 | **19/19**，自有Node协议子进程，包含attachments/permissions/cancel/legacy/stale models/malformed/disconnect/limits/import/restart与panel。[日志](v070-acp-panel-tests.log) |
| 官方OpenCode readiness | **1.19.5 initialize+session/new成功，9模型选项**，隔离HOME/XDG/净化env；0 prompt/0 model calls；目录不证明认证和服务可用。[报告](v070-opencode-readiness.json) |
| 原生UI | 实际Model发现→原生下拉选择→无自动审批→拒绝/取消/允许一次→禁用不支持的批准→工具/子消息/滚动输入区。[QA](v070-native-ui-qa.md)、[wire核对](v070-native-ui-check.json) |
| 打包/上游身份 | **146个文件匹配**，81上游测试/fixture未改，SDK bundle与两侧比较一致。[校验](v070-package-verification.log) |
| 保留验证 | 未变SDK532/532单测、CDP22/22、Claude 2.1.31无推理initialize、0.6历史导入原生UI；未冒充本轮重新执行。Ego保留基准时间为2026-10-30，同hash检查仍通过 |
| 官方31线上模型任务 | **未运行**，仍缺任务专用模型配置与必要站点测试登录；不计通过或Ego服务跳过 |

## 本轮行为与边界

OpenCode须显式启用`opencode-acp`、argv `["acp"]`、stdin、空modelArgs。原生ID绑定协议/可执行路径/参数/project，修订、fork、archive导入不继承会话权限。只有owned ID可load；不能load时拒绝，不暗中改成新会话。重放消息不重复入账；模型发现建立的空会话首次实际prompt仍携带复制的本地历史，其后只传本轮文字。

模型发现占用并发槽和project lease、阻止restore，可取消；不创建run/message/checkpoint。发现时UI和API均拒绝发送/排队prompt。模型来自session configOptions或advertised legacy models，限制256项、分组截断明确标记。选择后在新连接重新校验并确认model config；无凭证和实际模型可用性的推断。

权限只选择allow_once/reject_once，无单次允许选项时UI禁用批准，停止回答所有pending cancelled并发送原生cancel通知。客户端不提供fs/terminal/auth委托；Agent自己的项目配置/插件/MCP仍然适用，不能称OS沙箱或自动关闭其能力。附件发送实际内容并检查advertised capability，24MiB合计限制；无prompt读取个人历史。

工具input/result/diff与子消息有界保留；路径仅显示。最多200工具、100子记录、256KiB活动文本；超限子消息不会进入父回答。未见terminal的子活动标unresolved，失败/停止标interrupted。token/context/session累计费用分别显示，不将累计费用当作单轮账单。外部OpenCode历史迁移、原生fork、后台任务、Vek MCP自动注入和真实模型推理仍未验证。

扩展到202项时出现一次文件监听2.5秒超时，当时同时执行完整SDK回归；[失败记录](v070-service-concurrent-watch-failure.log)保留。原因尚不能仅凭时序确定；[独立单项复查](v070-watch-recheck.log)通过，SDK结束后全套202/202通过，未修改监听实现、断言或超时来掩盖失败。

[ACP设计](../analysis/opencode-acp-design.md) · [计划](../PLAN.md) · [功能清单](../analysis/feature-parity.md) · [文档索引](../docs/README.md)

## 下一步与剩余工作

下一项补Codex原生模型目录与明确选定历史导入，再逐项接入剩余5种native provider（Cursor/Devin/Antigravity/Grok/Droid）。同时保留Claude/OpenCode源会话原生迁移、多文件子历史/后台守护、自动MCP注入，以及linked worktree/远程PR、完整资料/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS跨应用与翻译、退出后调度、memory index、Ego专有服务和线上benchmark的缺口。

CLI stop仍是关闭请求，紧接同目录start需等待host实际退出；应单独补退出等待契约和真实进程回归。小Git仓库/同HEAD快照限制不变。应用：`dist/mac-arm64/Vek Browser.app`，正常用户版已重新打开并报告0.7.0。无远程发布；Electron42.11.18 / Chromium148.0.7778.280仍不等价Ego Chromium156的完整引擎能力。

[模型选择](v070-native-model-picker.png) · [审批](v070-native-approval.png) · [子消息/输入区](v070-native-child-composer.png) · [结构化结果](delivery-summary.json)
