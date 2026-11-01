# 0.13.0 原生 Profile archive 验收

2026-11-02，Asia/Shanghai。实际打包应用 `dist/mac-arm64/Vek Browser.app`，独立资料 `data/v130-native-ui`，合成本机 HTTP server。原生交互通过 CUA，未使用系统框注入；自动化 Electron fixture 的文件/确认框注入另行记录，二者不混计。

1. 创建测试 Space，在原生地址栏打开 `/one`、`/two` 两标签；页面只往测试 Profile 写合成 localStorage/sessionStorage。没有真实账号、其他浏览器源 Profile、Keychain 或付费模型。
2. Settings 新复选框默认为关；显式勾选 Include web storage from open tabs，经系统保存框选择隔离目录，真实两次口令确认后导出。显示2个Spaces、1个local origin、2个tab sessions；保存文件为 v2 密文、0600，无明文fixture值。
3. 从系统 Open 框选择该归档，真实口令解锁，再由原生确认框说明新 Profile、cookie/login/Space、local origin/tab session 数量和将加载网站的行为，点击 Restore。
4. 首轮恢复数据正确，但 Space 创建使 Settings 隐藏，留下欢迎面板：[原始观察](v130-native-before-result-fix.png)。已修复为显式重新打开 Settings，并在实际主应用测试中检查结果面板与人类可读计数；另清除bootstrap的虚构导航记录。
5. 最终重建后再次从原生文件框完整恢复；Settings 保持可见，显示新 Profile 和正确1 origin/2 sessions：[最终结果](v130-native-profile-result.png)。点击两张恢复标签，页面第一个网站脚本分别读到 `session: one`、`session: two`，且local值一致：[one](v130-native-restored-one.png)、[two](v130-native-restored-two.png)。Back disabled，未保留bootstrap根页。
6. [独立核对](v130-native-ui-check.json)记录密文版本/hash/mode、目的Profile新ID/Space与URL、fixture server未收到根文档网络请求。网站实际 `/one`、`/two` 加载确有网络请求；无网络只指bootstrap阶段。截图观察与文件/请求核对在JSON中分开标注。

导出在首轮同版本构建完成，恢复在最终结果面板/导航清理修正后重做。期间因重新构建重启QA应用，合成源页面会重新播种自己的会话；**不据此声称退出后sessionStorage持久恢复**。归档内容与无网络恢复逻辑相同。源数据不变、取消/部分失败等额外路径由临时Profile自动化测试证明，不扩大此原生场景证据。

最终全套313项、打包宿主132项、打包模块实际Electron2项/67内部检查通过；17项Profile专项包含原有7项和新增10项。曾有2次fixture过早采集/检查导航以及一次既有native interrupt audit断言失败，日志保留；实际source/destination页面就绪条件已补，Agent实现与断言未改，最终全套独立重跑通过。全部测试结果以[RESULTS](RESULTS.md)为准。

QA实例和server已停止，最终正常资料应用恢复为0.13.0，见[status](v130-normal-app-status.json)。31项真实网站模型基准、个人Profile/完整Chrome/Safari迁移仍未运行。
