# Claude 原生模型目录（0.10.0）

2026-11-01（Asia/Shanghai）。独立实现 `app/claude-models.cjs`，接入原有 `claude-session.cjs`、AgentService 与原生 panel。公共协议依据为 [官方 TypeScript SDK 参考](https://code.claude.com/docs/en/agent-sdk/typescript)的 initializationResult、ModelInfo 和 applyFlagSettings，以及本地官方 SDK 0.3.316 的公开类型/控制请求结构。运行时不依赖该 SDK 包，也没有复制 Ego 闭源代码。

## 发现与执行

- discovery 启动受原有 native 参数约束的 CLI，只发送 initialize，不发送 user；不新增 Vek messages/runs，不把生成的 session argv ID 当作已拥有的 native session。原有已完成会话的 ID、消息和 runs 保持不变。配置绑定 hash 仅用于目录失效，不从目录获取原生会话权限。
- 和 Codex/OpenCode 共用实际并发槽与项目保护 lease，支持停止、取消和重启中断；加载期工具请求不自动批准。
- 从 initialize.models 读取最多 256 项，值/别名、显示名、description、resolvedModel、明确返回的 supportsEffort / supportedEffortLevels / supportsAdaptiveThinking。缺字段为 unknown；不根据模型名字推测图片、effort、认证或服务能力。
- 单次原始数组最多 4096 项，原有传输 4 MiB 帧限制保留。重复同值一致项去重，冲突、错误类型和未知 effort level 明确拒绝。元数据只包含已列字段，不保存 initialize.account。
- 显式选择接受 value 或实际声明的 resolvedModel。已有目录的每个实际 turn 在 initialize 后重新读取和校验，失效模型/effort在 user 消息之前失败。无目录的旧手工 model 配置继续沿用原生 CLI 行为。
- 有目录后清空 model 会明确传 `--model=default`，包括原生 resume，避免沿用旧会话的模型选择。UI 保存 canonical ID 时保留对应有效选项，不能悄悄清成空值；切换模型清除旧 effort 选择。
- 显式 effort 必须由实际能力字段支持，随后发送 `apply_flag_settings {settings:{effortLevel}}` 并等待成功控制响应，再发送 user。旧 CLI 不支持该控制时明确失败，不降级为已应用。该确认只证明控制请求被接受，不能证明模型实际采用的 token/effort（组织策略可能影响它）。
- 清空 effort 后新 CLI 进程不发送 Vek effort overlay，沿用其 process default；不描述为隐藏原生配置完整迁移或组织限额重置。`--effort` 参数由 native runtime保留，避免 provider argv 绕过能力校验。

## 分层验证

`tools/probe-claude-models.mjs` 在净化 HOME/CLAUDE_CONFIG_DIR 中运行已有官方 CLI **2.1.31**，只 initialize 然后关闭；**0 user、0 模型调用、无继承认证**。返回 default / opus / haiku 三项，未返回 effort 能力字段。这些名称/描述属于该 CLI 的 bundled/cached 元数据，**不作为当前模型可用性、账号权益或价格证明**。[报告](../reports/v100-claude-model-readiness.json)。先前最新 native 二进制下载不完整，不将它用作验证成功的证据。

官方当前 SDK 类型包含更多可选字段；Vek 兼容实际返回字段，不把新文档字段强加到旧 CLI。合成 peer 单独提供已声明的 effort/resolvedModel，用真实独立协议进程验证顺序、fresh validation、失败前不发 prompt、默认模型/resume、取消/lease/全局容量、archive边界与cap限制。实际 Electron panel 测试检查 canonical 选择不丢失、旧 CLI unknown 和 effort 选项变化。

本轮新增16项服务/解析回归；完整本地、打包宿主、SDK和原生UI结果见 [RESULTS](../reports/RESULTS.md)。不调用付费模型或真实网站账号。原生 source resume/fork迁移、后台任务、更多 provider 和全产品 parity 仍未完成。
