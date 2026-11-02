# Vek 0.16 native scheduling QA

2026-11-02，macOS arm64最终发行包；仅本地fixture。原生交互使用CUA，CLI仅启动/读取公开snapshot/停止；截图由自有chrome capture接口留存。没有授权新OS权限、调用付费模型或操作真实账号。

- Settings → Background scheduling：Execution consent off、Setup absent、OS job not checked。
- Review：实际显示Vek 0.16.0 / Node 24.19.0、最终包可执行文件、拟安装的用户LaunchAgents路径、独立测试dataDir的私有launcher以及60秒timeout。原生截图检查路径完整、可滚动，Cancel/Enable按钮可达。[预览](v160-native-scheduler-review.png)
- Cancel review：预览消失，consent仍off、setup absent。Refresh：OS job not loaded。[取消后](v160-native-scheduler.png)
- 读取公开snapshot确认plan=null，文件系统确认拟安装plist、私有launcher、job.json均不存在；停止后foreground gate释放。[核对](v160-native-ui-check.json)

没有通过界面启用默认资料的持久任务。实际OS正向bootstrap/RunAtLoad、专属线程续接、foreground gate及卸载由[独立临时launchd测试](v160-native-launchd-check.json)验证，使用最终Electron可执行文件的Node模式；临时plist位于用户Library之外且已清理。

初次包内OS测试在上一进程尚未idle时kickstart，最终no-op等待超时；第二次kickstart前先从OS状态确认无活跃pid，再保留原不重复断言，最终通过。初次JSON中的noDuplicate=false、realOSBootout=false是未到达的默认标记，不是观察到重复或卸载失败；finally实际已卸载并清理。保留[原日志](v160-native-launchd-attempt1.log)及[原结构化记录](v160-native-launchd-attempt1.json)。这是测试调度前置条件修正，未改产品代码。源码、初次包内和最终包内三组临时job最终均重新只读核对：OS不存在、consent off、receipt已移除，见[清理复核](v160-launchd-cleanup-check.json)。

仅验证当前窗口的浅色布局；未验证所有尺寸、深色原生布局、logout/login、物理sleep/wake、OS background-item撤销或所有CLI认证环境。全量产品parity仍未完成。
