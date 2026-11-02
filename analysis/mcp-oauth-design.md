# HTTP MCP OAuth：预注册公共客户端

> 0.19增量：已新增显式CIMD、公共文档模板/身份审核及issuer约束；仍无自动托管/DCR/完整step-up。旧版范围保留为历史，当前实现见 [mcp-client-identity.md](mcp-client-identity.md)。
日期：2026-11-02（Asia/Shanghai）。0.12.0 的独立实现。依据公开 [MCP 2025-11-25 Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) 和已安装 Electron 的 safeStorage API；没有调用 Ego 私有认证服务或真实账号。

## 用户流程与协议范围

HTTP 配置可选 `oauth:{clientId,scopes?,redirectPort?}`。仅接受预注册的 public client，token endpoint authentication 为 `none`；没有 client secret、动态客户端注册、Vek 托管 client metadata、DPoP 或完整自动 step-up。一个配置不能同时设置 OAuth 和 Authorization header reference。

1. 点击 Prepare sign-in：不带浏览器 Cookie、现有 OAuth token 或环境凭据 GET MCP endpoint；解析 Bearer challenge，优先 resource_metadata，否则依次尝试带 endpoint path 和根路径的 protected-resource well-known metadata。
2. 要求 metadata.resource 对应同一精确 MCP endpoint；使用第一个 authorization_servers issuer，并在 UI 展示。依次尝试 OAuth metadata、OIDC path insertion、OIDC path append；严格核对 issuer 字符串，要求 S256 PKCE。不会跟随 HTTP redirect。
3. scope 优先使用显式配置，否则 challenge.scope，再否则 resource metadata.scopes_supported。界面只读展示 issuer、resource 和请求的权限。点击 Open sign-in page 后才打开系统浏览器，由用户在该服务完成实际授权。
4. 本机只监听 127.0.0.1，固定 `/oauth/callback` 路径。默认自动端口；也可指定已注册的 1024–65535 端口。自动端口要求 AS 支持 native loopback port 变化。state 为 256-bit 随机值，PKCE verifier 为独立 256-bit 随机值。校验方法/Host/Origin、重复参数、state 和可选 iss；AS 声明要求 iss 时必须存在。
5. 单次 code exchange 包含相同 redirect_uri、client_id、PKCE verifier 和 resource。结果成功后返回 Vek，再显式 Connect/Run tool。准备、失败或 401 不会自动打开登录页或重放工具。

生产 endpoint、metadata、issuer、authorization/token endpoint 要求 HTTPS。仅当 MCP endpoint 本身也是用户明确允许的 loopback HTTP 时，整个测试链路才可使用 loopback HTTP。每次 metadata/token 读取有超时和 256 KiB UTF-8 JSON 限额，不使用代理环境或系统浏览器凭据；采用 Node HTTPS 默认信任，没有跳过 TLS 验证的配置。

metadata 必须能在未携带 credential header 的条件下发现；此实现不把额外 headerRefs 转发给 AS。当前选择第一个 issuer，没有 AS 列表交互选择；scope 升级需用户手动配置/重新授权。故不声称所有第三方 MCP 登录方式或全部最新授权规范已兼容。

## 存储与作用域

- 令牌通过生产宿主注入的 Electron safeStorage encryptString/decryptString 存储于私有 `mcp/oauth-tokens.json`（目录0700、文件0600、原子替换）。Linux basic_text/unknown backend 被视为不可用；不以明文回退。协议/Electron测试注入独立 AES-GCM fixture，不把它描述为本机 Keychain 写入证明。
- 密文内部绑定 integration ID、MCP URL、公共客户端/redirect port/显式scope配置、project ID 和 thread ID。移动 ciphertext 或改外部 row/key/fingerprint 不能把令牌授予其他项目或线程。项目工具视图与某个线程视图的登录各自隔离；不是一次项目登录自动共享给所有线程。
- 公共 snapshot 不含 token、verifier、state、授权 URL、sealed data 或内部 fingerprint。已知令牌会在工具结果/错误中脱敏。拒绝与路由/配置等公共控制数据碰撞的令牌，避免恶意 issuer 利用脱敏破坏持久 ID。
- 仅接受有界 Bearer token：access/refresh 最少16字符、最多16 KiB，access token 使用受限 header 字符集。最多256个credential/4 MiB store；8个待完成flow、32条flow记录；一轮授权默认3分钟。credential脱敏集合有2048项上限，超限要求重启后授权。
- access token 即将过期时可在发送 MCP 请求前执行一次共享的 refresh；要求返回不同的新 refresh token。失败、超时、缺轮换或取消导致结果不确定时停止并要求重新登录，不自动重放 refresh POST。没有 expires_in 则不推测过期时间，遇401交给显式登录。
- HTTP401清除当前scope本地credential；403不静默扩权。重新授权期间断开旧session，并拒绝工具连接；取消后可重新使用仍有效的原credential。端点/client/scope变更或移除integration清除旧绑定。
- Sign out/forget 仅删除选定scope的本地令牌并断开连接，不等于服务端revoke、退出系统浏览器账号或安全擦除备份/进程历史。MCP服务关闭会取消pending callback和refresh；停止后的迟到code结果不能保存credential。

## 验证

新增18项：17项真实本地HTTP/crypto/服务协议与边界测试，1项真实Electron IPC/UI测试。包括challenge/双well-known/OIDC/path、PKCE/resource/state、固定callback路径/端口冲突、错误issuer与metadata、加密重启/密文重绑定、并发refresh轮换、401无工具POST重放、原session授权lease、错误token与控制数据碰撞、metadata取消与exchange期间取消、只读权限审核→显式打开→合成code授权→脱敏工具→sign out。

打包宿主新增9个OAuth检查：本机OS存储可用状态、真实metadata与本机callback准备、scope/私有数据边界、取消/不重开及无Header冲突。它们仅执行prepare/cancel：0外部浏览器打开、0code exchange/token、0真实账号操作、0模型调用。原生打包UI另验证审核与取消；真实Keychain令牌写入、真实AS登录/刷新/撤销仍未运行。最终本地/打包/SDK结果见 [RESULTS](../reports/RESULTS.md)。

下一步优先Profile web storage/会话范围与明确来源迁移；OAuth DCR、MCP MRTR/现代订阅和P3系统/调度等缺口继续保留。P1其他Agent集成和provider gateway注入继续暂缓。
