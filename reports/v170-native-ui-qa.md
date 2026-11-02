# 0.17 native MCP resources QA

2026-11-02，macOS arm64最终0.17.0发行包。独立data/v170-native-ui资料、离线项目与临时127.0.0.1 HTTP协议peer；没有真实账号、凭据、付费模型或OS新授权。全部界面点击/滚动通过CUA，CLI仅用于准备fixture、发出本地测试变更/读取公开状态和停止宿主。

- 打开MCP integrations，Connect后List updates off，没有隐式通知流。
- Watch list changes明确建立一个列表流；展开Resources，List resources显示文本形式的`<script>`名称；Subscribe建立第二个资源流。
- 通过本地fixture工具发出资源变更和列表失效，原生界面显示`changed — read again · updates 1`，旧资源目录失效；此时wire确认resources/read次数为0。[变化提示](v170-native-modern-stale.png)
- 点击Read latest，预览明确显示中文`离线内容 1 <script>inert</script>`为数据，readRevision追上revision。[内容预览](v170-native-modern-read.png)
- Done、Unsubscribe、Stop watching lists后，原生显示List updates off，wire确认活跃流0、保留资源订阅0、listWatch=null、resources/read恰好1次；正文不进入mcp/state.json，未发legacy initialize/subscribe/unsubscribe/cancelled。[核对](v170-native-ui-check.json)
- 停止一次性宿主和临时peer。默认资料未添加这个integration或开启监听。

断流/lost、明确Retry subscription、工具按钮随列表失效移除由21项发行模块回归中的实际Electron IPC场景验证（14内部检查），本次原生手工QA没有制造断流。截图检查当前浅色窗口和可滚动内容；没有宣称覆盖所有窗口尺寸/深色布局。没有真实远程MCP认证、MRTR输入续传或Ego同功能runtime对测。
