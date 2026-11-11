# 0.16 Reviewed macOS login scheduling and foreground takeover

本轮在[0.15单次worker](automation-execution.md)上增加可审核的login job生命周期与前台接管。**默认关闭**；每个automation仍需closedAppAllowed。不是系统级daemon，不以root执行，不物理唤醒睡眠机器，不提供登录退出后的无人值守运行。P1不同Agent集成继续暂缓。

## 依据与独立实现范围

Ego本地scheduler/mode证据仍沿用[daemon调查](shipped-daemon-features.md)及[执行模式证据](automation-execution.md)，只有有界shipped-static证据；本轮没有证明Ego使用launchd、同一安装位置或同一handoff实现。以下OS作业与控制协议是Vek独立设计。

本机`man 5 launchd.plist`、`launchctl help bootstrap/bootout/print`确认：user LaunchAgents、argv、StartCalendarInterval、RunAtLoad、ExitTimeOut及睡眠后calendar事件合并。选择空calendar字典每分钟检查，未使用会丢失sleep tick的StartInterval，也未配置KeepAlive。真实测试覆盖RunAtLoad和显式kickstart，不做物理sleep/wake实验，不把文档语义冒充实际睡眠验收。

## 用户明确审核

Settings → Background scheduling。Prepare只计算三分钟内有效的review，不写OS job或私有launcher。展示Vek/Node版本、可执行文件、login plist、私有launcher及60秒默认worker timeout；Enable要求同一token、同一配置和未改变的runtime。token不能给CLI/RPC写权限：除snapshot外，这组action仅允许主chrome可信IPC。

Job label是canonical dataDir的SHA-256前24位，plist默认为`~/Library/LaunchAgents/app.vek.scheduler.<hash>.plist`。自有launcher复制到私有`scheduler/launch.cjs`；job.json、launcher和plist为0600，scheduler目录0700。argv固定无shell，XML转义路径。只写入PATH和启动Electron Node模式所需flag，不拷贝环境凭据；进入provider前清掉host Node-mode flag。第三方CLI自己的安装/认证环境仍由其既有配置和OS权限决定。

Receipt覆盖canonical Vek路径、所选可执行文件SHA、实际Node版本、app顶层JS/CJS/MJS及package.json。稳定launcher先用Node内建模块检查consent、完整文件集合及各hash，再require worker。路径移动/代码更新/缺失/Node版本改变返回needs-review，不自动接受更新。**不覆盖外部provider程序/脚本、CSS、模型文件、全部Electron Framework字节；不是对抗同用户代码的安全沙箱。**

Enable在OS确认loaded后才返回成功；失败撤销consent并清理已知自有login文件，未完成的清理明确报错。Loaded表示OS已注册，执行结果另看last check；macOS会话、background-item与隐私限制仍适用，没有自动授予OS权限。

Disable先持久撤销consent，再等待worker实际收尾，bootout并删除自有login文件，保留receipt供以后重新审核。Remove进一步清掉自有launcher/receipt，保留Agent历史。改动/未知/symlink文件不会被覆盖或删除；失败时consent保持off并提示清理问题。可选job.json损坏时保持只读和blocked，浏览器仍可打开；有界snapshot不转发last-job文件的未知正文。

## 前台接管与writer归属

Foreground先取得私有foreground.lock，再检查并请求worker退出。活跃gate期间新worker直接skip，已有worker在每个dispatch前也检查gate。启动竞争由wx创建选出一个foreground owner；陈旧foreground gate只能在独占recovery guard下按身份重查后回收，未知guard不抢占。此范围针对scheduler/Agent writer，不宣称整个应用所有独立启动路径已全面等价。

Worker取得Agent锁后发布127.0.0.1临时HTTP控制端点：private bearer token、instance、PID、canonical dataDir；metadata为0600。只支持最多256字节的POST /stop，拒绝Origin、错误token和未知reason。没有浏览器操作或Agent执行接口，也不对外暴露token。Foreground验证identity后请求一次，再等Agent lease和端点释放；202 acknowledgement不能代替实际provider/checkpoint收尾。超时不向未知PID发kill，不并发打开Agent状态。

