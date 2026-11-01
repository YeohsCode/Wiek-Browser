# 0.14 macOS native UI QA

2026-11-02，最终macOS ARM64发行包，独立 `data/v140-native-ui`；CUA操作。未操作真实账号，未调用模型，未授予新OS权限。

| 检查 | 实际结果 |
|---|---|
| 默认与权限 | 新实例选区关闭、全部键未分配、无draft；screen/accessibility查询均为既有granted。helper另有status-only探针，未读取正文 |
| OS键注册 | UI明确启用单次选区，设置Control+Alt+Shift+K，实际Electron注册为registered；最终包重启后重新注册成功 |
| 跨应用选区 | 独立Electron42 fixture窗口仅含公开合成文本。CUA selectText确认选中，但两种按键写法均未观察到全局回调，draft/error均空。**未验证成功，不归因于确定的产品或工具缺陷** |
| 原生截图启动 | UI点击后出现busy，实测独立 `/usr/sbin/screencapture -i -x -t png` 进程，固定私有输出路径；未完成系统picker到PNG的正向选择 |
| 原生取消 | 最终包点击Cancel capture，真实进程退出后busy清空、无draft、无错误，临时目录无遗留；修复前取消曾显示Electron IPC错误前缀，已有回归 |
| 重置与清理 | UI Reset关闭选区、清空全局键、无draft/lastError；QA app退出，自建source进程结束。正常资料实例恢复为0.14 |
| 视觉 | 桌面面板深色主题文字/按钮可读，截图入口与权限/默认关闭状态可见；没有将所有应用/多屏兼容勾为完成 |

[最终核对](v140-native-ui-check.json)确认重置/临时目录/helper身份；[busy状态](v140-native-busy-state.json)保留了实际注册状态和截图operation；[重置后状态](v140-native-final-state.json)无正文/像素。[面板截图](v140-native-desktop.png)仅为Vek自身chrome，不是系统截图的输出。辅助身份见[helper identity](v140-helper-identity.json)。

原生OS正向截图、AXSelectedText正文、背景真实按键触发、拒绝/撤销权限、多显示器、非Electron应用与Fn支持均未通过本轮native验收。服务层和Electron IPC/panel测试的OS采集器/registry为明确注入fixture；20内部检查证明预览、复制/保存和真实Library标注衔接，不证明上述OS结果。Ego侧本轮只有保留的bounded shipped-static证据，没有对应runtime对测。
