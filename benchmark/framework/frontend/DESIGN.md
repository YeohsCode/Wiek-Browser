# WebUI 视觉设计语言 · Pine-ink Lab Console

> 本文是 wiek-benchmark WebUI 前端的**视觉规格**（design language）：约束颜色、字体、间距、组件形态与四屏骨架。它只管 UI 美学，不定义架构与数据契约。

---

## 1. 设计定位

**方向**：Refined Data-App / Pine-ink Lab Console。

取 Linear / Raycast 那类工程师工具的呼吸感与精致卡片，落在「暖纸中性底 + 深墨绿（pine）统治色」上，像一本**评测实验记录本**：明亮、克制、信息密集但一眼可读。

**不做**：白底紫渐变、AI slop、花哨炫技、为装饰牺牲可读性。

**四条原则**：

1. **意图性 > 强度**：克制圆角、柔和层次阴影、语义化状态色，每个微交互都服务可用性。
2. **单一统治色**：pine 墨绿贯穿主操作 / 选中 / 链接 / 进度；其余信息靠中性灰阶分级，不滥用颜色。
3. **状态语义化**：running / done / fail / skip / stopped 各有固定主色与浅底，长任务一眼可读。
4. **数据等宽**：所有 run-id、计数、配置值、表格数字用 JetBrains Mono，保证列对齐。

---

## 2. 色彩 Token

落地时以 `:root` CSS 变量承载（值取自参考稿，未改动）：

```css
:root {
  /* 表面：暖纸中性 + 抬升卡面 */
  --paper:        #f4f2ec;   /* app 底 */
  --paper-2:      #efece4;   /* 凹陷 / 次级底 */
  --card:         #fbfaf6;   /* 抬升卡面 */
  --card-2:       #ffffff;   /* 最高层（输入框 / 模态） */

  /* 发丝线 */
  --line:         #e0ddd2;
  --line-strong:  #c9c5b6;

  /* 墨色文字（近黑、略偏绿） */
  --ink:          #1d2421;   /* 主文字 */
  --ink-2:        #515a54;   /* 次级 */
  --ink-3:        #8c918a;   /* 三级 / 静默 */

  /* 统治强调色：深墨绿 pine */
  --pine:         #145e4b;   /* 主操作 / 选中 / 链接 / 进度 */
  --pine-bright:  #1c7a62;   /* hover */
  --pine-soft:    #e3efe9;   /* 选中底 / 序号方块底 */
  --pine-ghost:   #eef5f1;   /* 行 hover 底 */

  /* 语义状态色（各带 -soft 浅底） */
  --run:   #b4530d;  --run-soft:  #fbe9d9;   /* running，赤陶土-琥珀 */
  --done:  #14654f;  --done-soft: #dcefe6;
  --fail:  #a51f2d;  --fail-soft: #f6e0e0;
  --skip:  #6b6f67;  --skip-soft: #e8e6dd;
  --stop:  #4c4f56;  --stop-soft: #e5e6e9;

  /* 阴影（三档，墨绿调） */
  --shadow-sm: 0 1px 2px rgba(28,36,33,.05), 0 1px 1px rgba(28,36,33,.04);
  --shadow-md: 0 2px 4px rgba(28,36,33,.05), 0 8px 20px -8px rgba(28,36,33,.14);
  --shadow-lg: 0 24px 60px -18px rgba(20,40,33,.30), 0 4px 14px -6px rgba(28,36,33,.16);

  /* 圆角 */
  --r-sm: 6px;  --r: 9px;  --r-lg: 13px;
}
```

**底纹**：`--paper` 之上叠两层——22px 点阵（`radial-gradient(rgba(28,36,33,.045) 1px, transparent 1.4px)`，size `22px 22px`）+ 顶部极淡墨绿辉光（`radial-gradient(circle at 50% -8%, rgba(20,94,75,.06), transparent 45%)`）。选区色 `::selection { background: var(--pine); color: #fff; }`。

---

## 3. 字体

