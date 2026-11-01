# Vek Browser 0.14.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮补P3显式Desktop tools和全局快捷键注册，继续优先P2/P3；P1其他Agent集成暂缓。**P2/P3和全量Ego复刻仍未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **331/331**，比0.13新增18项，最终代码重跑通过。[日志](v140-service-tests.log) |
| Desktop专项 | **23/23**：13服务/4 native adapter/1实际Electron，加原有5偏好测试。[日志](v140-desktop-tests.log) |
| 实际打包宿主 | **140/140**，0.14.0受保护API；新增8项默认/权限边界检查。[日志](v140-package-workbench.log) |
| 打包模块专项 | **1/1实际Electron、20内部检查**；读取发行包模块，真实IPC/Library editor，OS registry/capture为fixture。[日志](v140-package-desktop-panel.log) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v140-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **162文件匹配、81个上游输入未改**；发行SDK hash与两侧测试一致。[校验](v140-package-verification.log) |
| 原生界面 | 既有权限状态、全局键注册/重启恢复、真实截图进程启动/取消/清理和默认重置已确认。**背景按键触发、AX正文、原生PNG正向链路未确认**。[QA](v140-native-ui-qa.md) |
| 保留证据 | SDK532/532单测、CDP22/22和历史官方CLI无推理readiness，未重跑；上一轮[Profile原生验收](v130-native-ui-qa.md)保留 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不计作通过或Ego服务跳过 |

Settings → Desktop capture & global shortcuts可配置一次性采集。选区默认关闭，只读当前AXSelectedText，按bundle ID排除/secure控件拒绝；不模拟Copy、轮询剪贴板或被动监听。截图走系统固定区域/窗口选择器；取消等待进程实际退出，失败/取消替换保留原有未过期draft。正文仅在内存保留3分钟，先预览再明确复制/保存/用作草稿；图片进入既有Library标注，保存后遵循Library持久生命周期。CLI/RPC只有元数据，不能采集/取正文/更改设置。[完整设计与REA边界](../analysis/desktop-tools.md)

四种全局键默认未分配；实际OS注册失败显示unavailable，重配失败保留旧键，与浏览器快捷键双向冲突检查；退出只注销模块自己拥有的键。chat/voice只打开面板，不自动发送或启动麦克风。当前仅macOS ARM64原生实现；Fn、被动选区浮动工具栏、跨应用音视频录制、多屏/所有应用兼容尚缺。权限由真实OS授予，本轮没有自动授权。

实际取消发现了Electron IPC错误前缀显示问题，已修正，最终原生取消无错误，新增abort-rejection与panel回归。Ego侧只复用身份匹配的有界shipped-static证据，没有native正向对测；不能把独立实现或注入fixture通过描述为Ego等价。

下一步P3应用退出后调度与standalone/dedicated执行语义，先实现明确opt-in的生命周期、去重、停用/卸载和失败恢复；不会自动安装后台常驻服务。P2明确来源完整迁移与MCP DCR/MRTR/现代订阅保留，P1不同Agent集成继续暂缓。

应用：`dist/mac-arm64/Vek Browser.app`。正常资料运行状态见[status](v140-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；应用未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
