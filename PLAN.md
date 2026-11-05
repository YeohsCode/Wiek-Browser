# Wiek Browser 复刻计划与进度

更新：2026-11-05（Asia/Shanghai）。当前源码检查点：**0.21.0（橙白标识、完整 V2 框架接入、linked worktree、中英/中西翻译）**；原品牌历史基线：**0.19.0（Vek）**。项目目标仍是独立复刻 Ego 的可验证功能；**全量复刻未完成**，不以任意百分比或 69 项 SDK 通过代替产品完成度。

## Wiek 改名与首个远程检查点

- [x] 产品名、主窗口/菜单/托盘/协议 client 名称改为 Wiek / Wiek Browser，应用包标识为 `app.wiek.browser`。
- [x] canonical CLI 为 `cli/wiek-browser.mjs`，旧命令入口兼容；`WIEK_*` 配置优先，旧 `VEK_*` 与归档格式兼容。
- [x] 新安装使用 Wiek 数据目录；原目录存在时原地复用，不自动移动个人资料。
- [x] 提供 English README 与 `README.zh-CN.md`；历史 0.19 README 保存在 `docs/history/`。
- [x] 本轮源码 498/498、打包宿主 197/197、190 个发行文件匹配，已提交 `d2d588e` 并推送到 `https://github.com/YeohsCode/Wiek-Browser.git`。
- [x] 已推送改名与 CI/翻译修复；继续完成桌面正向链路、P4 干净检出与基准准备。

## 当前执行优先级

按用户最新要求（2026-11-01）：**先跳过 P1 中不同 Agent 的集成，优先 P2、P3**。Cursor 未完成的代码已从工作树移出，保存在本机 Git stash `31764915635554521270725e0d0c38e178eea3cf`（`deferred P1 Cursor ACP work; prioritize P2 P3 2026-11-01`）；不是 0.11 发行功能，普通 clone 不包含该本机 stash。

当前顺序：P2有界资料web storage归档已完成 → P3单次采集/全局快捷键已实现有界范围 → 执行模式与显式closed-app tick已实现 → P3有界login job/前台接管已实现 → P2现代HTTP资源/显式订阅已实现 → 有界工具表单MRTR已实现 → 有界CIMD/客户端身份已实现 → P3 busy延期/completion、P2明确来源完整迁移与OAuth剩余项；继续保留执行模式剩余语义、翻译与远程Git。涉及 provider gateway 的集成部分随 P1 暂缓；不删除剩余目标。

## 2026-11-04 P3 集成进度（0.20 检查点）

当前优先级是完成全部 P3；P1 其他 Agent 集成继续暂缓。以下为 0.20 集成状态；源码与打包宿主回归通过，不作为 P3 全部完成的证明。

| P3 工作项 | 当前进展 | 下一步验收 |
|---|---|---|
| 自动化忙碌延期、完成条件、运行记忆/结果与崩溃恢复 | 核心、CLI 与编辑器已实现；最新 lifecycle/evaluator 日志 18/18，独立 process 检查日志 62/62；这些集合可能重叠，不相加当作总数 | 已接前台 Electron powerMonitor 并通过整体回归；继续真实系统切换与 closed-app Node 的 OS 事件边界验收 |
| 被动选区工具栏、按应用原生录制 | 服务、Swift helper、界面与主窗口接线已实现；一次性 AX 选区已获得正向合成内容；已修复 annotated-session 事件监听；源码 host 的实际选区、工具栏 Copy、应用录制截图与安全输入边界通过 | 补物理权限撤销、多显示器以及更广泛应用矩阵；源码 host 的正向证据不代替最终包的 OS 权限验收 |
| 翻译 | 本地 JSON CLI、界面、Argos 适配与安装命令已实现；中英双向模型安装完成；服务/工具栏专项 4/4；首次 Stanza 兼容失败已修复，MiniSBD 预热后真实中英双向服务样例通过 | 继续更多语种与发行包场景验收；模型与 Python runtime 不包含在当前应用包内 |
| 远程 Git / PR | 显式审核的 fetch/pull/push/lease 与 GitHub PR 流程已实现；初轮 35/35 包含真实本地 bare remote 与协议 fixture | 关闭等待、diff 截断和 Electron 面板已补并回归；PR 仍仅合成 gh 协议，未执行真实账号写操作 |
| 系统边界与终端证据 | 睡眠/登录切换未执行；独立交互终端只有静态图标/协议线索 | 单列真实系统验收，不用模拟测试冒充；没有充分证据前不宣称 Ego 存在完整独立终端 |