| 角色 | 字体 | 用途 |
| --- | --- | --- |
| display | **Bricolage Grotesque**（400–800，opsz 12–96） | 品牌、页面标题、分区名、模态标题 |
| body | **Hanken Grotesk**（400–700） | 正文、表单标签、说明文字 |
| mono | **JetBrains Mono**（400–700） | run-id、计数、表格、配置 KV、状态徽标、刻度 |

Google Fonts 引入（放 `index.html`）：

```html
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

```css
--mono: "JetBrains Mono", ui-monospace, monospace;
--sans: "Hanken Grotesk", system-ui, sans-serif;
--disp: "Bricolage Grotesque", "Hanken Grotesk", sans-serif;
```

**字号基准**：body 14px / line-height 1.5；页面标题 21px（disp 700，字距 −.02em）；分区标题 14.5px（disp 600）；表单标签 11.5px（600）；mono 计数 11–17px 按层级。**避开 Inter / Roboto / 系统默认。**

---

## 4. 间距 · 圆角 · 阴影

- **圆角**：输入 / 按钮 / 小卡 `--r-sm`(6)；中等容器 `--r`(9)；分区卡 / 模态 `--r-lg`(13)；状态 pill 用 20px 全圆。
- **阴影**：静止卡面 `--shadow-sm`；抬升（summary / prog-hero）`--shadow-md`；模态 `--shadow-lg`。
- **节奏**：分区卡间距 18px；表单 grid 行距 16px、列距 22px；视图内边距 26–30px。

---

## 5. 信息架构

**App Shell**：`grid-template-columns: 232px 1fr`，`max-width: 1440px` 居中。

```
┌──────────┬───────────────────────────────────────────┐
│ 侧栏 232  │ topbar（sticky · 面包屑 + 右侧操作）        │
│          ├───────────────────────────────────────────┤
│ brand    │ view（当前屏内容）                          │
│ nav      │                                            │
│  ·work   │                                            │
│  ·artif  │                                            │
│ foot     │                                            │
└──────────┴───────────────────────────────────────────┘
```

- **侧栏 `.side`**（sticky，渐变纸面）：
  - `brand`：34×34 pine 圆角 mark（内嵌两道浅绿短线 + 右下小环水印）+ `wiek·bench` / `console`。
  - `nav`：分组导航，组标签用 mono 大写小字（字距 .14em）。
    - **workspace**：New run · Runs（右侧 `count` 徽章）· Progress
    - **artifacts**：Compare · Export sessions
    - 选中态 `.on`：`--pine-ghost` 底 + `--pine` 字 + 左缘 `inset 2px 0 0 var(--pine)`；count 徽章转 pine 底白字。
  - `foot`：语言切换（`中文 / EN` 双段按钮）+ `host`（绿色 ping 脉冲点 + `127.0.0.1:8365`）+ 版本行（mono）。侧栏折叠为图标窄栏时只保留一个紧凑语言按钮，点击在 `zh` / `en` 间切换。
- **主列 `.main`**：`topbar`（sticky，`rgba(244,242,236,.78)` + `backdrop-filter: blur(8px)`，面包屑 disp 标题 + mono 副标 + 右侧 ghost 操作）+ `view`（padding 26/30）。

> **与数据契约的衔接**：侧栏的「Progress」是 **run-scoped**，指向当前或选定 run 的轻量进度，不是全局无参数页；实现上等价于从 Runs 某行进入该 run 的进度面板（可沿用 Drawer 容器，内容换成 §6 的仪表）。「Compare / Export sessions」是导出入口，点击弹模态（§6）。

---

## 6. 组件规格

### 语言切换 `.language-switcher`

- 常驻侧栏 footer 顶部，使用 `--paper-2` 底、`--line` 边与 `--r-sm` 圆角，不使用国旗表达语言。
- 展开态为等宽 `中文 / EN` 两段；当前语言使用 `--pine` 底白字，另一段透明底、`--ink-2` 字。按钮文字是语言自称，不随当前 locale 改写。
- 图标窄栏只显示一个 34×34 紧凑按钮，内容显示下一目标语言（当前中文显示 `EN`，当前英文显示 `中`），点击直接切换；tooltip 与 `aria-label` 使用当前 locale。
- 切换仅重绘文案、antd 内置 locale 与日期格式，不触发布局导航、数据请求或表单重置。

### 按钮 `.btn`
- **default**：`--card-2` 底 + `--line-strong` 边 + `--shadow-sm`；hover 上移 1px、边色加深、阴影转 md。
- **primary**：`--pine` 底白字 + 墨绿投影；hover 转 `--pine-bright`。
- **ghost**：透明，hover `--paper-2` 底。
- **danger**：红字红边，hover `--fail-soft` 底。
- 尺寸 `.sm`（padding 5/10，11.5px）；`:disabled` opacity .45。

### 状态徽标 `.pill`
圆角 20px，mono 10.5px/600，小写，左侧 6px `dot`。六态：

| 态 | 主色 / 底 | dot |
| --- | --- | --- |
| running | `--run` / `--run-soft` | blink 1.1s 闪烁 |
| done | `--done` / `--done-soft` | 实心 |
| error / fail | `--fail` / `--fail-soft` | 实心 |
| skip | `--skip` / `--skip-soft` | 实心 |
| stopped | `--stop` / `--stop-soft` | 实心 |
| queued | `--ink-3` / `--paper-2`（带边） | 实心 |

### 分区卡 `.section`
`--card` 底 + `--line` 边 + `--r-lg`。`header`：序号方块 `.idx`（22×22、`--r-sm`、`--pine-soft` 底 `--pine` 字、mono 700）+ disp 标题 + 右侧 mono `hint`。`body` padding 18/20。

### 表单控件
- `.field`：垂直 label + 控件 + 可选 `.desc`（11px 静默）；label 右可挂 `.opt`（mono 9.5px 注释，如「multi-select · blank → all」）。
- `.inp / .sel / .ta`：`--line-strong` 边、`--card-2` 底、`--r-sm`；**focus → `--pine` 边 + `0 0 0 3px rgba(20,94,75,.13)` 光晕**。`.mono` 变体用于数值 / id。`.ta` 默认 mono、min-height 96。`.sel` 自带 SVG 箭头。
- **分段控件 `.seg`**（thinking / guard mode 等枚举）：整行等分按钮，选中段 `--pine` 底白字，mono。
- **开关 `.switch`**：38×22，checked → track `--pine`、圆钮右移。置灰行 `.togrow.disabled`（opacity .5 + `pointer-events:none`），随测模式下 Auto judge 用它 + `.forced` mono 小字标注强制关闭。
- **benchmark 分桶 `.meta-row`**：`--pine-ghost` 底，左侧大号 mono task 总数（`30 tasks`）+ 竖分隔 + `.cat` chips（`navigation 12` / `forms 8` / `search 10`，数字 pine）。

### 模式切换 `.modeswitch`
胶囊分段（`--paper-2` 底 + 内 4px padding），`[1] Dataset` / `[2] Ad-hoc`，选中段抬为 `--card-2` 白卡 + 阴影，方括号键提示 mono pine。

### 右侧概览 `.summary`（New Run rail）
sticky（top 92），`--shadow-md`。header（disp 小标题 + 说明）+ `kv` 行（k 静默 / v mono，强调值 `.acc` pine）+ footer（整宽 primary「Start run」+ `est` mono 预估）。

### 运行表格 `table.runs`
- thead：mono 10px 大写、字距 .1em、`--paper-2` 底。
- tbody 行：hover `--pine-ghost`；选中 `.sel` → `--pine-soft` 底 + 左缘 `inset 3px 0 0 var(--pine)`。
- 列件：`.rid`（mono 主行 + 静默副行）/ `.toolchip`（browser tool，带色块）/ `.donefail`（`12 / 1 of 30` mono + 多段 `.bar`：done 绿、fail 红、skip 半透）/ `.checkbox`（选中 pine + 白勾）/ `.rowacts`（28×28 `.iconbtn`，stop hover 转红）。
- **来源徽标 `.origin-chip`**：仅对 CLI 起的 run 显示（紫灰 `#ece7f4` 底 / `#5a4a86` 字），形制同 `.derived-chip`。控制台启动是默认情况，不加徽标——只标「外来的」。
- **阶段芯片 `.stage-chip`**：运行中的行在状态 pill 下方追加一行 mono 9.5px，`i` 为 14×14 方形字母块——`A` 用 `--run-soft`/`--run`（跑任务中，占用队列）、`B` 用 `--pine-soft`/`--pine`（判分中，已让出队列）。它回答的是「它还在跑，为什么下一个已经开始了」。

