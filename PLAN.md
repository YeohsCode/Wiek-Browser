# Vek Browser 复刻计划与进度

更新：2026-11-02（Asia/Shanghai）。当前交付版本：**0.18.0**。项目目标仍是独立复刻 Ego 的可验证功能；**全量复刻未完成**，不以任意百分比或 69 项 SDK 通过代替产品完成度。

## 当前执行优先级

按用户最新要求（2026-11-01）：**先跳过 P1 中不同 Agent 的集成，优先 P2、P3**。Cursor 未完成的代码已从工作树移出，保存在本机 Git stash `31764915635554521270725e0d0c38e178eea3cf`（`deferred P1 Cursor ACP work; prioritize P2 P3 2026-11-01`）；不是 0.11 发行功能，普通 clone 不包含该本机 stash。

当前顺序：P2有界资料web storage归档已完成 → P3单次采集/全局快捷键已实现有界范围 → 执行模式与显式closed-app tick已实现 → P3有界login job/前台接管已实现 → P2现代HTTP资源/显式订阅已实现 → 有界工具表单MRTR已实现 → OAuth CIMD/DCR与明确来源完整迁移；继续保留执行模式剩余语义、翻译与远程Git。涉及 provider gateway 的集成部分随 P1 暂缓；不删除剩余目标。

## 当前检查点

| 项目 | 已完成的验收 | 当前状态 |
|---|---|---|
| 参考制品与调查 | ego-lite MIT 源码、Ego 0.6.1.13 安装包、31 任务 benchmark 已下载；REA daemon/client 证据及覆盖限制保留 | 已完成有界调查；全部 native/client 路径仍未覆盖 |
| 浏览器 SDK 与宿主 | Space/Profile/多标签、DOM/AX snapshot、CDP、上传/下载、剪贴板、iframe/worker 等；同集测试 Vek 69/69、Ego 68/69 | 0.18最终同集验收完成，非引擎全面等价 |
| 本地 Agent 工作台 | 通用 CLI、opt-in Codex app-server/Claude stream-json/OpenCode ACP、多 Agent 控制、对话分支/附件/审批、Claude选定历史分支、Codex有效rollout压缩/回滚导入及实时工具/子活动、Codex/Claude模型与effort目录 | 部分完成；其他5种原生 provider、源CLI原生会话迁移/后台任务和真实付费 turn 未验证 |
| 文件/Git | 受项目范围约束的读写/search/watch；常用 Git 操作；命名 checkpoint、预览/显式恢复/保护快照 | 部分完成；已有 turn 自动关联，linked worktree 和 PR 流程仍缺失 |
| MCP | stdio、scoped gateway/pairing；远程 HTTPS、legacy session/SSE 和显式 modern 工具模式 | 部分完成；已补 session 资源/模板/订阅；已补预注册public OAuth/PKCE与加密绑定；现代HTTP资源/列表与更新订阅已补；已补本地工具form MRTR；CIMD/DCR/sampling/URL与资源MRTR仍缺失 |
| 自动化 | at/interval/heartbeat/IANA cron、DST、防重复预约、运行记忆/提案/停止条件 | 0.16新增明确审核的macOS login job/前台接管；三种mode和closed-app tick可用，物理sleep/login撤销未实测，busy延期/completion contract仍缺 |
| 语音/Library/录制 | 本地 Whisper tiny、语音历史/词典；Collections、截图标注；显式网页操作录制 | 本地范围可用；新增显式网页/项目文本 memory 索引；0.14增加显式OS单次采集；正向native内容仍待验收，无被动监听/跨应用录制/翻译等价 |
| 浏览器界面/权限/资料 | 主题/标签布局/快捷键、独立窗口/托盘；权限隔离；Profile 数据归属；Chromium 选择导入和v2显式web storage加密archive | 部分完成；完整迁移/扩展/OS 设备能力仍有缺口 |
| 交付与基准 | macOS ARM64 应用；416/416 本地测试、184/184 打包宿主集成、81 个上游文件未改 | 0.18有界检查点完成；170个发行文件匹配，31 项线上模型任务未运行 |

