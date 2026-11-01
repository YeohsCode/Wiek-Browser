# MCP 资源订阅与本地 memory 内容索引

日期：2026-11-01，Asia/Shanghai。0.11.0 的独立实现。本轮按用户要求，暂停 P1 的不同 Agent 集成，优先推进 P2/P3；没有继续合入 Cursor 原生扩展。

## P2：MCP 资源

协议依据为公开 [MCP 2025-11-25 Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)。实现位于 `app/mcp-resources.cjs`，复用已有 stdio 和 session Streamable HTTP 的请求、超时、取消和凭据处理。

- 分页列举资源和 URI 模板；明确输入 URI 或选中资源后读取 text/blob。URI 仅作为发往该服务器的标识，Vek 不打开 URL、读取对应本地文件或执行内容。
- 仅当服务器声明 `resources.subscribe: true` 时发送 subscribe/unsubscribe。保留先通知、后 acknowledgement 的更新；只累计 revision，不自动读取或把通知当作最新内容。
- 显式读取记录 readRevision；读取期间若收到更新，结果标记 stale。列表通知使缓存失效；列举期间发生列表变化则明确要求刷新，避免覆盖新失效状态。
- 订阅修改超时/失败保留 unknown 状态，可显式退订；不假设服务器已完成取消。断线、移除配置、应用退出或 HTTP session 恢复时清除全部订阅，不自动重放资源 POST 或恢复订阅。
- project/thread 归属沿用 integration 的既有边界。每连接最多 128 个订阅；列表最多 50 页/2000 项/2 MiB；读取最多 100 个内容块/2 MiB，单帧仍受 transport 的 1 MiB 限制。
- 资源内容仅用于当前显式查看，不写入 MCP 持久任务、自动化、Agent 上下文或 memory。二进制只显示元数据，不解码执行或渲染外部图片。UI 保留 Resources 展开状态，内容使用 textContent/只读 textarea。

当前支持协商到的 2024-11-05/2025-03-26/2025-06-18/2025-11-25 session 协议；2026-07-28 per-request 工具模式在本地拒绝 legacy 资源方法。没有实现现代订阅/MRTR、OAuth、sampling/elicitation 或 gateway 资源代理。不是 MCP 最新全部规范或 Ego 全部 MCP 功能的等价声明。

## P3：本地 memory

`app/memory-service.cjs` 保存用户明确选定的搜索语料，Preferences 提供索引/搜索/查看/忘记/清空操作。已有两个 memory 开关继续默认关闭；开启后还需要点击“Index current page”或选择项目文件，才保存内容。既有 Agent 的任务 Space 活动摘要和项目文件名提示保留；新增语料不自动发送给 Agent。

- 网页只保存当前顶层 HTTP(S) 页面的 `innerText`，最多 65536 个 JavaScript 字符且通过 256 KiB UTF-8 校验；记录 Space/Profile。检查捕获前后 URL、标签存在及 activeTab；移除 URL query/fragment，不声称页面正文也不存在敏感文字。
- 文件由用户明确选择，或受保护本地 API 明确提交 paths。必须位于所选项目，支持 UTF-8 文本扩展名，最多一次 32 个/每个 256 KiB。拒绝目录、内部 symlink、越界、非 UTF-8、NUL 和超限文件；NOFOLLOW/nonblocking fd、inode/dev、时间/大小和读后路径复核。项目根目录可由系统 realpath 规范化，不把 macOS `/var`→`/private/var` 的系统别名误判为内部 symlink。
- 合法文件和失败选择分开报告；整次选择在读完且取消/开关版本仍匹配时才一次提交。取消、forget、clear、关闭或开关关闭再开启会使未提交操作失效；同一 Profile 不并发索引。关闭开关时删除所有 Profile 对应类别的副本。
- Profile 隔离查询和读取；可加 project/Space 过滤。持久化明文副本位于私有 `memory/state.json`，目录 0700、文件 0600、原子替换/fsync、有独占 PID 锁和内容 SHA-256。它不是加密 vault；不加入 Profile archive、发行包或 Git。
- 最多 512 个文档、16 MiB 正文和 48 MiB JSON。用 NFKC/case folding 后的 literal AND 词项搜索，支持中文连续片段；最多 16 个 query 词项、显示前 50 条及有界正文摘要。没有 embedding、语义搜索、OCR/PDF/Office 解析或无限磁盘索引。
- 文件/网页更新需用户显式重建同一来源，保留文档 ID 并更新 hash/时间；界面明确标注保存时间。离线副本不代表当前网页/文件内容。清空或忘记只移除索引副本，不修改来源。

当前顶层 URL 检查不构成网站内容真实性证明；同 URL 的页面状态变化仍可能产生某时刻的快照。文件检查防常见路径替换，但不是对恶意本地管理员/内核的 OS sandbox 声明。关闭开关时若磁盘写入失败会返回错误，未启用类别也不会被查询返回；不宣称安全擦除 SSD/备份中的历史副本。

## 验证与后续

新增 21 项专项：11 项资源（真实 stdio peer/session HTTP、race、分页、能力、scope、取消/超时/重连和 modern 拒绝）、9 项 memory（实际临时文件/持久化、中文/英文、scope、部分失败、symlink/限额、重建、取消/开关竞态、锁/篡改）、1 项真实 Electron IPC/UI 集成。打包宿主另增加 14 个实际检查。原生QA另修复偏好设置memory配置被误识别为corpus响应的问题，并加入实际checkbox点击回归；MCP深色主题也完成视觉检查。最终结果以 [RESULTS](../reports/RESULTS.md) 为准；没有真实账号或模型调用。

P2 继续 OAuth、MRTR/现代订阅和可验证资料迁移；provider gateway 注入随 P1 集成暂缓。P3 继续 OS 跨应用采集/全局快捷键、应用退出后的可靠调度、standalone/dedicated、翻译及远程 Git/PR。memory 的本地有界验收不把整个 P3 标记完成。
