# 0.12.0 原生 OAuth UI 验收

2026-11-02，Asia/Shanghai。打包应用 `dist/mac-arm64/Vek Browser.app`；独立资料 `data/v120-native-ui`。所有输入通过CUA；服务器为本地合成OAuth/MCP fixture，0真实账号操作、0模型调用。

1. 从MCP integrations打开已配置的HTTP OAuth fixture。显示Prepare sign-in；没有自动打开外部浏览器。
2. 实际点击Prepare sign-in：发现本地metadata并绑定本机callback。弹出Review OAuth sign-in，只读显示issuer、精确MCP resource和notes:read；提供明确Open sign-in page按钮。[截图](v120-native-oauth-review.png)
3. 点击Cancel关闭审核，再点Cancel sign-in结束flow。显示OAuth: cancelled，恢复Prepare sign-in。[截图](v120-native-oauth-cancelled.png)
4. 使用受保护API独立核对OS secure storage可用、flow已取消、credential为0且无authorization URL/verifier，见 [JSON](v120-native-ui-check.json)。未执行Open sign-in page、code exchange或Keychain令牌写入。

协议/Electron自动测试使用注入的AES-GCM存储和openExternal捕获器，另验证完整合成授权、PKCE、工具凭据脱敏和sign out，计入18项专项，不与此原生审核/取消过程混计。真实AS登录/刷新/撤销和Keychain令牌写入仍未运行。

最终303项本地、132项打包宿主、69项SDK在当前代码上完成，155文件/81上游输入身份核对通过。QA实例与本机fixture完成后停止，正常资料目录重新启动0.12.0，见 [status](v120-normal-app-status.json)。
