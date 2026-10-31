# Vek 0.5.0 原生界面验收

时间：2026-10-31，macOS ARM64 最终打包应用。使用独立 `data/v050-native-ui` 和临时Git项目；provider为仓库自有Node协议peer，不是Claude模型。

1. 实际原生点击 Agents & automations，选择 Claude native permission QA 会话。
2. 在真实composer输入并发送 `[approval] Verify explicit decline using the local protocol peer.`。
3. 观察到Running和原生审批卡；显示项目路径及literal输入 `{"command":"printf fixture-only","other":"<literal>"}`，有单次批准/拒绝/取消按钮。
4. 点击前独立读取实际provider audit：1个user message、0个control_response，未自动批准。保存 [待审批画面](v050-native-approval.png)。
5. 实际点击Decline，观察到Completed、`Decision: deny`。展开Native tools→Read，展示真实tool_use输入；展开Latest run，20 input/6 output/3 cached tokens和明确标为cumulative的$0.004000 session estimate。保存 [工具/用量画面](v050-native-tools-usage.png)。
6. 独立检查实际state和audit：恰好1个deny response、approval declined、正确session关联、before/after快照complete。见 [机器核对](v050-native-ui-check.json)。peer没有执行审批输入中的任何命令。
7. 关闭此QA host，重新打开正常用户资料目录的Vek；CLI实际status报告0.5.0。QA fixtures保留在忽略的data目录，未进入发行包。

本验收没有模型请求、外部账号、麦克风或个人资料读取。真正Claude CLI的initialize-only readiness另见 [报告](v050-claude-readiness.json)，两个证据层级不能互相替代。真实Claude原生文件修改/diff/恢复联动由最终包的59项宿主集成和13项协议专项覆盖；v0.4的准确名称确认UI记录保留为历史证据。
