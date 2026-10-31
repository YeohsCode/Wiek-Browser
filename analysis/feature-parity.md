# Vek Browser 功能对齐清单

本清单以新建的 **Vek Browser** 为实现目标。静态设计、源码存在和动态验证是三种不同证据；逐项状态区分已实现、局部验证与剩余缺口；完整E2E结果仍以原始报告为准。验证结果以 `reports/comparison.json` / `reports/comparison.md` 及原始日志为准。

当前版本 **0.6.0**，更新于 2026-10-31；执行进度和下一阶段验收见 [PLAN.md](../PLAN.md)。下文 0.2 表为历史检查点，同名能力以末尾0.3/0.4/0.5/0.6增量和当前报告为准。

公开 SDK 来源：`references/ego-lite`（MIT，aecc5831fc5a9ea01a078b632185992a3a7ac448）；新应用复用副本：`packages/sdk`。闭源安装包行为需要 REA 安装包证据与运行观察补充。

## 浏览器应用与交付面

| 能力 | 设计/验证边界 | 状态 |
|---|---|---|
| Chromium 网页浏览 | 地址输入、搜索、前进后退、刷新、页面可见与焦点 | 已实现；原生UI导航/输入/点击与真实E2E通过 |
| 多标签 | 创建、选择、关闭、popup、新窗口链接归属、重启恢复 | 已实现；创建/关闭/popup等有真实E2E证据；重启恢复未穷尽 |
| Space 工作区 | 用户 Space、Agent Space、多空间切换、状态与持久化 | 已实现；task spaces/control、跨空间与跨轮测试通过 |
| 用户接管 | 手工操作中止 Agent，移交/接管、inactive/permission 错误码 | 待验证 |
| Profile | 列举/创建/选择，cookies/storage 隔离，Space 归属 | 已实现；profile selection/跨空间测试通过；迁移不等价 |
| 已登录浏览状态 | 与 ego 等价的身份/登录导入语义；Chrome 数据与密钥可解密性 | partial：只读选择 Chromium profile 导入书签/历史/macOS v10 Cookies/密码，加密 vault；完整会话/web storage/扩展一键迁移仍未实现 |
| 历史/书签 | 列表、访问、增删、持久化 | 已实现；0.3修复跨Profile UI/增删/迁移归属，真实宿主隔离验证通过 |
| 下载管理 | 正常完成/失败/取消/保存，UI 与 Agent download 协调 | 已实现；全部download/PDF/concurrent/跨轮用例通过 |
| 扩展 | 载入/启用/移除及兼容边界 | partial：解压扩展载入/启停/移除/重启重载；受Electron API限制，无Chrome商店完整兼容 |
| 权限与设备 | Profile/top/requester/capability规则、native提示、once/持久授权/阻止、导航/超时撤销、Agent接管 | 0.3已实现并由真实Chromium query/预阻止request验证；设备chooser/OS授权/已打开stream撤销仍不等价 |
| 剪贴板 | 原生纯文本/HTML paste、原有内容恢复 | Vek Page keyboard interface通过38断言；Ego同项失败 |
| 原生菜单/快捷键 | 多标签、地址栏、开发工具、缩放等实际行为 | 待验证；需实物功能清单 |
| 帐户/ego 服务 | 不伪造账号/云同步/更新端点；服务功能测试按用户允许跳过 | 未验证；无自建等价服务 |
| 安装与升级 | 本地启动、CLI 路径、可打包应用、版本与升级语义 | 待验证；不得标为已发布 |
| Agent CLI | nodejs heredoc/-e、--sdk-path、taskspace、skill/help、失败退出码 | 已实现；打包CLI完整69-case通过 |
| Skill 与插件 | 同版 guide、learnings、九主机包装、用户已装 Skill 不被覆盖 | 待验证 |
| SDK 生命周期 | dispose callbacks/pending CDP/download、异常输出与语法行列 | 532单测、硬停/跨轮真实E2E通过，非穷尽故障证明 |

## 原生桥接

以下方法/属性已由真实 Electron/Chromium 宿主实现；最终打包版69-case E2E全部通过。该结论是整套功能测试覆盖，不是对每个参数组合的穷尽验证。

