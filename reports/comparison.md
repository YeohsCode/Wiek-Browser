# Ego / Vek Browser 同集测试对比

生成时间：2026-10-31T13:06:41.711Z

使用原封不动的上游真实浏览器 E2E runner、SDK 与本地 fixture，串行执行。SKIP 和未运行均不计为通过；本结果不等同 31 项在线模型 benchmark。

选择：69/69 个 cases。两侧 SDK、fixture 和 case 索引哈希一致。

| 浏览器 | 运行状态 | PASS | FAIL | SKIP | 未运行 | 断言 | 退出码 | 总用时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ego | fail | 68 | 1 | 0 | 0 | 1235 | 1 | 297.6s |
| vek | pass | 69 | 0 | 0 | 0 | 1248 | 0 | 153.4s |

| Case | Ego | Vek |
|---|---|---|
| environment initialization | pass (23 assertions, 3100ms) | pass (24 assertions, 2300ms) |
| helper surface | pass (67 assertions, 206ms) | pass (67 assertions, 181ms) |
| task spaces and control | pass (58 assertions, 1100ms) | pass (58 assertions, 866ms) |
| TaskSpace profile selection | pass (19 assertions, 399ms) | pass (19 assertions, 314ms) |
| v2 cross-space routing | pass (4 assertions, 518ms) | pass (4 assertions, 527ms) |
| navigation helpers | pass (33 assertions, 2600ms) | pass (33 assertions, 2500ms) |
| observation helpers | pass (51 assertions, 2600ms) | pass (51 assertions, 1500ms) |
| pointer and scroll helpers | pass (45 assertions, 28200ms) | pass (45 assertions, 6400ms) |
| keyboard and file helpers | pass (22 assertions, 2100ms) | pass (22 assertions, 1500ms) |
| keyboard regression | pass (14 assertions, 783ms) | pass (14 assertions, 730ms) |
| wait, fetch, cdp, js, help | pass (42 assertions, 2400ms) | pass (42 assertions, 2400ms) |
| runtime regression | pass (20 assertions, 3200ms) | pass (20 assertions, 3200ms) |
| target-scoped event isolation | pass (4 assertions, 3200ms) | pass (4 assertions, 3200ms) |
| page labels: create | pass (13 assertions, 369ms) | pass (13 assertions, 418ms) |
| page labels: restore and reuse | pass (14 assertions, 412ms) | pass (14 assertions, 401ms) |
| page labels: close and do not reuse | pass (10 assertions, 692ms) | pass (10 assertions, 547ms) |
| page labels: persist before hard stop | pass (1 assertions, 327ms) | pass (1 assertions, 305ms) |
| page labels: restore after hard stop | pass (3 assertions, 403ms) | pass (3 assertions, 295ms) |
| page inventory and budget | pass (9 assertions, 851ms) | pass (9 assertions, 748ms) |
| page adoption and release | pass (19 assertions, 580ms) | pass (19 assertions, 516ms) |
| page basic operations | pass (53 assertions, 3900ms) | pass (53 assertions, 1600ms) |
| page complex evaluate | pass (23 assertions, 654ms) | pass (23 assertions, 547ms) |
| page fetch | pass (25 assertions, 646ms) | pass (25 assertions, 572ms) |
| page actions and popup adoption | pass (57 assertions, 32300ms) | pass (57 assertions, 3900ms) |
| Page click hit target | pass (17 assertions, 8300ms) | pass (17 assertions, 3400ms) |
| Page action motion tolerance | pass (6 assertions, 1500ms) | pass (6 assertions, 1000ms) |
| Page drag and canvas drawing | pass (15 assertions, 12800ms) | pass (15 assertions, 1000ms) |
| Page JavaScript dialog handling | pass (34 assertions, 4700ms) | pass (34 assertions, 1000ms) |
| Page media playback | pass (17 assertions, 13200ms) | pass (17 assertions, 4600ms) |
| Page scrolled screenshot | pass (13 assertions, 549ms) | pass (13 assertions, 484ms) |
| Page snapshot locator quality | pass (4 assertions, 383ms) | pass (4 assertions, 346ms) |
| Page snapshot iframe viewport | pass (13 assertions, 856ms) | pass (13 assertions, 782ms) |
| Page snapshot subtree | pass (46 assertions, 2400ms) | pass (46 assertions, 1300ms) |
| Page ref identity across partial snapshots | pass (14 assertions, 5100ms) | pass (14 assertions, 1400ms) |
| Page refs across rounds: prepare | pass (5 assertions, 344ms) | pass (5 assertions, 335ms) |
| Page refs across rounds: resume | pass (12 assertions, 7400ms) | pass (12 assertions, 5000ms) |
| Page refs in dialog workflows | pass (10 assertions, 1600ms) | pass (10 assertions, 774ms) |
| Page refs after failed actions: prepare | pass (8 assertions, 768ms) | pass (8 assertions, 741ms) |
| Page refs after failed actions: resume | pass (3 assertions, 684ms) | pass (3 assertions, 290ms) |
| Page refs after upload: prepare | pass (2 assertions, 438ms) | pass (2 assertions, 439ms) |
| Page refs after upload: resume | pass (3 assertions, 362ms) | pass (3 assertions, 290ms) |
| Page snapshot lazy iframe | pass (14 assertions, 332ms) | pass (14 assertions, 300ms) |
| Page snapshot sibling iframes | pass (14 assertions, 536ms) | pass (14 assertions, 486ms) |
| Page snapshot nested iframes | pass (18 assertions, 521ms) | pass (18 assertions, 483ms) |
| Page snapshot replaced iframe | pass (11 assertions, 426ms) | pass (11 assertions, 448ms) |
| Page open Shadow DOM locators | pass (4 assertions, 2000ms) | pass (4 assertions, 778ms) |
| Page text locators | pass (6 assertions, 3200ms) | pass (6 assertions, 908ms) |
| Page Playwright selector compatibility | pass (16 assertions, 18200ms) | pass (16 assertions, 2900ms) |
| Page popup waiter and URL diagnostic | pass (11 assertions, 4600ms) | pass (11 assertions, 1200ms) |
| Page download lifecycle | pass (8 assertions, 1000ms) | pass (8 assertions, 664ms) |
| Concurrent TaskSpace downloads | pass (13 assertions, 5500ms) | pass (13 assertions, 2000ms) |
| Page Chromium PDF viewer download | pass (13 assertions, 2900ms) | pass (13 assertions, 1100ms) |
| Page download across rounds: prepare | pass (1 assertions, 1100ms) | pass (1 assertions, 655ms) |
| Page download across rounds: resume | pass (4 assertions, 1100ms) | pass (4 assertions, 205ms) |
| Page OOPIF actions | pass (15 assertions, 10100ms) | pass (15 assertions, 2100ms) |
| Page OOPIF restore and close | pass (7 assertions, 1100ms) | pass (7 assertions, 233ms) |
| Page load states | pass (50 assertions, 12800ms) | pass (50 assertions, 11600ms) |
| Page dedicated Worker startup | pass (1 assertions, 387ms) | pass (1 assertions, 345ms) |
| Page API alignment | pass (40 assertions, 5200ms) | pass (40 assertions, 5200ms) |
| Page actionability | pass (46 assertions, 12500ms) | pass (46 assertions, 5600ms) |
| Page evaluate timeout recovery | pass (24 assertions, 48400ms) | pass (24 assertions, 48300ms) |
| Page delayed popup: schedule | pass (1 assertions, 935ms) | pass (1 assertions, 680ms) |
| Page delayed popup: resume | pass (3 assertions, 1300ms) | pass (3 assertions, 1100ms) |
| v1 and v2 action parity | pass (13 assertions, 1900ms) | pass (13 assertions, 768ms) |
| portable keyboard workflow | pass (4 assertions, 880ms) | pass (4 assertions, 783ms) |
| Page keyboard interface | fail (26 assertions, 1900ms) | pass (38 assertions, 2000ms) |
| pure CDP workflow | pass (9 assertions, 467ms) | pass (9 assertions, 403ms) |
| snapshot workflow | pass (7 assertions, 3100ms) | pass (7 assertions, 1000ms) |
| visual workflow | pass (5 assertions, 425ms) | pass (5 assertions, 526ms) |

