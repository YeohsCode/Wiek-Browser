> 本文保留最初发货包静态调查边界。调查后Vek已补基础项目/本地CLI会话/消息与at/interval调度；更新后的partial/missing清单见 feature-parity.md 和 agent-service-design.md。

# 已发货 local-ego-daemon 功能与复刻缺口

Ego **0.6.1.13** 安装包中的 JS 表明，最新版产品除了公开 `ego-browser` SDK，还携带一套本地多 Agent 工作台后端：聊天与任务历史、模型/provider 管理、项目与文件、Git/PR、自动化调度、MCP 集成、语音转写等。当前 Vek 的浏览器桥接与 SDK E2E 不覆盖这些子系统，不能据此宣布“整个 ego 浏览器全功能复刻”。

以下是**发货代码的静态观察与静态连接关系**，不是功能已运行的声明。所有目标 JS 都按惰性文本分析，未启动 daemon、未执行其中的安装/运行命令、未读取用户凭据，也未将闭源实现复制进 Vek。

## 证据身份和覆盖边界

目标根：`downloads/ego/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/0.6.1.13/Resources/local-ego-daemon`。下文 `run:` / `acp:` / `sdk:` 分别指该根下的三个文件及一基行号。

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `runtime/run-DeGOi3G8.mjs` | 5,246,451 | `66006b5911bf3368bd3fc13737c889d4f2969e9acde07f1d7c6f9e2993b089bd` |
| `runtime/acp-CMydSrPv.mjs` | 315,459 | `67dc9f23939db234959a27f03f97a0f7e86ae296e8fd7b71d723278042698ea4` |
| `runtime/sdk-BNTzx9JU.mjs` | 1,865,564 | `39b65b60a64663871a8ee015a96ec49547b25a3d3a99f310fb61a22017ec511c` |

REA 6.5.0 CLI Evidence：`ev_0a7bdc68255ac1adb7db5fd967eaa355b6bbd1830efb7f12c750d8540dcbbee3`。完整记录存 `analysis/evidence/rea-daemon-heavy.json`（约 125 MiB）；便于阅读的元数据及覆盖摘要为 `rea-daemon-heavy-summary.json` / `rea-daemon-heavy-coverage.json`，逐文件身份为 `shipped-daemon-source-identities.json`。根 artifact SHA-256：`faefbb871ce738640629c2cd38085e6261f7030d0b11c2ecaee24b269175cae7`，与主调查的相同安装树匹配。

分析选择三个确切路径，隔离 analyzer heap 768 MiB、每文件上限 90 秒，最多 1,500 个语义节点/文件、全局 4,500 个。REA 实际解析三文件共 7,427,474 字节、访问 1,085,574 个 AST 节点、无 parse failure、记录 1,237 个 findings。**全 artifact 469 个相关文件中有 466 个不在本次源分析范围；语义图达到节点上限并标 partial/truncated。** 以下缺口核验采用实际函数、注册表、服务装配与具体处理器的有界人工读取，不能把不在图中的路径当不存在。没有重复运行相同 REA 分析来获取更大输出。

## 入口与可用性的证据层级

- `run:117969` 的 `makeServerRuntimeServicesLayer` 装配 orchestration、checkpoint、自动化、MCP、Git、usage、settings、workspace 等服务；`run:118003` 的应用装配同时连接 provider graph。
- `run:132017` 的 `LayerLive` 消费上述装配；`run:132031` 的 server program 请求 `Server.start`。
- `run:130972` 的 server creation 创建 HTTP server，`run:131015` 合并普通 HTTP、WebSocket RPC、Agent MCP 与 External MCP 路由；`run:131043` 起启动 orchestration、automation scheduler/reactor、session reaper/reconciler。
- 这比“搜到名字/依赖字符串”更强：实现和静态调用路径都在发货入口内。是否受当前窗口、账号、设置或用户引导控制，是否对所有用户显示对应 UI，仍需运行证据；本调查没有把静态可达性说成运行观察。

## 新增功能账本

下表均由上述 REA Evidence 身份绑定，位置列提供当前字节文件的可复查源行。`确认发货`表示处理器与服务实现存在；`运行未知`表示未进行实际交互验证。