| 接口 | 状态 |
|---|---|
| `ego.getBrowserVersion` | 已实现；同源真实E2E覆盖 |
| `ego.listProfiles` | 已实现；同源真实E2E覆盖 |
| `ego.useTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.listTaskSpaces` | 已实现；同源真实E2E覆盖 |
| `ego.createTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.claimTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.closeTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.completeTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.handOffTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.takeOverTaskSpace` | 已实现；同源真实E2E覆盖 |
| `ego.setAgentTaskState` | 已实现；同源真实E2E覆盖 |
| `ego.createTab` | 已实现；同源真实E2E覆盖 |
| `ego.listTabs` | 已实现；同源真实E2E覆盖 |
| `ego.snapshot` | 已实现；同源真实E2E覆盖 |
| `ego.animationHighlightMouseToPosition` | 已实现；同源真实E2E覆盖 |
| `ego.sendCDPMessage` | 已实现；同源真实E2E覆盖 |
| `ego.onCDPMessage` | 已实现；同源真实E2E覆盖 |
| `ego.onSendCDPMessageError` | 已实现；同源真实E2E覆盖 |

Snapshot 额外要求：viewport/full/subtree、compact text、唯一 ref、frame provenance、iframe/OOPIF、stable locator identity、DOM 更新/导航失效。CDP 额外要求：root/session 路由、Target 过滤、session 重附加、事件隔离、worker/OOPIF autoattach、dialog/permission 边界。这些都需真实浏览器测试。

## 全部公开 V2 SDK API

来源：`packages/sdk/src/public-api-schema.ts`。复用 SDK 能减少重复实现，但每条 API 仍依赖 Vek 原生桥接正确性；有源码不等于已验证。

