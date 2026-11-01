# Vek Browser 0.11.0 当前结果

更新：2026-11-01（Asia/Shanghai）。按用户要求暂缓 P1 的不同 Agent 集成，优先 P2/P3。本轮交付 session MCP 资源/模板/订阅，以及显式本地 memory 内容索引；**P2/P3 和全量 Ego 复刻均未整体完成**。

| 验证 | 完成结果与证据 |
|---|---|
| 本地全套 | **285/285**，包括新增 21 项资源、memory 和实际 Electron IPC/UI 测试；CLI 生命周期也通过真实 memory API 入口。[日志](v110-service-tests.log) |
| P2/P3 集中专项 | **21/21**：11 项 MCP 资源、9 项 memory、1 项真实 Electron 面板集成。[日志](v110-p2-p3-tests.log) |
| 打包宿主 | **123/123**，新增 14 个实际资源/网页/文件索引与 scope/失效/清除检查；保留既有 provider 与文件恢复验收。[日志](v110-package-workbench.log) |
| SDK E2E | **Vek 69/69、1248 断言**；保留 Ego 同 hash 的 **68/69、1235 断言**，HTML paste 失败。两侧0跳过/0未运行。[同集对比](comparison.md)、[本轮日志](v110-package-sdk.log) |
| 打包/上游身份 | **154 文件匹配**，SDK hash 与同集比较一致，上游 **81** 个测试/fixture 未改。[校验](v110-package-verification.log) |
| 原生界面 | 本轮打包应用的实际操作见 [QA](v110-native-ui-qa.md)；实际 Electron IPC 测试另包含在本地全套，二者不混计 |
| 保留验证 | SDK 532/532 单测、CDP 22/22，以及历史官方 CLI 无推理 readiness。本轮未重新执行这些历史专项 |
| 官方 31 线上模型任务 | **未运行**，不计通过或 Ego 服务跳过；本轮 **0 付费模型调用、0 外部账号操作** |

MCP 资源 URI 只发往选定服务器，不作为本机路径或 URL 打开。更新只增加 revision；显式读取期间若发生更新则标为 stale。断线、移除配置或 HTTP session 恢复清除订阅，不自动恢复或重放 POST。失败/超时的订阅修改显示 unknown；能力未声明或选择现代 per-request 模式时在本地拒绝不支持的方法。资源内容不持久化或自动进入 Agent/memory。

memory 默认关闭，开启后仍需用户显式索引当前 HTTP(S) 页或选择项目文本文件。Profile 隔离，支持中文/英文 literal AND 搜索、保存时间/hash、重新索引、忘记和清空；关闭对应开关删除该类副本。每文档 256 KiB、最多 512 文档/16 MiB 正文；正文存储于私有 0600 本地文件，无加密 vault、语义 embedding、全盘扫描或自动 Agent 注入。详细实现和边界见 [设计](../analysis/mcp-resources-memory.md)。

初轮打包检查发现 macOS `/var` 与 `/private/var` 路径别名误拒绝合法选定文件，已修正并在 canonical 项目根/aliased 输入的实际文件回归及最终打包套件中通过。保留[失败尝试](v110-package-workbench-attempt1.log)。同轮还补齐 CLI memory API allowlist。原生 UI 另发现偏好响应识别错误和 MCP 深色对比度问题，均已修正并回归，见 QA 与 [面板专项](v110-panel-regression.log)；没有跳过失败用例。

P1 的 Cursor 未完成代码仅保存在本机 stash，不进入 0.11 应用；既有 Codex/Claude/OpenCode 能力保留。历史官方验证仍为：Claude 2.1.31 initialize 3 模型但无 effort 字段、Codex 0.142.0 格式/目录与有界压缩回滚探针、OpenCode 1.19.5 session 发现，均不等于实际模型执行。详见 [0.10 目录](../analysis/claude-model-catalogue.md)、[0.9 回放](../analysis/codex-replay-activity.md)、[0.7 ACP](../analysis/opencode-acp-design.md)。

下一步先推进 P2 OAuth、MRTR/现代订阅与资料迁移；provider gateway 注入随 P1 暂缓。P3 仍缺 OS 跨应用采集/全局快捷键、应用退出后的调度、standalone/dedicated、翻译、远程 Git/PR 与更广内容类型的索引。Ego 专有服务与 31 任务线上基准继续明确未验证。

最终285项全套、21项专项和123项打包宿主在所有修正后重跑。SDK69项之后的改动局限偏好面板响应、MCP CSS和memory忘记/待提交索引的取消分支；最终CSS另由原生视觉验收，发行包身份重新核对。验证顺序详见QA。

最终应用 `dist/mac-arm64/Vek Browser.app`；Electron 42.11.18 / Chromium 148.0.7778.280 不等价 Ego Chromium 156 的完整引擎能力。没有远程发布或签名/公证。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
