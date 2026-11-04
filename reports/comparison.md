# Ego / Wiek Browser 同集测试对比

生成时间：2026-11-04T12:27:32.286Z

使用未改断言的上游真实浏览器 E2E runner 与本地 fixture，串行执行；两侧使用相同 SDK，本地修复见 ../analysis/sdk-changes.md。SKIP 和未运行均不计为通过；本结果不等同 31 项在线模型 benchmark。

选择：69/69 个 cases。两侧 SDK、fixture 和 case 索引哈希一致。

| 浏览器 | 运行状态 | PASS | FAIL | SKIP | 未运行 | 断言 | 退出码 | 总用时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| ego | fail | 68 | 1 | 0 | 0 | 1235 | 1 | 283.0s |
| vek | pass | 69 | 0 | 0 | 0 | 1248 | 0 | 169.3s |

| Case | Ego | Wiek |
|---|---|---|
| environment initialization | pass (23 assertions, 1800ms) | pass (24 assertions, 3200ms) |
| helper surface | pass (67 assertions, 187ms) | pass (67 assertions, 168ms) |
| task spaces and control | pass (58 assertions, 975ms) | pass (58 assertions, 1100ms) |
| TaskSpace profile selection | pass (19 assertions, 440ms) | pass (19 assertions, 383ms) |
| v2 cross-space routing | pass (4 assertions, 503ms) | pass (4 assertions, 671ms) |
| navigation helpers | pass (33 assertions, 2500ms) | pass (33 assertions, 3200ms) |
| observation helpers | pass (51 assertions, 2500ms) | pass (51 assertions, 1600ms) |
| pointer and scroll helpers | pass (45 assertions, 23500ms) | pass (45 assertions, 9000ms) |
| keyboard and file helpers | pass (22 assertions, 2100ms) | pass (22 assertions, 1600ms) |
| keyboard regression | pass (14 assertions, 730ms) | pass (14 assertions, 818ms) |
| wait, fetch, cdp, js, help | pass (42 assertions, 2400ms) | pass (42 assertions, 2500ms) |
| runtime regression | pass (20 assertions, 3200ms) | pass (20 assertions, 3600ms) |
| target-scoped event isolation | pass (4 assertions, 3100ms) | pass (4 assertions, 3300ms) |
| page labels: create | pass (13 assertions, 345ms) | pass (13 assertions, 473ms) |
| page labels: restore and reuse | pass (14 assertions, 417ms) | pass (14 assertions, 507ms) |
| page labels: close and do not reuse | pass (10 assertions, 669ms) | pass (10 assertions, 663ms) |
| page labels: persist before hard stop | pass (1 assertions, 314ms) | pass (1 assertions, 349ms) |
| page labels: restore after hard stop | pass (3 assertions, 387ms) | pass (3 assertions, 354ms) |
| page inventory and budget | pass (9 assertions, 848ms) | pass (9 assertions, 950ms) |
| page adoption and release | pass (19 assertions, 451ms) | pass (19 assertions, 637ms) |
| page basic operations | pass (53 assertions, 3900ms) | pass (53 assertions, 2000ms) |
| page complex evaluate | pass (23 assertions, 619ms) | pass (23 assertions, 673ms) |
| page fetch | pass (25 assertions, 648ms) | pass (25 assertions, 739ms) |
| page actions and popup adoption | pass (57 assertions, 31000ms) | pass (57 assertions, 4800ms) |
| Page click hit target | pass (17 assertions, 8300ms) | pass (17 assertions, 3700ms) |
| Page action motion tolerance | pass (6 assertions, 1600ms) | pass (6 assertions, 1300ms) |
| Page drag and canvas drawing | pass (15 assertions, 4900ms) | pass (15 assertions, 1000ms) |
| Page JavaScript dialog handling | pass (34 assertions, 5500ms) | pass (34 assertions, 1100ms) |
| Page media playback | pass (17 assertions, 12600ms) | pass (17 assertions, 5000ms) |
| Page scrolled screenshot | pass (13 assertions, 671ms) | pass (13 assertions, 621ms) |
| Page snapshot locator quality | pass (4 assertions, 326ms) | pass (4 assertions, 422ms) |
| Page snapshot iframe viewport | pass (13 assertions, 842ms) | pass (13 assertions, 988ms) |
| Page snapshot subtree | pass (46 assertions, 2400ms) | pass (46 assertions, 1700ms) |
| Page ref identity across partial snapshots | pass (14 assertions, 4000ms) | pass (14 assertions, 1600ms) |
| Page refs across rounds: prepare | pass (5 assertions, 339ms) | pass (5 assertions, 419ms) |
| Page refs across rounds: resume | pass (12 assertions, 7500ms) | pass (12 assertions, 5200ms) |
| Page refs in dialog workflows | pass (10 assertions, 1500ms) | pass (10 assertions, 894ms) |
| Page refs after failed actions: prepare | pass (8 assertions, 752ms) | pass (8 assertions, 831ms) |
| Page refs after failed actions: resume | pass (3 assertions, 725ms) | pass (3 assertions, 330ms) |
| Page refs after upload: prepare | pass (2 assertions, 454ms) | pass (2 assertions, 511ms) |
| Page refs after upload: resume | pass (3 assertions, 362ms) | pass (3 assertions, 312ms) |
| Page snapshot lazy iframe | pass (14 assertions, 418ms) | pass (14 assertions, 441ms) |
| Page snapshot sibling iframes | pass (14 assertions, 517ms) | pass (14 assertions, 609ms) |
| Page snapshot nested iframes | pass (18 assertions, 518ms) | pass (18 assertions, 572ms) |
| Page snapshot replaced iframe | pass (11 assertions, 569ms) | pass (11 assertions, 558ms) |
| Page open Shadow DOM locators | pass (4 assertions, 2000ms) | pass (4 assertions, 887ms) |
| Page text locators | pass (6 assertions, 3300ms) | pass (6 assertions, 1100ms) |
| Page Playwright selector compatibility | pass (16 assertions, 19100ms) | pass (16 assertions, 3200ms) |
| Page popup waiter and URL diagnostic | pass (11 assertions, 4500ms) | pass (11 assertions, 1400ms) |
| Page download lifecycle | pass (8 assertions, 1200ms) | pass (8 assertions, 777ms) |
| Concurrent TaskSpace downloads | pass (13 assertions, 6300ms) | pass (13 assertions, 2300ms) |
| Page Chromium PDF viewer download | pass (13 assertions, 2900ms) | pass (13 assertions, 1200ms) |
| Page download across rounds: prepare | pass (1 assertions, 1100ms) | pass (1 assertions, 755ms) |
| Page download across rounds: resume | pass (4 assertions, 1100ms) | pass (4 assertions, 235ms) |
| Page OOPIF actions | pass (15 assertions, 9700ms) | pass (15 assertions, 2300ms) |
| Page OOPIF restore and close | pass (7 assertions, 1100ms) | pass (7 assertions, 233ms) |
| Page load states | pass (50 assertions, 12700ms) | pass (50 assertions, 12000ms) |
| Page dedicated Worker startup | pass (1 assertions, 369ms) | pass (1 assertions, 386ms) |
| Page API alignment | pass (40 assertions, 5200ms) | pass (40 assertions, 5800ms) |
| Page actionability | pass (46 assertions, 13500ms) | pass (46 assertions, 6400ms) |
| Page evaluate timeout recovery | pass (24 assertions, 48400ms) | pass (24 assertions, 48600ms) |
| Page delayed popup: schedule | pass (1 assertions, 1000ms) | pass (1 assertions, 718ms) |
| Page delayed popup: resume | pass (3 assertions, 1300ms) | pass (3 assertions, 1100ms) |
| v1 and v2 action parity | pass (13 assertions, 1800ms) | pass (13 assertions, 1000ms) |
| portable keyboard workflow | pass (4 assertions, 863ms) | pass (4 assertions, 970ms) |
| Page keyboard interface | fail (26 assertions, 1600ms) | pass (38 assertions, 2600ms) |
| pure CDP workflow | pass (9 assertions, 519ms) | pass (9 assertions, 531ms) |
| snapshot workflow | pass (7 assertions, 3100ms) | pass (7 assertions, 1300ms) |
| visual workflow | pass (5 assertions, 438ms) | pass (5 assertions, 528ms) |

## 可审计产物

- **ego**：[合并日志](ego-e2e.log)、[stdout](ego-e2e.stdout.log)、[stderr](ego-e2e.stderr.log)、[结构化结果](ego-e2e.json)。
  CLI：`/Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser/tools/ego-reference-cli`；SDK SHA-256：`b4ddb96154c2e06ff775daae91a8dfd2df03bcff924c2c5e803bf88ec50fec13`。
- **vek**：[合并日志](vek-e2e.log)、[stdout](vek-e2e.stdout.log)、[stderr](vek-e2e.stderr.log)、[结构化结果](vek-e2e.json)。
  CLI：`/Users/andrewyeoh/Werk/projects/v-browser-uz/vek-browser/dist/mac-arm64/Wiek Browser.app/Contents/Resources/app/cli/wiek-browser.mjs`；SDK SHA-256：`b4ddb96154c2e06ff775daae91a8dfd2df03bcff924c2c5e803bf88ec50fec13`。

## 在线 benchmark

未运行（blocked）：本次没有为 Stage A 与 Judge 提供已确认可用的模型认证，也未确认五类第三方网站登录。未读取个人 API key。框架与 31 项任务已下载；详细前提见 ../analysis/public-api-and-tests.md。
