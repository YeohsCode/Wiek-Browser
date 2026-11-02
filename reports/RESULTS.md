# Vek Browser 0.15.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮推进P3三种自动化执行模式与显式closed-app单次worker；P1其他Agent集成继续暂缓。**OS自动唤醒尚缺，P2/P3和全量复刻未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **358/358**，比0.14新增27项，最终代码重跑。[日志](v150-service-tests.log) |
| 调度专项 | **38/38**：15 mode、11真实worker、1实际Electron和原11时区回归。[日志](v150-scheduler-tests.log) |
| 实际打包宿主 | **150/150**，新增10项mode/进程/归属/锁验收。[日志](v150-package-workbench.log) |
| 打包模块/CLI专项 | **12/12**：11实际发行CLI worker测试、1发行panel源码在Electron执行，共10界面检查。[日志](v150-package-scheduler.log) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v150-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **163文件匹配、81个上游输入未改**；发行SDK与两侧测试hash一致。[校验](v150-package-verification.log) |
| 原生UI + closed-app | CUA实际选择mode/consent、UI第一次执行、关闭后发行worker第二次执行、同专属线程续接、重开可见且无手工写入入口。[QA](v150-native-ui-qa.md)、[核对](v150-native-ui-check.json) |
| 保留证据 | SDK532/532单测、CDP22/22及历史官方CLI无推理readiness未重跑；0.14原生正向截图/AX正文/背景键触发仍未确认 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不算通过或Ego服务跳过 |

Heartbeat延续既有thread，standalone每次新建，dedicated首次新建后复用专属线程。新线程只复制project/provider/model/effort，不带源历史、附件、native身份或Space authority；显式automation memory可用于所有mode。专属会话拒绝独立prompt/steer/编辑/model/附件等写入；Pause只停未来，Stop取消实际run，删除定义停止owned进程并释放保留会话。scheduled先持久预约，再创建线程，crash不自动重放，仍可能丢一次。[设计和Ego静态证据](../analysis/automation-execution.md)

`closedAppAllowed`默认false，显式 `scheduler tick`只运行cutoff已到期的opt-in普通CLI任务，复用同一Agent锁/workspace/turn checkpoints；存在锁即skip，不清陈旧锁。signal/timeout等待实际退出，输出正文不进入CLI结果；worker只读user instructions，禁止子上下文自动启动浏览器。它不会打开网页Profile、安装OS作业、唤醒睡眠机器或持续轮询。Native provider需浏览器审批界面，worker明确不支持。

初始新增fixture错误地选择model却缺少provider模板参数、并尝试运行仍禁用的导入provider；补齐fixture配置/明确启用后原断言通过，没有改弱产品边界。[初始日志](v150-initial-fixture-failure.log)。原生QA另发现专属视图残留不可用编辑/回滚/删除入口，已移除并补Electron检查，最终包复验。

下一步P3：明确opt-in的系统唤醒作业安装/状态/停用卸载、稳定runtime路径、前台handoff和睡眠后恢复；Ego busy延期/completion contract仍有差异。P2来源完整迁移与MCP DCR/MRTR/现代订阅保留，P1继续暂缓。

应用：`dist/mac-arm64/Vek Browser.app`，正常资料状态见[status](v150-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
