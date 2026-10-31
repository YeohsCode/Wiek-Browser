# Vek 0.7.0 原生界面验收

2026-10-31，macOS ARM64最终应用包、隔离`data/v070-native-ui`和自建`data/v070-ui-project`。Node ACP wire peer仅发送合成协议消息，不调用模型，不读个人历史或访问外部账号。

1. 原生点击Agents→Conversation tools→Model。没有缓存目录时实际触发initialize+session/new，界面回到idle。独立读取磁盘和wire：0 messages、0 runs、0 session/prompt，目录只有peer返回的Fixture A/B。
2. 再次点击Model，原生下拉菜单实际显示Keep current/Fixture A/Fixture B，选择Fixture B并Save。[模型选择截图](v070-native-model-picker.png)。
3. 通过原生composer发送`[approval] Local ACP interface test`。界面显示running和审批卡，独立wire核对set_config_option值为fixture/b，点击前没有任何permission response。[待审批截图](v070-native-approval.png)。
4. 实际点击Decline。界面completed，输出`optionId:reject`；wire只发送一次reject_once，无持久授权。
5. 发送`[always-only] Verify no persistent grant`，实际观察Approve this request为disabled；点击Cancel turn后会话stopped，wire回答cancelled并发原生session/cancel，没有选择allow_always。
6. 发送`[approval] Single-use approval test`，实际点击Approve this request，输出`optionId:once`且completed。三轮均load同一owned session，旧消息REPLAY和child文本不进入父回答。
7. 展开Native activity history→Turn 3→Read和Local child。界面显示实际`Actual tool output`、note.txt的old/new diff、独立`Child-only answer`；子任务没有terminal事件所以明确unresolved。滚动活动区和外层容器，实际确认Attach files和Send prompt可见可达。[子消息与输入区](v070-native-child-composer.png)。
8. [机器核对](v070-native-ui-check.json)保留模型设置、三种审批结果、completed/stopped/completed、无持久授权和无父回答污染。日志不输出RPC token。
9. 关闭隔离host并等待runtime文件消失，重新打开正常用户资料目录应用；[实际status](v070-normal-app-status.json)报告0.7.0。没有远程发布。

工具路径和diff只显示，不因协议事件读取文件。文件快照/恢复由另一个真实临时Git项目的79项打包宿主集成验证，本UI项目没有开启快照。官方OpenCode 1.19.5另做隔离HOME/XDG与无继承认证的无推理发现，9个模型选项；不把合成peer或官方readiness描述为真实模型推理成功。