## 可审计产物

- **ego**：[合并日志](ego-e2e.log)、[stdout](ego-e2e.stdout.log)、[stderr](ego-e2e.stderr.log)、[结构化结果](ego-e2e.json)。
  CLI：`/Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser/tools/ego-reference-cli`；SDK SHA-256：`a8c27da3bf8733b77b927549ffdb40867737592b235dea03bdaffb9fcc572a56`。
- **vek**：[合并日志](vek-e2e.log)、[stdout](vek-e2e.stdout.log)、[stderr](vek-e2e.stderr.log)、[结构化结果](vek-e2e.json)。
  CLI：`/Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser/dist/mac-arm64/Vek Browser.app/Contents/Resources/app/cli/vek-browser.mjs`；SDK SHA-256：`a8c27da3bf8733b77b927549ffdb40867737592b235dea03bdaffb9fcc572a56`。

## 在线 benchmark

未运行（blocked）：本次没有为 Stage A 与 Judge 提供已确认可用的模型认证，也未确认五类第三方网站登录。未读取个人 API key。框架与 31 项任务已下载；详细前提见 ../analysis/public-api-and-tests.md。


本表通过 tools/compare-saved-runs.mjs 显式合并两次完整记录，哈希校验通过。Ego 基准先执行；Vek 使用最终 macOS 应用包的 CLI 执行，保留各自开始/结束时间及原始日志。
