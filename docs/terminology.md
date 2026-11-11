# Wiek Browser 术语表

更新于 2026-11-11。界面用词描述用户实际得到的结果。代码中的公开 API、数据字段和错误码继续兼容已有调用。

| 原名称或容易混淆的说法 | 统一中文名称 | 界面英文名称 | 实际含义与边界 |
|---|---|---|---|
| Space、空间 | 标签组 | Tab group | 有名称的一组标签页。可与其他标签组共用登录配置 |
| TaskSpace、任务空间 | 自动化任务的标签组 | Automation tab group | Agent 使用的标签组，提供页面标识和控制权管理 |
| 空间恢复，指重启浏览器 | 启动时重新打开上次的标签页 | Reopen previous tabs at startup | 按保存的网址加载页面，恢复选中的标签组与标签页 |
| 空间恢复，指已关闭内容 | 重新打开已关闭标签组 | Recently closed tab groups / Reopen tabs | 最近 30 个关闭记录中的网址，在原浏览器配置中创建个人标签组 |
| 空间恢复，指后续工具调用 | 继续自动化任务 | Continue automation task | 浏览器持续运行时，后续脚本复用任务 ID 和有效页面标识 |
| round、轮次 | 脚本调用 | Script call | 一次 CLI 执行，新建 Node 进程。页面可能继续存在 |
| Page | 页面控制句柄 | Page | SDK 控制一个标签页的对象。与网页 DOM 的 page 概念区分 |
| p1、页面标签 | 自动化页面标识 | Page label | 当前浏览器运行期间持久化的 SDK 标识。浏览器重启后须重新识别页面 |
| ref、snapshot 引用 | 页面元素引用 | Element reference | 最近一次页面快照里的元素标识，页面变化后须重新观察 |
| ownership、Your space | 当前控制方 | Agent has control / You have control | Agent 或用户当前可以操作。Agent 有控制权不代表正在运行 |
| handOff、移交 | 交给用户操作 | Hand off to user | 暂停此标签组的自动化操作 |
| takeOver、接管 | 继续 Agent 操作 | Resume agent control | 已移交且仍有效的任务，用户同意继续后恢复控制 |
| claim | 使用已有标签组 | Use an existing tab group | 将用户标签组交给 Agent，须有操作这些页面的授权 |
| finish | 结束自动化任务 | Finish agent task | 结束页面标识，按 keep 参数关闭或保留页面 |
| Profile、资料 | 浏览器用户配置 | Browser profile | 一套 cookies、缓存、站点数据与登录状态。共享它的标签组共享登录状态 |
| Profile archive | 加密浏览器数据备份 | Encrypted profile archive | 导出受支持的数据，导入到新浏览器配置。可选保存的密码和网站存储 |
| Workspace、工作空间 | 项目文件与 Git | Project files & Git | 已选项目目录的文件读写和版本控制 |
| checkpoint、turn snapshot | 项目文件备份 | Project file backup / File backups for each message | 保存工作文件和 Git 暂存状态。恢复会修改项目文件，需要预览与确认 |
| safety / protection checkpoint | 恢复前的文件备份 | Backup of the previous files | 恢复项目文件之前保存当前状态 |
| snapshot，浏览器 API | 页面结构快照 | Page snapshot | 当前页面的语义结构文本 |
| screenshot | 截图 | Screenshot | 页面或桌面的图像 |
| Indexed memory、记忆 | 已保存文本搜索 | Saved text search | 手动保存网页或项目文本后做字面检索。保存内容不会自动刷新 |
| run memory | 定时任务的持久笔记 | Scheduled task notes | 为一个定时任务保存跨次运行的文本 |
| Library | 已保存内容 | Saved items & screenshots | 本地网页引用、文本、图片和截图的管理入口 |
| Collections / groups，收藏内容 | 收藏文件夹 / 子分组 | Collections / Groups | 已保存内容的两层组织方式。与浏览器标签组分别解释 |
| Action recorder、录制 | 网页操作记录 | Page action history | 点击、部分按键、滚动及附带截图的时间线 |
| application recording | 应用操作记录 | Application action history | 对选定应用记录受支持的输入事件及截图 |
| Background scheduling | 关闭浏览器后运行定时任务 | Run tasks while browser is closed | 可选 macOS 登录后台任务，须单独启用相应定时任务 |
| MCP integrations | 外部工具连接 | External tools (MCP) | 按项目/会话作用域连接工具、资源及提示模板 |
| provider | Agent 程序 | Agent program | 用户配置的本地 Agent 命令或原生协议程序 |
| thread | 对话 | Conversation | 用户与 Agent 的消息和执行记录 |
| prompt template | 提示模板 | Prompt template | 服务提供的文字模板，可预览和填参 |
| Skill | Agent 技能说明 | Agent skill | Agent 读取的操作说明 |

页面重开会重新请求网址。表单、页面内存、滚动位置、未完成的 Agent 执行和旧元素引用，均超出当前重开机制的保存范围。独立窗口布局也未持久化。

## 已落实的改名

主窗口、独立窗口、菜单、快捷键名称以及标签组管理使用 Tab group。Agent 的控制状态使用 Agent has control。项目文件、外部工具、已保存内容、网页操作记录、文本搜索和文件备份的主要入口改为上表用词。中文 README 使用对应中文名称。

`taskSpace()`、`spaceId`、`profileId`、`workspace:*`、`memory:*`、`checkpoint:*` 和历史错误前缀仍属于兼容接口。第三方原始测试和历史证据保持原文。收藏文件夹等次级界面仍显示 Collections / Groups，后续可以统一为 Folder / Subfolder，需同时处理其动态编辑标题。

## 自动化使用约定

1. 同一个进行中的任务复用标签组。独立测试使用各自的唯一任务名和隔离数据目录。
2. 浏览器持续运行时可复用页面标识。重启后通过 `task.tabs()` 重新识别已授权的目标页，对无标识的页调用 `task.adopt(tab.page)`，再取新快照。
3. 已结束的任务可按已有授权重新使用页面，或为新测试创建新标签组。名称占用和普通页面错误不要求重复获取任务授权。
4. 用户正在操作、权限提示和设备选择仍按当前交接状态处理。恢复代码须以实际状态和授权为依据。

原因、运行证据和功能取舍见[易用性审计](../reports/usability-audit.md)。
