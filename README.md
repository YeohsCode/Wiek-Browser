# Vek Browser
> **0.4.0 更新**：项目可显式开启 Agent turn 前后文件/Git index 快照，查看逐轮/会话差异，并在预览和明确确认后恢复文件；保留恢复前保护快照，覆盖失败、中断和进程强停恢复。
>
> **0.3.0 更新**：新增远程 MCP（旧版会话与新版工具协议）、本地 Git 检查点及恢复前保护快照、IANA 时区/DST 调度、细分网站权限、下载暂停/继续和原生页面右键菜单，修复书签/历史/下载的 Profile 归属。
>
> **既有 0.2 功能**：已加入原生 Codex app-server（需自行启用/认证）、多 Agent 控制、对话分支/编辑/归档/附件、UTC cron 与 heartbeat、工作区/Git、MCP、Library/截图标注、操作录制、主题/竖向标签/快捷键、独立 Space 窗口/托盘、离线 Whisper、语音历史/词典，以及选择 Chromium 资料导入和加密 Vek Profile archive。
>
> 最新测试以 [reports/RESULTS.md](reports/RESULTS.md) 为准；[analysis/feature-parity.md](analysis/feature-parity.md) 明确列出剩余差距。不能把 69 项 SDK 用例通过理解成整款 Ego 已全量复刻。

进度与下一步验收见 [PLAN.md](PLAN.md)，全部文档入口见 [docs/README.md](docs/README.md)。当前检查点为 0.4.0；下一阶段优先补原生 provider 协议与会话完整性。

本地 Chromium 浏览器与 Agent 工作区。项目在 `vek-browser/` 中独立创建，使用 Electron 实现浏览器宿主、Space、多标签与原生连接层，复用 `citrolabs/ego-lite` 的 MIT SDK。Ego 安装包只用于分析和测试，不进入 Vek 发行包。

**当前是功能迁移版本，不代表 Ego 0.6.1.13 的全部功能已完成复刻。** 完成项、测试证据与缺口以 [功能对照](analysis/feature-parity.md)、[发货包调查](analysis/rea-investigation.md) 和 [同集测试报告](reports/comparison.md) 为准。

## 启动

当前工作区依赖和 SDK 已构建：

```sh
cd /Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser
npm start
```

或让 CLI 自动启动浏览器：

```sh
node cli/vek-browser.mjs start
node cli/vek-browser.mjs status
```

首次从源代码恢复依赖：

```sh
npm ci
npm --prefix packages/sdk ci --ignore-scripts
npm run build:sdk
npm start
```

建议 Node 24；目前实测平台为 macOS ARM64。使用 `VEK_DATA_DIR=/absolute/directory` 启动独立实例；开发版默认数据在 `data/`，打包版默认在 `~/Library/Application Support/Vek Browser/`。浏览记录、Cookie 与配置属于本地数据；不要将 `data/` 提交到仓库。

Git 提交不包含 77.7 MB 的 Whisper 模型权重；当前工作区和已打包应用已有模型。新 checkout 若需离线语音，在项目根恢复已固定的模型并核对校验和：

```sh
curl --fail --location --retry 3 \
  --output models/ggml-tiny.bin.tmp \
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin'
echo 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  models/ggml-tiny.bin.tmp' | shasum -a 256 -c - && \
  mv models/ggml-tiny.bin.tmp models/ggml-tiny.bin
```

校验失败时不要执行 `mv`。来源、大小和许可见 [models/MODEL-NOTICE.md](models/MODEL-NOTICE.md)。arm64 CPU decoder 及其构建身份/许可证在 `app/bin/`；重建它需先准备固定版本的 whisper.cpp checkout，见 [构建记录](reports/whisper-static-build.md) 和 `tools/build-whisper-static.sh`。

## Agent 操作网页

