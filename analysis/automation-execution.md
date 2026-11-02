# 0.15 Automation modes and explicit closed-app worker

本轮优先P3，不新增其他Agent集成。独立实现三种执行模式和一次性CLI worker；**未安装系统定时唤醒作业，退出后自动唤醒/前台handoff尚未完成**。

## Ego证据与边界

复用REA Evidence `ev_0a7bdc68255ac1adb7db5fd967eaa355b6bbd1830efb7f12c750d8540dcbbee3`，原artifact root SHA `faefbb871ce738640629c2cd38085e6261f7030d0b11c2ecaee24b269175cae7`。[原调查](shipped-daemon-features.md)只分析3文件，466文件在范围外，语义图partial/truncated。当前session exact-ID查询无retained记录，未假称重取旧图；本轮只读复核匹配身份的shipped daemon `run-DeGOi3G8.mjs`（5,246,451B，SHA `66006b5911bf3368bd3fc13737c889d4f2969e9acde07f1d7c6f9e2993b089bd`）。以下为一基行号，全部是静态实现证据，没有运行Ego或复制闭源代码。

- 25424–25441、25982–25995定义heartbeat继续目标、standalone每次新建、dedicated首次新建后复用专属线程。不同入口默认不同，不能称产品统一默认。
- 82325–82337、82670–82784：run ID唯一，continuation走turn start；无continuation则create，不带源历史/fork参数，dedicated首次绑定。115330–115333绑定仅在NULL时写入。
- 25444–25494、82691–82697：所有mode注入automation memory；持久上限32KiB、每次尾部注入8KiB有截断标识。memory不是完整源历史。
- 83600–83638、83700–83720：busy/审批/input与cooldown会延期；本轮Vek仍沿用跳过重叠/容量的有界语义，不称等价。
- 83567–83592、83163–83173：取消run尝试指定turn中断；delete取消活动run并archive definition，保留线程历史。best-effort中断不证明实际进程已停。
- 82028–82034、83330–83352、82871–82885：恢复reconcile已有turn；缺失时interrupted，无直接自动重放create/start。不能说崩溃后无缝续跑或exactly-once。

## Vek契约

`executionMode`与既有时间安排`kind`分开。旧数据/新建默认heartbeat，保持原target行为；`kind:heartbeat`是兼容保留的间隔类型，不强制executionMode。

| Mode | Vek线程行为 |
|---|---|
| heartbeat | 用定义的threadId追加；保留该线程已有可见历史/附件。忙时跳过，不抢占 |
| standalone | 每次新建线程；只复制template的project/provider/model/effort，不复制消息、附件、native ID/绑定/catalog或browser Space authority |
| dedicated | 首次新建并持久绑定ownedThreadId，后续继续；同样从干净线程开始。缺失/归属改变不自动换新，归档时明确失败 |

所有mode可加用户明确配置的automation memory。该字段仍沿用现有65,536字符有界本地notes，不声称与Ego的UTF-8 envelope上限/工具契约相同。`threadId`是目标或设置template，`ownedThreadId`/`lastRunThreadId`由服务产生；调用者不能写入binding authority。

一条定义同一时刻最多一个run，包含standalone。容量/项目lease失败时不遗留空线程。scheduled先持久推进nextRunAt和reservation，再创建线程/启动；crash不自动重试预约，可能丢一次，非exactly-once。恢复runCount从所有线程关联run统计。

Dedicated拒绝外部prompt/steer/编辑/resend/rollback/model/附件/删除及proposal accept等写入，界面无手工composer；仍允许查看、重命名、归档、明确审批/停止、fork到独立会话和文件差异查看。删除automation停止其实际进程并释放保留线程；删除template会停止关联run。Pause只停未来，Stop同时取消当前。运行中不能换mode/template，空闲更换会释放旧绑定。导入创建新IDs、provider禁用、automation暂停、closed-app consent清除，既有owned绑定不继承；导入历史不获得执行或恢复权限。

## 一次性worker

`node cli/vek-browser.mjs scheduler tick [--timeout-ms 60000]` 使用同一`VEK_DATA_DIR`。只运行启动cutoff已到期、active且`closedAppAllowed:true`的普通CLI任务。开关默认false，逐定义明确配置。Native provider/审批UI不支持，配置时拒绝，后续provider改变时也会skip且不消耗预约。未启用/未来到期的任务保留给后续tick或浏览器。

Worker不打开Chromium/网页Profile，不做模型发现，不监听端口/安装daemon或修改launchd；不会唤醒睡眠的机器，也不会持续轮询。继承正常CLI可见环境，使用已配置provider argv无shell；不采集新凭据。只读现有经过限额/非symlink校验的user instructions；不重写preferences，不注入浏览历史、文件目录、MCP或skill catalogue。新线程无源历史/附件；heartbeat保留自身已有显式内容。provider上下文设`VEK_BROWSER_AUTOSTART=0`，本地CLI无法偷偷启动浏览器。

Agent状态锁是唯一writer lease；worker不清理任何既有锁，live/stale都返回`skipped-locked`，提示用浏览器恢复陈旧锁。与浏览器同时启动的原子wx竞争只有一方写入；没有自动前台handoff，浏览器也不会静默接管worker。关闭/timeout/signal等待实际provider退出和before/after checkpoint收尾再释放锁。任务仍使用同一workspace/turn-checkpoints范围，不在headless模式跳过保护。

默认timeout60秒，可选25毫秒至1小时。过期或SIGINT/SIGTERM标interrupted，保留真实输出/文件快照，无自动重放；SIGKILL/OS崩溃仍需前台恢复陈旧锁。CLI exit0只表示tick收尾完成，失败provider在attempt outcome中记录，不能按0一概算任务成功。stdout只含IDs/outcome，不含provider正文；输出保存在私有Agent transcript。

## 验收与剩余

[当前结果](../reports/RESULTS.md)记录最终服务/打包/SDK数字。新增测试使用真实Node fixture进程、临时Git仓库和Electron UI；无真实模型/账号。普通CLI worker的正向调度、互斥、signal/timeout、failure、cutoff、user instructions、browser autostart拒绝和真实快照有回归。原生UI与发行CLI组合流程另见本轮QA，不冒充OS job自动唤醒验收。

后续P3：明确opt-in的macOS launchd安装/状态/停用卸载、稳定runtime路径、前台handoff、休眠后合并/失败恢复；继续保留Ego cooldown/defer、completion contract与更多native模式的边界。0.14原生正向截图/选区仍待确认。P2完整来源迁移与MCP剩余项保留，P1其他Agent继续暂缓。
