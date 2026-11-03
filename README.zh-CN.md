# Wiek Browser

[English](README.md) | [简体中文](README.zh-CN.md)

本地 Chromium 浏览器与 Agent 工作区，原名 **Vek Browser**。项目独立实现 Electron 宿主、浏览器界面、Profile、任务 Space 和本地服务，复用 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite) 以 MIT 许可开放的 SDK。

**当前开发检查点为 0.20.1。P3 仍在集成验收，尚未完成 Ego 全量功能复刻，P4 线上基准也未完成。** 实际进展见 [计划](PLAN.md)、[功能对照](analysis/feature-parity.md) 和 [验证结果](reports/RESULTS.md)。历史报告保留原 Vek 名称及其对应版本的测试结论。

本检查点已通过 **500/500 本地测试**、**197/197 打包宿主检查**，并核对发行文件与源码匹配。这些结果覆盖已记录的范围，原生 P3 验收与线上模型基准仍未完成。

## 从源码启动

当前桌面验证平台为 **macOS ARM64**。建议使用 Node.js 24 或兼容的更新版本。

```sh
git clone https://github.com/YeohsCode/Wiek-Browser.git
cd Wiek-Browser
npm ci
npm --prefix packages/sdk ci --ignore-scripts
npm run build:sdk
npm start
```

不安装可选语音模型也能启动浏览器。修改 Swift 原生工具后可重新编译：

```sh
npm run build:desktop-native
```

CLI 使用方式：

```sh
node cli/wiek-browser.mjs start
node cli/wiek-browser.mjs status
node cli/wiek-browser.mjs skill
node cli/wiek-browser.mjs stop
```

`WIEK_DATA_DIR=/absolute/path` 用于启动独立实例；原 `VEK_DATA_DIR` 与 `cli/vek-browser.mjs` 保留为兼容入口。开发版默认数据目录为 `data/`；打包版默认使用 `~/Library/Application Support/Wiek Browser/`。如果只有原来的 `Vek Browser` 数据目录，程序直接复用，不自动移动或删除；新目录已存在时优先使用新目录。应用标识改变后，macOS 权限及后台任务可能需要重新审核。

目录复用覆盖已有文件；OS 绑定的加密凭据迁移仍需单独验收，详见[改名兼容范围](analysis/wiek-rebrand.md)。

## 功能与当前范围

- 多标签、任务 Space、独立 Profile、书签/历史/下载、网站权限以及用户与 Agent 的控制移交。
- JavaScript 浏览器 SDK：页面 snapshot、定位、键鼠操作、iframe、截图、上传/下载和 CDP。
- 本地 Agent 工作台：CLI provider、已接入的部分原生协议、审批、附件、对话历史、逐 turn 文件与 Git 快照。
- 项目范围内的文件编辑/搜索/watch、本地 Git，以及显式审核后的远程 fetch/pull/push、GitHub PR 操作；PR 功能依赖已安装并完成认证的 `gh`。
- stdio/HTTP MCP、作用域连接、资源与订阅、OAuth/PKCE 审核、客户端身份文档和有界工具输入续传。
- 自动化调度、执行模式、明确启用的 macOS login job、忙碌延期、运行记忆/结果、停止条件评估和保守的崩溃恢复。
- Library/Collections、截图标注、网页操作录制、本地语音转写，以及需要用户启用的桌面工具。

**本检查点尚待完成的 P3 验收：** 物理多显示器/权限撤销及更多翻译语言、睡眠/登录/权限撤销，以及完整打包回归。远程 Git 使用一次性本地 bare 仓库验证；GitHub PR 使用合成协议进程测试，没有操作真实账号。其余 Agent 集成继续暂缓。完整浏览器资料迁移、部分 MCP 能力、语义 memory、签名/公证和 31 项线上模型基准仍在后续计划中。

## 让 Agent 操作网页

```sh
node cli/wiek-browser.mjs nodejs <<'JS'
const task = await taskSpace('research');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

跨轮继续使用相同任务名和页面标签。执行 `node cli/wiek-browser.mjs skill` 查看完整 SDK 指南；执行 `node cli/wiek-browser.mjs api help` 查看[本地工作台 API](skills/wiek-browser/API.md)。

## 可选本地模型

语音功能使用本地 Whisper tiny 模型。Git 不包含模型权重；语音测试或打包前需按 [models/MODEL-NOTICE.md](models/MODEL-NOTICE.md) 恢复固定版本并校验 SHA-256。该文档同时说明模型许可和 decoder 构建来源。

实验性的翻译适配使用 Python/Argos 及中英双向模型，可显式安装：

```sh
node cli/wiek-browser.mjs translation install --python /absolute/path/to/python3.12
```

安装步骤会下载依赖和模型到选定数据目录；推理设计为离线运行。已修复模型分句兼容问题，中英双向真实样例已通过服务层验证，推理期间禁止 socket 连接；这不是通用翻译质量分数。Python 和 Argos 模型不包含在应用包中。

## 测试与打包

```sh
npm test
npm run test:upstream
npm run test:workbench
npm run dist
```

新增 [Wiek CI](.github/workflows/wiek-ci.yml) 负责锁定依赖、恢复固定语音模型，以及 macOS ARM64 的 SDK/本地/打包验收。远端结果单独记录，不能把写好工作流等同于已通过。`npm run test:upstream` 会恢复两份固定上游 workflow 作为测试资料，不启用它们的发布流程。

macOS 产物为 `dist/mac-arm64/Wiek Browser.app`。当前为本地未签名构建，签名、公证和正式发布仍待配置。

最近一次完整验收的 **0.19.0 Vek 基线**：436 项本地测试、197 项打包宿主检查、69/69 项同集浏览器测试通过；相同 SDK hash 的 Ego 保留结果为 68/69。**这些数字不代表当前 0.20.1 工作树已通过验收。** 当前日志与缺口见 [reports/RESULTS.md](reports/RESULTS.md)。公开 SDK 测试和 fixture 语义保持不变；本地 69 项用例不能替代尚未运行的 31 项线上模型基准。

与 Ego 对标需要另外准备参考制品，放入被 Git 忽略的 `references/`、`downloads/`。仅开发和测试 Wiek 不要求持有 Ego 安装包。运行参考 E2E 时不要同时重建 SDK。

## 项目文档与许可

- [计划与剩余验收](PLAN.md)
- [文档索引](docs/README.md)
- [功能对齐与证据边界](analysis/feature-parity.md)
- [同集对比](reports/comparison.md)
- [第三方来源](NOTICE.md)及 [MIT 许可](LICENSE)

运行数据、凭据、依赖、构建产物、模型权重、参考浏览器及完整闭源解包材料不进入 Git。Wiek 与 CitroLabs 无隶属关系。为兼容旧数据、协议和历史证据，部分内部 Vek 标识会继续保留。