| 功能 | 具体观察与源位置 | 结论及 Vek 缺口 |
|---|---|---|
| 内置多 provider Agent harness | `run:81775` registry 明确接入 Codex、Claude、Cursor、Devin、Antigravity、Grok、Droid、OpenCode 八个 adapter；`run:81787` 构造启动渠道、credentials、enabled settings、runtime events | 确认发货；不是仅供外部 Agent 控浏览器的 SDK。Vek 当前 app/CLI 无对应 provider/session 编排，missing |
| 实际 Claude SDK 连接 | `run:65604` lazy import `sdk-BNTzx9JU.mjs`，`run:67169` 取 `query` 并调用；`sdk:40` 明示打包的 `@anthropic-ai/claude-agent-sdk@0.3.259`，`sdk:62171` 导出 query/session/subagent API | 确认依赖被 ego adapter 消费，非仅孤立捆绑库。不能将第三方 SDK 的全部 API 自动算作 ego UI；运行需已安装渠道/认证，Vek missing |
| 对话/任务历史与组织 | `run:85877` `projection_threads` 存 title/project/branch/model/session、archive、fork/parent/subagent、pins/notes/markers、goal/achievements、sidechat；`run:102475` message repository；`run:130279` 起 snapshot/detail/replay/live subscription RPC | 确认发货，有持久化任务会话与消息，不是浏览器 URL history。Vek 的浏览历史面板不等价，missing |
| 多 Agent 协作与任务控制 | `run:27055` thread read/list/wait tools；`run:28357` create/steer/interruption/title/archive/goal 等 Agent tools；`run:106428` 处理 handoff/fork；`run:98842` 涵盖 interrupt、background、approval/user input、session stop | 确认发货，包含用户输入/审批与排队状态。Vek TaskSpace handoff 不等价于 Agent thread 编排，missing |
| 对话编辑/回滚/检查点 | `run:98860` 处理 checkpoint revert、conversation rollback、message edit-and-resend；`run:117972` checkpoint store/diff 服务；`run:130283` getTurnDiff / fullThreadDiff RPC | 确认发货；Vek 没有对应聊天回滚/Git checkpoint 系统，missing |
| 会话导入/导出 | `run:129017` import route 和 Codex/Claude/Droid/OpenCode history 适配（129160 起）；`run:122910` archive writer；`run:125855` GET `/api/thread-export` | 确认发货；不等于复制浏览器 profile，Vek missing |
| 自动化调度 | `run:25497` schedule 计算（once/interval/daily/weekdays/weekly/cron、timezone、DST 与 jitter）；`run:82209` scheduler 每轮 reconcile+runDueOnce，唤醒/nextDue，`run:131044` 纳入 server startup | 确认发货的本地调度实现，不依赖 ego 云端才能存在。Vek 无 scheduler，missing |
| 自动化执行模式与生命周期 | `run:25921` heartbeat/standalone/dedicated；`run:82561` AutomationService 验证目标 thread/project、run capacity/cooldown/defer；`run:130607` list/create/update/delete/runNow/cancel/archive/proposal/subscribe RPC | 确认发货；Vek missing。仅启动 setInterval 不等价，需 thread ownership/idle、取消、恢复、run history |
| 自动化记忆与停止判定 | `run:83376` memory replacement 限 32 KiB；`run:26347` memory tool、`run:26390` result tool；`run:82285` stop policy，`run:82360` completion evaluation；`run:115032` automation DB schema | 确认发货；Vek missing。需要独立 persistence/结果通知及 completion contract |
| Skill/插件/命令/模型目录 | `run:65473` catalog，provider-native/home/project/plugin roots、按 provider 优先顺序、缓存、disable filtering；`run:130590` discovery RPC，list commands/skills/catalog/plugins/plugin details/models/agents；`run:88419` skill prompt integration | 确认发货。公开 SDK 的 GitHub/Google/X learnings 是另一层；Vek 目前只复用 SDK Skill，工作台目录与插件管理 missing |
| 工作区与文件编辑/预览 | `run:130376` 起 directories/search/content/index/scripts/read/write/watch/resolve references/local preview grant、filesystem browse；`run:112964` WorkspaceFileSystem；`run:87550` studio outputs | 确认发货。Vek browser webpage/file URL 不能替代整个工作区编辑/冲突/watch/输出模型，missing |
| Git/分支/PR 工作流 | `run:130439` 起 GitHub repo/status/diff/pull/stacked action、PR snapshot/thread、branch/create/checkout/stash/stage；`run:130455` PR list/detail/diff/action/comment/pin；`run:117992` service 装配 | 确认发货；Vek missing；读页面 GitHub 与本地 Git/gh 工作流不同。无外部写操作被执行 |
| External MCP | `run:114392` tool registry：capabilities/allowed projects/overview/create/read/wait task；`run:130902` integrations/create/revoke/pairing/runtime challenge HTTP；`run:131015` 挂载路由 | 确认发货，含 integration allowlist/scope/pairing/audit。Vek loopback 浏览器 RPC 不等价，missing |
| Agent scoped MCP | `run:28960` gateway、`run:81190` stdio proxy、`run:81542` registry、`run:81611` credentials；`run:117991` 与 agent adapters 共用 credential layer | 确认发货；Vek missing。不能靠暴露无 scope 的普通 HTTP 端点声明对齐 |
| 语音输入 | `run:130510` prewarm/transcribe RPC 委托 adapter；`run:126014` `/api/voice/transcribe`；`run:123605` upload admission | 确认服务接口，具体 provider 支持受 capability 检查，不代表所有模型都有语音。Vek missing；麦克风权限支持不等价 |
| 设置、用量与诊断 | `run:130472` settings/environment/provider update/status；`run:130484` profile/token stats、provider usage、子进程内存/诊断；`run:126344` accounting、`run:127380` observability | 确认发货；Vek browser settings 与 Agent usage/diagnostics 不等价，missing |
| 本地服务器发现 | `run:128249` localServerMonitor；`run:130482` list/stop RPC | 确认发货，本次未停止任何进程；Vek missing |
| 内置 Agent HTTP 展示桥 | `run:123959` AGUI，`run:125067` thread.create、125160 thread.turn.start；`run:131015` server 挂载 | 确认有 HTTP/事件展示桥后端；完整 client UI 没有纳入本次 REA，视觉、路由、显示开关为 unknown |