完成顺序：修复原生监听和剩余边界 → 真实翻译与桌面 QA → 全量本地/打包回归与同集 SDK 对标 → 更新文档、发布记录与 commit。P2 的 OAuth 剩余项和完整来源迁移在 P3 收尾后继续；P4 线上模型基准与签名发布仍未开展。

## 当前检查点

| 项目 | 已完成的验收 | 当前状态 |
|---|---|---|
| 参考制品与调查 | ego-lite MIT 源码、Ego 0.6.1.13 安装包、31 任务 benchmark 已下载；REA daemon/client 证据及覆盖限制保留 | 已完成有界调查；全部 native/client 路径仍未覆盖 |
| 浏览器 SDK 与宿主 | Space/Profile/多标签、DOM/AX snapshot、CDP、上传/下载、剪贴板、iframe/worker 等；同集测试 Wiek 69/69、保留Ego 68/69 | 0.20.3 共享修复 SDK 下重新完成两侧同集验收，非引擎全面等价 |
| 本地 Agent 工作台 | 通用 CLI、opt-in Codex app-server/Claude stream-json/OpenCode ACP、多 Agent 控制、对话分支/附件/审批、Claude选定历史分支、Codex有效rollout压缩/回滚导入及实时工具/子活动、Codex/Claude模型与effort目录 | 部分完成；其他5种原生 provider、源CLI原生会话迁移/后台任务和真实付费 turn 未验证 |
| 文件/Git | 受项目范围约束的读写/search/watch；常用 Git 操作；命名 checkpoint、预览/显式恢复/保护快照 | 部分完成；已有 turn 自动关联，0.21 已补 linked worktree 独立 index/refs；已补有审核的远程 Git/PR 流程，真实 PR 账号验收待执行 |
| MCP | stdio、scoped gateway/pairing；远程 HTTPS、legacy session/SSE 和显式 modern 工具模式 | 部分完成；已补 session 资源/模板/订阅；已补预注册public OAuth/PKCE与加密绑定；现代HTTP资源/列表与更新订阅已补；已补本地工具form MRTR；已补有界CIMD/身份审核；托管身份/DCR/step-up/sampling/URL与资源MRTR仍缺失 |
| 自动化 | at/interval/heartbeat/IANA cron、DST、防重复预约、运行记忆/提案/停止条件 | 0.16新增明确审核的macOS login job/前台接管；三种mode和closed-app tick可用，物理sleep/login撤销未实测，0.20 已补 busy 延期、turn contract、completion evaluator 与 SIGKILL 恢复守护 |
| 语音/Library/录制 | 本地 Whisper tiny、语音历史/词典；Collections、截图标注；显式网页操作录制 | 本地范围可用；新增显式网页/项目文本 memory 索引；0.14增加显式OS单次采集；0.20.1 有界源码 host 的被动选区/工具栏 Copy/指定应用录制正向通过，真实中英翻译通过；物理系统兼容矩阵仍待验收 |
| 浏览器界面/权限/资料 | 主题/标签布局/快捷键、独立窗口/托盘；权限隔离；Profile 数据归属；Chromium 选择导入和v2显式web storage加密archive | 部分完成；完整迁移/扩展/OS 设备能力仍有缺口 |
| 交付与基准 | macOS ARM64 应用；512/512 本地测试、532/532 SDK、197/197 打包宿主集成、81 个上游文件未改 | 0.20.3有界检查点完成，201个发行文件匹配，31 项线上模型任务未运行 |

