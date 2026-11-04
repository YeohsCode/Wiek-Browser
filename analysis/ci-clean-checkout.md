# 干净检出与远端 CI 排查

CI 使用 `.github/workflows/wiek-ci.yml`，当前目标为 macOS ARM64。执行真实 SDK 构建/断言、原生 helper 编译、本地服务/Electron 面板、Whisper 模型恢复、应用构建、打包宿主、69 项共享浏览器用例，以及发行与品牌身份检查。写好工作流或其中一段通过，不等于整条流水线通过。

## 已发现的可重复构建缺口

| 远端运行 | 实际失败 | 已实施的修复 |
|---|---|---|
| 41690733098 | SDK build 找不到 `skills/ego-browser/references/` | 精确放行两份 MIT Skill 文档；从 staged 文件导出后的 SDK 构建成功，不借用忽略目录 |
| 41824900816 | 打包宿主读取忽略的 `downloads/voice/jfk.wav` 失败 | 相同音频进入版本化 `tests/fixtures/audio/`；SHA-256 和许可保留，转录断言不变；本地宿主重跑通过 |
| 41826077172 | 媒体控件点击失败；popup waiter 返回旧页，后续预算耗尽级联 | 分别处理 CI 显示模式与公共 SDK 的 popup 更新竞态；没有删除失败用例或放宽预算 |

原始日志在 `reports/p4-ci-*`。被忽略的 `.github/workflows/ci.yml`、`main-pr-source.yml` 仅由固定 hash 的 `.fixture` 恢复为原始 SDK 测试输入，不能作为本仓库的发布自动化启用。

## 显示与 popup 的不同原因

失败 runner 的页面截图视口为 794×537；媒体夹具使用固定宽度 grid，按钮区域在小窗口中发生命中错误。`tools/configure-ci-display.swift` 在 GitHub runner 上选择至少 1440×1000 的可用模式，并记录前后尺寸、可用模式和返回码。它没有改 fixture 的 CSS、点击语义或断言；未设置 `GITHUB_ACTIONS=true` 时会拒绝配置本地显示。首版在 41828102389 中当进程存活时返回成功，但 41828541167 仍保留 794×537 视口：CGDisplaySetDisplayMode 会随调用程序退出恢复。现改用 CGBeginDisplayConfiguration / CGConfigureDisplayWithDisplayMode / CGCompleteDisplayConfiguration(.forSession)，并由第二个独立进程 `--verify-only` 检查保持效果。Apple 官方说明见 [CGDisplaySetDisplayMode](https://developer.apple.com/documentation/coregraphics/cgdisplaysetdisplaymode(_:_:_:))；不把一次进程内成功当成后续测试环境就绪。

另外，SDK 的旧 popup 在初次发现后仍可能收到 URL/title 更新。原来的 waiter 仅过滤 space/opener，于是把更新当成新 popup。`tests/sdk-popup-refresh.test.mjs` 在修复前稳定返回旧 p2 而不是新 p3；修复在注册时记录已有目标，保留更新通知的其他语义。所有原始 SDK 测试仍通过，相同 SDK 应同时用于 Ego 和 Wiek 重测，详见 [SDK changes](sdk-changes.md)。

本机 0.20.3 的一次完整测试出现合成 PR 子进程超时，原始 511/512 日志保留。该用例单独运行通过，随后没有并行打包负载的完整重跑为 512/512。没有为消除这次失败修改超时断言。

## 结果解释

最终结果看 `reports/RESULTS.md` 和对应 GitHub run 的完成状态。最新源码提交、正在运行的 CI、已验收应用包与历史 Ego 版本分别记录。线上 31 项模型基准、最终包的物理权限/多显示器/睡眠登录矩阵、签名/公证继续单列；本地 fixture 或 CI 不代表这些项目完成。

远端 41830035061 的独立显示验证已确认 1600×1200 保持，但 SDK 一个会话初始化单测耗时 126ms，触及其短墙钟预算，结果为531/532。原始日志保留。CI现先执行原始构建/skill检查/typecheck，再在相同SDK目录以 `--test-concurrency=1` 执行全部原始单测；未改任一断言或阈值。本机串行532/532通过，最终远端结论另记。

最终远端 [41830745101](https://github.com/YeohsCode/Wiek-Browser/actions/runs/41830745101) 全部通过，代码提交 `b50f9b702dc1a297a53769f0c62548048b0da017`：SDK532、本地512、打包宿主197、Wiek69/69与1,248断言、201发行文件/81原始输入与独立品牌检查通过。状态和各阶段原始日志保存于 `reports/p4-ci-41830745101-*`。