### 串行队列（Runs 表内联组）

队列是 Runs 表**顶部的一个分组**，不是独立页面——排队 run 依然是 run，只是尚未开始。队列为空且未暂停时整组消失，表回到原样。

- **色彩**：队列专用 slate 蓝 `--queue: #4d5a8a` / `--queue-soft: #e5e8f4`，刻意落在 run（赤陶）与 judge（pine）色系之外——排队 run 没有执行过，不该读作任何 run 状态。
- **分组行 `tr.qgroup`**：`--queue-soft` 底，整行 `colSpan`。内容 = `.qgroup-title`（mono 10px 大写 `队列 · N 个等待`，pine 换 `--queue`）+ `.qgroup-why`（11px 规则说明）+ 右对齐 `.qgroup-act`（暂停/恢复队列）。**队列为空但已暂停时该行仍在**，否则暂停态会藏掉自己的恢复入口。
- **队列行 `tr.qrow`**：`rgba(229,232,244,.32)` 底（hover 加深），`.rid` 转 `--ink-2`/500 字重以与已执行的 run 拉开层次。首列是 `.qpos`——22×22 `--queue` 实底白字 mono 位次徽标（取代复选框：排队 run 不参与批量导出）。
- **状态 pill**：`.pill.queued.qpill`（`--queue-soft` 底 + `--queue` 字）。**注意** `.pill.queued` 单独使用时仍是灰色——它在 Progress / Judge 里表示「等待中的 task」，是另一个维度，不共用队列色。
- **行内操作 `.rowacts`**：插到队首（`position !== 1` 才显示）/ 立即启动 / 复用配置 / 取消排队（`.iconbtn.del`，✕ 而非垃圾桶——没有产物可删）。
- **New run rail `.enq-banner`**：通道被占用时出现在 summary header 下方，`--queue-soft` 底 + `#ccd2e8` 边，说明本次将排在第几位；同时主按钮文案从 `Start run` 换成 `入队（第 N 位）`。

