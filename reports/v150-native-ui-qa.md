# 0.15 Native UI + closed-app CLI QA

2026-11-02（Asia/Shanghai），独立 `data/v150-native-ui`，macOS ARM64发行包。原生交互全部用CUA；fixture准备与关闭后的预约通过明确的本地测试脚本完成，没有模拟原生UI输入。0模型、0真实账号操作，未安装launchd/后台daemon。

1. 以自有Node fixture准备一个普通CLI provider、包含PUBLIC_SOURCE_CONTEXT的template及paused one-time任务。界面默认mode=heartbeat、closed-app=Off，无自动执行。
2. 通过实际原生下拉菜单选择Dedicated和On · explicit CLI worker tick，Save后卡片显示对应配置，runCount仍0。
3. 原生Run now完成一次，出现专属线程。运行中浏览器下实际发行CLI `scheduler tick`返回skipped-locked，没有抢占或写入Agent状态。
4. CLI stop等待浏览器实际退出。fixture脚本只在浏览器关闭后arm原任务；发行CLI单次tick完成第二次run，ownedThreadId与第一次相同。没有runtime.json或遗留Agent锁，源PUBLIC_SOURCE_CONTEXT不在两个输出中。
5. 重开实际发行应用，选中专属会话，可见两次PUBLIC_AUTOMATION_REQUEST与真实fixture输出，无composer，并有归属提示。初次QA发现该视图还显示会被后端拒绝的编辑/回滚/删除/model入口；已隐藏并新增实际Electron断言，最终包原生复查通过。

[实际worker结果](v150-native-worker-tick.json)、[运行中锁结果](v150-native-locked-worker.json)、[状态核对](v150-native-ui-check.json)、[配置卡](v150-native-automation.png)、[最终专属会话](v150-native-owned-thread.png)。[修正前界面](v150-native-before-controls-fix.png)仅含公开合成内容。

文件/线程/进程均属一次性fixture，真实付费provider与native审批没有执行。该流程证明实际UI配置与显式closed-app tick衔接，不证明OS自动唤醒、睡眠恢复、launchd安装/停用、前台自动handoff或Ego同模式runtime等价。普通CLI正文只保存在该fixture的私有Agent transcript；结构化核对不包含provider正文。
