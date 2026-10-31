# Codex模型能力与所选历史（0.8）

Vek独立实现原生模型目录客户端和所选rollout解析，不复制Ego闭源代码。普通源码工作不重新运行REA；Ego原有静态provider注册表只说明本阶段对齐目标，不能证明全产品功能等价。

## 接口证据

[官方app-server文档](https://learn.chatgpt.com/docs/app-server)和[目录不等价访问授权的说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)用于核对接口。实际实现还核对本机官方CLI **0.142.0**生成的ModelListParams/Model/ModelListResponse/TurnStartParams/ResponseItem类型；生成文件在忽略目录`references/codex/v0.142.0`。协议以对应CLI为实测版本，不硬编码文档示例模型。

官方CLI在隔离HOME/CODEX_HOME、临时空project和未继承认证环境下initialize和model/list成功，观察到5个带effort的目录项。另用thread/start和thread/inject_items向一次性本地会话追加两条合成历史，再thread/read刷新并解析其真实JSONL，得到两条预期文字。**没有turn/start或模型调用**；原始历史在忽略的`data/v080-official-codex-rollout.jsonl`，完整内置instructions不进入Git或日志。[报告](../reports/v080-codex-readiness.json)。

全局`/opt/homebrew/bin/codex`当前缺少平台可选依赖，未修改全局安装；使用应用自带的`/Applications/Codex.app/Contents/Resources/codex`继续完成验证。它的SHA和schema摘要可恢复核对。

## 模型发现与执行

沿用原有background discovery、并发槽/project lease/取消/重启中断契约。Codex只initialize/initialized/model/list，不创建native thread或run/message。目录逐页读取，最多16页/256可见模型；过滤hidden、去重复、拒绝循环cursor，超限标truncated。保存原生model slug（区别于catalogue id）、name、efforts/default/inputModalities/isDefault。旧目录缺inputModalities时按官方兼容约定保留text/image。

UI原生下拉选择真实模型和它支持的effort；切模型重置effort，Codex空模型选择会在有目录默认项时明确发送该model slug，避免沿用旧session模型而按另一个默认模型校验；ACP仍保持当前session模型。发现目录后的每个turn重新读取并校验；未出现的model/effort和已知不支持的image在turn/start之前失败。effort通过TurnStartParams.effort发送。目录可能bundled/cached，不能推断认证、访问授权或推理成功。旧版手工model配置在没有目录时仍兼容，不冒充经过能力检查。

配置变化清除目录/effort；native session继续绑定协议、可执行路径、参数和project。UTF-8使用StringDecoder，加载旧会话期间不把重放活动计入新turn；拒绝外来thread事件、不同resume身份、未知完成状态和重复/超量server requests。旧协议事件缺threadId时仍兼容，不宣称所有旧事件有完整来源身份。

## 所选rollout导入

只读取用户选择的一个普通JSONL，不扫描个人目录、不调用provider读取历史。复用有界fd读取：NOFOLLOW/非阻塞/读前后stat、32MiB/20000行/4MiB每行，严格UTF-8和完整JSON。支持一个开头session_meta和response_item的user/assistant文本及function_call/output显示记录；event_msg中的重复对话不重复导入，reasoning和system/developer不复制。已观察的生成AGENTS/environment用户上下文单独计数并排除；附件仅留不可用占位，不读取URL/路径。

不猜测压缩、回滚、revert和未知记录布局：显式拒绝这些文件。不是完整Codex原生会话迁移，也不恢复隐藏上下文/子会话。1MiB每条/8MiB主文本、有界工具显示记录；重复item id冲突拒绝。源ID仅来源说明，不授予resume、可执行配置、附件路径或checkpoint权限。

预览token最多4个、15分钟、内存持有；导入重新核对inode/hash，来源变化拒绝。导入0runs/无nativeID，稍后明确发送prompt才把可见文字送入新owned session。JSON archive白名单保留显示来源和工具证据，不继承原生能力。UI提供原生文件选择、预览、目的project/provider及导入后的活动展示。

## 仍未完成

完整压缩/回滚历史、多文件子历史、原生source resume/fork、后台任务、统一Codex原生工具/subagent实时展示、Claude模型目录、MCP自动注入和真实模型turn仍有缺口。其余5种原生provider及OS/MCP/迁移/线上benchmark继续按[PLAN](../PLAN.md)推进，完整产品parity为false。