### Progress 仪表（signature 屏）
`prog-layout = 320px 侧 + 1fr 主`。

- **`.prog-hero`**：
  - **环形 `.ring`**：108px SVG（`rotate(-90deg)` 起点顶部），done 实弧 + fail 叠加弧；中心 mono 24px 大号百分比 + 大写 label。右侧 `.ring-legend`（色块 + 文案 + mono 数值）。
  - **五宫格 `.counts`**：`total / done / fail / skip / active`，1px 缝隙拼接，各取对应语义色（active 用 `--run`）。
  - **线性条 `.linbar`**：done / fail / skip 实段 + **active 段 45° 斜纹滚动动画**（`repeating-linear-gradient` + `stripe` keyframes），表「正在跑」。
- **`.prog-config`**：该 run 的 config KV（mono）。
- **`.prog-main`**：task 列表。header 含 `.filtertabs`（all / running / done…，选中抬白卡）。`.trow` 为 `22px 1fr 96px 64px 100px` 网格：序号 / `tid`（mono + 静默副行）/ 状态 pill / `slot` 槽位号（运行中 pine、空闲 muted）/ `.openlink`（已导出 →「open →」pine；未导出 `.muted` 不可点）。列表区 `max-height: 560px` 滚动，自定义滚动条。

### 模态 `.modal`
overlay：`rgba(26,33,30,.42)` + `blur(3px)`，pop 弹入。modal：header（36×36 pine-soft 图标 `mi` + disp 标题 + 说明 + 右上 ghost ×）+ `mbody` + footer（`--paper-2` 底、右对齐按钮）。
**Compare 专属**：`.testrow`（pine 边 + `TEST` 标签 + 选中 run）+ `.baselbl` + `.baselist`（可选 `.baseitem`，选中 `.on` pine 边）+ `.download-note`（`--done-soft` 底 + `~/Downloads` 路径 code）。