证据入口：[当前结果](reports/RESULTS.md)、[同集对比](reports/comparison.md)、[逐项功能清单](analysis/feature-parity.md)、[机器可读结果](reports/delivery-summary.json)。532 项 SDK 单测沿用未改版结果；不描述为本轮重新运行。

## 版本进度

- [x] 0.1：独立浏览器宿主、公开 SDK 桥接、同源浏览器测试与基础打包。
- [x] 0.2：Agent 工作台、文件/Git、stdio MCP、Library/标注/录制、偏好/窗口、离线语音、资料 archive。
- [x] 0.3：远程 MCP、命名 Git checkpoint、IANA/DST、网站权限竞态回归、Profile 归属修正、下载暂停/继续、网页右键菜单。
- [x] 当前文档归一：修正 README 旧数字/缺失项，建立本计划及文档索引；整理首次 Git 提交范围。
- [x] 0.4：Agent turn 前后快照、逐 turn/会话差异、明确确认文件恢复、保护快照及失败/中断/真实进程强停恢复。
- [x] 0.5：Claude原生stream-json、绑定会话续接、逐次权限/取消、工具事件、实际附件和用量；协议fixture与官方CLI无推理握手分层验收。
- [x] 0.6：Claude选定JSONL分支预览/导入、来源变更拒绝、实际工具结果/耗时/子Agent记录、停止和archive边界验证。
- [x] 0.7：OpenCode ACP v1、无prompt模型发现与选择、owned session续接/重放隔离、单次权限/取消、工具与子消息/usage/附件、turn文件恢复。
- [x] 0.8：Codex分页模型/effort/输入能力目录、执行前刷新校验、所选rollout可见历史预览/导入、真实CLI无推理格式验证。
- [x] 0.9：Codex有效压缩/回滚历史、原生实时command/diff/MCP/子Agent、子turn单次审批及事件归属。
- [x] 0.9.1：CLI stop等待实际退出、身份核对/超时、同目录立即重启和provider最终快照验证。
- [x] 0.10：Claude initialize目录、alias/canonical ID、已声明effort控制与fresh validation、取消/lease/旧版unknown。
- [x] 0.11：P2 session MCP资源/模板/订阅与显式读取；P3按Profile隔离的显式网页/项目文本memory索引。
- [x] 0.12：预注册public客户端HTTP OAuth：metadata/PKCE/只读权限审核、显式登录、绑定加密存储/refresh轮换、取消/401不重放。
- [x] 0.13：Profile archive v2显式顶层localStorage/per-tab sessionStorage、v1兼容、无网络bootstrap、取消/冲突/部分失败和CHIPS遗漏验证。
- [x] 0.14：macOS显式原生区域/窗口截图、一次性AX选区/应用排除、临时预览与Library标注、全局快捷键注册/冲突/退出释放；真实OS仅验证注册、启动/取消/清理；正向内容待验收，范围见RESULTS。
- [x] 0.15：三种执行模式与专属线程归属、干净新会话、显式一次性closed-app worker、互斥/timeout/取消及真实Git快照；未安装OS唤醒。
- [x] 0.16：默认关闭的审核式macOS login job、代码/runtime receipt、停用/卸载、认证停止端点及真实foreground接管；物理睡眠与登录边界保留。
- [x] 0.17：现代HTTP资源/模板/读取、显式subscriptions/listen、首条确认/精确ID/子集校验、断流状态/明确重试、取消与列表竞态；0.18新增有界工具表单续传。
- [ ] 后续：优先 P2/P3 剩余项；不同 Agent 的 P1 集成暂缓，线上基准仍属 P4。

## 执行顺序与阶段验收

### P0 / 0.4：把手动 checkpoint 接入真实 Agent turn

- [x] 在项目明确启用后，保存 turn 前后 checkpoint，持久化 thread/run/turn 与 checkpoint 的关联。
- [x] 提供单 turn/整会话文件差异；将“仅回滚对话”和“恢复文件”明确呈现为各自真实动作。
- [x] 文件恢复沿用预览、当前状态指纹、用户明确确认和恢复前保护快照；保持原有分支/index/stash。
- [x] 处理失败/取消/重启、重复事件、HEAD 改变、不支持的仓库与超限情况；保留可解释的未捕获状态，不伪造快照成功。
- [x] 用真实临时 Git 仓库和本地 provider 验证成功/失败/中断/冲突/保护快照恢复；既有 SDK 用例与断言保持不变。

