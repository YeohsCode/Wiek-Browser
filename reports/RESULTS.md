# Vek Browser 0.18.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮完成P2有界工具表单MRTR：需要输入时停留待审阅，明确提交/拒绝/取消后才继续。P1不同Agent集成暂缓；**其他P2/P3缺口和全量复刻仍未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **416/416**，比0.17新增17项：16协议/服务、1实际Electron面板含13检查。[日志](v180-service-tests.log) |
| 实际打包宿主 | **184/184**，新增11项输入审阅、scope/重复提交、精确状态续传、取消和不持久化检查。[日志](v180-package-workbench.log) |
| 打包MCP模块 | **38/38**，17项新输入流程及21项现代资源/通知流；两项实际Electron面板分别13/14内部检查。[日志](v180-package-mcp.log) |
| 原生UI | CUA审阅、typed默认值、明确提交和Cancel task；修正select尺寸/深色结果文字对比度。[QA](v180-native-ui-qa.md)、[核对](v180-native-ui-check.json) |
| SDK E2E | **最终打包Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v180-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **170文件匹配、81个上游输入未改**；SDK与测试hash一致。[校验](v180-package-verification.log) |
| 保留证据 | SDK532/532单测、CDP22/22沿用记录；0.16真实launchd执行/卸载及原生接管是历史证据，0.18未重跑OS安装；0.14正向OS采集仍未确认 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不算通过或Ego服务跳过 |

工具表单声明仅限本地现代HTTP tools/call。支持受限平面schema、typed/default/required/数值/长度/枚举/格式验证、最多8轮；拒绝sampling、URL输入和其他请求续传。输入/state与可能回显内容的交互结果不写MCP历史，重启不恢复。取消/断连/原任务超时结束审阅或在途POST；失去响应不自动重放。[实现边界与公开规范来源](../analysis/mcp-input-continuations.md)

首次SDK运行 **19通过/50失败/0跳过/0未运行**，最早出现跨进程标签引用与键盘空格断言失败，随后页面预算耗尽导致多项失败。该运行与新建原生QA宿主重叠；窗口/焦点干扰是推测，未证明单一根因。保留[完整失败日志](v180-sdk-attempt1.log)及[用例结果](v180-initial-vek-e2e.json)，关闭额外QA宿主后以全新资料单独重跑69/69通过；完成select/深色结果CSS后，最终打包版再次单独全套69/69通过。未修改SDK断言/fixture或SDK/浏览器操作实现。另有一次QA脚本误用不存在的`api state`，只影响状态打印，后续使用`status`；不是产品回归失败。

未完成资源读取/URL MRTR、sampling/roots、prompt变化通知、现代stdio、task extension与Ego同功能运行对测。预注册OAuth已随全套回归，CIMD/DCR/完整step-up仍缺；明确来源完整迁移、P3物理sleep/login/OS后台撤销、busy延期/completion contract及正向OS截图/AX仍保留。

下一步优先核对现代OAuth CIMD/身份机制，再推进明确来源迁移和P3剩余边界；P1不同Agent集成继续暂缓。

全套416与宿主184对应最终功能逻辑；随后只有select/深色结果CSS调整，最终38项MCP模块与69项SDK在最后发行包重验通过。

应用：`dist/mac-arm64/Vek Browser.app`；正常资料0.18状态见[status](v180-normal-app-status.json)，默认后台作业关闭且未安装。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