Main在Agent/workspace/checkpoint收尾后才释放foreground gate；worker接管结果为yielded-foreground，已预约run不自动重放。Workers仍不清理陈旧Agent锁；hard kill/崩溃不保证独立进程组中的provider自动消失，恢复不能推断外部副作用。正常signal、timeout、disable和foreground handoff有真实进程验证。

## 验收

新增20项：8 control/实际host、11 job/launcher、1 Electron IPC panel（11内部检查）；原worker11项继续回归。临时launchd fixture使用独立label及用户Library之外的临时plist，实际bootstrap/RunAtLoad/foreground gate/同专属线程续接/不重复/bootout，finally移除自有job。发行包再次使用Electron Node runtime验收，不操作真实provider账号或付费模型。精确结果见[RESULTS](../reports/RESULTS.md)、[真实OS核对](../reports/v160-native-launchd-check.json)。

验证中保留了初始观察：测试cleanup顺序在service close前移除了目录；改为先收尾后删除fixture。另有旧native interrupt测试看到request audit就stop，未确认client已收到turn ID；现增加acknowledged nativeTurnId前置等待，原interrupt断言不变。失败记录不证明所有历史超时均由同一原因导致，未修改provider协议实现。

首次包内真实OS测试还在上一进程未idle时kickstart，no-op等待超时；fixture改为每次kickstart前确认OS状态无活跃PID，原不重复断言保留，最终包测试成功且清理确认。初次记录中未到达的默认false不代表观察到重复或卸载失败，详见[原生QA](../reports/v160-native-ui-qa.md)。产品实现没有因此修改。

本轮边界：没有实测logout/login、物理sleep/wake、OS background-item撤销、所有runtime安装布局或所有CLI认证环境。P3 cooldown/defer、completion contract及0.14 OS采集正向仍有缺口。下一阶段优先P2 MCP现代请求/订阅，DCR和明确来源完整迁移保留，P1继续暂缓。

## 0.24 安装布局与代码身份增量

新增8项布局验收，连同既有job/control/worker专项共40/40通过，见[本轮日志](../reports/v024-scheduler-layouts.log)。所有launchctl调用均由夹具记录，没有注册、启用或移除真实系统登录项。

- 打包目录、资料目录和登录文件目录包含空格、中文及XML特殊字符时，plist解析后的argv仍是精确的两项路径；可执行文件、应用根目录和资料目录入口的符号链接按canonical路径审核。
- 指向同一资料目录的入口共用一个job身份；重新打开设置不自动安装第二份。审核后重定向应用或可执行入口也不改变此前明确审核的canonical目标。
- 移动已审核的运行目录后，稳定launcher返回needs-review，不能自动追随新位置；先关闭旧执行授权、重新审核新位置才可恢复。移动资料目录后，旧安装凭据不能自动获得新位置的登录任务权限，设置明确阻止更改。
- 修复了一处代码收据缺口：仅筛选isFile会把源目录中的代码符号链接排除在摘要之外。现在审核阶段拒绝非普通或非canonical源文件，launcher也在加载worker之前拒绝新增代码符号链接。实际夹具验证外部模块的标记文件不会被执行写入；package.json的链接同样在审核前拒绝。

这些结果证明有界安装路径和代码身份行为，不证明物理sleep/wake、logout/login、OS撤权或所有第三方CLI安装/认证布局均已验收。系统级场景继续保留为未完成。

最终包可另行执行 `node tests/scheduler-packaged-runtime.mjs /absolute/Resources/app /absolute/MacOS/Wiek\ Browser`：以夹具OS回调创建临时收据，再用包内Electron的Node模式执行精确审核的bootstrap argv。它只运行空资料目录的一次tick，检查实际记录与自有文件清理，不调用真实launchctl。初次工具链检查针对0.23旧包通过，保存为baseline；0.24最终包结果必须另行验证。
