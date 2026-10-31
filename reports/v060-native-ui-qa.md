# Vek 0.6.0 原生界面验收

2026-10-31，最终macOS ARM64应用，隔离`data/v060-native-ui`和自建Git项目。来源为自有`data/v060-import-session.jsonl`（两个合成分支），provider为仓库Node协议peer，没有模型请求或个人历史扫描。

1. 原生点击Agents→Import Claude history。通过真实macOS文件选择器的Go to Folder定位这一个JSONL，点击Open。
2. 对话框显示两个分支、目的project/provider、source迁移边界。实际切换到Alternative answer branch后预览变成该分支，再切回Imported final answer后预览恢复。截图：[分支预览](v060-native-history-preview.png)。
3. 点击Save。观察到新会话idle，主聊天有选定answer，没有alternative；来源和imported activity存在。
4. **发送前独立读取state/磁盘**：0 runs、无nativeThreadId、wire audit文件未创建；来源文件SHA与导入provenance相同。没有执行历史命令、读其引用路径或自动启动provider。
5. 在真实composer发送`[activity] Continue this imported synthetic conversation.`，实际本地Node peer完成。它用新`--session-id`启动，该ID不同于源history session；主stdout没有Child-only文本。
6. 重启该隔离host后，导入记录、历史工具结果及真实run活动仍存在。展开Native activity history→Turn 1：观察到Read completed/failed、nested工具和unresolved项；打开工具显示`Actual tool output`和2秒报告耗时；打开Local child review显示completed、Child reviewed、独立子消息`Child-only <literal> answer`。
7. 验收发现多个活动区域会挤出输入区，已收敛为一个有界活动历史折叠区，并允许会话容器垂直滚动。**最终包**中实际滚动活动和外层容器，确认Send prompt/Attach files可见可达；[子消息与输入区](v060-native-child-and-composer.png)。未发出的terminal仍明确unresolved，没有伪造完成。
8. [机器核对](v060-native-ui-check.json)包含源字节不变、0自动执行、新原生session、工具结果/错误/子状态、父回答隔离和真实turn快照complete。peer不会执行tool_use中的命令或读output_file。
9. 关闭QA host并等待其runtime退出，重新打开正常用户资料目录的应用，CLI实际status确认0.6.0。没有远程发布、外部账号或付费调用。

真实Claude CLI 2.1.31只在隔离HOME、无继承认证下执行initialize（包括forwardSubagentText字段），见[readiness](v060-claude-readiness.json)。它不能证明真实模型、所有CLI版本或后台Agent守护已验证。CLI stop当前是请求关闭；立即同目录restart应等待runtime退出，本次QA按此等待后启动。
