# Wiek Browser 独立运行测试

生成时间：2026-11-08T18:14:00.512Z

使用原始测试的隔离名称映射版本；断言、用例和超时阈值不变。SKIP 和未运行均不计为通过；不等同31项在线模型评估。

| 浏览器 | PASS | FAIL | SKIP | 未运行 | 断言 |
|---|---:|---:|---:|---:|---:|
| Wiek | 25 | 44 | 0 | 0 | 574 |

| Case | Wiek |
|---|---|
| environment initialization | pass |
| helper surface | pass |
| task spaces and control | pass |
| TaskSpace profile selection | pass |
| v2 cross-space routing | pass |
| navigation helpers | fail |
| observation helpers | fail |
| pointer and scroll helpers | fail |
| keyboard and file helpers | pass |
| keyboard regression | pass |
| wait, fetch, cdp, js, help | pass |
| runtime regression | pass |
| target-scoped event isolation | pass |
| page labels: create | pass |
| page labels: restore and reuse | pass |
| page labels: close and do not reuse | pass |
| page labels: persist before hard stop | pass |
| page labels: restore after hard stop | pass |
| page inventory and budget | pass |
| page adoption and release | pass |
| page basic operations | pass |
| page complex evaluate | pass |
| page fetch | pass |
| page actions and popup adoption | pass |
| Page click hit target | pass |
| Page action motion tolerance | pass |
| Page drag and canvas drawing | pass |
| Page JavaScript dialog handling | pass |
| Page media playback | fail |
| Page scrolled screenshot | fail |
| Page snapshot locator quality | fail |
| Page snapshot iframe viewport | fail |
| Page snapshot subtree | fail |
| Page ref identity across partial snapshots | fail |
| Page refs across rounds: prepare | fail |
| Page refs across rounds: resume | fail |
| Page refs in dialog workflows | fail |
| Page refs after failed actions: prepare | fail |
| Page refs after failed actions: resume | fail |
| Page refs after upload: prepare | fail |
| Page refs after upload: resume | fail |
| Page snapshot lazy iframe | fail |
| Page snapshot sibling iframes | fail |
| Page snapshot nested iframes | fail |
| Page snapshot replaced iframe | fail |
| Page open Shadow DOM locators | fail |
| Page text locators | fail |
| Page Playwright selector compatibility | fail |
| Page popup waiter and URL diagnostic | fail |
| Page download lifecycle | fail |
| Concurrent TaskSpace downloads | fail |
| Page Chromium PDF viewer download | fail |
| Page download across rounds: prepare | fail |
| Page download across rounds: resume | fail |
| Page OOPIF actions | fail |
| Page OOPIF restore and close | fail |
| Page load states | fail |
| Page dedicated Worker startup | fail |
| Page API alignment | fail |
| Page actionability | fail |
| Page evaluate timeout recovery | fail |
| Page delayed popup: schedule | fail |
| Page delayed popup: resume | fail |
| v1 and v2 action parity | fail |
| portable keyboard workflow | fail |
| Page keyboard interface | fail |
| pure CDP workflow | fail |
| snapshot workflow | fail |
| visual workflow | fail |

详细身份和日志见[结构化记录](comparison.json)。原始输入身份见[sdk-test-lineage.json](sdk-test-lineage.json)。线上模型评估未运行（blocked）：仍缺专用模型与账号。
