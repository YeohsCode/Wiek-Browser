# P4 canonical SDK V2 adapter：实现约束

本文件基于当前 MIT SDK 源码。共享控制原语及本地 smoke runner 已实现，**0.21 已接入完整框架 adapter，并通过两侧本地 hook smoke；线上基准仍未运行**。参考框架固定在 `f566ac293e4e6bd80c4e9b062b5699f04eac41f4`；原始 adapter SHA-256 为 `baa7e1133eadb79fbcf0065ea9814a7a69cc9cb2cb9af84680271012282150cc`。两侧必须应用相同补丁和同一 SDK，不修改原始任务或评分标准。

## 与旧接口不能直接互换的语义

- 旧框架只探测 flat helpers 和 `taskSpaces.*`。新公共入口是 `taskSpace()`；能力探测只检查函数存在，不调用它。它会在名字不存在时创建新 space，因此截图与清理必须先用 `listTaskSpaces()` 找到现存精确 ID，再调用 `taskSpace(id)`。不存在时清理返回明确的幂等结果，截图返回缺失错误，不创建空白任务来冒充成功。
- `TaskSpace.cdp()` 只支持 Target/Browser 域。`Page.captureScreenshot` 和 `Accessibility.getFullAXTree` 应经实际选中的 `Page.cdp()`，不能把旧全局 `cdp` 简单替换成 `task.cdp`。
- `task.tabs()` 返回 `active`、`page`、`openedBy`；未托管 tab 的 `UnmanagedPage` 没有 Page 的 CDP 能力。优先选择实际 active 的托管页；active 页不受支持时应明确失败，不偷换成另一页或自动 adopt 用户页面。
- 结束操作是 `task.finish({keep: []})`，不是 `completeTaskSpace(id,{keep:false})`。它只关闭 Agent 管理的页，可能保留未知来源/未托管页并返回 `closedSpace:false`。保留 receipt，并把未完全清理作为明确状态；不强制 claim/close 用户资料。
- 用户接管和 user ownership 是控制边界。截图、清理不得在错误后回退到另一个历史 helper、擅自 takeover 或放宽隔离。

源码依据：`packages/sdk/src/helpers.ts` 的 `taskSpace`/`resolveTaskSpace`，`packages/sdk/src/page-model.ts` 的 `TaskSpace.tabs`/`finish`/`cdp`、`Page.cdp` 与 `UnmanagedPage`。它们描述当前实现，不构成对 Ego 专有代码的推断。

## 实现与验证约束（已按 0.21 执行）

1. 在独立目录维护共享 adapter 和可重复应用的补丁，校验参考文件 hash；保留框架 MIT 许可证。不得静默修改被忽略的参考 checkout 作为唯一实现。
2. 增加 canonical 的能力探测、Skill 匹配、任务候选解析/释放识别、截图/AX、结束与清理路径。旧方言继续使用其原合同，不以异常自动切换合同。
3. 用合成 runtime 验证：探测零副作用；缺失名字不创建；ID/名字歧义；接管拒绝；选中页隔离；保留未知页；截图失败与空数据；旧文件不能伪装为新截图；每次清理有结构化 receipt。
4. 对两侧同一 SDK 运行只访问本地 fixture 的实际 smoke：创建、跨进程恢复、截图/AX、结束和缺失任务幂等。记录 SDK、adapter、任务、CLI 和产物 hash；不启动模型、不使用真实账号。
5. 获得专用 Stage A/Judge 配置和测试账号后才执行 31 项线上任务。发布未运行/失败/专有服务跳过的实际数量；本地 smoke 不能当作线上 benchmark 分数。

## 已实现的本地控制原语

`tools/benchmark-sdk-v2-contract.mjs` 的 factory 可原样序列化到两侧 SDK 的 nodejs 环境，不读浏览器专属私有接口。11 项专项验证缺失任务零创建、所有权竞争、名字/ID 歧义、active Page 隔离、未知页保护、空截图与可选 AX 失败。

`tools/verify-benchmark-v2-smoke.mjs --browser wiek|ego|both` 使用同一 SDK 与控制源码、同一 loopback HTML，分 CLI 进程创建/恢复/截图/AX/结束，校验真实 PNG、实际 AX 文本和缺失任务不改变数量。CLI 输出必须带本次随机 marker，退出失败或无 marker 不会冒充成功；Wiek 使用一次性数据目录并在最后停止该实例。

Ego 显式版本示例：

```sh
WIEK_BENCH_EGO_CLI="/absolute/path/to/Versions/0.6.2.7/Helpers/ego-browser" \
  node tools/verify-benchmark-v2-smoke.mjs --browser both
```

Ego 使用命名 `vek-reference` 的专用实例，不回退到个人默认浏览器。下载副本从历史 0.6.1.13 自动更新后，保留旧测试身份与新 smoke 的 CLI hash/实际 host version；不同版本的结果分别说明，不能把新 smoke 冒充旧版 69-case 重跑。原始路径/连接/脚本失败日志均保留。

实际 smoke 两侧均通过：Ego 0.6.2.7（16,388-byte PNG/9 AX nodes）和 Wiek 0.20.2（13,804-byte PNG/9 AX nodes）。同一 SDK hash `a8c27da3…572a56`、同一控制源码与 fixture hash；详情见 `reports/p4-sdk-v2-local-smoke.json`。测试未运行模型或真实账号动作。当前 native Ego 将 marker 写入 stderr，runner 同时解析两个输出通道；所有初轮失败保留，没有据退出码 0 伪造成功。

当前 smoke 验证 API 生命周期与本地内容，不做像素相同或质量评分断言；两侧沿用各自窗口 viewport。正式 Stage A 应显式固定 viewport，并在截图后清理 metrics override。严格实例 guard 还需要同时适配 canonical 脚本的任务选择，不能只改能力探测后继续使用 Wiek CLI 不支持的旧 `--taskspace` 前缀。

## 0.21 完整框架接入

版本化 overlay 位于 [benchmark/sdk-v2](../benchmark/sdk-v2/README.md)，以原始文件 hash、固定 commit、原始任务数据和 Acorn 身份为前置条件。能力探测使用 lexical canonical 入口，严格 guard 解析实际 JavaScript，先于旧 release/任务管理豁免执行；不能用注释、字符串或 finish() 为错误任务放行。它是 harness 语法约束，不是任意 JS 的安全沙箱。

当前 59 项回归（33 新增、26 原框架测试）和 14 项共享控制测试通过；Ego 0.6.2.7/Wiek 0.21.0 的实际 framework registry、Skill 配对、截图/AX hook、1280×800 PNG、视口恢复、结构化清理与缺失幂等均通过。见 [框架结果](../reports/p4-sdk-v2-framework-smoke.json)。测试没有运行 agent 模型循环或 judge；31 项任务数据未改。

最初使用全新 Ego fixture Profile 时触发首次引导，CLI 虽然退出 0 却没有执行脚本。保留各轮失败和直接诊断；最终使用此前已经初始化的 data/ego-reference 专用测试资料，不绕过引导、不访问个人默认资料。截图每次使用随机 marker 与独立临时文件，校验输出 hash、PNG 尺寸和实际 task/Page receipt；未清除 metrics override 则失败。线上公平性仍须另行固定交互 viewport、模型、思考、预算、附件与账户状态。
