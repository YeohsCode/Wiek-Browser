# Vek Browser 0.13.0 当前结果

更新：2026-11-02（Asia/Shanghai）。本轮完成有界Profile web storage归档与恢复，继续优先P2/P3；P1其他Agent集成暂缓。**P2/P3和全量Ego复刻仍未完成**。

| 验证 | 结果与证据 |
|---|---|
| 本地全套 | **313/313**，比0.12新增10项，最终代码独立重跑通过。[日志](v130-service-tests.log) |
| Profile专项 | **17/17**：原有7项加4数据/4捕获/2实际Electron；后两项共67内部检查，包括真实主应用IPC和口令表单，自动化文件/确认框注入。[日志](v130-profile-storage-tests.log) |
| 实际打包宿主 | **132/132**，运行0.13.0 macOS应用的受保护API。[日志](v130-package-workbench.log) |
| 打包模块专项 | **2/2实际Electron、67内部检查**，从发行包读取主应用/存储模块，在本机Electron运行，文件/确认框注入。[日志](v130-package-profile-storage.log) |
| SDK E2E | **Vek69/69、1248断言**；保留同hash完整Ego **68/69、1235断言**（HTML paste失败），两侧0跳过/0未运行。[日志](v130-package-sdk.log)、[同集对比](comparison.md) |
| 打包/上游身份 | **157文件匹配、81个上游输入未改**；发行包SDK hash与两侧测试一致。[校验](v130-package-verification.log) |
| 原生界面 | CUA完成实际Save/Open框、两次口令导出、解锁及原生Restore确认；1 origin/2独立session在网站脚本前恢复，结果可见、Back无bootstrap记录。[QA](v130-native-ui-qa.md)、[核对](v130-native-ui-check.json) |
| 保留证据 | SDK532/532单测、CDP22/22和历史官方CLI无推理readiness，本轮未重跑这些专项；服务代码仍受全套回归覆盖 |
| 官方31线上模型任务 | **未运行**；0付费模型、0外部账号操作，不计作通过或Ego服务跳过 |

Settings可显式导出当前Profile已打开顶层HTTP(S)页面的localStorage和各标签独立sessionStorage。v2密文兼容读取v1，保留完整UTF-16 code units；仅向新Profile恢复，在无网络bootstrap中回读后才加载真实页面。检测已有存储冲突，失败关闭目的标签并清理该origin的局部写入；CHIPS cookies明确遗漏，不变成普通cookie。[完整设计](../analysis/profile-web-storage.md)

不含关闭标签/旧origin/iframe/IndexedDB、完整导航栈、扩展代码、Safari/Firefox多来源迁移，也不持久恢复应用退出后的sessionStorage。取消文件选择、口令或最终确认不会建新Profile；确认后没有原生中途取消按钮，也不承诺整份事务回滚。真实网站登录迁移未验收。

原生测试发现导入成功后结果面板被Space切换隐藏，已修复并加实际renderer断言。另保留两次fixture未等源/目的页面加载完成的失败日志，以及一次既有native interrupt audit失败；补就绪等待后，最终代码313/313独立重跑通过，未改Agent实现或原断言。见[attempt1](v130-service-attempt1.log)、[attempt2](v130-service-attempt2.log)、[interrupt观察](v130-service-native-interrupt-attempt.log)、[UI原始观察](v130-native-before-result-fix.png)。

既有MCP OAuth预注册public客户端/PKCE、session资源订阅及显式memory索引保留；真实AS/Keychain token写入、DCR/MRTR/现代订阅等边界未消失。下一步P3跨应用选区/截图与显式全局快捷键，先核对REA证据和OS权限，随后退出后调度。P2明确来源完整迁移与MCP剩余项继续保留，P1不同Agent集成继续暂缓。

应用：`dist/mac-arm64/Vek Browser.app`。正常资料运行状态见[status](v130-normal-app-status.json)。Electron42.11.18 / Chromium148.0.7778.280不等价Ego Chromium156完整引擎；应用未签名/公证，无远程发布。

[计划](../PLAN.md) · [功能对照](../analysis/feature-parity.md) · [结构化结果](delivery-summary.json) · [文档索引](../docs/README.md)
