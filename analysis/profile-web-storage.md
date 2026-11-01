# 0.13 Profile web storage portability

独立实现：`app/profile-storage-data.cjs`、`app/profile-web-storage.cjs`、`app/profile-archive.cjs` 与实际应用导入/导出。只显式采集所选 Vek Profile 已打开的顶层 HTTP(S) 页面；不兼容未知 Ego export 格式，不读其他浏览器的 LevelDB，不自动发现个人资料。

## 采集与恢复

Settings → Encrypted profile archive 新增默认不勾选的 **Include web storage from open tabs**。导出沿用系统保存框、两次输入口令和 AES-256-GCM/scrypt；磁盘只写加密文件，原子替换、0600。cookies 原有范围保留，saved logins 仍单独选择。MCP token、memory 文本、Agent 认证、扩展代码和网站权限不进入归档。

同 Profile/顶层 origin 的 localStorage 只采一份，各标签当前 origin 的 sessionStorage 分开保存。前后检查 CDP frame/loader ID、URL 和 storage key，只接受普通第一方 `origin/` key。导航/关闭/不支持/超限时保留标签信息并报告存储遗漏。采集不导航、不扫描其他 origin、不运行归档提供的程序。所有页面并非同一时刻的事务快照，网站可继续改变数据。

恢复先解密、验证并显示确认框，再创建新 Profile/Space/标签身份和用户所有权。localStorage 在临时无 preload 的 WebContentsView 中恢复；sessionStorage 在其目的标签中恢复。先加载 about:blank 初始化 renderer，再用 CDP Fetch 拦截并本地满足唯一的 origin 根文档请求，其他请求拒绝。bootstrap 无网站代码或外部资源，CSP default-src none，绕过 service worker。完成写入和逐项回读后移除拦截，才分派实际标签 URL。**实际网站加载会访问网络，网站代码仍可能修改数据或判定登录失效**。

主应用 bootstrap 期间不抓 favicon、不记虚构根页面历史；UI/磁盘保留预定 URL，实际导航提交后采用真正 URL，并清掉bootstrap引入的虚构前后退记录。修正原实现筛除不可迁移标签后 activeTabIndex 可能指错的问题。

不勾选 **Open restored tabs** 时仍恢复 localStorage/cookies，但明确跳过 per-tab sessionStorage。这些是此次打开标签的运行会话；Vek 正常退出/重启目前不持久恢复 sessionStorage，不冒充完整 Chrome session restore 或前后退历史迁移。

## v2 格式与限制

新 envelope `version:2`，原密码/KDF/密文认证不变，version 仍在 AAD。读取器兼容 v1；v1 不接受新增字段，也不凭空补存储。未知版本拒绝，旧 Vek 不支持读取 v2。

```js
{
  profile: { name: 'Portable fixture' },
  webStorage: {
    encoding: 'utf16le-base64',
    localStorage: [{ origin: 'https://example.test', entries: [['awA=', 'dgA=']] }]
  },
  spaces: [{ name: 'Research', tabs: [{
    url: 'https://example.test/page',
    sessionStorage: { origin: 'https://example.test', entries: [['awA=', 'dgA=']] }
  }] }]
}
```

每对 `[key,value]` 是 UTF-16LE code units 的规范 base64（示例 k/v）。Web Storage 允许 NUL、孤立代理项、空 key 和 `__proto__` 普通字符串。直接经过 Electron CDP 字符串转换会丢失某些 code units，因此固定的隔离世界脚本先编码为 ASCII，恢复时在隔离世界解码，以原生 Storage.prototype 方法写入并校验。归档值不作为代码、对象属性映射、路径或网络请求执行。原严格 JSON/Unicode 校验继续适用于元数据与 base64 文本。

最多128个 local origin；每 area1024项、2MiB原始 UTF-16，key64KiB、value1MiB；local + 所有 per-tab area 总共8MiB。全归档仍32MiB，其他 Spaces/标签/结构限额沿用原协议。sessionStorage origin 必须与其 tab 精确 origin 一致；重复 key/local origin、未知编码、非规范/奇数字节 base64 拒绝。捕获总量超限会遗漏并报告相应 area，最终 schema 验证后才写文件。

## 冲突、失败与取消

仅向新 Profile 恢复，已有 Profile 不合并或覆盖。area 必须为空，冲突时拒绝并保留现有内容。局部写入失败/结果不确定时关闭目的 WebContents，仅清新 Profile 的该 origin localStorage，不清 cookies、其他 origin 或其他 Profile；清理失败单独警告。一个 origin 失败可继续其他 origin；单 tab session 失败后新开无该会话的标签并警告。计数只增加已回读验证的 area。

同应用只允许一个归档操作。文件选择、口令、最终确认均可取消，确认前不创建新 Profile、不访问目标网站。辅助层 AbortSignal/超时关闭目的 WebContents 并清理局部写入；**当前 UI 没有确认后的中途取消按钮**。确认后的资料导入仍可能部分完成，不承诺整份事务回滚或崩溃恢复。

Electron Cookie API 不暴露 CHIPS partition key。导出从明确属于所选 session 的 tab 使用 Network.getAllCookies 取实际 partition metadata；partitionKey/opaque key cookie 遗漏并警告，防止变成普通 cookie。实际 Electron fixture 验证所选/其他 Profile、HttpOnly/hostOnly 和 CHIPS。协议不可用时导出失败，不退回丢失 partition 信息的读取。

## 验证与剩余项

专项含 v1 固定旧制品、v2 密文/UTF-16/额度/恶意字段、捕获竞态，以及两套实际 Electron：真实 sessions（iframe排除、source不变、无 bootstrap 网络、冲突、注入部分写失败/abort/超时）和完整主应用 IPC/renderer/口令表单（系统文件/确认框由 fixture 注入；取消不建 Profile、关闭标签导入、独立会话和选中标签）。只用本地 HTTP fixture、临时 Profile，无真实账号、个人源目录、付费模型或 Keychain 读取。最终打包和原生系统框观察以 [RESULTS](../reports/RESULTS.md) 为准。

未覆盖关闭标签/旧 origin/iframe partition 存储、IndexedDB、Cache API、service worker、扩展配置/代码、完整导航栈、Safari/Firefox/multi-source web storage、真实网站登录和退出后 sessionStorage 恢复。P2/P3及全量复刻保持未完成。

参考：[CDP Fetch](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)、[Storage](https://chromedevtools.github.io/devtools-protocol/tot/Storage/)、[Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[Electron WebContents](https://www.electronjs.org/docs/latest/api/web-contents)。以本机 Electron42/Chromium148 fixture 为行为证据，不以 tip-of-tree 文档替代运行验证。
