# Wiek 改名范围与兼容边界

2026-11-04。产品名称、窗口/菜单/托盘、协议 client 名称和应用包为 Wiek Browser，bundle ID 为 `app.wiek.browser`。canonical CLI 为 `cli/wiek-browser.mjs`，旧入口保留。`WIEK_*` 优先并映射旧 `VEK_*`，旧输入仍可用；内部 IPC、加密归档标识及历史证据保留旧名。

开发默认 `data/`；打包版优先已存在的 Wiek 目录，只有 Vek 目录时原地复用，不自动移动/删除。已测试 CLI aliases、环境优先级、目录选择及旧 v1/v2 加密归档；目录复用本身不等于 OS 绑定凭据迁移。

Electron 42.11.18 的 [PostCreateMainMessageLoop](https://github.com/electron/electron/blob/v42.11.18/shell/browser/electron_browser_main_parts.cc#L517) 用应用名称设置 macOS Safe Storage 的 service/account。因此原名称下的 OS 加密 cookies、vault 和 OAuth 密文跨应用名解密未在本轮验收；保留原数据，不能把目录选择测试宣称为完整凭据迁移。需要完整迁移时，可在原版明确导出选定资料、在新版导入并重新授权相应服务；不自动读取 Keychain 原始密钥。代码签名/TCC 授权和 login-job runtime receipt 也需按新身份复核。

旧名称出现在归档 format/MIME、错误码、SDK host-instance override、私有 IPC、原始日志和历史文档中属于兼容/证据标识。新 README 提供 English/简体中文，不重写历史测试身份。
