# Wiek Browser 0.20.1（2026-11-04）

已补齐真实桌面/翻译的有界证据，以及独立 CI 与干净检出的测试资料。**全量复刻、P3 系统矩阵和 P4 线上基准仍未完成**。

| 最终验证 | 结果 | 证据 |
|---|---|---|
| 本地服务/协议/组件 | 500/500；0失败/跳过 | [source](v201-source-tests.log) |
| SDK单测/构建/typecheck | 新一轮532/532；81既有输入未改 | [SDK](v201-sdk-tests.log) |
| 打包宿主 | 197/197；无付费模型或真实账号写操作 | [host](v201-package-workbench.log) |
| 同集浏览器 | Wiek69/69、1,248断言；保留同SDK/fixture/index的Ego68/69；两侧0跳过/未运行 | [suite](v201-browser-suite.log)、[compare](comparison.md) |
| 发行身份 | 192文件匹配，SDK hash不变，81上游输入未改 | [identity](v201-release-verification.log) |
| 桌面原生 | 源码host真实选区/工具栏Copy/应用click录制/65,846-byte PNG；最终helper父进程退出1,025ms自停 | [acceptance](../analysis/p3-desktop-acceptance.md) |
| 翻译 | 真实中英服务样例，推理阻止socket连接；Electron面板8检查 | [service](p3-translation-real-service.json)、[panel](v201-translation-panel.log) |
| 干净检出 | 恢复2份精确inactive workflow fixtures，临时树运行4项原始断言通过 | [fixtures](p4-clean-checkout-fixtures-final.log) |
| 远端CI | 已触发，最近观察queued；未宣称远端通过 | [Actions](https://github.com/YeohsCode/Wiek-Browser/actions) |

原生正向使用源码host和一次性公开fixture，不代替最终包TCC/所有应用兼容。物理多显示器、权限撤销、睡眠/登录未验收。翻译仅中英两例，Python/翻译模型不打包。完整suite后只重打包API说明，app/CLI/SDK执行源码不变。目录兼容不代表OS绑定密文迁移，见[改名范围](../analysis/wiek-rebrand.md)。

[基准就绪报告](p4-benchmark-readiness.json)核对31项任务、5项需登录/6平台/1附件；SDK V2 adapter、专用模型/限额和测试账号仍待准备，无线上分数。此前检查点保留如下。

---

# Wiek Browser 0.20.0 检查点（2026-11-04）

产品名由 Vek 改为 Wiek；canonical CLI 为 `cli/wiek-browser.mjs`，旧命令、环境变量和既有数据/归档兼容。包含本轮 P3 自动化、桌面工具、翻译、远程 Git/PR 的集成代码；**P3 未全部验收，P4 线上基准未运行**。

| 本轮验证 | 结果 | 日志 |
|---|---|---|
| 完整本地服务/协议/组件测试 | 498/498；0 失败、0 跳过 | [最终回归](v200-source-tests-final.log) |
| macOS ARM64 打包与宿主集成 | 构建成功；197/197；无付费模型/真实账户操作 | [build](v200-build.log)、[host](v200-package-workbench.log) |
| 发行身份 | 190 文件匹配；81 上游输入未改；SDK hash 与保留比较相同 | [verification](v200-release-verification.log) |
| 改名与旧入口兼容 | canonical/legacy CLI、环境优先级、旧目录复用已测 | `tests/brand.test.mjs` |
| 远程 Git/PR 界面 | 真实 Electron IPC、本地 bare Git 与合成 gh；通过 | [panel](v200-remote-panel-final.log) |
| 初轮发现与修复 | 保留真实失败日志；旧归档 format、环境前缀、延期语义断言和新增面板测试转义已修复 | [initial](v200-source-tests-initial.log)、[intermediate](v200-source-tests.log) |

新增原生被动监听/录制尚未完成真实正向验收；离线翻译首次真实运行暴露 Stanza 元数据兼容问题，待修；物理 sleep/login/revocation 与多显示器未运行。终端只有静态线索，未认定为完整 Ego 功能。本轮尚未重新执行 69-case 浏览器 E2E，下面 0.19 结果是历史基线。

---

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
