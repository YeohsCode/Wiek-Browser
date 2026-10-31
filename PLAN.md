# Vek Browser 复刻计划与进度

更新：2026-10-31（Asia/Shanghai）。当前交付版本：**0.4.0**。项目目标仍是独立复刻 Ego 的可验证功能；**全量复刻未完成**，不以任意百分比或 69 项 SDK 通过代替产品完成度。

## 当前检查点

| 项目 | 已完成的验收 | 当前状态 |
|---|---|---|
| 参考制品与调查 | ego-lite MIT 源码、Ego 0.6.1.13 安装包、31 任务 benchmark 已下载；REA daemon/client 证据及覆盖限制保留 | 已完成有界调查；全部 native/client 路径仍未覆盖 |
| 浏览器 SDK 与宿主 | Space/Profile/多标签、DOM/AX snapshot、CDP、上传/下载、剪贴板、iframe/worker 等；同集测试 Vek 69/69、Ego 68/69 | 当前版本验收完成，非引擎全面等价 |
| 本地 Agent 工作台 | 通用 CLI、opt-in Codex app-server、多 Agent 控制、对话分支/附件/审批/导入导出 | 部分完成；其他原生 provider 和真实付费 turn 未验证 |
| 文件/Git | 受项目范围约束的读写/search/watch；常用 Git 操作；命名 checkpoint、预览/显式恢复/保护快照 | 部分完成；已有 turn 自动关联，linked worktree 和 PR 流程仍缺失 |
| MCP | stdio、scoped gateway/pairing；远程 HTTPS、legacy session/SSE 和显式 modern 工具模式 | 部分完成；OAuth/MRTR/订阅/sampling/elicitation 缺失 |
| 自动化 | at/interval/heartbeat/IANA cron、DST、防重复预约、运行记忆/提案/停止条件 | 部分完成；应用关闭后不调度，standalone/dedicated 不完整 |
| 语音/Library/录制 | 本地 Whisper tiny、语音历史/词典；Collections、截图标注；显式网页操作录制 | 本地范围可用；无 OS 跨应用采集、翻译或云端润色等价 |
| 浏览器界面/权限/资料 | 主题/标签布局/快捷键、独立窗口/托盘；权限隔离；Profile 数据归属；Chromium 选择导入和加密 archive | 部分完成；完整迁移/扩展/OS 设备能力仍有缺口 |
| 交付与基准 | macOS ARM64 应用；156/156 本地测试、53/53 打包宿主集成、81 个上游文件未改 | 本地检查点完成；31 项线上模型任务未运行 |

证据入口：[当前结果](reports/RESULTS.md)、[同集对比](reports/comparison.md)、[逐项功能清单](analysis/feature-parity.md)、[机器可读结果](reports/delivery-summary.json)。532 项 SDK 单测沿用未改版结果；不描述为本轮重新运行。

## 版本进度

- [x] 0.1：独立浏览器宿主、公开 SDK 桥接、同源浏览器测试与基础打包。
- [x] 0.2：Agent 工作台、文件/Git、stdio MCP、Library/标注/录制、偏好/窗口、离线语音、资料 archive。
- [x] 0.3：远程 MCP、命名 Git checkpoint、IANA/DST、网站权限竞态回归、Profile 归属修正、下载暂停/继续、网页右键菜单。
- [x] 当前文档归一：修正 README 旧数字/缺失项，建立本计划及文档索引；整理首次 Git 提交范围。
- [x] 0.4：Agent turn 前后快照、逐 turn/会话差异、明确确认文件恢复、保护快照及失败/中断/真实进程强停恢复。
- [ ] 后续：原生 provider、迁移、MCP 剩余能力、OS 集成与线上基准；按下面顺序推进。

## 执行顺序与阶段验收

### P0 / 0.4：把手动 checkpoint 接入真实 Agent turn

- [x] 在项目明确启用后，保存 turn 前后 checkpoint，持久化 thread/run/turn 与 checkpoint 的关联。
- [x] 提供单 turn/整会话文件差异；将“仅回滚对话”和“恢复文件”明确呈现为各自真实动作。
- [x] 文件恢复沿用预览、当前状态指纹、用户明确确认和恢复前保护快照；保持原有分支/index/stash。
- [x] 处理失败/取消/重启、重复事件、HEAD 改变、不支持的仓库与超限情况；保留可解释的未捕获状态，不伪造快照成功。
- [x] 用真实临时 Git 仓库和本地 provider 验证成功/失败/中断/冲突/保护快照恢复；既有 SDK 用例与断言保持不变。

完成标准：一个实际本地 provider 修改文件后，UI 可查看该 turn 的真实 diff，明确确认后能恢复文件与 index；失败、中断和重启路径有实际测试证据。现有普通小仓库限制需明确显示；linked worktree 支持单独设计与验证，不在无证据时承诺。

### P1 / 下一阶段：原生 provider 与会话完整性

- [ ] 优先补 Claude 原生流式协议、恢复、权限审批、用量和附件，再按证据核对其他 provider。
- [ ] 将 native 历史导入、原生工具事件和模型能力建模接入工作台，避免通用 stdout 被误称为原生协议支持。
- [ ] 协议 fixture、实际本机非推理 readiness 与真实模型 turn 分开记录；付费模型/账号任务需要专用配置和明确执行授权。

### P2：MCP 与资料迁移

- [ ] 补 OAuth、MRTR/订阅和 provider gateway 注入；保持最小 scope、取消、版本边界和无工具 POST 自动重放。
- [ ] 扩展 Profile archive 的可验证 web storage/会话范围与多来源迁移；只使用明确选定的来源，不自动读取个人 Profile。
- [ ] 用合成 fixture 验证迁移兼容、部分失败、取消、冲突和恢复；保留 Electron 扩展 API/定制 Chromium 的边界。

### P3：OS 能力、执行模式与剩余本地功能

- [ ] 设计 OS 跨应用选区/截图/录制及全局快捷键；权限由用户在实际 OS 流程授予，未获权限时明确不可用。
- [ ] 补应用退出后的调度与 standalone/dedicated 执行语义；验证唤醒、去重、卸载/停用与失败恢复。
- [ ] 真实翻译适配、memory 内容索引和远程 Git/PR 流程逐项验收；独立交互终端须先确认 Ego 实际功能证据。

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
