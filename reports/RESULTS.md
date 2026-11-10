# Wiek Browser 验证结果

检查点：**0.23.0**；日期：2026-11-10（Asia/Shanghai）。本轮目标是独立运行迁移，完整P2/P3/P4功能范围仍按计划推进。

完整修复清单见[独立运行修复报告](independence-results.md)。

## 独立运行链路

产品改用自身SDK构建、Wiek命名空间、错误码、状态、桥接、CLI、Skill和指南。安装包排除旧安装器；实际`skill`输出带同版起止标记，`install`和`upgrade`都有可用行为。应用运行不需要另一个浏览器、原CLI、外部SDK包或私有服务。

全局命令指向Wiek应用包，三种Agent的Skill入口已注册；旧入口备份在扫描目录之外。原浏览器项目内进程已通过SIGTERM收尾，未强制终止或删除浏览资料。产品运行源、SDK输出与安装包都有独立性扫描。

原始81份测试输入保留字节身份，已迁至只读夹具。隔离运行只映射命名，不删断言/用例、不放宽期限。[输入链路](sdk-test-lineage.json)和[迁移记录](system-entrypoint-migration.json)保留实际身份。许可证与原始历史记录不作为产品运行依赖。

## 本轮实际结果

| 检查 | 当前结果 | 记录 |
|---|---|---|
| SDK隔离回归 | 532/532，0失败/跳过 | [SDK日志](v023-sdk-tests-final.log) |
| 类型/指南/站点学习资料 | 均通过 | [类型](v023-sdk-typecheck.log)、[指南](v023-guide-check.log)、[资料](v023-site-learning.log) |
| 本地完整回归 | 548/548，0失败/跳过 | [最终日志](v023-source-tests-after-ci.log) |
| 独立运行和安装 | 4/4；CLI配置隔离和无响应宿主2/2 | [安装与SDK](v023-independent-tests-final.log)、[CLI隔离](v023-cli-isolation-final.log) |
| 仓库内评估框架 | 336/336（完整框架及适配器）；截图/AX/清理hook通过 | [回归](v023-framework-all-tests.log)、[实际hook](v023-framework-smoke.log) |
| 打包宿主 | 197项通过，0.23.0 | [宿主](v023-package-workbench.log) |
| 打包本地服务面板 | 11项检查通过 | [面板](v023-package-local-server-panel.log) |
| 浏览器完整回归 | 最终69/69、1,248断言，0失败/跳过；宿主已退出 | [首次身份](v023-browser-initial.json)、[最终运行日志](v023-browser-suite-final.log) |
| 最终包独立性/源身份 | 195份运行文件零旧依赖；199份发行文件与源身份一致 | [独立性](v023-independent-package.log)、[发行身份](v023-package-identity.log) |
| 本轮远端CI | 全部通过；源码提交 `d6d3be9` | [完整CI](https://github.com/YeohsCode/Wiek-Browser/actions/runs/42724506570) |

浏览器回归执行时旧CLI已不在PATH，原进程为零，旧环境变量指向不可用位置。另有纯loopback测试确认显式Wiek工作区/状态设置仍生效，旧设置被忽略，没有连接其他浏览器。

远端实际结果同样为532项SDK、548项源码、336项框架/适配器、197项打包宿主、11项面板、69项浏览器/1,248断言；263份框架输入、199份发行文件和81份原始测试输入身份通过。原始日志统一保留为 `p4-ci-42724506570-ci-*.log`，状态见[CI身份](p4-ci-42724506570-status.json)。后续证据提交只更新文档与日志，运行代码保持上述已验证提交的身份。

## 验证边界与保留的失败

本轮初次完整回归为544/545，一条既有PR夹具子进程超时，见[初次日志](v023-source-tests.log)。夹具改用父进程的明确Node路径，17项远程流程专项通过，期限未放宽。之前CI的面板等待问题改为等待控件恢复可用后点击，原断言不变。后续完整回归以最终日志为准，不用专项通过替代完整结果。

此前完整浏览器重跑为25通过/44失败，宿主无响应时自动启动产生锁冲突；失败记录保留在[v023-browser-failed-wiek-e2e.json](v023-browser-failed-wiek-e2e.json)。CLI新增无响应宿主保护；测试改用全新隔离目录并负责退出，打包前拒绝覆盖运行中的应用。本轮使用独立打包目录，当前用户实例保持运行。

评估框架扩展回归初次326通过/6失败，保留[首次完整日志](v023-framework-all-tests-initial.log)。修正了品牌与版本表面检查、失败日志夹具和当前Skill路径别名支持；新增4条路径边界检查。原始SDK测试输入没有修改。

本轮首次远端CI中，335项框架测试通过、1项因任务数据未提交而失败。根目录忽略规则误排除了嵌套的框架数据和参考说明；现已加入精确例外。新增跟踪输入检查，验证263份文件已进入Git且摘要一致，并用干净检出重跑336项框架/适配器回归通过。见[干净检出](v023-clean-checkout-framework.log)和[输入身份](v023-clean-checkout-inputs.log)。

原0.22远端CI失败，记录在[原始状态](p4-ci-42132702954-status.json)。不把旧检查点的远端通过结果套到当前代码。

原始31任务数据保持字节和顺序；其中历史校准注释保留来源身份。线上Stage A/Judge任务没有执行，没有模型成绩。没有调用付费模型、修改真实网站账号或执行真实PR写操作。

多屏/撤权、物理sleep/login、完整MCP/资料迁移/语义记忆、签名/公证等仍见[实施计划](../PLAN.md)和[能力矩阵](../analysis/implementation-matrix.md)。当前包未签名、未公证。
