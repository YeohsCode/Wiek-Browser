# Vek Browser 0.17.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮推进P2现代HTTP MCP资源与显式通知流；P1其他Agent集成继续暂缓。**MRTR输入续传及其他P2/P3缺口仍在，全量复刻未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **399/399**，比0.16新增21项；最终连接池调整后重跑。[日志](v170-service-tests.log) |
| MCP专项 | **73/73**，现代资源/流、旧版HTTP/session资源、stdio服务与OAuth一起回归。[日志](v170-mcp-focused.log) |
| 实际打包宿主 | **173/173**，新增15项现代资源、通知、不自动获取、scope、断流/明确重试和清理检查。[日志](v170-package-workbench.log) |
| 打包模块专项 | **21/21**：20协议/服务及1实际Electron IPC panel（14内部检查），使用最终发行模块/renderer。[日志](v170-package-modern.log) |
| 原生UI | CUA实际连接、watch、资源subscribe、更新stale、明确读取中文内容、unsubscribe/stop；wire确认0自动read、1明确read、最终0流。[QA](v170-native-ui-qa.md)、[核对](v170-native-ui-check.json) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v170-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **169文件匹配、81个上游输入未改**；发行SDK与两侧测试hash一致。[校验](v170-package-verification.log) |
| 保留证据 | SDK532/532单测、CDP22/22与历史官方CLI无推理readiness未重跑；0.16真实launchd执行/卸载及原生review/cancel保留历史证据，0.17未重跑真实OS安装；0.14正向OS采集仍未确认 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不算通过或Ego服务跳过 |

现代2026-07-28 HTTP模式新增resources/list、templates/list和read；URI只作为所选MCP服务器的标识符。Subscriptions/listen首条ack与每个事件的subscriptionId/被接受filter都要吻合，确认前通知、额外URI或错误ID会关闭该流；空子集明确unsupported。正常关闭和断流分别显示closed/lost，重试由用户明确发起，重连不自动恢复。列表/更新通知只使缓存失效或增加revision，不自动读取正文或发送Agent。[设计与官方规范来源](../analysis/mcp-modern-subscriptions.md)

已确认的流可长期存活，逐行/事件大小限制仍适用；每连接最多16流，现代HTTP连接池32 sockets让普通read仍能执行。列表每次明确刷新，不将上次显示当作当前新鲜数据。HTTP取消关闭流，不发legacy cancellation，也不重放POST或自动续流。工具列表竞态会要求重新刷新，界面移除已失效工具按钮。

没有MRTR inputResponses/requestState续传、sampling/elicitation、prompt变化通知、现代stdio或task extension，没有Ego该功能的运行对测。预注册OAuth继续回归；CIMD/DCR/完整step-up仍缺。P3物理sleep/login/OS后台撤销、busy延期/completion contract和正向OS截图/AX仍保留。

本轮初次21项和最终全套/发行检查均无失败。review中发现16条长流可能占满原16 sockets，最终改为32并在原容量测试中追加“16流下仍能read”的断言，随后全套399/399重跑；没有降低容量或删除断言。上游SDK输入未改。

下一步P2优先可审核、可取消的MRTR输入续传；采样/模型调用不自动开启。完整来源迁移、OAuth现代身份机制与P3剩余验收继续排队，P1不同Agent集成保持暂缓。

应用：`dist/mac-arm64/Vek Browser.app`，正常资料状态见[status](v170-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
