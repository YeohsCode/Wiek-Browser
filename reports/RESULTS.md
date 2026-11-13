# Wiek Browser 验证结果

当前开发检查点为 **0.27.0**，日期为 2026-11-14。完整功能覆盖和正式发行条件继续见[计划](../PLAN.md)。

## 0.27 专项验收

- IndexedDB 归档恢复共享引用和循环引用、稀疏数组、同一固定缓冲区上的多个二进制视图。真实 Chromium 验证恢复后的对象身份、数组空位、缓冲区和视图范围，并成功恢复含旧版 TypedArray 标签的归档。[设计与边界](../analysis/profile-indexeddb-design.md)

- 打包专项 16/16 通过，其中 29 项真实 IndexedDB 检查、37 项应用 IPC 检查。打包宿主 198 项通过。浏览器同集 69/69、1,248 条断言，204 份发行文件与 81 份原始输入身份检查通过。原始 SDK 532/532，TypeScript 检查通过。[打包专项](v027-package-targeted.log) · [宿主](v027-package-workbench.log) · [同集](v027-browser-suite.log) · [身份核对](v027-package-identity.log) · [SDK](v027-sdk.log)
- 打包后台启动器的隔离测试通过，验收脚本输出本次结果，避免覆盖以前的报告。桌面权限探测成功，实机录制、多屏和撤权仍待验收。[启动器](v027-package-scheduler.log) · [权限状态](v027-package-desktop-permissions.json)
- 本机串行源码回归 610/611，Git 专项复测 16/17。两次各有一项不同的合成 PR 夹具超时，两条用例再单独复测均通过，原期限保留。[串行回归](v027-source.log) · [Git 专项](v027-git-retest.log) · [两条用例](v027-git-cases.log)
- 本机命令及三处指南链接已更新。源码提交 `db9329b` 已推送。[安装记录](v027-install.json) · [远端 CI](https://github.com/YeohsCode/Wiek-Browser/actions/runs/43459604246)

## 0.26 专项验收

- IndexedDB 加密备份保留自增主键的下一值。真实 Chromium 检查覆盖独立主键、内联字段路径、删除记录、清空仓库、最后一个可用键和生成器耗尽。导出探测确认回滚，导入离线完成。旧归档继续可读；带自增键的归档需要 0.26 或更高版本。[设计与边界](../analysis/profile-indexeddb-design.md)
- 打包宿主 198 项，浏览器同集 69/69、1,248 条断言，204 份发行文件与 81 份原始测试输入的身份检查通过。[宿主](v026-package-workbench.log) · [同集](v026-browser-suite.log) · [应用包核对](v026-package-identity.log)
- 打包专项 15/15 通过，含 27 项真实 IndexedDB 检查和 37 项应用 IPC 检查。导入后页面在首轮初始化时读到了保留的自增键位置，归档准备过程发出零次网络请求。[专项日志](v026-package-targeted-final.log)
- P3 打包版后台启动器在隔离环境完成空任务检查，核对审核过的参数及清理结果。桌面原生组件读取到辅助功能、输入监控及屏幕录制权限均已授予。多显示器、撤权、实际系统注册及物理睡眠唤醒仍待验收。[启动器](v026-package-scheduler.log) · [权限状态](v026-package-desktop-permissions.json)
- 首次并行源码回归 609/610。MCP 表单夹具在界面关闭后立即检查网络请求，当时请求仍在传输。单项复测通过，夹具改为等待本次调用实际完成后再检查请求，保留原有断言和整体期限。[初测](v026-source.log) · [单项复测](v026-mcp-panel-retest.log)
- 修正后的本机串行全量回归 608/610。两项远程 Git 合成夹具超时，随后独立文件复测 17/17。原始 SDK 532/532，TypeScript 检查通过。全局命令与三处指南链接已更新到 0.26 目录包。[串行全量](v026-source-final.log) · [Git 复测](v026-git-retest.log) · [SDK](v026-sdk.log) · [安装记录](v026-install.json)
- 源码已推送为 `05dd68c`，远端 CI 已通过，完整源码 610/610。[远端运行](https://github.com/YeohsCode/Wiek-Browser/actions/runs/43354343788)

## 0.25 专项验收

- 实际目录包的恢复与 IndexedDB 专项 7/7 通过，覆盖控制权错误被捕获后的退出码与日志、跳过重开时的旧数据保留、正常启动恢复，以及 Map、Set、RegExp 的加密归档往返。
- 原始 SDK 回归 532/532 通过，81 份固定输入保持字节身份。TypeScript 检查通过。
- 第一次完整源码回归为 608/609。远程 Git 合成夹具的认证错误断言遇到子进程超时，串行单项复测通过，完整串行复测通过 609/609。

- 打包版浏览器同集 69/69，共 1,248 条断言，204 个发行文件身份检查通过。全局命令已切换到 0.25 目录包。

- 0.25 实际应用包宿主检查 198 项通过。远端 CI 对源码提交 `6748d30` 全部通过，含 609 项源码、532 项 SDK、336 项评估框架、69 项浏览器同集和 198 项宿主检查。[远端运行](https://github.com/YeohsCode/Wiek-Browser/actions/runs/43336629530) · [验收状态](p4-ci-43336629530-status.json)

[打包宿主](v025-package-workbench.log) · [打包专项](v025-package-tests.log) · [SDK 回归](v025-sdk-regression.log) · [源码复测](v025-source-final.log) · [源码初测](v025-source-initial.log) · [远程 Git 单项复测](v025-git-retest.log) · [浏览器同集](v025-browser-suite.log) · [应用包核对](v025-package-identity.log) · [安装记录](v025-install.json)

## 用户反馈与自动化继续执行

[术语表](../docs/terminology.md)统一标签组、重新打开标签页、继续自动化任务、浏览器用户配置、文件备份和操作记录等名称。[易用性审计](usability-audit.md)包含实际复现路径与23项功能/设计取舍。

指南删除一目标一组和普通错误后一律重复询问的限制。重启后按当前标签页重新建立页面句柄，独立测试使用唯一名称与隔离目录，已有授权可继续目标页面。实际包恢复测试与全局命令指南均已核对。错误码与控制权判断兼容既有调用。

## 0.24 检查点结果

| 检查 | 结果 | 证据 |
|---|---|---|
| 完整源码回归 | 608/608，零失败/跳过 | [最终日志](v024-source-tests-final.log) |
| 原始SDK隔离回归 | 532/532，81份输入字节身份不变 | [日志](terminology-sdk-regression.log)、[身份](sdk-test-lineage.json) |
| 术语相关面板与恢复专项 | 12/12；导入标题夹具修正后8/8 | [面板](terminology-focused-tests.log)、[修正复测](terminology-recovery-final.log) |
| 浏览器继续执行 | 源码与实际包均17项行为检查通过 | [源码](terminology-recovery-initial.log)、[应用包](terminology-packaged-recovery.log) |
| 实际应用包宿主 | 198项检查通过，0.24.0 | [宿主](v024-package-workbench.log) |
| 实际包本地服务/迁移/MCP面板 | 13/13用例；含15项标题面板、14项提示面板、22项IndexedDB、34项存储、37项宿主IPC检查 | [面板](v024-package-panels.log) |
| 实际包后台任务启动器 | 0.24.0和内置Node执行准确审核参数；临时配置清理确认 | [启动器](v024-package-scheduler.log) |
| 框架固定输入 | 263份身份匹配 | [身份](terminology-framework-inputs.log) |
| 实际包图标与独立运行扫描 | 通过 | [图标](terminology-brand-package.log)、[扫描](terminology-independent-package.log) |
| 69项浏览器同集 | 69/69，1,248断言，零失败/跳过，独立宿主退出 | [运行日志](v024-browser-suite.log)、[结果](comparison.md) |
| 实际包源码与原始输入身份 | 204份发行文件一致，81份原始输入不变，包中SDK与同集执行字节一致 | [身份](v024-package-identity.log) |
| 0.24 远端CI | 全部通过，源码提交 `646421e` | [完整CI](https://github.com/YeohsCode/Wiek-Browser/actions/runs/42938519050)、[验收状态](p4-ci-42938519050-status.json) |

远端验收包括532项SDK、608项源码、336项框架、198项打包宿主、17项打包恢复检查、69项浏览器/1,248条断言和204份发行文件身份。面板、迁移、后台启动器、固定输入与图标检查同样通过。原始CI日志保留为 `p4-ci-42938519050-ci-*.log`。本次归档提交仅更新文档和证据，运行代码对应上述CI提交。

## 0.24 功能专项

0.24还包含项目本地服务显式标题读取、现代stdio和提示模板预览、有限类型IndexedDB加密备份、后台任务安装路径与代码身份检查。分别见[本地服务](../analysis/local-services-design.md)、[MCP](../analysis/mcp-stdio-prompts-design.md)、[浏览器数据备份](../analysis/profile-indexeddb-design.md)和[后台任务](../analysis/background-scheduling.md)。

此前专项为MCP 139/139、浏览器数据迁移23/23、后台路径/调度40/40。当前完整源码结果覆盖它们，单独日志仍保留。

## 保留的失败与边界

0.24初次完整源码为606/607，一条文件监听夹具未匹配预期文件，最初失败的唯一原因未确认。原用例单独复测通过，等待条件随后改为目标文件事件，期限未放宽。第二次完整回归605/607，两条既有远程Git夹具子进程超时，日志保留。术语修改后第一次为607/608，导入夹具仍断言旧标题；同步当前标题后相关8/8，最终完整608/608。见[第一次](v024-source-tests-initial.log)、[第二次](v024-source-tests.log)、[标题夹具失败](v024-source-tests-terminology.log)和[最终通过](v024-source-tests-final.log)。

当前阻塞报告依据可复现的条件。用户那次具体失败调用的完整日志尚未取得，因此没有认定唯一根因。控制错误覆盖普通日志和异常捕获后可能退出0的输出契约也已列入审计，尚需单独设计兼容调整。

当前包为本地未签名、未公证的目录包。所有新增运行测试使用合成Agent、临时项目和回环页面，模型调用与真实账号写入均为零。后台任务系统调用使用夹具适配器，未替代物理sleep/login、后台项撤权或多屏验收。

## 上一检查点

0.23源码提交 `d6d3be9` 的[远端CI](https://github.com/YeohsCode/Wiek-Browser/actions/runs/42724506570)通过532项SDK、548项源码、336项框架、197项宿主、69项浏览器/1,248断言和199份发行文件身份。完整记录见[0.23摘要](wiek-v0.23-checkpoint.json)与[独立运行报告](independence-results.md)。这些结果属于上一检查点。

31项线上模型任务、完整功能范围、签名/公证和物理设备验收仍在计划内。
