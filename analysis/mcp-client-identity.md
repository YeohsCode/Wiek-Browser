# MCP 客户端身份：预注册与CIMD（0.19）

2026-11-02–03，Asia/Shanghai。公开协议的独立实现，不是Ego同后端运行等价证明；P1不同Agent集成继续暂缓。

## 配置和用户流程

HTTP OAuth保留预注册公共客户端，新增显式`registration:"metadata"`，以及两个模式都可用的精确`issuer`约束。未指定registration或选择preregistered时，旧配置/加密binding不变，不把URL形式的预注册ID自动解释为文档地址。

Metadata模式需要用户拥有或有权使用的HTTPS clientId文档URL，以及1024–65535固定回调端口。URL必须为canonical URL.href形式，有非根路径，无query/fragment、dot段或编码路径分隔符。这比草案允许的所有URI写法更窄。Vek不提供默认托管域名或自动发布。

1. Add/Configure HTTP server选择HTTPS Client ID Metadata Document，填写client ID、固定端口，可选预期issuer，保存。选择CIMD却留空client ID会在保存前报错，不降级成无OAuth配置。
2. Client metadata to host生成只读公共JSON模板；此动作不发网、不创建登录flow或监听端口。用户自行把JSON放到指定HTTPS URL。
3. Prepare sign-in先核对资源/AS发现、S256及公共token认证，再要求AS明确声明CIMD。获取文档时不带token、Cookie、环境凭据，不跟随redirect，不抓取logo/client_uri/jwks等附属URL。
4. 文档需有精确client_id、非空client_name、包含精确`http://127.0.0.1:PORT/oauth/callback`的redirect_uris、明确authorization_code/code和token_endpoint_auth_method:none。拒绝共享secret。额外未使用元数据不产生执行权限。文档以5 KiB、UTF-8/JSON、10秒单次读取和原登录总截止时间为界；接受application/json和application/*+json。
5. 审核界面增加client ID、来源机制、元数据名称与精确callback，再展示issuer/resource/scopes。服务器名称是惰性文本，不证明域名归属或可信发布者。Open sign-in page仍须明确点击，之后沿用PKCE/state/iss/resource校验、单次code exchange、加密存储和refresh轮换。

每次重新prepare都读取新文档，无跨flow文档cache。CIMD失败不自动切换为预注册/DCR，不开启浏览器或重放工具POST。固定端口冲突、取消、过期和失败均结束对应flow。

## 发行方和凭据

显式issuer与发现结果逐字匹配，不做额外规范化。预注册客户端若已有同配置/scope凭据，重新授权还会读取其密文内的issuer；不能靠修改外部明文row的issuer绕过绑定。默认配置仍兼容旧凭据；清除未显式pin的凭据也清除了记忆中的发行方。需要退出登录后仍固定AS时应配置issuer。

未显式pin的CIMD身份可跨AS使用，每次都重新发现/验证并明确审核；不是把旧token传给新AS。refresh仍使用该密文内原AS token endpoint，客户端ID和scope配置变动清除旧绑定。没有client secret/private_key_jwt、托管publisher、DCR或完整scope step-up。真实公网AS、真实Keychain令牌写入/刷新/撤销未验收。

## 依据与边界

本轮核对[当前MCP客户端注册规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)与其引用的[CIMD草案00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)：支持标志、URL/document身份、公共客户端和redirect注册要求是本实现的协议依据。MCP将预注册已有关系保留为优先选择，CIMD用于无预先关系场景；DCR保留兼容且已标为deprecated。草案是工作中标准，不声称已成为RFC或覆盖更新草案的全部扩展。

实际AS必须能访问托管文档并允许该native loopback redirect。测试用的本机HTTPS publisher和私有CA不能证明所有公网AS可用。产品没有关闭证书校验的配置；测试只在独立进程临时信任合成CA，不安装OS根证书、不改全局信任库。

## 验证

新增20项：19协议/服务、1实际Electron IPC面板含20内部检查。覆盖严格配置/模板、真实TLS与无认证获取、元数据/能力/URL/回调、MIME/UTF8/尺寸/redirect、取消/截止时间/端口冲突、代码授权/URL身份refresh/密文重启、issuer pin/明文row篡改和CIMD可迁移发行方。旧OAuth17协议+1面板一起回归，专项38/38；本地全套436/436。

打包模块、真实宿主、原生截图与最终同集SDK验收以[RESULTS](../reports/RESULTS.md)为准。合成授权使用AES-GCM fixture；原生手工只prepare/review/cancel，不把它描述为真实账号或Keychain token写入。

下一步转向P3自动化busy延期/completion语义，先对照现有REA证据明确验收范围；P2来源迁移和其他MCP缺口保留，P1继续暂缓。
