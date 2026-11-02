# 0.18 原生MCP输入审阅验收

2026-11-02，macOS arm64 0.18.0打包版，独立data/v180-native资料与临时loopback HTTP peer。没有真实账号、凭据或模型。CLI仅准备/核对本地fixture、读取公开状态和清理；原生表单提交/取消通过CUA。

- 打开MCP integrations，连接Local reviewed input、列出工具并运行interactive。任务进入awaiting_input，未自动填写。
- Review input显示集成名、完整endpoint、工具、项目scope、轮次/截止时间，以及惰性文本`<script>inert</script>`。表单可编辑name、默认整数2与布尔false。[审阅截图](v180-native-input-review.png)
- CUA填写NativeFinalQA并点击Submit reviewed inputs；任务completed，远端返回类型正确的`{name:"NativeFinalQA",count:2,confirm:false}`，并显示交互结果不保存到历史。
- 另一个任务经Review input → Cancel task变为cancelled，审阅入口消失。[取消截图](v180-native-input-cancel.png)
- 原生检查发现新增select仍是紧凑原生尺寸，以及旧结果块在深色主题对比度不足；补齐select布局/focus与深色结果颜色。最终包再次运行38项MCP测试，并复核当前深色窗口。[最终结果截图](v180-native-input-result.png)
- 最后一次对比度复核的结果通过本应用的公开API准备（FinalContrastQA），不是再次声称CUA填写；此前原生填写/取消对应的服务和renderer逻辑未变。重启后旧交互结果不恢复，最终无活跃review，MCP状态文件无schema/填写值/opaque state或结果正文。[核对](v180-native-ui-check.json)
- 临时宿主停止、peer终止。默认资料不添加测试集成；最终正常资料运行状态单列保存。

仅检查当前深色窗口；没有宣称浅色/全部尺寸验收。逐项decline/dismiss、验证失败保留表单、超时关闭、更多schema和stream取消由实际Electron隔离IPC/协议回归覆盖；本次手工原生QA只实操提交和整任务取消。没有Ego同功能runtime对测。