| API | 状态 |
|---|---|
| `profiles` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `listTaskSpaces` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `taskSpace` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `claimTaskSpace` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `takeOverTaskSpace` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.spaceId` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.name` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.ownership` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.page` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.userPage` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.pages` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.tabs` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.newPage` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.adopt` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.release` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.waitForControl` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.handOff` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.finish` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `TaskSpace.cdp` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.label` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.spaceId` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.openedBy` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.targetId` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.goto` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.reload` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.snapshot` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.screenshot` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.url` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForURL` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForEvent` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.page` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.url` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.suggestedFilename` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.saveAs` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.path` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.failure` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.cancel` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Download.delete` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForTimeout` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.title` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.info` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.acceptDialog` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.dismissDialog` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.evaluate` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForFunction` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.fetch` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.cdp` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForSelector` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForLoadState` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.events` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.click` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.dblclick` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.hover` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.dragAndDrop` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.fill` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.selectOption` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.focus` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.press` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.setInputFiles` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.waitForFileChooser` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `FileChooser.isMultiple` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `FileChooser.setFiles` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.close` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.mouse.click` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.mouse.move` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.mouse.down` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.mouse.up` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.mouse.wheel` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.down` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.up` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.press` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.type` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.insertText` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |
| `Page.keyboard.paste` | MIT SDK复用；宿主真实E2E覆盖，非逐参数穷尽 |

V1 兼容 helper、CDP/fetch、site tools 与 migration guard 的入口见 `packages/sdk/src/helpers.ts:695`；仍需 helper surface 和 v1/v2 parity 测试。

## 同一真实 E2E 的逐项验证状态

此处是工作清单，运行后应直接查报告，不手动把失败写成通过。未选择的 case 记 SKIP，选中但未产生上游结果记 not_run。

| Case | Ego baseline | Vek Browser |
|---|---|---|
| environment initialization | PASS (23 assertions) | PASS (24 assertions) |
| helper surface | PASS (67 assertions) | PASS (67 assertions) |
| task spaces and control | PASS (58 assertions) | PASS (58 assertions) |
| TaskSpace profile selection | PASS (19 assertions) | PASS (19 assertions) |
| v2 cross-space routing | PASS (4 assertions) | PASS (4 assertions) |
| navigation helpers | PASS (33 assertions) | PASS (33 assertions) |
| observation helpers | PASS (51 assertions) | PASS (51 assertions) |
| pointer and scroll helpers | PASS (45 assertions) | PASS (45 assertions) |
| keyboard and file helpers | PASS (22 assertions) | PASS (22 assertions) |
| keyboard regression | PASS (14 assertions) | PASS (14 assertions) |
| wait, fetch, cdp, js, help | PASS (42 assertions) | PASS (42 assertions) |
| runtime regression | PASS (20 assertions) | PASS (20 assertions) |
| target-scoped event isolation | PASS (4 assertions) | PASS (4 assertions) |
| page labels: create | PASS (13 assertions) | PASS (13 assertions) |
| page labels: restore and reuse | PASS (14 assertions) | PASS (14 assertions) |
| page labels: close and do not reuse | PASS (10 assertions) | PASS (10 assertions) |
| page labels: persist before hard stop | PASS (1 assertions) | PASS (1 assertions) |
| page labels: restore after hard stop | PASS (3 assertions) | PASS (3 assertions) |
| page inventory and budget | PASS (9 assertions) | PASS (9 assertions) |
| page adoption and release | PASS (19 assertions) | PASS (19 assertions) |
| page basic operations | PASS (53 assertions) | PASS (53 assertions) |
| page complex evaluate | PASS (23 assertions) | PASS (23 assertions) |
| page fetch | PASS (25 assertions) | PASS (25 assertions) |
| page actions and popup adoption | PASS (57 assertions) | PASS (57 assertions) |
| Page click hit target | PASS (17 assertions) | PASS (17 assertions) |
| Page action motion tolerance | PASS (6 assertions) | PASS (6 assertions) |
| Page drag and canvas drawing | PASS (15 assertions) | PASS (15 assertions) |
| Page JavaScript dialog handling | PASS (34 assertions) | PASS (34 assertions) |
| Page media playback | PASS (17 assertions) | PASS (17 assertions) |
| Page scrolled screenshot | PASS (13 assertions) | PASS (13 assertions) |
| Page snapshot locator quality | PASS (4 assertions) | PASS (4 assertions) |
| Page snapshot iframe viewport | PASS (13 assertions) | PASS (13 assertions) |
| Page snapshot subtree | PASS (46 assertions) | PASS (46 assertions) |
| Page ref identity across partial snapshots | PASS (14 assertions) | PASS (14 assertions) |
| Page refs across rounds: prepare | PASS (5 assertions) | PASS (5 assertions) |
| Page refs across rounds: resume | PASS (12 assertions) | PASS (12 assertions) |
| Page refs in dialog workflows | PASS (10 assertions) | PASS (10 assertions) |
| Page refs after failed actions: prepare | PASS (8 assertions) | PASS (8 assertions) |
| Page refs after failed actions: resume | PASS (3 assertions) | PASS (3 assertions) |
| Page refs after upload: prepare | PASS (2 assertions) | PASS (2 assertions) |
| Page refs after upload: resume | PASS (3 assertions) | PASS (3 assertions) |
| Page snapshot lazy iframe | PASS (14 assertions) | PASS (14 assertions) |
| Page snapshot sibling iframes | PASS (14 assertions) | PASS (14 assertions) |
| Page snapshot nested iframes | PASS (18 assertions) | PASS (18 assertions) |
| Page snapshot replaced iframe | PASS (11 assertions) | PASS (11 assertions) |
| Page open Shadow DOM locators | PASS (4 assertions) | PASS (4 assertions) |
| Page text locators | PASS (6 assertions) | PASS (6 assertions) |
| Page Playwright selector compatibility | PASS (16 assertions) | PASS (16 assertions) |
| Page popup waiter and URL diagnostic | PASS (11 assertions) | PASS (11 assertions) |
| Page download lifecycle | PASS (8 assertions) | PASS (8 assertions) |
| Concurrent TaskSpace downloads | PASS (13 assertions) | PASS (13 assertions) |
| Page Chromium PDF viewer download | PASS (13 assertions) | PASS (13 assertions) |
| Page download across rounds: prepare | PASS (1 assertions) | PASS (1 assertions) |
| Page download across rounds: resume | PASS (4 assertions) | PASS (4 assertions) |
| Page OOPIF actions | PASS (15 assertions) | PASS (15 assertions) |
| Page OOPIF restore and close | PASS (7 assertions) | PASS (7 assertions) |
| Page load states | PASS (50 assertions) | PASS (50 assertions) |
| Page dedicated Worker startup | PASS (1 assertions) | PASS (1 assertions) |
| Page API alignment | PASS (40 assertions) | PASS (40 assertions) |
| Page actionability | PASS (46 assertions) | PASS (46 assertions) |
| Page evaluate timeout recovery | PASS (24 assertions) | PASS (24 assertions) |
| Page delayed popup: schedule | PASS (1 assertions) | PASS (1 assertions) |
| Page delayed popup: resume | PASS (3 assertions) | PASS (3 assertions) |
| v1 and v2 action parity | PASS (13 assertions) | PASS (13 assertions) |
| portable keyboard workflow | PASS (4 assertions) | PASS (4 assertions) |
| Page keyboard interface | FAIL (26 assertions) | PASS (38 assertions) |
| pure CDP workflow | PASS (9 assertions) | PASS (9 assertions) |
| snapshot workflow | PASS (7 assertions) | PASS (7 assertions) |
| visual workflow | PASS (5 assertions) | PASS (5 assertions) |

## 在线 31 任务的验证前提

完整任务身份见 `analysis/real-world-bench-task-manifest.json`。目前未运行，状态 **blocked**：未为本任务提供已确认的 Stage A / Judge 模型认证和第三方站点登录；未读取个人密钥。后续运行须保持两侧同 benchmark commit、task IDs、agent/model/thinking、judge、limits/concurrency、相近时间及等价登录状态。

公开 benchmark adapter 与最新 SDK V2 的候选空间解析有版本漂移，须同等修复两侧或固定兼容版本。默认 medium 不等于营销 max；公开模型报告 87.1% 不等于对比页 93.5% 的同批原始数据。没有实际运行证据时不生成虚构成功率。

## Vek 0.2.0 本地工作台复刻状态（历史检查点）

本轮继续使用 daemon Evidence `ev_0a7bdc68255ac1adb7db5fd967eaa355b6bbd1830efb7f12c750d8540dcbbee3`，并新增客户端 PAK Evidence `ev_c746b1b63234454354fe180d624d455e35d018a7b6219d016262de3385d93883`。后者确认了此前未列入的偏好、Library、截图标注、操作录制等发货界面；静态存在不等于已确认 Ego 运行可用。完整边界见 [client-resource-feature-ledger.md](client-resource-feature-ledger.md)。

| 功能 | Vek 0.2.0 实现与证据 | 仍有的差距 |
|---|---|---|
| 本地 Agent / provider | 通用 argv CLI；opt-in 原生 Codex app-server，真实 initialize + ephemeral thread/start 无付费探针；流式回复/恢复/审批/用量使用真实 fake wire 测试 | 其余七种 provider 原生协议、真实付费生成未验证；配置目录不代表已认证 |
| 多 Agent 控制 | create/read/list/wait/steer/stop/handoff；父子关系、并发/停止/下一轮排队；native turn steer/interrupt | 通用 CLI 不伪称有原生会话 steering |
| 对话组织和分支 | 归档/置顶/笔记/markers/goal、fork/sidechat、消息编辑重发/回滚、JSON 导入导出 | 回滚仅对话修订；没有自动 Git checkpoint revert；不是 Ego 原生 ZIP 格式 |
| 附件 | 20 MiB/件、10件活跃上限、私有副本、软移除/恢复、native localImage、内联导入导出 | 非图像附件仅真实路径上下文；是否读取由实际 provider 决定 |
| 自动化 | at/interval/UTC 五字段 cron/heartbeat、记忆、提案审批、运行历史、maxRuns/日期/失败停止条件 | 无应用退出后的 OS 调度；无任意时区/DST、完整 standalone/dedicated 执行语义 |
| 文件/Git | 项目范围读写/搜索/tree/watch/冲突/hash、文字与图片预览、实际 Git status/diff/log/branch/stage/commit/stash | 无 remote PR/comment/push；无任意脚本执行/完整 studio 编辑器 |
| MCP | 真实 stdio 客户端、project/thread scope、工具列表/任务等待取消、引用凭据、一次性 pairing、loopback bearer gateway、4个受 Space 控制的浏览器工具 | 无远程 HTTP/OAuth客户端、完整 sampling/elicitation/provider gateway 自动注入 |
| Skills/commands/agents | 本机和项目有界目录、来源与正文、启停、按会话选择、实际 provider context 注入 | 无在线 marketplace / 安装包管理；不改个人全局配置 |
| 语音 | 自建静态 CPU Whisper + multilingual tiny 模型，真实公开音频转写；录音/WAV、停止、词典、语言、历史保留、音频下载、提示音、网页静音恢复 | 麦克风系统权限需用户在 app 中授予；没有 Ego 云端润色/反馈/语音 provider 全兼容 |
| Library/Collections | text/page/url/image、collection/group/tag、软删除恢复、私有本地图片保存 | 页面保存为链接/元数据，不是完整离线网页归档 |
| 截图标注 | 实际网页 PNG、区域裁剪、矩形/箭头/文本、颜色/粗细/字号、undo/redo、PNG 导出；真实 Electron 像素探针 | 当前采集范围为浏览器页面；无系统全屏/跨应用截图权限集成 |
| 操作录制 | 显式 start/stop、当前 target 锁定、可信 click/key/scroll、元素框与截图、限额、软删除恢复与 JSON 导出；真实宿主可信/伪造点击回归 | 不记录字段值/敏感字段；无跨应用 OS 事件采集 |
| 偏好与快捷键 | light/dark/system、真实横竖 tabbar、冲突检查、原生 menu accelerators、用户 instructions、选择工具栏、本地模型开关 | 自定义快捷键限本应用，非 OS 全局快捷键 |
| Memory 开关 | 默认关闭；开启后仅注入当前会话 Space 的去 query/hash 历史摘要和项目顶层文件名 | 没有全局索引/嵌入检索/完整 Memory Workspace；客户端中该界面亦含 demo 数据 |
| 选择工具栏 | 浏览器 DOM 选区 copy/save/ask；ask 只进入草稿不自动发送 | 无 OS 跨应用 AX 选区；translate 后端未实现（不展示可用翻译） |
| Space 与窗口 | 固定、批量关闭（默认保留固定和运行任务）、停止关联任务、最近关闭恢复、真正独立原生窗口并复用 WebContents、托盘后台模式 | 独立窗口保留轻量浏览器工具栏；关闭返回主窗；窗口布局不持久化 |
| Home 快捷网站 | 当前 Profile 的添加/编辑/移除、真实打开 | 不同步到 Ego 云端 |
| Chromium 资料迁移 | 用户选择只读目录、书签/历史、macOS v10 Cookie/密码、系统加密独立 vault、精确 origin 手动填充、逐项失败统计 | 无 Safari、多源 profile 自动发现、完整 IndexedDB/localStorage/扩展/会话迁移；分区 Cookie 不支持 |
| Profile archive | Vek 专用 AES-256-GCM+scrypt 文件，tabs/书签/历史/cookies/可选密码/扩展元数据；恢复到新 Profile | 不兼容未知 Ego export 格式；不传扩展二进制和 web storage |
| 扩展/下载 | 解压扩展路径持久、启停/重载；下载历史/状态保存与中断恢复 | Electron 扩展 API/商店与定制 Chromium 仍不等价；中断下载不自动续传 |

本轮最终服务/原生打包集成结果见 ../reports/RESULTS.md 和原始日志；数字以最后完成的测试为准。保留所有失败/中断尝试，不把单次 SDK gate 或 fake provider 测试解释为全产品 100% 对齐。**全量功能复刻仍未完成**：上表右栏和引擎/专有服务边界仍然存在。

## 引擎版本边界

最终macOS包使用Electron42.11.18 / Chromium148.0.7778.280 / Node24.19.0，Ego0.6.1.13的CLI报告Chromium156.0.8078.48 / Node24.22.1。协议适配通过69个既有用例，不代表全部Web平台特性或自定义Chromium修改等价。实际版本记录在 `reports/package-runtime-versions.json`。


## Vek 0.3.0 继续补齐（覆盖上文对应 0.2 时点）

| 能力 | 当前实现和已完成证据 | 仍然存在的边界 |
|---|---|---|
| Git checkpoint | 命名保存真实 index/staged/unstaged/untracked；预览和显式恢复；恢复前保护checkpoint；21个真实Git/旧工作区测试、实际Electron panel、最终宿主集成 | 普通.git仓库、同HEAD、2MiB/文件、32MiB总量；无自动turn diff/agent rollback绑定、linked worktree/remote PR |
| 远程 MCP | 显式HTTPS+header env refs；legacy Streamable HTTP session/init/JSON/SSE/GET恢复/DELETE，modern工具协议显式选择；25个HTTP/TLS/modern/panel/原stdio测试 | 无OAuth/MRTR/现代订阅/sampling/elicitation；不是全部最新规范；不自动重放工具POST |
| Cron 时区与DST | Intl验证IANA timeZone，UI选择与持久；春季跳过缺失minute、秋季仅首次；spawn前持久预约和重启去重，38个Agent组合回归 | 应用关闭后不执行；at-most-once预约遇crash可丢一次；依赖ICU、offset采样和1830天有界窗口；无OS守护进程 |
| 网站权限 | Profile+顶层origin+请求origin+能力；camera/microphone拆分；allow/block/ask；once/超时/导航/关闭、旧请求身份、原生弹窗AbortSignal，11个专项测试 | 设备chooser/桌面采集/service worker/OS授权/现有stream结束仍不完整；opaque和未知能力拒绝 |
| Profile数据归属 | 书签/历史/下载显示和修改、资料导入/导出的目标Profile；旧未标记行归Default；RPC显式Space派生Profile | 旧版本混入的无标记数据无法凭空判断原Profile；不推测恢复所属 |
| 下载暂停继续 | 真实DownloadItem pause/canResume/resume，2MiB真实限速文件的暂停字节稳定与完整下载验证 | 不承诺跨重启续传；CDP指定路径可能不出现在Electron savePath，SDK负责其路径 |
| 页面右键菜单 | 原生links/images/edit/selection/Library/agent draft/navigation/inspect，打开菜单交还Agent控制 | 独立功能实现，非Ego所有菜单逐像素等价；第三方网页/OS功能仍受其规则 |

本轮完整结果以 ../reports/RESULTS.md 为准。0.3的本地能力增量不能消除完整Chromium替换、其他provider原生协议、Chrome/Safari全资料迁移、OS跨应用功能、翻译、远程PR、Ego专有服务和31项线上benchmark的剩余工作。**全量功能复刻仍未完成。**


## Vek 0.4.0 Agent turn 文件快照

已完成项目显式启用、真实provider运行前后快照、thread/run/native turn关联、逐turn和会话span的真实worktree/index差异、预览/精确名称确认恢复及保护快照。失败/停止/准备期取消/after超限/HEAD变更/并发/导入/fork和实际host SIGKILL后的恢复均有真实临时Git验证。原生UI实际运行本地fixture并完成文件/index恢复，非模拟成功。

完整行为与限制见 [turn-checkpoints-design.md](turn-checkpoints-design.md)。快照仍局限普通小仓库，linked worktree/自动保留/远程PR未完成；本地快照不是外部编辑器隔离，也不回滚浏览器/账号等外部效果。对话回滚仍为单独动作。其余全量复刻缺口继续保留，当前测试入口为 [RESULTS.md](../reports/RESULTS.md)。


## 0.5.0 当前增量：Claude原生协议

本段覆盖此前“只有Codex原生协议”的记录。`claude-stream-json`现有实际NDJSON/control客户端、重启续接、配置/项目会话绑定、逐request批准/拒绝/取消、过期审批、partial去重/UTF-8、工具事件、实际image/PDF/text附件、main-loop token和会话累计费用。修改文件/快照/diff/恢复沿用真实turn生命周期。

新增13个协议测试、本地全套169/169，打包宿主59/59；官方Claude CLI 2.1.31在隔离HOME/无继承认证下initialize成功，0user messages/0model calls。它只证明握手，不能替代模型执行和当前最新CLI验证。最新0.3.316类型声明用于接口参考；该版本可选native下载未完成，其部分文件没有被当成可运行CLI。

仍partial：Claude历史手动选择导入、完整工具结果/subagent展示、原生fork/完整模型能力、MCP gateway自动注入、其他6种nativeprovider和真实付费turn。已有通用CLI或13fixture通过不等于八种原生协议均可用。细节见 [Claude设计](claude-native-design.md) 与 [当前验收](../reports/RESULTS.md)。


## 0.6.0 当前增量：Claude历史与活动记录

本段覆盖0.5中的“Claude历史/工具结果UI缺失”。现有明确选定JSONL→分支预览→来源inode/hash复核→新对话导入；parent链与并行工具结果有界恢复，sidechain/meta隔离，坏尾/循环/混合session拒绝。来源session/外部路径/工具命令不产生执行或恢复权限；后续prompt以可见文本建立新native session，不能称源CLI原生resume/fork迁移。

实时记录tool_result/progress、parent_tool_use_id子消息、task生命周期/usage；旧run迟到事件不覆盖新run。未收到终态明确为unresolved/interrupted。展示有字节/条数上限，不自动读output_file，不在父result后守护后台子任务。所有历史run可查看，native JSON archive保留白名单显示证据。

新增15项专项回归，全套184/184、最终宿主67/67；UI/SDK/官方CLI initialize层级见当前结果。模型推理未执行。其他6种原生provider、模型能力目录、原生源会话迁移、多文件子历史和后台守护仍partial/missing。[设计](claude-history-design.md)。
