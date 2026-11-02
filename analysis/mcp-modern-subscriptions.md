# 0.17 Modern HTTP MCP resources and explicit subscriptions

本轮按用户优先级推进P2，P1不同Agent集成继续暂缓。扩展既有显式`2026-07-28` HTTP客户端，新增资源/模板/读取及通知流；不是全部现代MCP、Ego私有服务或Agent gateway集成的完成声明。

## 公共协议依据与实现范围

2026-11-02核对官方[订阅规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions)、[资源规范](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)和[版本机制](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)。现代HTTP通过POST `subscriptions/listen`请求通知流，首条ack确认实际接受的filter，后续事件按request ID关联；取消关闭流。旧版GET和`resources/subscribe`仅保留在session客户端。没有据此证明Ego用同一代码或后端；本轮实现独立遵循公开协议。

此前现代模式在本地拒绝资源操作，只有工具调用。现在允许同一scope的resources/list、templates/list和read，保留能力校验、分页/重复cursor/数量/字节限制、text/blob联合验证。URI只是发送给所选服务器的标识符，不访问其中的本地路径或跳转URL。只在用户请求时展示内容，不持久保存正文，不自动发送给Agent。

## 显式订阅与生命周期

- 每条资源订阅独立HTTP SSE流，列表监听另用一个流，且只申请服务器已声明的tools/resources listChanged。没有自动开启监听。
- ack必须是首条消息，携带精确subscriptionId；只接受原请求的filter子集。空子集显示unsupported并关闭流，未知类型/额外URI/错误ID/确认前通知会关闭该流并报告lost。
- 收到关联resource update只增加revision；显式read记录readRevision。在读取期间变化仍显示stale。列表通知使相应列表失效；工具列表获取中遇变化明确要求refresh，界面不保留已失效的旧工具按钮。
- graceful complete显示closed，传输断开/协议异常显示lost，保留提示与Retry subscription。重试明确执行；可能遗漏的更新不重放，重试/断流将已有内容标为有缺口。连接重建不自动订阅。
- Unsubscribe/Stop watching lists关闭并等待对应流收尾。disconnect、移除integration、停止服务释放所有流；HTTP不发送legacy cancelled通知，也不GET续传。
- acknowledgment受普通请求timeout限制，确认后的流可以长期存活。逐SSE行/事件限制继续适用，取消累计1000事件限制仅用于这类显式长流；普通request的限制未扩大。
- 每连接最多16活跃流、128保留资源条目、64 HTTP controllers；现代HTTP连接池的32 sockets为普通请求保留空间，16条通知流同时开启时仍可显式read。没有自动重试401、跨服务器转移凭据或付费模型调用。

现代列表每次明确调用均重新获取，不复用跨请求protocol cache。界面显示上次列出的内容不是实时新鲜度保证；未实现ttl/cacheScope共享缓存。旧版session列表和通知路径保持原行为。

## 接口和界面

保留`mcp:resources:*`接口；现代模式内部转换成listen/close。增加`mcp:subscriptions:watch`、`mcp:subscriptions:stop`，参数为`{integrationId,scope}`，只支持现代HTTP；沿用项目/thread归属检查。snapshot只增加有界stream状态/filter/错误与active count，不将controller或HTTP对象暴露给页面。

Connected tools展示Watch list changes/Stop watching lists与List updates状态；现代Resources展开后可列举、读取、订阅、取消和明确重试。文本通过textContent/textarea显示，模板要求完整URI，不执行内容。列表和资源通知不触发自动网络读取。原生QA与发行包验收见[当前报告](../reports/RESULTS.md)。

## 测试与边界

新增21项：20个真实临时loopback HTTP协议/服务测试和1个实际Electron IPC panel（14内部检查）。覆盖首条ack、ID/子集校验、并发读取stale、列表竞态、过千事件、timeout/AbortSignal、单流错误隔离、容量和socket可用性、401不重放、scope/断开/重连、不持久正文及界面重试/缓存失效。历史旧测试中“现代资源一律拒绝”改为“未声明能力时不发网络请求”，新能力由上述正向/负向测试覆盖；上游81输入和69SDK断言不改。

仍未实现MRTR inputResponses/requestState续传、sampling/elicitation交互、prompt通知、现代stdio、task extension、自动版本探测回退或全规范等价。input_required仍明确失败，不包装成成功内容。OAuth现有预注册public client支持继续回归；CIMD/DCR/完整step-up仍保留，DCR在现代规范中的定位需下一项重新核对，不能沿旧计划直接扩权注册。

下一步P2先设计用户可审核、可取消的MRTR输入续传与不确定结果边界；sampling/模型执行不自动开启。完整来源迁移及P3 OS正向/睡眠和completion contract缺口继续保留，P1继续暂缓。
