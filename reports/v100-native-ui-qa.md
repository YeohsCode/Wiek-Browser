# 0.10.0 Claude 目录原生 UI

2026-10-31（Asia/Shanghai），最终 macOS ARM64 包、隔离 `data/v100-native-ui` 和自建项目、本地合成 Claude stream-json peer。0 真实模型调用、未使用真实账号。

1. 原生 Agents → Conversation tools → Model 首次触发实际目录发现。回到 idle，独立读取确认 0 messages、0 runs、无 nativeThreadId，wire 只有一次 initialize、0 user。
2. 再次 Model 弹出实际观察的目录。选择 Default fixture；Reasoning effort 菜单只有 Agent default / low / high。选择 high，页面同时显示另一项 Older CLI fixture 的 effort unknown / no declared levels。[截图](v100-native-model-effort.png)。
3. Save 后仍 idle；在实际 composer 粘贴本地验证文字并发送，任务 completed，UTF-8 世界保留。[完成截图](v100-native-completed.png)。
4. [独立 wire 核对](v100-native-ui-check.json)：启动参数 `--model=default`，实际执行前再次 initialize，总数2；apply_flag_settings 的 effortLevel=high 在唯一一条 user 之前被确认。此 peer 的确认不是模型有效 effort/预算的证明。
5. 原生菜单 canonical ID 保留、切换旧项后 effort 只有默认选项，由实际 Electron panel 专项覆盖；本次手工 UI 不重复宣称这些点击流程。
6. 本地官方 CLI 2.1.31 的三项目录与缺失 effort 字段由净化环境的无 prompt 探针独立验证；它没有参与这次合成 peer 的执行。QA host 用新 stop 契约等待实际退出，最终正常资料应用版本另由当前 status 报告确认。