```sh
node cli/vek-browser.mjs nodejs <<'JS'
const task = await taskSpace('research');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

下一轮继续使用相同 task 名称和 Page 标签。调用 `node cli/vek-browser.mjs skill` 查看完整 API。支持 snapshot/ref、CSS/role/text/XPath 定位、输入/键鼠、跨源 iframe/Shadow DOM、上传/下载、截图、事件/等待、页面脚本与 CDP，以及 Agent/用户之间的控制移交。

```js
const task = await taskSpace('research');
await task.finish({ keep: [] }); // 关闭受管理页面并结束
// 或 keep:'all' 保留页面给用户
```

`node cli/vek-browser.mjs stop` 关闭该数据目录对应的 Vek 实例。

## 桌面功能

- 多标签、多个 Space、独立 Profile 与持久浏览状态；个人空间和 Agent 工作空间。
- 导航、搜索、后退/前进、刷新、查找、缩放、打印、常用快捷键。
- 按 Profile 隔离的书签/历史/下载，下载暂停/继续、网站权限、网页右键菜单；Cookie JSON/Chromium 资料选择导入、加密 Vek archive、解压扩展管理。
- 本地 Agent 工作区：项目、通用 CLI、opt-in Codex app-server、流式/审批、多 Agent 控制、对话分支/附件/导入导出。
- 文件编辑/搜索/watch、常用 Git 操作、命名 checkpoint 预览与明确确认恢复，以及恢复前保护快照。
- stdio/远程 HTTP MCP、scoped pairing/gateway、技能目录与会话上下文。
- 一次性、间隔、IANA 时区 cron 与 heartbeat 自动化，运行记忆/提案/停止条件。只在 Vek 开启时调度；DST 与崩溃恢复取舍见专项文档。
- Library/Collections、实际网页截图/标注、操作录制，以及本地 Whisper 转写/语音历史/词典。

本地 Agent 会话只运行你配置的已安装 CLI；没有 provider 或认证时明确报错，不生成模拟回复。Codex preset 根据本机实际 `exec --help` 发现，默认使用只读 sandbox。通用 CLI 支持 stdin 或 argv 中的 `{prompt}` 模板。测试只使用本地 fake provider；未进行付费模型调用。

尚未完成完整 Chrome/Safari 会话/web storage/扩展迁移、全部 Chrome 扩展 API、其余七种 provider 原生协议、linked worktree/远程 PR、MCP OAuth/MRTR/订阅、OS 跨应用采集/翻译、应用退出后的调度、完整 memory index、Ego 专有服务和自动更新。已实现能力也有范围限制，见 [功能对照](analysis/feature-parity.md) 和 [计划](PLAN.md)。

## 当前验证结果

0.4.0 最终打包版：**69/69** 同源真实浏览器用例通过；Ego 基准：**68/69**（HTML 粘贴用例失败），两侧无跳过/未运行。另有 **156/156** 本地测试、**53/53** 打包宿主集成、142 个打包文件身份匹配；81 个上游测试/fixture 保持原样。SDK 单测 532/532、CDP 探针 22/22 沿用未变更版本记录，没有冒充本轮重跑。详细结果以 [RESULTS.md](reports/RESULTS.md)、[comparison.md](reports/comparison.md) 与原始日志为准。

Vek引擎为Chromium148.0.7778.280，Ego为156.0.8078.48；现有自动化用例兼容不代表所有Web平台能力等价。

## 验证与对标

```sh
npm test                 # 本地服务、协议、组件与比较器验证
npm run test:upstream    # 同源 SDK 单测
npm run test:workbench   # 真实宿主集成；需模型/公开音频 fixture
node tests/snapshot-probe.mjs
node tests/cdp-transport-probe.mjs
```

同一份 69-case 真实浏览器 E2E，使用相同 SDK 与本地 fixture。单独测试 Vek 无需 Ego checkout；同时比较两侧则先准备下述本地参考制品：

```sh
VEK_COMPARISON_EGO_CLI="$PWD/tools/ego-reference-cli" npm run test:e2e -- --browser both
```

Ego 基准须先用独立测试实例启动并完成首次向导：

```sh
"downloads/ego/ego lite.app/Contents/MacOS/ego lite" \
  --user-data-dir="$PWD/data/ego-reference" \
  --ego-server-name=vek-reference --no-first-run \
  --no-default-browser-check --enable-features=SnapshotSubtree
```

比较器支持 `--browser ego|vek|both` 和重复 `--only 'exact case name'`。只选择个别 case 时，可能需要显式包含 environment initialization 或 prepare case。不要同时运行会 rebuild SDK 的测试实例，否则原生 Ego 可能读取未写完的 SDK 文件。报告保留失败、skip 和未运行，不把它们算作通过。

官方 31 项线上模型 benchmark 已下载至 `references/ego-browser-benchmark-framework`，任务清单在 `analysis/real-world-bench-task-manifest.json`。它需要独立模型 API、部分第三方账号，尚未运行；本地 69-case E2E 结果不能替代该线上分数。

## 打包

```sh
npm run dist
```

产物为 `dist/mac-arm64/Vek Browser.app`。这是本地构建；没有发布、开发者签名或公证。闭源 Ego 安装包、个人数据、参考仓库及 REA Evidence 均不包含在包中。

## 调查材料与 Git 范围

- 当前本地 `references/ego-lite/`：公开 MIT 仓库，固定 aecc5831fc5a9ea01a078b632185992a3a7ac448；复用的 SDK/测试在已提交的 `packages/sdk/`。
- 当前本地 `downloads/ego-lite-arm64.dmg` 和 `downloads/ego/ego lite.app`：官方 0.6.1.13 制品，不进入 Git 或 Vek 应用包。
- 当前本地 `analysis/evidence/`：REA 的完整清单、反编译和 JS 分析记录留在工作区；Git 只保留明确列出的身份/覆盖摘要，不提交闭源解包资源。
- `analysis/shipped-daemon-features.md`：包内 Agent daemon 的功能及覆盖边界。
- `reports/`：原始测试日志、结构化结果和对比报告。

`data/`、依赖、构建目录、Whisper 中间产物、模型权重、参考仓库、完整 REA 原始记录以及尚未适配的上游 `.github/lefthook` 自动化均被忽略，文件未从本地删除。普通 checkout 不自动具备参考浏览器或全部调查原始证据。当前仅本地 Git 提交，没有远程推送或发布。

许可与第三方来源见 [NOTICE.md](NOTICE.md)。

## 本地工作台 API

`node cli/vek-browser.mjs api help` 查看完整参数说明。例：

```sh
node cli/vek-browser.mjs api agents:projects:list --json '{}'
node cli/vek-browser.mjs api voice:snapshot --json '{}'
```

MCP gateway 默认不启动；工作区文件与 Git 始终受所选项目范围限制。语音模型和 CPU 转写程序随 macOS ARM64 应用一起打包，默认不需要网络推理。模型/decoder 许可证与构建来源见 `models/`、`app/bin/`。

Profile archive 是 Vek 自有加密格式，并非 Ego 导出文件；只读导入 Chromium v10 加密记录的支持不等于完整 Chrome/Safari 登录迁移。无实际证据时不报告账户服务、原生 provider 或线上模型任务成功。