证据入口：[当前结果](reports/RESULTS.md)、[同集对比](reports/comparison.md)、[逐项功能清单](analysis/feature-parity.md)、[机器可读结果](reports/delivery-summary.json)。532 项 SDK 单测在本轮重新运行通过；Ego 0.6.2.7 新运行仍为 HTML paste 单项失败，原 0.6.1.13 日志另存 reports/history/；历史版本数据仍保留。

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
- [x] 0.18：本地现代HTTP工具表单MRTR审核/续传/取消、作用域与不保存输入、原任务截止时间和重启清理。
- [x] 0.19：显式HTTPS CIMD、无网络公共模板、只读身份审核、精确issuer与加密预注册身份绑定。
- [ ] 后续：优先 P2/P3 剩余项；不同 Agent 的 P1 集成暂缓，线上基准仍属 P4。

## 执行顺序与阶段验收

### P0 / 0.4：把手动 checkpoint 接入真实 Agent turn

- [x] 在项目明确启用后，保存 turn 前后 checkpoint，持久化 thread/run/turn 与 checkpoint 的关联。
- [x] 提供单 turn/整会话文件差异；将“仅回滚对话”和“恢复文件”明确呈现为各自真实动作。
- [x] 文件恢复沿用预览、当前状态指纹、用户明确确认和恢复前保护快照；保持原有分支/index/stash。
- [x] 处理失败/取消/重启、重复事件、HEAD 改变、不支持的仓库与超限情况；保留可解释的未捕获状态，不伪造快照成功。
- [x] 用真实临时 Git 仓库和本地 provider 验证成功/失败/中断/冲突/保护快照恢复；既有 SDK 用例与断言保持不变。

完成标准：一个实际本地 provider 修改文件后，UI 可查看该 turn 的真实 diff，明确确认后能恢复文件与 index；失败、中断和重启路径有实际测试证据。现有普通小仓库限制需明确显示；0.21 已补 linked worktree 支持并以真实临时仓库验证，见 analysis/linked-worktree-checkpoints.md。

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
- [x] 0.19：显式HTTPS CIMD、公共JSON模板/身份审核、固定callback、精确issuer和已有密文pre-registration发行方绑定。
- [ ] Vek托管客户端身份、OAuth DCR/完整step-up；资源/URL MRTR、sampling/roots、现代stdio与prompt通知仍缺失，保持最小scope、取消、版本边界和无工具POST自动重放。
- [ ] provider gateway 注入随 P1 不同 Agent 集成暂缓。
- [x] 0.13：显式打开顶层HTTP(S) localStorage与当前origin per-tab sessionStorage；v2/v1、UTF-16、无网络bootstrap、新Profile、active index和CHIPS语义验证。
- [ ] 明确来源多浏览器迁移及IndexedDB/完整会话仍缺失；只使用用户选定来源，不自动读个人Profile。
- [x] 0.13有界archive使用合成fixture验证兼容、部分失败、取消、冲突、恢复；不代表完整浏览器迁移或退出后会话已完成。

### P3：OS 能力、执行模式与剩余本地功能