### Toast
右下角，`--ink` 深底浅字，pine 勾图标，`code` 显产物路径，`tin` 弹入。

---

## 7. 四屏视觉骨架

1. **New Run**：`modeswitch` → `formwrap`（左 `forms` + 右 296 `summary` rail）。
   - 左列分区：`01 Dataset`（benchmark + meta-row 分桶 / task_ids）· `02 Run`（browser tool / guard `.seg` / concurrency / iterations / retry / Auto judge·Auto export `.togrow`）· `03 Provider`（provider / model / thinking `.seg` / tool profile `.seg`）· `04 Limits & Judge`（timeout / judge model / concurrency / max screenshots）。
   - **随测模式**：`01` 换成单 `.ta` task 文本域；Auto judge 行 `.disabled` + `.forced`「forced off」。
2. **Runs**：`toolbar`（Refresh / Export sessions / Report / Compare + 右侧 `selnote` 选中计数）+ `tablecard`。
3. **Progress**：左 `prog-side`（hero 环 + counts + linbar + config）+ 右 `prog-main`（task 列表）。
4. **Compare / Export**：`.modal` 对话框（test = 已选 + baseline 多选 + 下载路径提示 → Toast）。

---

## 8. 动效

- 屏切换 `fade`（.35s）；分区 staggered `rise`（`animation-delay` 递增 .02→.06…）。
- 持续微动：running dot `blink`、host `ping` 脉冲、active linbar `stripe` 斜纹滚动。
- 按钮 hover 上移 1px + 阴影；克制，聚焦载入与状态时刻。

> **实现注意**：`blink` / `ping` / `stripe` 这类持续动画会让无头浏览器的 `Page.captureScreenshot` 等不到稳定帧而超时（本次出稿截图即遇到）。建议挂一个 `prefers-reduced-motion` 分支或截图开关（注入 `*{animation:none!important}`），方便自动化 / 回归截图。

---

## 9. 落地映射（技术栈）

遵循全局前端约定（Swiss International Style + antd / shadcn 分工）：

- **CSS 变量先行**：把 §2 token 落成 `:root` 变量 + Tailwind `theme.extend`（颜色 / 圆角 / 阴影），状态色映射到语义类，全站复用。
- **antd**（复杂多字段表单：Provider / Judge / 采样）：用 antd `Form`；`ConfigProvider` theme token 对齐——`colorPrimary: #145e4b`、`borderRadius: 6`、`fontFamily` 指向 Hanken / JetBrains Mono；`Select / Input / Switch / Segmented` 靠 token + 少量 className 收敛到本规格（focus 光晕、pine 选中段）。
- **shadcn**（轻量交互：运行卡片、状态 pill、导出 Modal、Toast）：主题色对齐 pine，圆角 / 阴影用本文档变量。
- **字体**：`index.html` 引 Google Fonts；`--sans` = Hanken（body）、`--disp` = Bricolage（标题）、`--mono` = JetBrains Mono（数据）。
- **与 Swiss 的关系**：本方向是 Swiss International Style 的**暖色化、数据应用化演绎**——保留强网格、克制、功能优先，把中性灰底换成暖纸、信号色定为 pine。

---

## 10. 与现有实现的差异（迁移提示）

当前 `frontend/`（`App.tsx` / `ConfigForm.tsx` / `RunsPanel.tsx`）：顶部 antd `Segmented`「New run / Runs」两 tab + antd 默认外观 + Inter 字体，朴素。目标差异（**均为 UI 形态升级，不改现有路由、进度字段与导出端点契约**）：

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 导航 | 顶部 `Segmented` 两 tab | 左侧持久侧栏（workspace + artifacts 分组） |
| 字体 | Inter | Bricolage / Hanken / JetBrains Mono |
| 主题 | antd 默认 | pine + 暖纸 token 化（`ConfigProvider` theme） |
| Progress | antd `Drawer` + `Progress` 条 | 320+1fr 仪表（环形 + 五宫格 + 斜纹条 + task 列表），可沿用 Drawer 容器 |
| 导出 | 工具栏按钮 + Modal | 侧栏 artifacts 入口 + 本规格 Modal / Toast |