完成标准：一个实际本地 provider 修改文件后，UI 可查看该 turn 的真实 diff，明确确认后能恢复文件与 index；失败、中断和重启路径有实际测试证据。现有普通小仓库限制需明确显示；linked worktree 支持单独设计与验证，不在无证据时承诺。

### P1 / 不同 Agent 集成暂缓：原生 provider 与会话完整性

- [x] 补 Claude 原生流式协议、会话续接、逐次权限审批、用量和附件；仍须按证据核对其他5种原生 provider。
- [x] Claude所选JSONL历史分支导入、真实工具结果和子Agent活动展示；保留导出再导入中的有界显示记录。
- [x] OpenCode ACP v1原生接入和session模型目录；协议进程、官方CLI无推理发现与打包宿主分别验证。
- [x] Codex原生模型目录和所选rollout有效可见历史导入；支持有界压缩/回滚，不继承源会话。
- [x] Codex压缩/回滚历史语义和实时工具/子Agent活动、子turn单次审批。
- [x] CLI stop等待实际退出并回归同目录立即start、provider终止及最终快照。
- [x] Claude模型目录、声明能力与显式effort控制，旧版未返回字段保持unknown。
- [ ] 暂缓：核对并接入其余5种原生provider；Cursor探索保存在本机stash，当前未交付。
- [ ] OpenCode外部历史迁移、原生fork、后台子任务和自动MCP注入仍待实现。
- [ ] Claude源CLI会话原生resume/fork迁移、多文件子历史及后台任务守护仍缺失，当前导入续接明确为新会话加可见文本。
- [x] 协议 fixture、实际本机非推理 readiness 与真实模型 turn 分开记录；付费模型/账号任务需要专用配置和明确执行授权。

### P2：MCP 与资料迁移

- [x] 0.11：session MCP资源/模板分页、显式text/blob读取、subscribe/unsubscribe、更新revision/失效提示、断线不重放、scope与有界UI。
- [x] 0.12：预注册public OAuth（none/S256）、明确审核/显式打开、loopback callback、作用域绑定密文/refresh轮换、取消与401不重放；实际AS/Keychain令牌写入未运行。
- [x] 0.17：现代HTTP资源与显式tools/resources列表和resource URI通知流；逐条ack/ID/过滤校验、取消/断开/不自动重连和scope边界。
- [x] 0.18：本地现代HTTP工具表单MRTR，scope/一次性review、输入验证、明确accept/decline/cancel、原截止时间、断开/重启清理与不重放。
- [ ] OAuth CIMD/DCR/完整step-up；资源/URL MRTR、sampling/roots、现代stdio与prompt通知仍缺失，保持最小scope、取消、版本边界和无工具POST自动重放。
- [ ] provider gateway 注入随 P1 不同 Agent 集成暂缓。
- [x] 0.13：显式打开顶层HTTP(S) localStorage与当前origin per-tab sessionStorage；v2/v1、UTF-16、无网络bootstrap、新Profile、active index和CHIPS语义验证。
- [ ] 明确来源多浏览器迁移及IndexedDB/完整会话仍缺失；只使用用户选定来源，不自动读个人Profile。
- [x] 0.13有界archive使用合成fixture验证兼容、部分失败、取消、冲突、恢复；不代表完整浏览器迁移或退出后会话已完成。

### P3：OS 能力、执行模式与剩余本地功能

- [x] 0.14有界实现：单次OS截图与AX选区读取、默认关闭/按应用排除、全局快捷键、预览与明确使用；权限由真实OS流程授予，不伪造成功。
- [ ] 被动选区浮动工具栏、OS跨应用录制、多显示器/权限撤销和所有应用兼容仍待验证；0.14不代表这些完成。
- [x] 0.15：heartbeat/standalone/dedicated线程生命周期；显式closed-app单次CLI tick，默认关闭、非native provider、预约去重、锁互斥、signal/timeout/真实快照。
- [x] 0.16：明确opt-in的macOS login job安装/停用卸载、runtime变更阻止执行、foreground等待真实收尾；真实一次性launchd fixture完成bootstrap/运行/卸载。
- [ ] 物理sleep/wake、logout/login/OS后台项撤销和更多安装布局仍需验收；busy延期、Ego completion contract与hard-kill恢复仍有缺口。
- [x] 0.11：显式网页/项目UTF-8文本memory内容索引；Profile隔离、中文/英文literal搜索、保存副本/重建、删除与取消/开关清除。非语义/全磁盘索引，不自动注入Agent。
- [ ] 真实翻译适配和远程 Git/PR 流程逐项验收；独立交互终端须先确认 Ego 实际功能证据。