- [x] 0.14有界实现：单次OS截图与AX选区读取、默认关闭/按应用排除、全局快捷键、预览与明确使用；权限由真实OS流程授予，不伪造成功。
- [x] 0.20.1：明确启用的被动选区工具栏、指定应用录制、目标框/真实PNG、安全输入过滤与孤儿监听自停；源码 host 的正向结果见桌面验收。
- [ ] 物理多显示器、实际权限撤销、最终包的 OS 权限和更广泛应用矩阵仍待验收。
- [x] 0.15：heartbeat/standalone/dedicated线程生命周期；显式closed-app单次CLI tick，默认关闭、非native provider、预约去重、锁互斥、signal/timeout/真实快照。
- [x] 0.16：明确opt-in的macOS login job安装/停用卸载、runtime变更阻止执行、foreground等待真实收尾；真实一次性launchd fixture完成bootstrap/运行/卸载。
- [x] 0.20：busy/input/approval 延期、cooldown、32KiB memory/8KiB提示尾部、notify/silent contract、独立受限停止评估、真实 SIGKILL/no-replay/孤儿PID阻塞已实现并测试。
- [ ] 物理sleep/wake、logout/login/OS后台项撤销和更多安装布局仍需验收；前台 Electron 与 closed-app Node 的 OS 事件感知范围不同。
- [x] 0.11：显式网页/项目UTF-8文本memory内容索引；Profile隔离、中文/英文literal搜索、保存副本/重建、删除与取消/开关清除。非语义/全磁盘索引，不自动注入Agent。
- [x] 0.20.1：Argos/MiniSBD 真实中英双向服务样例（推理阻止socket连接）、实际 Electron 翻译控件；远程 Git 的真实本地 bare repo、PR 合成 gh 协议与面板验收。
- [ ] 更多翻译语种及真实 PR 账号路径仍需明确配置；独立交互终端静态证据不足，保留 unknown，不以图标推断完整功能。

### P4：同条件线上基准与发布

