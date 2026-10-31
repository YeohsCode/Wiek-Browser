# Vek Browser 0.6.0 当前结果

本轮补Claude JSONL历史选择文件、分支预览与导入，以及原生工具结果/耗时、子Agent消息和已观察状态。导入后由用户发送prompt才建立新的原生会话；源文件不会获得执行或文件恢复权限。**全量Ego复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| SDK E2E | **Vek 69/69，1248断言**；同输入哈希的保留Ego基准 **68/69，1235断言**；两侧0跳过/0未运行。[对比](comparison.md)、[本轮日志](v060-package-sdk.log) |
| 当前本地全套 | **184/184**，新增9历史、4事件、2实际协议进程回归；最终UI布局修正后已重跑。[日志](v060-service-tests.log) |
| 打包宿主 | **67/67**，新增preview/import→新owned session、真实并行工具结果、子消息隔离、来源变更拒绝，保留browser/MCP/files/voice/permissions与turn恢复检查。[日志](v060-package-workbench.log) |
| Claude集中专项 | **29/29**，包括15项原生协议、13项history/events和真实Electron panel；当前全套包含这些全部用例。[专项日志](v060-claude-tests.log) |
| 官方Claude CLI readiness | **2.1.31 initialize成功**，包括forwardSubagentText请求字段；隔离HOME/无继承认证，0user messages/0model calls。[报告](v060-claude-readiness.json) |
| 原生UI | 实际文件选择→切换分支预览→导入idle且0执行→本地协议任务→新session→工具结果/子消息/重启持久化；修正活动过多时的滚动与输入区可达。[QA](v060-native-ui-qa.md)、[磁盘/wire核对](v060-native-ui-check.json) |
| 打包/上游身份 | **145个文件匹配**，81上游测试/fixture未改，SDK bundle与两侧比较一致。[校验](v060-package-verification.log) |
| 保留验证 | 未变SDK532/532单测、CDP22/22；未冒充本轮重跑。Ego基准是较早完整记录，保留时间与同hash检查 |
| 官方31线上模型任务 | **未运行**，仍缺任务专用模型配置与必要站点测试登录；不计通过或Ego服务跳过 |

## 本轮行为与边界

历史只读用户明确选定的单个JSONL，不扫描个人目录、不跟随外部文件引用。32MiB/20000行/4MiB每行，strict UTF-8/完整JSON/UUID/session/循环与重复冲突校验；bad tail拒绝。按parent链选择分支，并仅恢复与选中工具和assistant API消息对应的并行结果。sidechain/team/meta不混入主对话，压缩/missing-parent边界不强拼。

原生UI在预览中选择已有project/provider，提交重新检查相同inode与hash。内存token限4个/15分钟/成功使用一次。导入0个执行run，不继承native resume binding、文件恢复引用、pending审批或可执行配置；图片/PDF只留未复制占位。继续时用可见文本建立新会话，之后resume该新会话；**不等价源CLI原生resume/fork或完整隐藏上下文迁移**。

实时显示工具input/result/status/duration，处理并行多content block、结果先到和嵌套归属。子消息独立展示，task旧run迟到事件不能覆盖较新run。没有terminal的活动标unresolved，失败/停止/崩溃标interrupted。最多200工具/100子活动/200子消息/256KiB显示文本，超限标记；不会自动读output_file。

历史run活动和imported活动可展开，native JSON archive保留白名单化显示证据。活动历史收敛为一个可滚动折叠区，外层会话可滚动到输入和发送按钮。

仍为每轮单CLI进程，明确result结束本轮；不保持result之后的后台子Agent，不宣称完整后台任务生命周期。官方CLI只做无推理握手，实际模型执行和当前最新版完整兼容未验证。最初一次history专项失败（并行result误列为第三个分支）已修复；[初始失败日志](v060-history-events-initial-failure.log)保留，当前全套和宿主均通过。

[设计](../analysis/claude-history-design.md) · [计划](../PLAN.md) · [功能清单](../analysis/feature-parity.md) · [文档索引](../docs/README.md)

## 下一步与剩余工作

优先OpenCode原生会话与模型能力目录，再推进其他provider。仍缺其他6种native协议、Codex/其他原生历史、Claude源会话原生迁移和多文件子历史/后台守护、原生MCP自动注入，以及linked worktree/远程PR、完整资料/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS跨应用与翻译、退出后调度、memory index、Ego专有服务与线上benchmark。

已有turn快照的小Git仓库/同HEAD等限制不变。CLI stop仍是关闭请求，紧接同目录start需等待host实际退出。应用：`dist/mac-arm64/Vek Browser.app`，正常用户版已重新打开并报告0.6.0。无远程发布；Electron42.11.18 / Chromium148.0.7778.280仍不等价Ego Chromium156的完整引擎能力。

[原生分支预览](v060-native-history-preview.png) · [子消息/输入区](v060-native-child-and-composer.png) · [结构化结果](delivery-summary.json)
