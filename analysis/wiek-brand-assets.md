# Wiek 独立标识（0.20.2）

权威源是 `app/assets/wiek.svg`（橙色圆角方块、底部渐变至白色、白色 W 和白色圆点）和 `wiek-tray.svg`（单色模板）。图形以 SVG 路径独立绘制，没有读取、变形或描摹 Ego 图标。原始设计及生成图形沿用本仓库 MIT 许可。

`npm run build:brand` 使用锁定的 Resvg 2.6.2 生成 PNG；macOS 的 iconutil 生成 ICNS。覆盖侧栏、欢迎页、favicon、主/次窗口、Dock、托盘、canonical Skill 和 ego-browser 兼容 Skill；兼容文件名不代表使用 Ego 视觉素材。开发依赖 Resvg 不随产品分发。

`tools/verify-brand-assets.mjs` 对活跃 app/skills/SDK 输出检查两张已知原始 Ego PNG 的 SHA-256；发行模式还核对包外层 icon.icns 和 Skill 图片身份。此检查能排除这两份原图，不声称通用视觉相似度检测。历史参考截图和下载制品继续作为调查证据，均不属于产品输入。

P4 CI 首次运行 41690733098 在 SDK build 失败：裸 `references/` 忽略规则漏掉 `skills/ego-browser/references/`。显式纳入两份 MIT 文档；干净导出的源码验证不借用本地忽略的 Skill 目录。SDK 源码和原始断言没有为绕过失败而改写。