这里的 missing 是对本次调查时 Vek **`app/`、`cli/` 范围的有界源码核验**：该范围仅包含浏览器 host/UI、snapshot/CDP/CLI，没有对应 thread/provider/automation/MCP/chat 服务。后续代码变更需重新核验，不能将这一时点的负面结论扩展到未来实现。

## 终端与 ACP：不能从依赖名称过度推断

`acp:4` 至 48 的方法表含 session new/load/list/fork/resume/prompt/cancel、permission、fs read/write、terminal create/output/wait/kill/release。`run:47425` 为这些 method 注册分发到可选 handler，`run:47479` 起暴露 handler setter。

但 `run:47816` 至 47825 的初始化默认 **fs read/write=false、terminal=false**；本次 `run` 文件的有界检索只找到 terminal setter/接口转发，没有查到已绑定的 PTY UI 或 terminal create 实现。所以只能确认“携带 ACP 终端协议适配面”，**不能确认此版本提供独立的交互终端窗口或默认启用客户端终端执行**。provider 自己的工具可能启动 shell，与应用内可见 PTY 仍是不同能力。

Vek 的独立交互终端对齐状态因此为 **unknown**；不是已证实 ego 特性缺失，也不是已复刻。需后续检查 client/native UI、provider capability 参数与真实交互。

## 对“全功能”和测试结果的影响

1. 69-case 同源 E2E 是**公开浏览器 SDK/原生桥接能力**的真实 gate；它测试 Page/Space/CDP/ref/input/files 等，不测试上述 daemon 的 Agent 会话、schedule、workspaces、Git/PR、MCP 或聊天历史。
2. SDK unit tests、69-case pass rate、31 个在线网页任务 success rate 互不替代；任何一组全过都不能推导整个产品 100% parity。
3. “涉及 ego 服务的测试可跳过”不应被扩大为跳过所有 daemon 功能：schedule/thread/history/workspace 等本身是本地实现；只有确实依赖 ego 账号/专有服务且无法替换的部分才能按用户范围单列跳过。
4. 当前应报告：Vek 的浏览器能力正在同集验证，同时**已确认还缺多个本地 Agent 工作台子系统**。不要把外部第三方 Agent 可以调用 Vek CLI 描述成内置了对应 agent/channel/session 管理。
5. 没有源码许可证证据表明这个发货 daemon 自有代码也采用公开 ego-lite 的 MIT。依赖 SDK 有其各自条款；本调查仅恢复功能事实、接口和行为需求，没有复用闭源实现。

## 待继续的证据与验收

- 已回答：新版是否超出公开 SDK（是）；多 provider、聊天/历史、skills、schedule、workspace/Git/MCP/voice 的实现与注册是否在发货入口（有静态连接证据）。
- 部分回答：各 subsystem 的完整用户流程、enablement、默认可见性/权限、实际故障恢复；需受控本地 UI/请求探针，不能仅凭代码推断。
- 未回答：完整 client bundle 与 native Chromium 产品层全量功能、独立交互 PTY、云端 ego 专有服务的最终边界；本次未分析 466 个文件也未执行 daemon。
- 新 subsystem 的后续 Vek 验收应加独立且行为明确的集成测试：provider 启停/恢复、消息流/审批/导入导出、schedule 时区/持久化/取消/去重、MCP scope+pairing、workspace 冲突与 watch、Git fixture/PR mock、voice capability。不可改弱现有 SDK assertions 来掩盖缺口。
