# 0.19 原生CIMD身份审核验收

macOS arm64 0.19.0打包版，独立data/v190-native资料、合成本机HTTPS publisher/issuer/resource。日期以[核对JSON](v190-native-ui-check.json)的checkedAt为准（Asia/Shanghai）。临时CA仅通过该独立宿主的NODE_EXTRA_CA_CERTS信任，未安装OS根证书或修改全局信任库。没有真实账号、模型或公网发布。

- CLI准备隔离项目/HTTPS integration与固定callback配置；全部原生点击通过CUA。
- Client metadata to host显示只读HTTPS client ID和公共JSON，明确说明需自行托管、不会由Vek发布。[模板截图](v190-native-client-document.png)
- Prepare sign-in成功取得AS声明与合成HTTPS文档，弹出Review OAuth sign-in。界面完整显示client ID、metadata机制、惰性`<script>`客户端名称、固定IPv4 callback、issuer、resource与notes:read；可见Open sign-in page按钮，但本次未点击。[身份审核](v190-native-identity-review.png)
- 先Cancel关闭审核，再Cancel sign-in，状态变为cancelled，Prepare入口恢复。[取消截图](v190-native-cancel.png)
- 公开状态核对credentials/tasks/connections均为0，callback已关闭，没有token store，MCP state.json没有抓取的客户端名称/文档正文。[核对](v190-native-ui-check.json)
- 原生手工没有打开外部浏览器、code exchange或Keychain token写入。真实TLS code授权/refresh/重启使用自动化Electron/crypto fixture验证，不混称真实账号或OS存储证明。
- 临时宿主和HTTPS peer停止，测试CA文件清理；正常资料不会添加该integration或信任该临时CA，最终正常应用状态单列记录。

仅检查当前深色窗口，未宣称全部窗口尺寸/浅色主题。配置字段和模板/审核全流程由实际Electron IPC回归覆盖；没有Ego同功能runtime对测或公网AS兼容验收。

上述原生截图完成后，仅追加CIMD空URL不能静默保存为无OAuth配置的界面防错；没有改变有效配置的prepare/审核/cancel流程。最终发行包的真实Electron回归另验证该防错和完整身份流程。
