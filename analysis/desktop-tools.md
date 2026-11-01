# 0.14 Desktop tools / OS capture

独立实现：`app/desktop-service.cjs`、`app/desktop-native.cjs`、Desktop panel、原生Swift selected-text helper。P1其他Agent集成继续暂缓。本轮是P3的有界单次采集与全局快捷键，不是被动选区监听、跨应用录制或完整Ego parity。

## 参考证据与独立实现范围

原调查保留REA Evidence `ev_c746b1b63234454354fe180d624d455e35d018a7b6219d016262de3385d93883`，见[client ledger](client-resource-feature-ledger.md)。本轮REA当前session精确查询没有retained记录，因此未假称重取旧图；只读复用磁盘摘要和匹配身份的shipped资源。`58639.js` SHA-256 `7059f829715c35cc9b62b0c6895741494264bbfaf57435d78695122087b11f38`，35,329字节，PAK成员offset34,710,279，原gzip长度7,617、SHA `0bdeec15b1e3376f8a373d2d74615ad8ba6279115c547a4d201c5ae7acea049d`；resources.pak SHA `198a2161aca71aff88ab0a44b1089103a7d4ed89104d31beadabc233122d1671`。

静态范围：58639.js UTF-16 offsets29057–29365的`takeScreenshotInteractive`是显式native调用，取消返回null；14624–15622有selectionTool enable/disable和bundle ID排除，25568–26050有选区通知桥，27304起有Accessibility检查/申请/设置桥。58614.js（SHA `2ece7002e55b47bfb1fdf70517a00f90f57a2c2fe053d33b3efbb7728ed8c776`）约31500–34500把voice/screenshot/chat标为Global、clip/switch Space/Space Manager标为In ego。只有shipped-static证据，不能推断AX observer、被动截屏或运行授权成功。原分析有3310文件未纳入所选语义范围，完整native backing仍未知。没有复制闭源实现。

## 产品行为

Settings → Desktop capture & global shortcuts。默认无全局键、选区读取关闭；启动和刷新只查本进程的权限状态，不截图、不读取别的应用。global screenshot/selected text/chat/voice可分别设置；chat只打开对话面板，voice只打开语音面板，不启动模型或麦克风。Fn-only不支持。OS注册失败显示unavailable；重配失败保留旧键，退出只注销本模块拥有的键。浏览器内快捷键与Desktop全局键双向冲突检查；原配置在启动时与其他应用抢占失败也不会伪称成功。

截图调用系统固定 `/usr/sbin/screencapture -i -x -t png`，用户在macOS原生UI选择区域/窗口、Esc取消。无静默全屏抓取、音频或视频流。工具只接固定argv和私有临时路径，无shell。macOS Screen Recording拒绝/受限时提示权限，不自行更改OS设置。只在用户点击后打开固定系统设置入口；实际授权由用户完成。

selected-text快捷键在激活Vek前调用自有Swift helper：只读当前前台应用的focused AX element之AXSelectedText；先检查bundle排除和secure/protected角色，不退回AXValue、全窗口文本或模拟Copy。无clipboard polling、按键hook、AXObserver、鼠标监听或后台定时器。超过128KiB、空/未支持选区、前台应用变化、无AX权限都会拒绝；某些应用不公开selection，不能保证每个应用成功。helper只输出一次JSON，stdout有界、stderr不向UI/日志暴露。父进程和helper的TCC归属可能不同，真实成功仍取决于helper实际权限，不能只凭父进程状态宣称可读取。

结果先是单个临时draft，主进程只在内存保留最长3分钟，snapshot不含文本/像素。正文读取、复制、保存或改变设置只允许可信主chrome IPC；受token保护的CLI/RPC仅能读desktop snapshot，不能触发OS capture、权限请求或取得draft正文。网页不获得新bridge；独立窗口也不能调用这些动作。一次只运行一个capture；取消/禁用/排除/关闭会使迟到结果失效，进程取消等到实际退出。取消/失败替换保留原有未过期draft；用户明确discard/reset/关闭才丢弃。正常取消不显示错误。

选区先显示来源app/bundle和正文，用户再明确Copy、Save text to Library或Use as Agent draft；后者只填composer，不发送prompt。图片先Show captured content，再转入现有Library的crop/rectangle/arrow/text标注及显式保存/导出。已有未保存标注在替换前确认。不会自动保存、注入memory、发给Agent或同步。Library当前是应用级保存域；明确保存后的内容遵循已有Library的权限与回收站，不随临时draft过期或关闭selected-text开关删除。

## 持久化、边界与构建

`desktop/state.json`只存version1、selectionEnabled、excludedApps和4个shortcut字符串，目录0700/文件0600/原子替换；最大64KiB，最多128个bundle ID。Native临时PNG位于0700目录，读前核对inode/dev/size、拒绝symlink、最大20MiB，再经现有PNG CRC/尺寸验证（单边32768、80M pixels）。无论成功、取消或失败均清理临时文件；重启仅清理本适配器命名的残留目录。抓取到读入期间有短暂本地临时PNG，不承诺截图从未落盘或JS字符串被安全擦除。

`tools/native/selection.swift`为自有源码，`npm run build:desktop-native`调用现有Apple swiftc编译ARM64 `app/bin/vek-selection`，无第三方依赖、Apple Events或安装后台服务。最终source/binary hash与工具版本见本轮helper identity报告。非macOS的native capture/selection当前明确unsupported；不把固定macOS工具描述为跨平台实现。

公共Electron参考：[globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut)、[systemPreferences](https://www.electronjs.org/docs/latest/api/system-preferences)。实现不使用desktopCapturer自动取全显示器缩略图，选择由Apple系统工具处理。Swift使用系统AppKit/ApplicationServices。真实多显示器、每个应用secure角色、权限撤销/重签名后TCC与被动浮动选区菜单未全面验证。

验收分层：真实临时文件/子进程、模拟OS registry/采集器服务边界；实际Electron IPC/panel及Library editor；打包宿主只读状态与远程调用拒绝；原生CUA测试只用自有fixture。具体通过项、OS真实授权/读取/截图是否运行，以[RESULTS](../reports/RESULTS.md)及本轮原生QA为准。

实际OS验收（2026-11-02）：最终打包版查询到既有screen/accessibility granted，未授予新权限；选区全局键注册/重启恢复、系统截图进程启动/取消/退出/临时目录清理通过。CUA已选中独立Electron窗口的公开fixture，但没有观察到全局按键回调，因此未取得AX正文，也未完成系统picker到原生PNG的正向链路。不得把注入采集器的20项Electron检查当成这些native成功证明。见[原生QA](../reports/v140-native-ui-qa.md)。