- [x] 0.21 完整共享 V2 框架 adapter：相同补丁/SDK；59 项框架回归、14 项控制边界和两侧实际截图/AX/清理 hook 通过，未运行模型。
- [ ] 获得专用 Stage A/Judge 模型配置与必要站点测试账号后，执行同 commit/task/model/thinking/limits/login 条件的 31 任务基准。
- [ ] 分别统计成功、失败、未运行和确实依赖 Ego 专有服务的跳过；不套用营销成功率。
- [x] 建立 Wiek 独立 CI、固定 action SHA/依赖/模型身份、干净检出的上游测试资料恢复；已推送并触发远端队列。
- [x] 远端完整 CI：代码提交 `b50f9b7`，运行 [41830745101](https://github.com/YeohsCode/Wiek-Browser/actions/runs/41830745101) 成功；含532 SDK、512本地、197宿主、69浏览器和发行/品牌身份核对。
- [x] 完整 SDK V2 Stage A adapter 已接入；签名/公证及正式发布仍待完成，代码推送不等于发布签名安装包。

## 提交与验证约定

- 首次仓库根为 `vek-browser/`。提交独立实现、MIT SDK/测试、文档、结构化结果和本地测试日志；用户后续已明确授权推送到 YeohsCode/Wiek-Browser，当前按该授权持续提交与推送。
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

0.19设计见 [mcp-client-identity.md](analysis/mcp-client-identity.md)。新增20项（19协议/服务、1实际Electron面板含20检查），OAuth专项38/38。显式CIMD要求自行托管HTTPS文档及固定callback；没有自动托管/注册回退。下一步P3 busy延期/completion，来源迁移和OAuth其余范围保留；P1暂缓。

## 推送后的 P3 / P4 推进（2026-11-04）

- [x] P3 翻译：切换为安装时预热的 MiniSBD；真实中英双向样例经服务/子进程通过，推理阻止 socket 连接。保留最初 Stanza 失败日志；界面与更多语种继续验收。
- [x] P4：新增独立 macOS ARM64 CI（固定 action SHA、只读权限、锁定依赖、SDK/本地/打包/同集用例）。远端首次执行结果待记录。
- [x] P4 干净检出：固定两份 SDK 依赖的上游 workflow 资料，自动恢复为忽略的测试输入；测试断言未改，独立临时树的 4 项上游断言通过。
- [x] P4 模型恢复：固定 Whisper URL/大小/SHA-256 的恢复命令；不将权重放入 Git。
- [x] P4 静态就绪检查：31 个任务 ID 与当前参考 checkout 顺序一致，5 项需登录、6 个平台、1 个附件；不是 benchmark 成功率。
- [ ] P4 adapter 仍需适配 canonical SDK V2；需要固定两侧模型/思考/限额/任务/账户状态后才可跑线上对比。没有执行付费模型或真实账号任务。

## 0.20.1 最终验收

- [x] 桌面原生源码host正向链路及parent-exit守护；真实中英翻译服务、实际Electron翻译面板。
- [x] 完整本地500/500、SDK532/532、打包宿主197/197、同集69/69与1,248断言；192个发行文件匹配。
- [x] 原始失败日志保留；源码host结果不代替最终包OS验收。
- [ ] 继续P3物理系统边界/多显示器/实际权限撤销；OS绑定加密凭据迁移仍是P2缺口。
- [ ] 继续P4远端CI验收、共享SDK V2 adapter与专用模型/账号就绪、签名/正式发布。

## 0.20.2 独立标识与 P4 构建修复

- [x] 独立 SVG W 标识及单色托盘图标，接入窗口、Dock、侧栏/欢迎页、favicon 和两种 Skill；替换兼容 Skill 中的两张原 Ego 图片。
- [x] ICNS/PNG 可从独立 SVG 重建；开发渲染器锁定版本，发行包检查自有 ICNS 及已知原 Ego 图片身份。
- [x] 读取远端 run 41690733098 的真实失败日志；补齐被 Git 忽略的 SDK Skill references，不改原始断言。
- [x] 用 staged 源码导出进行 SDK 构建，不借用忽略的 Skill 目录；SDK 532/532、本地 500/500 通过。
- [x] 最终包 197/197、同集 Wiek 69/69（1,248 断言）、201 文件身份与 81 上游输入未改；原图 hash 0 命中。
- [x] 核对 V2 taskSpace 创建/截图 Page/finish 保护语义，写明共享 adapter 实现与双侧 smoke 设计。
- [ ] 新远端 CI 结果待验收；P3 系统矩阵与 P4 共享 V2 adapter/线上基准仍保留。

### 0.20.2 P4 第二轮干净 CI 与 V2 控制原语

- [x] 远端 41824900816：SDK/native/local 500/500/模型恢复/应用构建通过；打包宿主发现第二份遗漏输入 `downloads/voice/jfk.wav`。
- [x] 把同一 WAV（SHA-256 `59dfb9a4…7860e`）移入版本化测试夹具，保留 MIT 项目许可与转录断言；未修改 SDK 断言。
- [x] 共享 V2 控制原语及 11/11 边界专项：精确现存 ID、active Page 截图/AX、保护未知页和结构化结束 receipt。
- [x] 同一 SDK、控制源码和 loopback HTML：Ego 0.6.2.7 与 Wiek 0.20.2 双侧跨进程恢复、真实 PNG/AX、结束及缺失任务幂等全部通过；0 模型/账号操作。
- [x] WAV 夹具修复后打包宿主重跑 197/197 通过。
- [ ] 共享控制原语尚未接入完整 Stage A adapter；线上 benchmark 与新远端完整 CI 结果待验收。

## 0.20.3 共享 SDK 竞态与 CI 视口

- [x] 远端 41826077172：原生编译/SDK/本地 511 项/模型/构建/打包宿主均通过；浏览器回归出现媒体视口和旧 popup 更新竞态，后续 Page budget 失败为残留页级联，原始日志保留。
- [x] 新回归修复前失败、修复后通过；SDK waiter 在注册时记录已发现目标，后续旧 URL/title 更新不能当作新 popup。保留上游测试与 fixture，两个浏览器使用同一修改后的 SDK。
- [x] 原有 SDK 532/532、完整本地最终重跑 512/512、打包宿主 197/197；首轮一个合成 PR 操作超时已保留，单例及完整重跑通过。
- [x] runner-only 显示配置脚本 typecheck 与本机拒绝执行通过；远端 41828102389 的显示配置步骤成功。
- [x] 新 SDK b4ddb961…fec13 下，Wiek69/69（1,248断言）、Ego0.6.2.7为68/69（1,235断言、HTML paste失败）；201个发行文件匹配、81原始输入未改；两侧V2 smoke通过。
- [x] 显示配置改用 session transaction，第二个独立进程确认1600×1200保持；首版进程退出恢复的问题保留原始日志。
- [x] 保留远端短墙钟预算531/532的初轮失败；全部阈值/断言不变，单文件并发后532/532，整条远端CI于41830745101成功。

## 下一步（0.20.3 后）

1. 将共享 V2 控制原语接入完整 Stage A：能力探测、Skill配对、canonical任务候选解析、严格实例guard、固定viewport及截图/结束receipt；两侧使用同一补丁。
2. P3继续最终包的OS权限、物理多显示器/权限撤销、sleep/login边界与更多翻译语种；需要真实环境证据的项目保持未验收。
3. 线上31任务需要专用Stage A/Judge配置与测试账号；签名/公证需相应配置。尚未执行付费模型/真实账号任务，不以本地69项代替线上得分。

## 0.21 当前验收（2026-11-05）

以下覆盖前文历史检查点的“下一步”，不把仍依赖真实设备/账号的项勾成完成。

- [x] 按用户要求改为橙色背景、底部白色渐变、白色右上圆点；所有应用/Skill PNG/ICNS 从独立 SVG 重建，最终包 ICNS 匹配、原 Ego 两张图片 hash 零命中。
- [x] 完整 benchmark overlay 纳入版本控制，可按固定 commit/原文件/任务数据/parser 身份重复安装；不只修改忽略的参考 checkout。探测、Skill、严格语法 guard、截图/AX hook、清理/队列 purge 均接入。
- [x] 59 项框架回归（33 新增 + 26 原框架）、14 控制边界通过；Ego0.6.2.7/Wiek0.21.0 的实际 registry/hook 双侧 smoke 通过，固定1280×800，恢复视口、校验新 marker/hash/receipt；0 模型/账号操作。
- [x] linked worktree 手动/turn checkpoint：每个工作树独立 index lock 与 refs；6 项真实 Git 新回归，包含主/另外工作树不被恢复影响、GC/detached、metadata/identity 拒绝。
- [x] 翻译安装器支持显式语言方向；中英/中西四例通过源码与打包服务，推理禁止 socket。首轮模型未预热失败保留；模型和 Python 不随包分发。
- [x] 当前本地522/522、打包宿主197/197、Wiek同集69/69（1,248断言）；202发行文件匹配、81上游输入未改。SDK未改，沿用相同b4ddb961…fec13及其此前532/532证据。
- [x] 最终包只读OS状态：screen/accessibility granted；已停止本轮独立检查进程。不是原生采集正向证明。
- [x] 当前远端 run41952407500 完整成功：532 SDK、522本地、59框架回归/实际Wiek hook、197宿主、69浏览器/1,248断言、202发行文件和品牌检查；验证代码提交57cc0a1。
- [ ] P3外部验收：最终包原生正向、物理多显示器/实际撤权、sleep/wake/logout/login/后台项撤销和更广应用矩阵。当前未物理切换系统会话。
- [ ] P4线上31任务：仍缺专用Stage A/Judge模型/思考/限额与测试账号；已向用户请求配置位置，不读取个人默认资料或执行付费模型。
- [ ] 正式发布：仍缺Apple签名/公证配置。P1其他Agent暂缓；P2剩余OAuth/迁移等继续保留，不能据本检查点宣称全量复刻完成。

下一步：本轮新增CI阶段已完整验收通过；获得专用配置后跑两侧同条件31任务、记录实际成功/失败/服务依赖跳过，再完成签名发布和真实设备矩阵。P2后续代码缺口以其原清单继续实施。

最终包原生UI尝试记录：[attempt](reports/p3-v021-native-package-attempt.json)。CUA选中已有的“替换当前项目”确认框，未点击或替换；测试fixture和本轮独立包实例已停止。干净参考checkout的59项adapter回归再次通过：[clean](reports/p4-v2-clean-regression.log)。