### P4：同条件线上基准与发布

- [ ] 修复或固定 benchmark adapter 与 SDK V2 的版本漂移，对 Ego/Vek 同等应用。
- [ ] 获得专用 Stage A/Judge 模型配置与必要站点测试账号后，执行同 commit/task/model/thinking/limits/login 条件的 31 任务基准。
- [ ] 分别统计成功、失败、未运行和确实依赖 Ego 专有服务的跳过；不套用营销成功率。
- [ ] 建立 Vek 自己的 CI、可恢复构建、签名/公证及版本发布流程；当前仅本地构建，无远程发布。

## 提交与验证约定

- 首次仓库根为 `vek-browser/`。提交独立实现、MIT SDK/测试、文档、结构化结果和本地测试日志；不推送远程。
- 忽略运行数据、第三方 checkout/安装包、闭源解包资源、REA 完整原始记录、构建产物/缓存及模型权重。文件保留在当前磁盘；小型证据身份摘要进入 Git。
- CPU Whisper arm64 可执行文件及其许可证/构建身份进入提交；模型按固定 URL/SHA-256 恢复，见 [模型来源](models/MODEL-NOTICE.md) 和 README。历史原始证据仍可通过当前工作区路径查阅，普通 checkout 不自动包含它们。
- copied upstream `.github/` 和 `lefthook.yml` 面向旧目录，本次不作为 Vek 的 CI/hook 提交；没有跳过一个已经安装的 Vek 检查。
- 文档提交核对链接、版本/数字、Git 暂存清单和敏感路径，不因纯文档变化重复付费/线上测试。后续功能变更运行相关专项和必需的宿主/SDK gate。

0.4 实现与边界见 [turn-checkpoints-design.md](analysis/turn-checkpoints-design.md)。新增专项 11/11、本地全套 156/156、打包宿主 53/53 已通过；最终 SDK 与原生 UI 结果以当前报告为准。自动快照沿用小仓库限制，未扩展为任意 worktree 或完整远程 Git 工作流。

0.5 实现见 [claude-native-design.md](analysis/claude-native-design.md)。当时下一项为Claude原生历史选择导入与工具结果，现已推进至下面0.6范围。13项新协议测试、本地全套169/169、打包宿主59/59已通过；真实Claude CLI 2.1.31只发送initialize，未发送prompt或继承认证；不能宣称模型推理已验证。最新CLI二进制下载未完成，不以部分下载文件为readiness证据。

0.6 实现和限制见 [claude-history-design.md](analysis/claude-history-design.md)。新增15项历史/事件/实际协议进程回归，全套184/184；打包宿主67/67。导入不扫描个人目录、不执行源工具、不从文件获得native resume/checkpoint权限。下一步优先OpenCode原生会话及模型能力目录，继续逐项对齐其他provider。

0.6时发现的CLI关闭生命周期缺口已在0.9.1补齐：stop成功意味着原宿主PID实际退出，真实provider收尾/快照和同目录立即start均有回归。参见 [CLI生命周期](analysis/cli-lifecycle.md)。

0.7 实现与边界见 [opencode-acp-design.md](analysis/opencode-acp-design.md)。新增18项ACP回归，现有Electron panel新增模型目录/发现/审批状态验证；本地全套202/202，打包宿主79/79。官方OpenCode 1.19.5净化环境下initialize+session/new成功，9模型选项，0prompt/0模型调用。首轮发现后仍发送复制的本地历史，旧会话重放不重复入账；目录不等价凭证或模型服务可用。其他5种原生provider与完整产品parity仍未完成。

