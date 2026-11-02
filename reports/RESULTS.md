# Vek Browser 0.16.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮推进P3审核式macOS login job与前台接管；P1其他Agent集成继续暂缓。**物理sleep/wake与重新登录尚未实测，P2/P3和全量复刻未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **378/378**，比0.15新增20项，最终产品代码。[日志](v160-service-tests.log) |
| 调度专项 | **31/31**：8 control、11 job/launcher、1实际Electron IPC panel、原11真实worker。[日志](v160-scheduler-tests.log) |
| 实际打包宿主 | **158/158**，新增8项default-off/可信IPC边界检查。[日志](v160-package-workbench.log) |
| 打包模块/CLI专项 | **32/32**：以上31项加mode panel；control/job/launcher取自发行包，worker走发行CLI，两种实际Electron panel共21内部检查。[日志](v160-package-scheduler.log) |
| 真实macOS后台执行 | 最终包Electron Node runtime：bootstrap、RunAtLoad、foreground gate、同专属线程续接、不重复及bootout均通过，清理确认。[核对](v160-native-launchd-check.json)、[日志](v160-native-launchd.log)；另保留[系统Node源码测试](v160-native-launchd-source-check.json) |
| 原生设置界面 | CUA实际打开、review、cancel、refresh；显示Vek0.16/Node24.19，取消后无plist/launcher/receipt，停止后gate释放。[QA](v160-native-ui-qa.md)、[核对](v160-native-ui-check.json) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v160-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **168文件匹配、81个上游输入未改**；发行SDK与两侧测试hash一致。[校验](v160-package-verification.log) |
| 保留证据 | SDK532/532单测、CDP22/22及历史官方CLI无推理readiness未重跑；0.14原生正向截图/AX正文/背景键触发仍未确认 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不算通过或Ego服务跳过 |

Settings中的后台调度默认关闭，用户先审核可执行路径、版本、拟安装文件和timeout再启用。每个automation仍需明确closedAppAllowed且仅普通CLI；每分钟检查，不物理唤醒睡眠机器。稳定私有launcher核对runtime/code receipt，移动或更新阻止执行并要求重审。Disable撤销consent并等待worker收尾、卸载OS job；Remove进一步移除自有setup，保留历史。缺失/冲突/未知文件不冒充成功。[设计和证据边界](../analysis/background-scheduling.md)

Foreground先持有独占gate，再通过认证loopback stop端点请求worker停止，等真实provider退出、checkpoint完成及lease释放才打开Agent状态；ack不能替代收尾，超时不强杀。正常接管和停用已验证，hard kill及全部独立启动路径不宣称完整恢复。Receipt仅覆盖所述runtime与顶层JS，不是外部provider或全部Electron文件的完整安全认证。

真实OS fixture使用独立dataDir/label与用户Library之外的临时plist，最终清理；正常资料未安装持久login job。未实测logout/login、物理sleep/wake、OS后台项撤销、所有安装布局或第三方CLI认证环境。

保留三类初次验证记录：cleanup顺序错误已修正；旧interrupt测试增加收到native turn ID的前置等待，原interrupt断言保留；首轮OS fixture未等上次任务idle就kickstart，最终no-op等待超时，增加OS idle前置条件后通过。未据此推断所有历史超时根因。[cleanup](v160-control-cleanup-attempt.log)、[interrupt](v160-service-parallel-attempt.log)、[OS原记录解释](v160-native-ui-qa.md)。

下一步P2：MCP现代请求/订阅的协商、断线与取消语义；DCR/来源完整迁移仍保留。P3 busy延期/completion contract、OS采集正向及睡眠/重新登录边界继续待验收。P1不同Agent集成保持暂缓。

应用：`dist/mac-arm64/Vek Browser.app`，正常资料状态见[status](v160-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
