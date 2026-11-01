# Vek Browser 0.12.0 当前结果

更新：2026-11-02（Asia/Shanghai）。优先P2/P3，P1其他Agent集成继续暂缓。本轮交付预注册公共客户端的HTTP MCP OAuth；既有资源订阅和显式memory索引保留。**P2/P3及全量Ego复刻均未整体完成**。

| 验证 | 完成结果与证据 |
|---|---|
| 本地全套 | **303/303**，含新增18项OAuth协议/crypto/服务和真实Electron IPC/UI。[日志](v120-service-tests.log) |
| OAuth专项 | **18/18**：17项本地HTTP/加密/服务边界，1项实际Electron界面。使用合成AS、注入AES-GCM和浏览器捕获器，0真实账号。[日志](v120-oauth-tests.log) |
| 打包宿主 | **132/132**；新增9项OS存储可用、metadata/callback准备、scope、取消、不打开及不重放检查，仅prepare/cancel。[日志](v120-package-workbench.log) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash Ego **68/69、1235断言**，HTML paste失败。两侧0跳过/0未运行。[本轮日志](v120-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **155文件匹配**，SDK hash与同集比较一致，**81个上游测试/fixture未改**。[校验](v120-package-verification.log) |
| 原生打包界面 | 实际Prepare→只读审核issuer/resource/scopes→取消；没有打开系统浏览器或写入Keychain token。[QA](v120-native-ui-qa.md)、[独立核对](v120-native-ui-check.json) |
| 保留验证 | SDK532/532单测、CDP22/22、历史官方CLI无推理readiness与0.11资源/memory原生UI，本轮没有重复运行这些历史专项；其代码回归仍在全套中 |
| 官方31线上模型任务 | **未运行**；本轮0付费模型调用、0外部账号操作，不记作通过或Ego服务跳过 |

HTTP配置可添加预注册public client ID。Prepare先进行不带用户凭据的metadata发现，审核后才显式打开系统浏览器；支持none/S256、精确resource、固定loopback路径与可选注册端口。加密凭据绑定integration和project/thread/config，防止密文重新指派；refresh要求不同的新token，结果不确定时重新授权。401、code或refresh均不自动重放原工具POST；重新授权阻止旧session工具请求。详见[设计与限制](../analysis/mcp-oauth-design.md)。

OAuth DCR/托管client metadata/client secret/DPoP/完整step-up仍不支持；实际第三方AS登录、刷新、撤销与Keychain token写入**未运行**。OS接口可用和注入加密器的协议测试不替代这些证据。Sign out只清本地credential，不等于服务端revoke或退出外部浏览器账号。

0.11的session MCP资源/模板/订阅、revision/stale和显式读取，以及Profile隔离的显式网页/项目UTF-8 memory索引继续可用；不自动采集、刷新或发送给Agent。历史修复和界面证据见[0.11设计](../analysis/mcp-resources-memory.md)与[原生QA](v110-native-ui-qa.md)。

下一步优先Profile archive的可验证web storage/会话范围和明确来源迁移；随后补OAuth DCR、MRTR/现代订阅及P3系统能力/退出后调度/执行模式/翻译/远程Git。P1不同Agent集成及provider gateway注入保留暂缓；31项线上模型基准继续未运行。

最终应用 `dist/mac-arm64/Vek Browser.app`，正常资料目录已运行0.12.0，见[status](v120-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156的完整引擎能力；没有远程发布或签名/公证。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