0.8 实现和边界见 [codex-capabilities-history.md](analysis/codex-capabilities-history.md)。新增21项Codex目录/历史专项，全套223/223、打包宿主92/92；原生panel支持真实目录/effort选择和所选文件预览。官方Codex CLI 0.142.0净化环境发现5项模型目录，创建一次性本地thread并inject两条合成历史，未调用turn/start或模型；不等价认证/推理验证。历史遇压缩/回滚/未知布局拒绝，源会话原生迁移仍缺失。

0.9 实现与证据边界见 [codex-replay-activity.md](analysis/codex-replay-activity.md)。本地244/244；官方CLI实际生成rollback marker并接受合成压缩记录，空display turns不作为语义等价证明。未调用模型。打包宿主99/99、SDK69/69（1248断言），150文件匹配，上游81文件不变；原生UI完成实际活动和有效历史续接验收。

0.9.1 实现见 [cli-lifecycle.md](analysis/cli-lifecycle.md)。新增4项真实host/超时/身份/参数回归；source与packaged分别验证，最新全套和SDK结果以当前报告为准。下一项Claude原生目录，不自动调用模型。

0.10 实现见 [claude-model-catalogue.md](analysis/claude-model-catalogue.md)。新增16项目录/控制回归，本地264/264；官方2.1.31实际初始化返回3项模型且缺effort字段，0user/0模型调用；现代effort控制以公开SDK协议及本地peer单独验证，不宣称旧CLI或实际模型已执行。打包109/109、SDK69/69（1248断言），152文件身份一致，81上游文件未改；原生模型菜单和wire顺序完成验收。

0.11 实现与边界见 [mcp-resources-memory.md](analysis/mcp-resources-memory.md)。P1不同Agent集成已暂缓，P2资源订阅与P3本地memory索引完成有界验收；不将P2/P3整体勾选完成。完整测试和打包结果以当前RESULTS为准。

0.12 实现与限制见 [mcp-oauth-design.md](analysis/mcp-oauth-design.md)。新增18项OAuth专项，本地303/303、打包132/132；本机打包只验证prepare/cancel和OS存储可用状态，协议/UI正向授权采用合成AS及注入加密器，不冒充真实账号或Keychain写入。其余P2/P3继续推进。

0.13 实现与限制见 [profile-web-storage.md](analysis/profile-web-storage.md)。新增10项回归，全套/打包/SDK和原生UI的最终数字以当前RESULTS为准。下一步优先P3跨应用选区/截图和显式全局快捷键，随后退出后调度，先核对已有REA功能证据与OS边界；P2完整来源迁移、DCR/MRTR/现代订阅仍在队列。

0.14 实现/证据/权限边界见 [desktop-tools.md](analysis/desktop-tools.md)。下一步P3退出后调度与standalone/dedicated执行语义：先做明确opt-in的生命周期、去重和退出/卸载设计；不自动安装后台常驻服务。P2完整来源迁移与MCP剩余项保留，P1继续暂缓。

0.15 实现与静态证据边界见 [automation-execution.md](analysis/automation-execution.md)。本轮新增27项，closed-app只是一条显式tick命令，不自动安装/唤醒或持续执行。下一步P3系统作业生命周期和foreground handoff，再补P2迁移/MCP；P1继续暂缓。

0.16 设计与验收范围见 [background-scheduling.md](analysis/background-scheduling.md)。20项新增回归，真实OS fixture不写用户Library安装路径且最终卸载。下一步P2 MCP现代请求/订阅；保留DCR/完整来源迁移及P3其余边界，P1继续暂缓。

0.17 设计与验收范围见 [mcp-modern-subscriptions.md](analysis/mcp-modern-subscriptions.md)。新增21项（20协议/服务、1实际Electron panel含14检查）；现代资源与显式通知流是有界完成。下一步优先P2可审核MRTR输入续传，OAuth身份机制重新核对现代规范；P1不同Agent集成保持暂缓。

0.18设计见 [mcp-input-continuations.md](analysis/mcp-input-continuations.md)。新增17项（16协议/服务、1实际Electron面板含13检查），宿主新增11检查。仅本地现代HTTP工具表单续传；资源/URL/sampling仍缺。下一步核对现代OAuth CIMD/身份机制，并推进明确来源迁移和P3剩余边界，P1暂缓。
