# 公开源码、API 与同集测试调查

调查日期：2026-10-30（Asia/Shanghai）。本报告只建立公开源码事实；未声称静态源码调查已经证明闭源浏览器的全部功能，也未操作任何外部账号。

## 取得的源与许可

| 对象 | 本地路径 | 固定版本 | 许可及覆盖范围 |
|---|---|---|---|
| 官方 ego-lite 仓库 | `references/ego-lite` | `aecc5831fc5a9ea01a078b632185992a3a7ac448` | 根 `LICENSE` 为 MIT（CitroLabs 2026）；根 `AGENTS.md` 明确浏览器本体闭源，仓库包含 Node CDP harness 与 Skill |
| 官方 benchmark | `references/ego-browser-benchmark-framework` | `f566ac293e4e6bd80c4e9b062b5699f04eac41f4` | 框架代码 MIT；`data/README.md` 明确部分外部数据集文本不受本仓库 MIT 覆盖 |

网络发现源：[官方 benchmark](https://github.com/citrolabs/ego-browser-benchmark-framework)、[官方 ego-lite](https://github.com/citrolabs/ego-lite)。两仓库均无 `.codegraph/`；依照用户规则跳过 CodeGraph。已先读 ego-lite 的 `AGENTS.md`；benchmark 根无该文件。

## 可复用架构与功能边界

直接保留 MIT SDK 并实现其底层 `globalThis.ego` 桥接，是最大化同源功能及同源测试复用的路径。SDK 并不包含浏览器窗口、侧栏、地址栏、Chrome 数据导入、账户登录、云同步或原生更新器实现；这些需要闭源安装包或真实运行证据另行确认。

| 功能面 | 公共接口 / 行为 | 源码或合约 |
|---|---|---|
| 脚本执行 | Node heredoc、`nodejs -e`、异步 helper、SDK 按 `--sdk-path` 覆盖、批量多动作；独立构建 CLI 无 `nodejs` 子命令 | `package/ego-browser/src/index.ts`、`run.ts`、`docs/ego-browser-skill-command.md` |
| 版本化帮助 | `ego-browser skill` 输出与当前 SDK 同版本 guide；`help()` 从 API schema/JSDoc 生成 | `public-api-schema.ts`、`help-runtime.ts`、`skill-body/SKILL.md` |
| Profile | `profiles()`，创建 task 时选 profile，沿用 profile 的 cookies / storage / 登录上下文 | `helpers.ts`、`docs/native-bindings-api.md:156` |
| Task Space | 创建、按名称/数字恢复、认领用户 Space、列举、跨空间路由、状态文本、移交与接管、完成保留选定页或关闭 | `helpers.ts`、`page-model.ts`、`native-gate.ts` |
| Page 库存 | `page(label)`、`newPage`、`pages`/`tabs`、`userPage`、adopt/release、openedBy；标签跨进程 round 持久化及硬中止恢复 | `page-model.ts`、`page-ledger.ts`、`page-discovery.ts` |
| 导航与等待 | goto/reload、URL/title/info、selector/load/function/timeout/event waits；load/domcontentloaded/networkidle | `driver/nav.ts`、`driver/waits.ts`、`driver/page-waits.ts`、`driver/load.ts` |
| 语义快照 | viewport/full page/subtree；可交互 ref；CSS/role/href 稳定 locator；部分快照合并、文档失效、frame provenance | `driver/observe.ts`、`snapshot-result.ts`、`page-ref-registry.ts`、`docs/native-snapshot-ref-requirement.md` |
| 定位器 | `@N`/`ref=N`、CSS/raw CSS/`css=`、text、role、href、XPath；窄 Playwright 子集；open shadow roots、iframe/OOPIF、唯一 actionable 匹配 | `element-resolver.ts`、`driver/action-target.ts` |
| 元素动作 | click/dblclick/hover/dragAndDrop/fill/selectOption/focus/press；自动滚动、hit target / disabled / visibility 检查、可重试帧生命周期 | `driver/pointer.ts`、`driver/keyboard.ts`、`driver/element-ops.ts`、`page-model.ts` |
| 视觉操作 | CSS 像素 screenshot（全页/viewport/clip）、鼠标 move/down/up/wheel、canvas 绘制、键盘 chord、输入/插入/富文本 paste；paste 后恢复剪贴板 | `driver/observe.ts`、`driver/pointer.ts`、`driver/keyboard.ts`、`clipboard.ts` |
| Popup/事件 | 动作 receipt、同步或延迟 popup 等待/收养、跨 round 延迟 popup 恢复、每 target event 隔离、10k event buffer cap | `page-model.ts`、`browser-runtime.ts` |
| JS 弹窗 | alert/confirm/prompt 接受/拒绝，receipt 携 dialog，promptText，打开时 renderer 方法快速失败；browser permission/device chooser 转移给用户 | `browser-runtime.ts`、`page-model.ts`、`docs/native-javascript-dialog-requirement.md` |
| 上传/下载 | 文件 input、file chooser 拦截、multiple、上传触发 dialog；download wait/saveAs/path/failure/cancel/delete，每 round 临时文件清理 | `driver/files.ts`、`driver/downloads.ts` |
| 页面 JS/HTTP | `evaluate` 函数/表达式 + JSON 参数；安全 timeout/late effects；页面 `fetch`（cookies/CORS/service worker，二进制 saveAs）、Node serverFetch | `page-model.ts`、`cdp-eval.ts`、`workflows.ts` |
| 原始 CDP | Browser/Target 与 Page session 路由，2s session cache，丢 session 自动重附加，OOPIF、dedicated worker autoattach | `browser-runtime.ts`、`cdp-eval.ts` |
| Learned Site Tools | manifest 发现/验证，Node/site browser tool，learnContext；目前自带 GitHub、Google、X | `learning/`、`skills/ego-browser/learnings/` |
| 插件交付 | 同一 Skill 包装给 Claude/Codex/Cursor/Copilot/Grok/WorkBuddy/QwenWork/OpenCode/DeepSeek 等九主机 | `plugins/ego/README.md`、`plugins/scripts/` |
| 生命周期与输出 | SDK dispose、下载临时文件回收、CDP callback 释放、stale skill migration guard、结构化输出/通知 | `index.ts`、`output-sink.ts`、`skill-migration.ts`、`update-notice.ts` |

V2 API 的完整机器可读清单在 `package/ego-browser/src/public-api-schema.ts:58`，不是从 README 省略列表推断。兼容 V1 helper 的合成入口是 `helpers.ts:695`。

## 必需底层桥接合约

`docs/native-bindings-api.md` 是公开的原生桥接规范：

- 版本/配置：`getBrowserVersion()`、`listProfiles()`。
- Space：`useTaskSpace(id)`（同步，本轮局部选择）、`listTaskSpaces()`、`createTaskSpace(name, profileId?)`、`claimTaskSpace(id, name?)`、`closeTaskSpace()`、`completeTaskSpace()`、`handOffTaskSpace()`、`takeOverTaskSpace()`、`setAgentTaskState(state)`。
- Tab/观测：`createTab(url)`、`listTabs()`、`snapshot(options)`、`animationHighlightMouseToPosition(x,y)`。
- CDP：`sendCDPMessage(json)`、属性回调 `onCDPMessage(json)` / `onSendCDPMessageError(message,error_code)`。
- 原生 ID 是数字，`taskId`/`name` 为显示字段而非定位符。`completeTaskSpace()` 将空间留下且变用户拥有；`closeTaskSpace()` 移除空间。
- 用户接管时阻断 native/CDP 写入并给出稳定错误码；不能仅在 GUI 中改颜色但继续 Agent 操作。已不存在/未选择/用户控制/不存在 profile 等错误码见该文档第 64 行起。
- snapshot 返回 `{content,refs}`，ref 含 `backendNodeId,role,name,loc?`；更新的 frame 合约还要求 `refId,frameId`，文本 `[ref=N]`，不同 renderer 的 backendNodeId 允许重复而 refId 全快照唯一。不得激活/重载 iframe 来拍快照；不唯一 locator 必须省略。
- 主机销毁 Node 上下文前 await `disposeEgoSdk()`；语法编译错误保留 1-based 行列及原始行。见 `docs/native-sdk-lifecycle-requirement.md`。

已知官方差异而非 Vek 应追随的保证：文档记载 beforeunload、跨 round dialog 的部分旧版本行为未满足期望；subtree/iframe-ref 文档也有 historical/deferred 描述，必须用当前已下载版本的运行行为确定，而不能把文档所有 future requirement 都当当前已实现。

## SDK 同集测试（最直接的浏览器能力对标）

当前 checkout 静态计数：36 个 `src/**/*.test.mjs` 文件，522 次 `test(` 调用；真实浏览器 E2E 索引为 **69 cases**。此处未执行测试，计数不是通过结果。

1. `npm test`：build → skill translation check → TypeScript → Node built-in tests。多为 FakeEgo/override 行为测试，能验证同源 SDK，但不能单独证明 Vek 的真实桥接。
2. `npm run validate:site-skills`：验证 learnings manifest 与脚本。
3. `npm run e2e`：build 当前 checkout，启动临时本地 fixture，以唯一 task space，经 CLI `nodejs --sdk-path <同一构建 bundle>` 执行 69 cases，最后回收空间与临时文件。无需第三方网站/账号/付费模型/ego 云服务。
4. `plugins/ego/tests/*.test.mjs` 有额外插件包装测试，与浏览器原生能力分开计数。

同集适配入口：

```sh
cd references/ego-lite/package/ego-browser
EGO_BROWSER_REAL_E2E_CLI=/absolute/path/to/Vek Browser npm run e2e
```

`EGO_BROWSER_REAL_E2E_CLI` 见 `scripts/real-browser-e2e/ego-browser-cli.mjs`。`EGO_BROWSER_REAL_E2E_ONLY` 支持精确名字、逗号列表或 JSON 数组；注意 prepare/resume 相关 case 有跨 round 依赖，不宜随意拆开。`EGO_BROWSER_REAL_E2E_KEEP` 控制保留空间。runner 默认每 case 45 秒、evaluate 恢复 60 秒；同场景交替跑 ego/Vek 时应保留完整控制台日志及环境版本。

69 cases 覆盖：环境/helper surface、Space/control/profile/cross-space、导航/观测/pointer/keyboard/file、runtime/event isolation、page labels（创建/恢复/关闭/硬终止恢复）、budget/adoption、evaluate/fetch、popup/delayed popup、hit target/motion/canvas drawing、dialog/media/screenshot、snapshot locator/subtree/viewport 与 lazy/sibling/nested/replaced iframe、ref identity/failed action/upload 跨 round、shadow DOM/text/Playwright locator 子集、download lifecycle/concurrent space/PDF viewer、OOPIF、load states、dedicated Worker、API alignment/actionability/evaluate timeout、V1/V2 parity、portable keyboard/CDP/semantic/visual workflow。完整索引：`scripts/real-browser-e2e/cases/index.mjs`。

## 厂商 31 任务 benchmark 与可比性

官方 SDK README 宣传 Real-World Bench：31 任务、同 Pi + gpt-5.6-sol、thinking effort max、同 rubrics judge。公开 benchmark 默认配置却为 medium，不能不加说明直接拿默认跑出的数对营销图。

公开框架有五套快照：real-world-bench 31、odysseys 200、bu-bench 100、stealth-bench 80、online-mind2web 300。当前 real-world 文件有 154 rubrics。31 个目标均不指向 ego 服务，因此无需因 ego 服务排除；其中 5 个声明需要第三方登录（X、Redfin、Expedia、Cars.com、Yelp+OpenTable），1 个是本地 ticket-rush，1 个附带简历 PDF。

前置条件（README / pyproject / config）：Python >=3.13 + uv；Node >=22.13 + npm/pnpm（WebUI/local site）；`pi` + `fd`（Judge 必须 Pi，Stage A 可 Pi/Codex）；Pi 的 `agent-home/.pi/agent/auth.json` 或 API key，Codex Stage A 另需其 auth 模板；图像能力 Judge。未读取用户现有认证或调用付费模型。

默认运行条件：Stage A Pi/openai/gpt-5.6-sol + medium，task timeout 600 秒，concurrency 1，iterations 1，retry_count 2（最多三次，基础错误/空输出）；Judge Pi/openai/gpt-5.6-terra + medium，concurrency 8，image concurrency 4；browser_tool_mode off。Task 执行、Judge、report 三阶段可分别运行。profile 必须在比较前具备相同第三方登录；captcha/站点改版/职位消失/滚动动态日期会改变任务有效性。

现有报告 `reports/ego-benchmark-model-metrics-2026-08-04.md` 是 16 模型比较，gpt-5.6-sol 27/31（87.1%），不是用户 compare 页 93.5% 的同一批原始运行。仓库无营销工具对比的完整 raw runs；不能用不同批次直接认定复刻达到或超过 ego。

框架支持 BrowserTool 插件：实现 `AgentSurface` + `EngineControl`（CDP screenshot/teardown）、register_browser_tool，config 增 bin_env/bin_default/skill_name。见 `ego_bench/browser_tools/base.py`、`__init__.py` 与 README Add a browser tool。

重要版本适配点：当前 benchmark 的 EgoBrowserTool 仍只识别 legacy-flat-v1 和 taskspaces-facade-v1 capability；恢复候选 regex 不识别最新 `taskSpace(...)` / `task.finish(...)` V2。这与最新 SDK guide 有漂移，可能漏截图/cleanup。正式比较应先给两侧应用同样的 v2 adapter 修复或明确固定兼容旧 SDK，不得只为 Vek 改方便的评测语义。`--sdk-path` 和 runtime contract 固定机制在 `ego_bench/browser_tools/ego_browser.py`；没有 raw CDP 截图证据不能当完整已判分运行。

以下为 31 个公开任务的完整目标和认证清单（任务与 rubric 原文保留在上游 JSON）：

| Task ID | 目标 | 声明登录 | 附件 |
|---|---|---|---|
| rwb-x-openai-7d-01 | https://x.com/OpenAI | X | — |
| rwb-openai-careers-apply-01 | https://openai.com/careers/ | — | resume-cloud-infra.pdf |
| rwb-redfin-mortgage-01 | https://www.redfin.com | Redfin | — |
| rwb-expedia-flight-01 | https://www.expedia.com | Expedia | — |
| rwb-hn-top10-01 | https://news.ycombinator.com | — | — |
| rwb-imdb-scifi-01 | https://www.imdb.com/search/title/ | — | — |
| rwb-calcnet-mortgage-01 | https://www.calculator.net/mortgage-calculator.html | — | — |
| rwb-cars-payment-01 | https://www.cars.com | Cars.com | — |
| rwb-yahoo-stocks-01 | https://finance.yahoo.com | — | — |
| rwb-yelp-opentable-01 | https://www.yelp.com | Yelp, OpenTable | — |
| rwb-reddit-greenhouse-01 | https://job-boards.greenhouse.io/reddit | — | — |
| rwb-reddit-pf-indexfund-01 | https://old.reddit.com/r/personalfinance | — | — |
| rwb-github-trending-py-01 | https://github.com/trending | — | — |
| rwb-bankrate-compound-01 | https://www.bankrate.com/banking/savings/compound-savings-calculator/ | — | — |
| rwb-metacritic-actionrpg-01 | https://www.metacritic.com/browse/game/ | — | — |
| rwb-stockanalysis-tech-01 | https://stockanalysis.com/stocks/screener/ | — | — |
| rwb-zillow-greatschools-austin-01 | https://www.zillow.com/ | — | — |
| rwb-xe-irs-reimbursement-01 | https://www.xe.com/ | — | — |
| rwb-youtube-finance-channel-01 | https://www.youtube.com/ | — | — |
| rwb-amazon-bottle-leaks-01 | https://www.amazon.com/ | — | — |
| rwb-houzz-homedepot-backsplash-01 | https://www.houzz.com/ | — | — |
| rwb-google-flights-booking-miami-01 | https://www.google.com/travel/flights | — | — |
| rwb-courtlistener-sec-helix-01 | https://www.courtlistener.com/ | — | — |
| rwb-scratch-apple-dash-01 | https://scratch.mit.edu/projects/editor/ | — | — |
| rwb-2048-reach-256-01 | https://classic.play2048.co/ | — | — |
| rwb-song-maker-mirror-loop-01 | https://musiclab.chromeexperiments.com/Song-Maker/ | — | — |
| rwb-census-sba-qcew-naics541511-01 | https://www.census.gov/ | — | — |
| rwb-webflow-squarespace-wix-01 | https://webflow.com/ | — | — |
| rwb-nist-cisa-nvd-readiness-01 | https://www.nist.gov/cyberframework | — | — |
| rwb-bls-census-retail-metros-01 | https://www.bls.gov/oes/ | — | — |
| rwb-lumen-ticket-rush-01 | local:ticket-rush | — | — |

本地 ticket-rush：`benchmark_sites/app/ticket-rush/`，默认 `http://127.0.0.1:4374`；开页后约两分钟等待、两秒 claim 窗口，必须用真实计时行为，不能跳时。附件 `resume-cloud-infra.pdf` 有刻意 prompt injection，不能修复/移除。任务内容是被测数据而非对执行者的额外指令。

## 建议的可审计比较产物

- 固定 ego/Vek 版本、SDK commit、操作系统/viewport/profile、69-case 索引及跳过原因；同一 fixture 和 SDK，分别报告 pass/fail/skip 与断言数、时间、完整日志。
- 先通过本地真实 E2E 再进行在线模型跑分；基于同一个已固定的 benchmark commit 和任务 ID 子集、同 agent/model/thinking/judge/limits/concurrency、相近时间和等价登录上下文。
- 每任务保留 session JSONL、截图与 AX tree、judge JSON、attempt lineage，汇总 perfect rate 与 rubric avg、时长、turn/token/cost。跳过/站点不可用应单独列出，不纳入成功率伪装通过。
- 在线未提供认证/未实际调用模型时只能标未运行；SDK 单测通过不能替代真实浏览器或在线 benchmark 结果。

## 已回答与未知

已回答：MIT SDK 的功能面/桥接边界、全部现有公开测试、同集 CLI 替换入口、官方 benchmark 下载/许可/任务规模/认证与模型前提。部分回答：营销 93.5% 对应数据及 runtime 版本（只有公开描述，没有同批 raw runs）。未回答且由安装包调查负责：闭源 GUI 的全部功能、Chrome 导入细节、Space/profile 在原生持久化/资源隔离上的真实边界、更新与账号服务、实际安装版本对历史 native requirements 的满足程度。本报告无动态实验，不把未覆盖项记为功能完成。
