# 0.11.0 原生 UI 验收

2026-11-01，Asia/Shanghai。使用打包 `dist/mac-arm64/Vek Browser.app`，独立 `data/v110-native-ui` 资料；全部内容为合成 fixture。GUI 输入均通过 CUA；未登录任何服务，0 模型调用/0 外部账号操作。

- 打开本机 loopback 合成网页，进入 Settings → Appearance & shortcuts。确认 Indexed memory 的默认空列表、对应开关和禁用状态。
- 实际点击 Browser activity，再点击 Index current page：保存 1 个网页文档；中文“全文检索”命中正文，来源 URL 已省略合成 query/fragment。
- 实际点击 Project file context，再点 Choose files to index；macOS 系统选择器中通过 Go to Folder 选定 `data/v110-native-project/notes.md` 并 Open。显示 Indexed 1 file(s)、2 documents；中文“选定项目文件”命中实际文件正文与保存时间。
- MCP integrations → Connect 合成 Node peer → Resources → List resources。两页结果出现，`<script>untrusted</script>` 作为可见文字显示。
- 点击 Subscribe：显示 subscribed、changed — read again、updates 1；未自动读取。点击 Read latest：只读对话框显示实际 `revision 0`，后台状态变为 no unread update。Done → Unsubscribe 后状态行消失，恢复 Subscribe。
- 重启最终打包应用，重新连接后订阅为空；资源面板深色背景、标题和内容对比度已目视验证。

原生验收发现两项问题并修正：偏好设置响应中的 `memory` 布尔配置被误当作 corpus，导致切换开关后 `.map` 错误；现仅接受具有 documents 数组的索引响应，真实 Electron IPC 测试增加了开关点击回归。另补 MCP 面板深色主题样式。错误截图保留为 [attempt1](v110-native-ui-attempt1.png)，不是最终状态。

最终证据：[中文文件索引](v110-native-memory.png)、[实际资源读取](v110-native-mcp-resource.png)、[最终深色面板](v110-native-mcp-final.png)、[独立状态核对](v110-native-ui-check.json)。资源读取截图摄于样式修正前；最终深色截图摄于修正后，功能过程未据此扩大为真实服务验证。

最终 285 项本地测试、21 项专项和打包宿主123项均在所有修正后通过；MCP CSS 另做原生视觉验收。SDK69项完成后补过偏好面板响应识别、MCP CSS和memory忘记操作取消待提交索引的分支，这些没有改变SDK/浏览器页面宿主；最终发行包重新验证154文件身份与相同SDK hash。没有把SDK描述为在这些改动后重复执行。

QA 资料、项目和服务器均为专用临时实例；完成后停止 QA 应用及 loopback server，并以正常资料目录重新启动 0.11.0，见 [status](v110-normal-app-status.json)。
