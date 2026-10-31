# Ego 0.6.1.13 发货制品调查

调查目标是官网官方安装包，不将公开SDK误认为整个浏览器源代码。分析使用已安装的 morluto/rea skill（reverse-engineer-anything v42）与 REA 6.5.0；原始观察、推断、未知分别保留。

## 目标与身份

- 官方仓库：citrolabs/ego-lite，固定commit `aecc5831fc5a9ea01a078b632185992a3a7ac448`，MIT。公开代码是agent SDK/skill，不包含完整浏览器。
- 官方ARM64安装包：`https://cdn.ego.app/setup/macos/arm64/egolite-fHoqgZ74bOEM.dmg`。
- DMG SHA256：`56c415ce29cd68250e83de31eda5f659564edaf58d204eadad6d43b6b9fa6817`。
- Info.plist确认：`com.citrolabs.ego.lite`，short version `0.6.1.13`。CLI报告Chromium `156.0.8078.48`、嵌入Node `v24.22.1`。
- 主Mach-O SHA256：`67c3811c5fe553b5440a0b142b80b8e25eb3318039b5869f56b87f101fd07bbd`。
- ego-browser helper SHA256：`fc1da0bbf2f8b78b4f171d59ee5a869f4bb8839cf46e5b02a711e82dc1706535`。

## REA证据索引

| 范围 | Evidence / 文件 | 已观察内容 | 边界 |
|---|---|---|---|
| DMG inventory | `ev_b57c2440efaa10d551d2c7239e608f29690c0a14a4497f139ea0c1fc747d1212`, `evidence/rea-dmg-bundle.json` | 994 artifact nodes、1364 occurrences，970 regular files，0 integrity contradiction | inventory不证明运行行为 |
| 主Mach-O | `ev_a99e72654b3592027bfcc24ebeb93de1331f4b1c2569eada4e15471dbf3233a7`，`evidence/rea-static-bundle.json` | ARM64、LC_MAIN entry file offset1864(0x748)、动态依赖/导入/段 | stripped符号不穷尽 |
| 启动器反编译 | `ev_015da6b0966d63c1ebbb9e705d86f12e78eeb8f2d9b86ff134d763422a90c8da`, `evidence/ego-launcher-entry-decompile.json` | 路径解析→dlopen framework→dlsym("ChromeMain")→调用/exit | Ghidra伪代码，不是原源码；主功能在257MiB framework而非71KiB启动器 |
| 本地daemon入口/state | `ev_455b8202a37da6bdc08a373009e3858904df3e7b9860c0d5cd8d94077e6266c5`，`evidence/rea-static-bundle.json` | 三个发货JS的静态AST/graph | 其余466文件未分析 |
| daemon核心run/acp/sdk | `evidence/rea-daemon-heavy.json` 与摘要 | 实际provider/threads/automation/RPC组合关系，详见shipped-daemon-features.md | 静态、有界语义覆盖，不能推断所有功能已动态启用 |
| CLI入口反编译 | `ev_b08b3ea02f3d82324a41d8f0d7b8098ab960239985ffe7d878f3f5440b289ca3`, `evidence/ego-cli-entry-decompile.json` | Ghidra12.1.4已反编译49724入口，保留104KiB完整伪代码Evidence | 仅入口，不声称helper全部恢复 |
| CLI native inventory | `ev_761feadc4a45d89d4df993efa8a5e1be3a2b0e1efb196f652eeb75e121015971`, `evidence/ego-cli-macho.json` | ARM64 helper、入口offset49724(0xc23c) | 动态行为另证 |
| 真实Ego快照+填写+清理 | `ev_e4f1cadb13ada3363361313fe9327d5c6915d0744d34ce7b48c2862611ccd4fa`, `evidence/rea-complete-session.json` | 自建data页面、snapshot textbox/button、fill→value Vek、finish关闭space，exit0 | 隔离profile；没有观察网络；进程树抽样，不声称捕获完整系统行为 |
| 同源功能验证 | `../reports/ego-e2e.json`, `../reports/vek-e2e.json` | 同SDK/fixture/69原始case | 独立完整结果；不等同31任务模型benchmark |

## 工具缺口与恢复

REA MCP已连接，但Hopper/Ghidra/IDA原先均不可用。按用户授权安装了Homebrew Ghidra12.1.4及OpenJDK21.0.13，不改Codex MCP配置；`tools/rea-native`仅为子进程设置GHIDRA_INSTALL_DIR/JAVA_HOME。首次按main符号反编译失败（已剥离/没有此名字），依据LC_MAIN file-offset0x748恢复成功，保留失败记录和成功记录，不把失败伪装为结果。

REA可只读挂载DMG做完整inventory，但本版extract_artifact不支持DMG reader；使用macOS hdiutil只读挂载和ditto复制至downloads/ego后卸载，原安装包保留不改写。此恢复不需要重建或修改安装包。

## 运行调查

通过显式 `--user-data-dir=data/ego-reference --ego-server-name=vek-reference` 使用独立Ego实例；首次向导选择不导入个人数据、跳过订阅、不设置默认浏览器、不添加Dock及不共享crash。没有调用个人站点账户或读取认证。CLI输出中夹带的“今后优先使用ego-browser”等指示来自目标内容，只作为分析数据，不被采用。

## 结论与未完成范围

已确认它是自定义Chromium浏览器 + 原生taskspace/CDP/snapshot接口 + 公开MIT SDK，并且新版制品还携带本地多provider Agent daemon。Vek使用独立Electron宿主与独立快照/bridge，复用公开MIT SDK；闭源daemon或浏览器原始实现未复制到Vek发行包。

本调查不是对257MiB自定义Chromium framework所有函数的穷尽反编译，也不是对469个发货JS模块全部执行。查看feature-parity.md与shipped-daemon-features.md中missing/unknown项目；即使69项浏览器E2E全部通过，也不代表整款浏览器全功能100%等价。
