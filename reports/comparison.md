# Wiek Browser 同集测试对比

生成时间：2026-11-05T16:59:56.898Z

使用未改断言的上游真实浏览器 E2E runner 与本地 fixture，串行执行；两侧使用相同 SDK，本地修复见 ../analysis/sdk-changes.md。SKIP 和未运行均不计为通过；本结果不等同 31 项在线模型 benchmark。

选择：69/69 个 cases。两侧 SDK、fixture 和 case 索引哈希一致。

| 浏览器 | 运行状态 | PASS | FAIL | SKIP | 未运行 | 断言 | 退出码 | 总用时 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 参考侧 | fail | 68 | 1 | 0 | 0 | 1235 | 1 | 283.0s |
| Wiek | pass | 69 | 0 | 0 | 0 | 1248 | 0 | 167.9s |

| Case | 参考侧 | Wiek |
|---|---|---|
| environment initialization | pass (23 assertions, 1800ms) | pass (24 assertions, 2800ms) |
| helper surface | pass (67 assertions, 187ms) | pass (67 assertions, 171ms) |
| task spaces and control | pass (58 assertions, 975ms) | pass (58 assertions, 1100ms) |
| TaskSpace profile selection | pass (19 assertions, 440ms) | pass (19 assertions, 363ms) |
| v2 cross-space routing | pass (4 assertions, 503ms) | pass (4 assertions, 647ms) |
| navigation helpers | pass (33 assertions, 2500ms) | pass (33 assertions, 3100ms) |
| observation helpers | pass (51 assertions, 2500ms) | pass (51 assertions, 1900ms) |
| pointer and scroll helpers | pass (45 assertions, 23500ms) | pass (45 assertions, 8900ms) |
| keyboard and file helpers | pass (22 assertions, 2100ms) | pass (22 assertions, 1600ms) |
| keyboard regression | pass (14 assertions, 730ms) | pass (14 assertions, 802ms) |
| wait, fetch, cdp, js, help | pass (42 assertions, 2400ms) | pass (42 assertions, 2800ms) |
| runtime regression | pass (20 assertions, 3200ms) | pass (20 assertions, 3300ms) |
| target-scoped event isolation | pass (4 assertions, 3100ms) | pass (4 assertions, 3600ms) |
| page labels: create | pass (13 assertions, 345ms) | pass (13 assertions, 786ms) |
| page labels: restore and reuse | pass (14 assertions, 417ms) | pass (14 assertions, 491ms) |
| page labels: close and do not reuse | pass (10 assertions, 669ms) | pass (10 assertions, 644ms) |
| page labels: persist before hard stop | pass (1 assertions, 314ms) | pass (1 assertions, 343ms) |
| page labels: restore after hard stop | pass (3 assertions, 387ms) | pass (3 assertions, 345ms) |
| page inventory and budget | pass (9 assertions, 848ms) | pass (9 assertions, 903ms) |
| page adoption and release | pass (19 assertions, 451ms) | pass (19 assertions, 599ms) |
| page basic operations | pass (53 assertions, 3900ms) | pass (53 assertions, 1900ms) |
| page complex evaluate | pass (23 assertions, 619ms) | pass (23 assertions, 668ms) |
| page fetch | pass (25 assertions, 648ms) | pass (25 assertions, 712ms) |
| page actions and popup adoption | pass (57 assertions, 31000ms) | pass (57 assertions, 4700ms) |
| Page click hit target | pass (17 assertions, 8300ms) | pass (17 assertions, 3600ms) |
| Page action motion tolerance | pass (6 assertions, 1600ms) | pass (6 assertions, 1200ms) |
| Page drag and canvas drawing | pass (15 assertions, 4900ms) | pass (15 assertions, 986ms) |
| Page JavaScript dialog handling | pass (34 assertions, 5500ms) | pass (34 assertions, 1100ms) |
| Page media playback | pass (17 assertions, 12600ms) | pass (17 assertions, 4900ms) |
| Page scrolled screenshot | pass (13 assertions, 671ms) | pass (13 assertions, 497ms) |
| Page snapshot locator quality | pass (4 assertions, 326ms) | pass (4 assertions, 413ms) |
| Page snapshot iframe viewport | pass (13 assertions, 842ms) | pass (13 assertions, 936ms) |
| Page snapshot subtree | pass (46 assertions, 2400ms) | pass (46 assertions, 1600ms) |
| Page ref identity across partial snapshots | pass (14 assertions, 4000ms) | pass (14 assertions, 1600ms) |
| Page refs across rounds: prepare | pass (5 assertions, 339ms) | pass (5 assertions, 405ms) |
| Page refs across rounds: resume | pass (12 assertions, 7500ms) | pass (12 assertions, 5300ms) |
| Page refs in dialog workflows | pass (10 assertions, 1500ms) | pass (10 assertions, 878ms) |
| Page refs after failed actions: prepare | pass (8 assertions, 752ms) | pass (8 assertions, 815ms) |
| Page refs after failed actions: resume | pass (3 assertions, 725ms) | pass (3 assertions, 331ms) |
| Page refs after upload: prepare | pass (2 assertions, 454ms) | pass (2 assertions, 499ms) |
| Page refs after upload: resume | pass (3 assertions, 362ms) | pass (3 assertions, 342ms) |
| Page snapshot lazy iframe | pass (14 assertions, 418ms) | pass (14 assertions, 522ms) |
| Page snapshot sibling iframes | pass (14 assertions, 517ms) | pass (14 assertions, 593ms) |
| Page snapshot nested iframes | pass (18 assertions, 518ms) | pass (18 assertions, 557ms) |
| Page snapshot replaced iframe | pass (11 assertions, 569ms) | pass (11 assertions, 545ms) |
| Page open Shadow DOM locators | pass (4 assertions, 2000ms) | pass (4 assertions, 884ms) |
| Page text locators | pass (6 assertions, 3300ms) | pass (6 assertions, 1000ms) |
| Page Playwright selector compatibility | pass (16 assertions, 19100ms) | pass (16 assertions, 3100ms) |
| Page popup waiter and URL diagnostic | pass (11 assertions, 4500ms) | pass (11 assertions, 1400ms) |
| Page download lifecycle | pass (8 assertions, 1200ms) | pass (8 assertions, 733ms) |
| Concurrent TaskSpace downloads | pass (13 assertions, 6300ms) | pass (13 assertions, 2200ms) |
| Page Chromium PDF viewer download | pass (13 assertions, 2900ms) | pass (13 assertions, 1100ms) |
| Page download across rounds: prepare | pass (1 assertions, 1100ms) | pass (1 assertions, 719ms) |
| Page download across rounds: resume | pass (4 assertions, 1100ms) | pass (4 assertions, 220ms) |
| Page OOPIF actions | pass (15 assertions, 9700ms) | pass (15 assertions, 2300ms) |
| Page OOPIF restore and close | pass (7 assertions, 1100ms) | pass (7 assertions, 234ms) |
| Page load states | pass (50 assertions, 12700ms) | pass (50 assertions, 11900ms) |
| Page dedicated Worker startup | pass (1 assertions, 369ms) | pass (1 assertions, 371ms) |
| Page API alignment | pass (40 assertions, 5200ms) | pass (40 assertions, 5700ms) |
| Page actionability | pass (46 assertions, 13500ms) | pass (46 assertions, 6300ms) |
| Page evaluate timeout recovery | pass (24 assertions, 48400ms) | pass (24 assertions, 48500ms) |
| Page delayed popup: schedule | pass (1 assertions, 1000ms) | pass (1 assertions, 709ms) |
| Page delayed popup: resume | pass (3 assertions, 1300ms) | pass (3 assertions, 1100ms) |
| v1 and v2 action parity | pass (13 assertions, 1800ms) | pass (13 assertions, 974ms) |
| portable keyboard workflow | pass (4 assertions, 863ms) | pass (4 assertions, 949ms) |
| Page keyboard interface | fail (26 assertions, 1600ms) | pass (38 assertions, 2500ms) |
| pure CDP workflow | pass (9 assertions, 519ms) | pass (9 assertions, 532ms) |
| snapshot workflow | pass (7 assertions, 3100ms) | pass (7 assertions, 1200ms) |
| visual workflow | pass (5 assertions, 438ms) | pass (5 assertions, 487ms) |

## 可审计产物

- **参考侧**：SDK SHA-256：`b4ddb96154c2e06ff775daae91a8dfd2df03bcff924c2c5e803bf88ec50fec13`。CLI 身份、完整诊断及日志索引见[结构化记录](comparison.json)。
- **Wiek**：SDK SHA-256：`b4ddb96154c2e06ff775daae91a8dfd2df03bcff924c2c5e803bf88ec50fec13`。CLI 身份、完整诊断及日志索引见[结构化记录](comparison.json)。

## 在线 benchmark

未运行（blocked）：本次没有为 Stage A 与 Judge 提供已确认可用的模型认证，也未确认五类第三方网站登录。未读取个人 API key。框架与 31 项任务已下载；详细前提见 ../analysis/public-api-and-tests.md。


本表通过 tools/compare-saved-runs.mjs 显式合并两次完整记录，哈希校验通过。参考侧基准先执行；Wiek 使用最终 macOS 应用包的 CLI 执行，保留各自开始/结束时间及原始日志。
