# Vek Browser 0.19.0 当前结果

更新：2026-11-03（Asia/Shanghai）。本轮实现P2显式CIMD与客户端身份审核；P1不同Agent集成继续暂缓。**Vek托管身份、DCR/完整step-up及其他P2/P3缺口仍在，全量复刻未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **436/436**，比0.18新增20项：19协议/服务、1实际Electron面板含20检查。[日志](v190-service-tests.log) |
| OAuth专项 | **38/38**，新CIMD及既有预注册OAuth/真实Electron面板一起回归。[日志](v190-oauth-focused.log) |
| 实际打包宿主 | **197/197**，新增13项文档/身份、TLS prepare、scope、配置失效、issuer和取消边界检查。[日志](v190-package-workbench.log) |
| 打包MCP模块 | **58/58**：20项CIMD、17项输入续传、21项现代资源/通知；实际Electron面板分别20/13/14内部检查。[日志](v190-package-mcp.log) |
| 原生UI | CUA公共模板、身份审核与取消；0token/工具任务，callback关闭。[QA](v190-native-ui-qa.md)、[核对](v190-native-ui-check.json) |
| SDK E2E | **最终打包Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v190-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **171文件匹配、81个上游输入未改**；SDK/fixture/index身份一致。[校验](v190-package-verification.log) |
| 保留证据 | SDK532/532单测、CDP22/22沿用；0.16真实launchd/前台接管为历史证据，0.19未重跑OS安装；0.14正向OS采集仍未确认 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不算通过或Ego服务跳过 |

CIMD模式使用明确配置的HTTPS文档URL，要求AS能力标志、文档精确ID、public none认证、code grant/response和固定IPv4 callback；5 KiB/MIME/UTF8/超时校验，不跟随redirect或获取文档中的其他URL。模板可本地审核，但文档须自行托管，AS还须接受其loopback redirect。预注册配置保持兼容，已有密文身份校验issuer，可选显式issuer固定；CIMD未pin时可更换AS并重新审核。取消/失败不自动注册、开浏览器或重放工具。[实现与公开规范来源](../analysis/mcp-client-identity.md)

本轮源测试、打包MCP/宿主检查及原生准备/取消均无失败。审核中补充CIMD空URL不能静默保存为无OAuth配置的校验，最终全套436/436已重跑；最终发行模块58/58、宿主197/197与SDK69/69随后重验通过。TLS测试只在各自隔离进程信任合成CA，没有关闭产品TLS验证或修改OS信任库。原生未进行真实登录/Keychain token写入；自动化完整code/refresh使用合成本机HTTPS服务与AES-GCM fixture。0.18首轮SDK干扰失败继续保留为历史记录，不挪作本轮通过证据。

仍未完成自动托管客户端身份、DCR/完整step-up、资源/URL MRTR、sampling/roots、现代stdio/prompt通知/task extension、明确来源完整迁移，以及P3物理sleep/login/OS后台撤销、busy延期/completion和正向OS截图/AX。没有Ego该功能的运行对测；同源SDK69项不等同31线上模型基准。

下一步转向P3 busy延期/completion语义，先对照现有REA证据确定可验证范围；P2来源迁移与其他MCP缺口保留，P1继续暂缓。

应用：`dist/mac-arm64/Vek Browser.app`；[正常资料状态](v190-normal-app-status.json)已恢复到0.19，测试集成未加入、默认后台作业仍关闭且未安装。应用未签名/公证，无远程发布。Electron42.11.18/Chromium148.0.7778.280不等价Ego Chromium156完整引擎。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
