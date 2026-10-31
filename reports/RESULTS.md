# Vek Browser 0.8.0 当前结果

本轮新增Codex分页原生模型目录、推理强度和输入能力选择、执行前刷新，以及选定rollout可见历史预览/导入。继续导入对话时创建新owned session，不继承来源会话执行权限。**全量Ego复刻仍未完成。**

| 验证 | 完成结果与证据 |
|---|---|
| SDK E2E | **Vek 69/69，1248断言**；同输入哈希的保留Ego基准 **68/69，1235断言**；两侧0跳过/0未运行。[对比](comparison.md)、[本轮日志](v080-package-sdk.log) |
| 本地全套 | **223/223**，新增14目录/能力和7历史回归，现有Electron panel扩展Codex模型/effort与历史导入检查。[日志](v080-service-tests.log) |
| 打包宿主 | **92/92**，新增目录0执行→选择→刷新/effort→实际编辑/diff/恢复，以及rollout预览/导入→新会话和来源变更拒绝。[日志](v080-package-workbench.log) |
| Codex集中专项 | **26/26**，21项新增、4项原有native和真实Electron panel。[日志](v080-codex-tests.log) |
| 官方Codex CLI | **0.142.0**净化HOME/CODEX_HOME、无继承认证：initialize+分页model/list成功，5个带effort的模型项；创建临时thread并inject两条合成raw history，真实rollout解析成功。**0 turn/start、0模型调用**；目录不证明访问授权。[报告](v080-codex-readiness.json)、[schema身份](v080-codex-schema-identities.json) |
| 原生UI | 原生模型/effort菜单→实际wire请求→macOS文件选择器→官方合成rollout预览→idle且0执行→新owned session复制文字续接。[QA](v080-native-ui-qa.md)、[wire核对](v080-native-ui-check.json) |
| 打包/上游身份 | **148文件匹配**，81上游测试/fixture未改，SDK bundle与两侧比较一致。[校验](v080-package-verification.log) |
| 保留验证 | SDK532/532单测、CDP22/22、Claude 2.1.31与OpenCode 1.19.5无推理readiness、0.6/0.7原生UI；本轮没有重新执行。Ego基准为2026-10-30完整记录，同hash检查通过 |
| 官方31线上模型任务 | **未运行**，缺任务专用模型配置与必要站点测试登录，不计通过或Ego服务跳过 |

## 当前行为和边界

Codex模型发现仅initialize/initialized/model/list，不创建native thread、执行run或用户消息；沿用并发槽、project lease、停止和重启中断规则。目录最多16页/256可见模型，过滤hidden、去重复并拒绝循环cursor。model slug、efforts/default/inputModalities/isDefault由实际响应读取。UI按所选模型展示effort，发现后的每个turn重新校验；已知不支持的image或失效model/effort在turn/start之前失败。空选择在有目录default项时明确把同一model slug传给原生turn，避免校验与旧session实际模型不一致。无目录的旧手工model配置仍兼容，不冒充能力校验。

所选JSONL经过NOFOLLOW/regular fd、有界稳定读取、严格UTF-8/完整JSON、单session和重复ID冲突校验，预览token最多4个/15分钟，导入重新检查inode/hash。32MiB文件、20000行、4MiB每行、1MiB每条/8MiB总文字。只复制支持的response_item user/assistant文本和有界function-call显示结果；重复event消息、生成AGENTS/environment、system/developer/reasoning排除。图片/文件留不可用占位，不跟随引用路径。

压缩、回滚、revert和未知record布局明确拒绝；不称完整Codex源CLI迁移。导入0runs/无native ID，只有之后明确prompt才使用复制文字建立新session。源session、指令、工具、配置、路径或archive元数据不能赋予执行/checkpoint恢复权限。Codex历史工具证据能显示，统一原生实时工具/子Agent活动仍缺失。

修正native Codex分块UTF-8、加载期重放隔离、不同resume身份/外来thread事件、未知完成状态及重复/超量server request处理。旧事件可能不含threadId，仍兼容而不宣称完整来源身份。官方CLI目录可能bundled/cached，未验证认证/模型推理；本机全局npm CLI缺平台依赖，改用应用自带CLI完成验证，未修改用户全局安装。

本轮69项SDK完整回归后，最后修正了Agent默认模型选择；该修正重新验证本地全套与打包宿主。SDK和浏览器宿主桥接没有改变，最终核对bundle及宿主源码身份；没有把该provider修正说成又跑了一遍SDK。

[设计](../analysis/codex-capabilities-history.md) · [计划](../PLAN.md) · [功能清单](../analysis/feature-parity.md) · [文档索引](../docs/README.md)

## 下一步与剩余工作

下一项补Codex压缩/回滚历史语义和实时工具/子Agent活动，再推进Claude目录及剩余5种native provider（Cursor/Devin/Antigravity/Grok/Droid）。仍缺源会话原生迁移/后台任务、自动MCP注入、linked worktree/远程PR、完整资料/web storage/扩展迁移、MCP OAuth/MRTR/订阅、OS跨应用与翻译、退出后调度、memory index、Ego专有服务及线上benchmark。

CLI stop仍为关闭请求，同目录立即start需等待host实际退出；后续应补退出等待契约和真实进程回归。普通小Git仓库/同HEAD快照边界不变。最终应用`dist/mac-arm64/Vek Browser.app`，正常用户版实际报告0.8.0；无远程发布。Electron42.11.18 / Chromium148.0.7778.280仍不等价Ego Chromium156的完整引擎能力。

[模型/effort](v080-native-model-effort.png) · [历史预览](v080-native-history-preview.png) · [续接](v080-native-import-continuation.png) · [结构化结果](delivery-summary.json)
