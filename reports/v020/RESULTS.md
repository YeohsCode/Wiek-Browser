# Vek Browser 0.2.0 当前结果

已继续复刻并构建 macOS ARM64 应用：`dist/mac-arm64/Vek Browser.app`。本轮在既有 SDK/原生桥接基础上增加了本地 Agent 工作台、文件/Git、MCP、Library/截图标注、操作录制、偏好/窗口、语音与资料迁移，并扩展了 Ego 客户端 PAK 的 REA 分析。

| 验证 | 结果与证据 |
|---|---|
| 同源完整浏览器 SDK E2E | **Vek 69/69，1248断言；Ego 68/69，1235断言**；两侧0跳过/0未运行；SDK/fixture/cases哈希一致，[完整对比](comparison.md) |
| 本地服务/CLI解析/原生协议与附件/Library/录制/偏好/资料加密等测试 | **96/96**，[日志](round-3-service-tests.log) |
| 打包版真实宿主集成 | **31/31**：真实provider→CLI→SDK→网页、MCP scope/接管/撤销、文件冲突、主题/布局、独立窗口/固定/恢复、真实PNG/Whisper/可信输入录制，[日志](package-workbench-integration.log) |
| SDK单元测试 | 532/532，沿用未变更SDK版本，[日志](sdk-unit-tests.log) |
| 上游测试/fixture完整性 | 81个文件逐字节未改；打包SDK SHA256与两侧测试一致 |
| 打包内容 | 43项源码/CLI/API guide/model/NOTICE身份匹配；没有夹带downloads/references/analysis/reports/data/tests |
| 原生界面 | 版本入口、Profile加密导出/恢复、dark/vertical与重启、公开WAV文件离线转写完成；[QA记录](package-v020-ui-qa.md) |
| 官方31项线上模型benchmark | **未运行**：缺独立模型认证与必要站点登录，不计为通过或Ego服务跳过 |

## 新增能力

- 通用本地CLI与opt-in Codex app-server；多Agent控制；对话归档/置顶/笔记/目标/分支/侧聊/编辑重发/回滚；文件附件、审批和JSON会话迁移。
- at/interval/UTC cron/heartbeat、运行历史/记忆/提案、停止条件；仅应用运行时调度。
- 项目范围文件搜索/编辑/watch/预览与Git；stdio MCP和受scope保护的本地gateway；本机/项目技能目录与会话上下文。
- Library/Collections、真实网页截图/裁剪/矩形/箭头/文本/撤销、PNG保存；显式操作录制、敏感字段过滤、截图与导出。
- 深浅/系统主题、横竖标签、快捷键冲突检查、选择工具栏、固定/批量/恢复Spaces、原生独立窗口、托盘模式、Home快捷网站。
- 随包的CPU Whisper与多语言tiny模型；公开音频真实转写，语音词典/语言/历史/音频保留；选择目录只读导入Chromium资料、系统加密vault、Vek专用加密Profile archive。

## 仍未完成的部分

**这仍不是整款 Ego 的全量功能复刻。** 七种其他provider原生协议、完整Chrome/Safari会话与web storage/扩展迁移、远程MCP/OAuth、完整Git checkpoint/PR工作流、OS跨应用选择/截图/录制与翻译、任意时区/退出后调度，以及Ego专有服务仍有缺口。详见[逐项差距清单](../analysis/feature-parity.md)。

Vek使用Electron42.11.18 / Chromium148.0.7778.280 / Node24.19.0；参考Ego为Chromium156.0.8078.48。69-case兼容不能证明全部Web平台或定制Chromium行为等价。原生Codex真实探针止于initialize和只读ephemeral thread/start，没有付费turn；其流式/审批等通过本地fake-wire测试验证。

## 使用与产物

`npm start`启动源码，或打开上述`.app`。`node cli/vek-browser.mjs api help`查看本地工作台API。真实用户版数据与测试profile隔离；测试未读取个人Chrome/Keychain、录制麦克风或执行网站账户操作。未发布、签名公证或部署。

[深色竖向界面](package-v020-dark-vertical.png) · [本地转写界面](package-v020-voice.png) · [截图像素探针](library-annotation-electron.png) · [可机读结果](delivery-summary.json)
