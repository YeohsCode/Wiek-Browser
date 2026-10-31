# Vek 0.8.0 原生界面验收

2026-10-31，最终macOS ARM64应用、隔离`data/v080-native-ui`、自建project和Node app-server wire peer；未调用真实模型或操作外部账号。

1. 原生Agents→Conversation tools→Model触发分页发现。独立wire读取只有initialize/initialized和两次model/list；0 messages/0 runs/无native thread。
2. 再次Model后，原生下拉菜单显示Model A/B；选Model A，effort只显示Agent default/low/high。实际选high并Save。[截图](v080-native-model-effort.png)。
3. 在原生composer发送本地测试文字。任务completed、UTF-8世界无损；wire核对turn/start的model为fixture/a、effort为high，执行前再次model/list。
4. 原生点击Import Codex history；用真实macOS文件选择器的Go to Folder选定`data/v080-official-codex-rollout.jsonl`。这是官方CLI 0.142.0在隔离环境生成的合成历史，不是个人会话。
5. 预览显示2 messages、1 generated context excluded、0 attachments，以及Synthetic offline user/answer。手动把未来provider选为本地wire peer，没有启用或调用真实Codex provider。[预览截图](v080-native-history-preview.png)。
6. 点击Save后界面idle，独立磁盘读取0 runs、无nativeThreadId，来源hash相同。真实文件选择和导入没有自动执行。
7. 实际发送继续文字后completed；wire调用thread/start，未调用thread/resume，prompt包含原两条可见历史文字，来源session ID没有成为native权限。[续接截图](v080-native-import-continuation.png)。
8. [机器核对](v080-native-ui-check.json)保留发现0执行、模型/effort传递、无source resume、源字节不变和UTF-8结果。此UI项目未开启文件快照；真实edit/diff/restore另由92项宿主集成验证。
9. 关闭QA host并等待runtime退出，重新打开正常资料目录，CLI实际status确认0.8.0。[记录](v080-normal-app-status.json)。没有远程发布。

完整压缩/回滚历史和原生source fork/resume仍未实现；这些文件显式拒绝。原生UI运行的是合成wire peer，官方CLI只做无turn/start的目录/本地历史格式验证，不能作为真实模型推理或账号访问成功的证明。
