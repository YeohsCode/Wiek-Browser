# 显式 IndexedDB 资料迁移

归档格式升级到 v3，继续验证和解密 v1/v2。设置页新增默认不勾选的 IndexedDB 选项；只有用户通过本机可信导出流程启用后，才读取所选 Profile 当前打开标签的顶层 HTTP(S) 来源。不会导航寻找历史来源、读取 iframe 或扫描其他 Profile。

## 实现

- 捕获前后核对完整顶层 URL、loader、frame 和 storage key。分区或 opaque 来源跳过；导航期间不能把新来源的数据归到旧来源。
- 每个数据库在一条覆盖全部 object stores 的只读事务中读取 schema、索引和记录，保持该数据库内一致性。不同数据库之间不宣称原子快照。
- 数据库/仓库/索引名称、字段路径与文本用 UTF-16 base64 保留 NUL 和孤立代理项。记录值是固定 tagged JSON 数据，不作为代码执行；对象属性通过定义自有数据属性还原，不触发原型设置器。
- 支持显式主键、复合键、内联字段路径及唯一/多值索引。值支持 null/undefined、布尔、数值（含 NaN/Infinity/-0）、有界 BigInt、字符串、密集数组、普通对象、Date、ArrayBuffer，以及完整覆盖 backing buffer 的标准数值 TypedArray/DataView。
- 目前不迁移 auto-increment 仓库（无法无损保证已删除记录后的生成器位置）、Blob/File/CryptoKey、Map/Set/RegExp、共享/循环引用、稀疏数组、切片视图及其他不支持的类型。包含这些数据的整个数据库跳过；导出结果明确显示数据库/来源跳过数量和警告，不能把它标为完整迁移。

## 还原与边界

只还原到新建 Profile。先通过拦截并本地履行的空白同源文档建立来源，网站脚本与 cookie 不发送到服务器，随后再创建数据库。目的来源已有任何 IndexedDB 数据库时直接拒绝，不覆盖、不清空已有数据库。

还原后通过实际 schema/记录读取核验。失败或取消先关闭临时 contents，再只清理此前确认全空的导入来源 IndexedDB；不清理其他来源或其他存储类别。无法确认临时文档已关闭时不执行清理，直接隔离不完整 Profile，防止仍活动的文档在清理后再次写入。清理失败/超时会中止并从可选 Profile 列表移除不完整 Profile；不会打开其标签。清理类型 `indexdb` 和来源参数遵循 [Electron Session API](https://www.electronjs.org/docs/latest/api/session#sesclearstoragedataoptions)。

边界为最多32来源、每来源32数据库、每库64仓库、每仓库64索引、每库2,048记录、每库2 MiB和总计8 MiB的序列化数据。单值编码最多512 KiB；二进制在分配编码字符串前限制384 KiB；结构深度16、节点数4,096。读取和写入有超时，并在结束时关闭本次连接/事务。没有浏览器通用 API 可在读取记录之前知道其完整结构化克隆内存大小，因此不宣称能限制浏览器加载单条原始记录时的内存开销。

## 验收

23项资料迁移专项回归通过；其中新的IndexedDB会话22项实际检查、既有Web Storage会话34项检查、可信宿主IPC共37项检查。

合成 Electron 会话验证了显式键/复合键/Infinity键、schema与索引、UTF-16、Date及二进制、仅当前来源、源数据不变、已有数据库冲突、失败清理和取消。可信宿主 IPC 验证勾选选项后的归档和还原，并在网站脚本运行前观察到还原数据；所有 bootstrap 网络请求为零。

单独的单元回归检查了导航/分区来源拒绝、类型/大小限制、非法 schema、原型键和旧格式解密。此能力仍是有界 IndexedDB 子集，不代表多来源完整资料迁移或完整登录会话等价。
