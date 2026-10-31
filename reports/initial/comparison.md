# Ego / Vek Browser 同集测试对比

生成时间：2026-10-29T16:26:35.540Z

使用原封不动的上游真实浏览器 E2E runner、SDK 与本地 fixture，串行执行。SKIP 和未运行均不计为通过；本结果不等同 31 项在线模型 benchmark。

选择：69/69 个 cases。尚无两侧相同 SDK、fixture、case 索引的完整运行证据。

| 浏览器 | 运行状态 | PASS | FAIL | SKIP | 未运行 | 断言 | 退出码 | 总用时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ego | fail | 63 | 6 | 0 | 0 | 1194 | 1 | 289.3s |

| Case | Ego | Vek |
|---|---|---|
| environment initialization | pass (23 assertions, 3100ms) | not_run |
| helper surface | pass (67 assertions, 202ms) | not_run |
| task spaces and control | pass (58 assertions, 982ms) | not_run |
| TaskSpace profile selection | pass (19 assertions, 261ms) | not_run |
| v2 cross-space routing | pass (4 assertions, 486ms) | not_run |
| navigation helpers | pass (33 assertions, 2200ms) | not_run |
| observation helpers | pass (51 assertions, 3400ms) | not_run |
| pointer and scroll helpers | pass (45 assertions, 24500ms) | not_run |
| keyboard and file helpers | pass (22 assertions, 2100ms) | not_run |
| keyboard regression | pass (14 assertions, 743ms) | not_run |
| wait, fetch, cdp, js, help | pass (42 assertions, 2400ms) | not_run |
| runtime regression | pass (20 assertions, 3200ms) | not_run |
| target-scoped event isolation | pass (4 assertions, 3100ms) | not_run |
| page labels: create | fail (0 assertions, 113ms) | not_run |
| page labels: restore and reuse | fail (0 assertions, 91ms) | not_run |
| page labels: close and do not reuse | fail (0 assertions, 91ms) | not_run |
| page labels: persist before hard stop | fail (0 assertions, 90ms) | not_run |
| page labels: restore after hard stop | fail (0 assertions, 116ms) | not_run |
| page inventory and budget | pass (9 assertions, 847ms) | not_run |
| page adoption and release | pass (19 assertions, 554ms) | not_run |
| page basic operations | pass (53 assertions, 3900ms) | not_run |
| page complex evaluate | pass (23 assertions, 585ms) | not_run |
| page fetch | pass (25 assertions, 641ms) | not_run |
| page actions and popup adoption | pass (57 assertions, 31800ms) | not_run |
| Page click hit target | pass (17 assertions, 8200ms) | not_run |
| Page action motion tolerance | pass (6 assertions, 2300ms) | not_run |
| Page drag and canvas drawing | pass (15 assertions, 10900ms) | not_run |
| Page JavaScript dialog handling | pass (34 assertions, 5500ms) | not_run |
| Page media playback | pass (17 assertions, 11500ms) | not_run |
| Page scrolled screenshot | pass (13 assertions, 674ms) | not_run |
| Page snapshot locator quality | pass (4 assertions, 393ms) | not_run |
| Page snapshot iframe viewport | pass (13 assertions, 835ms) | not_run |
| Page snapshot subtree | pass (46 assertions, 2400ms) | not_run |
| Page ref identity across partial snapshots | pass (14 assertions, 6000ms) | not_run |
| Page refs across rounds: prepare | pass (5 assertions, 343ms) | not_run |
| Page refs across rounds: resume | pass (12 assertions, 7400ms) | not_run |
| Page refs in dialog workflows | pass (10 assertions, 1500ms) | not_run |
| Page refs after failed actions: prepare | pass (8 assertions, 740ms) | not_run |
| Page refs after failed actions: resume | pass (3 assertions, 1300ms) | not_run |
| Page refs after upload: prepare | pass (2 assertions, 1400ms) | not_run |
| Page refs after upload: resume | pass (3 assertions, 356ms) | not_run |
| Page snapshot lazy iframe | pass (14 assertions, 318ms) | not_run |
| Page snapshot sibling iframes | pass (14 assertions, 499ms) | not_run |
| Page snapshot nested iframes | pass (18 assertions, 499ms) | not_run |
| Page snapshot replaced iframe | pass (11 assertions, 567ms) | not_run |
| Page open Shadow DOM locators | pass (4 assertions, 2000ms) | not_run |
| Page text locators | pass (6 assertions, 3400ms) | not_run |
| Page Playwright selector compatibility | pass (16 assertions, 18100ms) | not_run |
| Page popup waiter and URL diagnostic | pass (11 assertions, 4500ms) | not_run |
| Page download lifecycle | pass (8 assertions, 1200ms) | not_run |
| Concurrent TaskSpace downloads | pass (13 assertions, 5700ms) | not_run |
| Page Chromium PDF viewer download | pass (13 assertions, 2900ms) | not_run |
| Page download across rounds: prepare | pass (1 assertions, 1100ms) | not_run |
| Page download across rounds: resume | pass (4 assertions, 1100ms) | not_run |
| Page OOPIF actions | pass (15 assertions, 6700ms) | not_run |
| Page OOPIF restore and close | pass (7 assertions, 1100ms) | not_run |
| Page load states | pass (50 assertions, 12700ms) | not_run |
| Page dedicated Worker startup | pass (1 assertions, 374ms) | not_run |
| Page API alignment | pass (40 assertions, 5200ms) | not_run |
| Page actionability | pass (46 assertions, 13500ms) | not_run |
| Page evaluate timeout recovery | pass (24 assertions, 48400ms) | not_run |
| Page delayed popup: schedule | pass (1 assertions, 1100ms) | not_run |
| Page delayed popup: resume | pass (3 assertions, 1200ms) | not_run |
| v1 and v2 action parity | pass (13 assertions, 1800ms) | not_run |
| portable keyboard workflow | pass (4 assertions, 851ms) | not_run |
| Page keyboard interface | fail (26 assertions, 1600ms) | not_run |
| pure CDP workflow | pass (9 assertions, 447ms) | not_run |
| snapshot workflow | pass (7 assertions, 3200ms) | not_run |
| visual workflow | pass (5 assertions, 403ms) | not_run |

## 可审计产物

- **ego**：[合并日志](ego-e2e.log)、[stdout](ego-e2e.stdout.log)、[stderr](ego-e2e.stderr.log)、[结构化结果](ego-e2e.json)。
  CLI：`/Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser/tools/ego-reference-cli`；SDK SHA-256：`a8c27da3bf8733b77b927549ffdb40867737592b235dea03bdaffb9fcc572a56`。

## 在线 benchmark

未运行（blocked）：本次没有为 Stage A 与 Judge 提供已确认可用的模型认证，也未确认五类第三方网站登录。未读取个人 API key。框架与 31 项任务已下载；详细前提见 ../analysis/public-api-and-tests.md。
