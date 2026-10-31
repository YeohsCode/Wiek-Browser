# CLI 关闭完成契约（0.9.1）

2026-10-31（Asia/Shanghai）。旧版 `stop` 在 shutdown RPC 被接受时返回；宿主仍需等待 provider 终止与快照落盘，同目录随即 `start` 可能连回旧实例。0.9.1 独立修正这一交付边界。

`vek-browser stop [--timeout-ms N]` 先通过已认证的 loopback RPC 读取 browserInfo，核对 PID 与 browserInstanceId 和本次连接的 runtime metadata 相同，再请求 shutdown。确认后关闭客户端连接，每 50ms 检查原 PID 是否已经退出；只有实际退出才输出 `Vek Browser stopped.` 并成功返回。runtime.json 提前消失不作为结束依据。

默认等待 30000ms，允许 100..120000ms，使用单调时钟。超时明确失败，说明原进程可能还在收尾；**不强杀、不移除 runtime metadata、不启动替代实例**。错误不会输出 token。参数在连接前校验；身份不匹配不会发送 shutdown。此契约针对 stop 成功之后的顺序 start，不承诺多个独立 CLI 并发 start 的选主或进程崩溃恢复。

测试运行真实隔离 Electron 宿主、本地延迟 SIGTERM provider 和临时 Git 仓库：停止返回时主/子 PID 均已消失，最后一次 provider 文件修改及 turn after checkpoint 已落盘；随即重启同目录并读到 interrupted run、完整快照和终止时 diff。连续三次 stop→立即 start，均获得新 browserInstanceId 且持久数据可读。另外用真实独立 Node WebSocket host 验证超时保留存活进程/metadata、不同实例身份拒绝关闭，以及非法参数不创建 profile。

[当前结果](../reports/RESULTS.md)记录 source / packaged 两侧用例和完整回归。没有更改 provider 终止策略、SDK 源码/断言、用户浏览器资料、付费模型或真实账号。
