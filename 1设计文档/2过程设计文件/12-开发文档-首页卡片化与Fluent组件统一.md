# 12 - 开发文档：首页功能入口卡片化 + 组件风格统一迁移 Fluent UI（D-15）

> 版本：v1.0　|　日期：2026-11-02　|　状态：待实施
> 关联：D-15（本次登记）、D-06（CodingPlace 组件不存在）、D-07（模板残留）、D-09（.btn-primary 污染）、D-05（备案链接，仅引用）、《14-界面与交互设计》
> 台账：新增 **D-15**（已登记进《07》§10.1），编号承接 D-14

---

## 1. 背景与现状盘点

### 1.1 组件体系混用清单（"两套观感"的具体来源）

| 页面/区域 | 现状 | 观感体系 |
|---|---|---|
| NavMenu | Bootstrap navbar + `navbar-toggler` + open-iconic 图标 | Bootstrap |
| MainLayout 顶栏 | `top-row px-4` + "About" 外链（D-07 模板残留） | Bootstrap |
| Index 首页 | 仅 `<h1>欢迎` + `<h2>你好！` + fixed 页脚，**无任何功能入口** | 无 |
| Counter 木鱼 | FluentButton / FluentIcon ✔ | Fluent |
| LoveTime | FluentSelect / FluentButton / FluentStack ✔ | Fluent |
| Tetris | 全部原生 `<button class="game-btn">`（暂停/继续/重开/旋转/方向），深色自定义配色 | 自定义 |
| Game_2048 | 全部原生 `<button>`（方向 + 重玩） | 自定义 |
| CodingPlace | `FluentPage`/`FluentPageHeader` 等**在 FluentUI 3.8.0 中不存在**（RZ10012，D-06），渲染退化 | 损坏 |

基础设施已就绪：`Program.cs` 已 `AddFluentUIComponents()`，包 3.8.0（含 Icons）。问题不是"没装"，是**只用了零散几处**，且导航/首页/游戏页三套观感并存。

### 1.2 一个必须先说清的技术约束

**FluentUI 3.x 没有官方深色主题**（dark theme 是 4.x 的能力）。Tetris/2048 是黑底游戏页，若直接迁移 FluentButton，其默认浅色 Accent 会与黑底冲突。因此本文档的统一策略是：**结构统一用 Fluent 组件（获得一致的 hover/active/disabled/焦点行为），游戏页配色通过 `Style`/`Class` 覆盖保留现有深色语义**（暂停蓝 #0078D4 / 继续绿 #107C10 / 重开红 #D83B01 / 方向深蓝 #106EBE）。"观感统一"统一的是**交互质感与控件语言**，不是把游戏页刷成白色。

## 2. 目标与非目标

**目标**

1. 首页充实为功能入口页：卡片化展示 4 个功能 + 站点介绍卡，点击直达；
2. 页面级控件全量 Fluent：Tetris、Game_2048 的原生按钮迁移 FluentButton；CodingPlace 的失效组件（D-06）用 3.8.0 实际存在的组件重写；
3. 导航迁移：NavMenu → FluentNavMenu + Fluent Icons（替代 Bootstrap navbar + open-iconic）；
4. 顺带清理：MainLayout 的 "About" 外链（D-07 一部分）、首页 fixed 页脚遮挡问题、首页 PageTitle；
5. e2e 套件同步适配，全部既有 spec 保持全绿。

**非目标（明确不做，防止范围失控）**

- **不迁移 MainLayout → FluentLayout**：整体布局骨架重构（header/抽屉/主题注入）改动面覆盖全站，风险与收益不成比例，另立文档；
- **不移除 Bootstrap 引用**：布局骨架仍依赖 `top-row/px-4/navbar` 等类；open-iconic 视任务 B2 完成情况移除（见 §5）；
- 不改任何游戏逻辑、不换深色游戏页主题；
- 不处理 D-05 备案链接指向（保持现状文案，仅在首页页脚重构时保留原链接，D-05 继续开放）。

## 3. 任务 A：首页卡片化设计

### 3.1 信息架构

```
Index.razor
├─ <PageTitle>夜游桃花源</PageTitle>        ← 替换 "jtjsym"
├─ header：欢迎语（保留）+ 一句副标题
├─ main：入口卡片区（CSS Grid，auto-fill 自适应）
│   ├─ 卡片1 站点简介（非链接卡）：站点定位一句话
│   ├─ 卡片2 按下试试 → /counter      （电子木鱼）
│   ├─ 卡片3 爱情计时器 → /loveTime
│   ├─ 卡片4 2048 → /game_2048
│   └─ 卡片5 俄罗斯方块 → /tetris
└─ footer（文档流内，不再 fixed）
    └─ 备案链接（文案/URL 不动，D-05 保持开放）
```

- CodingPlace 不进卡片（导航中本就注释隐藏）；
- 卡片用 **FluentCard** 包裹 + FluentIcon（`Icons.Regular.Size32.*`，选型：木鱼→`Food_Apple`? 实施时从 Icons 包选定，文档给建议不锁死）+ 标题 + 一句话描述；整卡可点（`NavLink` 或 `NavigationManager`，实施时取更简者）；
- 布局：`repeat(auto-fill, minmax(200px, 1fr))`，移动端自动单列；hover 上浮 2px + 边框高亮，风格与《14-界面与交互设计》现状规范对齐；
- **页脚修正**：删除 `position: fixed`（会遮挡内容），改为文档流内居中条——该问题此前未登记，随本次一并消除，不单开缺陷号。

## 4. 任务 B：Fluent 统一策略（分层）

| 层 | 范围 | 本次 |
|---|---|---|
| L1 控件层 | 页面内按钮/输入/卡片 | **✔ 全部迁移** |
| L2 导航层 | NavMenu | **✔ 迁移**（FluentNavMenu 可脱离 FluentLayout 独立使用，实施时先在 sidebar 深色背景验证样式） |
| L3 布局层 | MainLayout → FluentLayout | ✘ 不做（§2） |

### 4.1 NavMenu → FluentNavMenu（B2）

- `FluentNavMenu` + `FluentNavLink`，`Collapsible="true"` 保留现有移动端折叠行为；`Title` 用站点名；
- 图标：open-iconic `oi-home/pulse/heart/play-circle/code` → Fluent Icons 对应项（Home/Pulse/Heart/Gamepad/Code，实施时按 Icons 包实际名称选定）；
- 折叠状态由组件自带 `Expanded` 管理，替换手写 `collapseNavMenu`——若与 sidebar 宽度动画（site.css `.sidebar`）不兼容，降级保留手写折叠、仅替换菜单项渲染，**以 e2e nav spec 全绿为准**；
- 迁移后 open-iconic 全站无引用 → 从 `_Layout.cshtml` 移除其 css 引用（bootstrap 保留）。

### 4.2 游戏页按钮迁移（B3/B4）

**Tetris.razor**（6 枚按钮）与 **Game_2048.razor**（5 枚按钮）：

- 原生 `<button class="game-btn ...">` → `<FluentButton Class="game-btn ..." Appearance="Appearance.Accent" Style="background-color:...">`；
- **类名保留**（`game-btn/control-btn/rotate-btn/direction-btn` 等不换名）——这是关键决策：D-14 的 ≤520px Grid 布局、L4 缩档 CSS 全部锚定这些类，保留类名则移动端布局零回归；
- shadow DOM 说明：`width/height/flex/border-radius` 等作用在 `fluent-button` 宿主元素上有效；`:hover` 的 `filter/transform` 同样作用于宿主。实施时逐按钮核对视觉效果；
- **↓ 软降按钮的特殊验证点**：`@onpointerdown/@onpointerup/...` 四个事件在 FluentButton 组件上写法为直接挂在组件标签（Blazor 会落到根 DOM 元素）。实施第一步先单独验证软降按住/松开仍工作；若事件被组件内部吞掉，**该按钮回退保留原生**并在 §6 豁免清单登记——不允许为它改组件源码；
- disabled 绑定（`disabled="@isGameOver..."`）→ FluentButton 的 `Disabled` 参数，注意改参数名。

### 4.3 CodingPlace 重写（B5，顺带关 D-06）

- 删除 `FluentPage/FluentPageHeader/FluentTextBlock` 等不存在组件（RZ10012 ×3），用 `FluentCard` + `FluentButton` + 普通标记重写"任务混部"静态展示；顺带清理 `InputExample/OutputExample` 未使用字段（D-10 一部分？D-10 指向同一页面同一字段，**若本次删除则 D-10 一并关闭**）；
- 该页仍在导航隐藏状态，仅消除构建噪音与渲染退化，不扩充功能。

### 4.4 MainLayout 清理（B6，顺带 D-07 部分）

- 删除 `top-row` 内 "About" 外链行（模板残留）；顶栏保留但内容换为站点名或留空（最小改动：整行删除，`article` 上移，site.css 相应微调）；
- MainLayout 第 3 行 `<PageTitle>jtjsym</PageTitle>` 保留（C-03 方案的兜底标题），首页有自己的 PageTitle 覆盖。

## 5. 改动清单

| # | 文件 | 改动 | 对应任务 |
|---|---|---|---|
| 1 | `Pages/Index.razor` | 重写：卡片网格 + 文档流页脚 + PageTitle | A |
| 2 | `Shared/NavMenu.razor` | FluentNavMenu 迁移 + Fluent Icons | B2 |
| 3 | `Pages/_Layout.cshtml` | 移除 open-iconic css 引用 | B2 |
| 4 | `Pages/MyPage/Tetris.razor` | 6 枚按钮 → FluentButton（类名/配色保留，软降事件先验证） | B3 |
| 5 | `Pages/MyPage/Game_2048.razor` | 5 枚按钮 → FluentButton | B4 |
| 6 | `Pages/MyPage/CodingPlace.razor` | 失效组件重写 + 删未用字段 | B5 |
| 7 | `Shared/MainLayout.razor` | 删 About 外链行 | B6 |
| 8 | `wwwroot/css/site.css` | 卡片网格样式；核对 game-btn 覆盖在宿主元素上的生效情况 | A/B3 |
| 9 | `tools/e2e/tests/nav.spec.mjs` | 断言适配卡片导航（若 nav spec 有依赖 navbar 选择器的断言） | 测试 |
| 10 | `tools/e2e/tests/d15_home_fluent.spec.mjs` | 新增（§7.1） | 测试 |
| 11 | `tools/e2e/tests/{g2048,tris}.spec.mjs` + `helpers.mjs` | 按钮选择器适配（§7.2） | 测试 |
| 12 | 《07》台账 | 登记 D-15（已随本文档完成）；实施后关 D-06/D-10、D-07 部分关闭、D-14 复核 | 流程 |

**明确不动**：`Program.cs`、`_Imports.razor`、MainLayout 骨架结构、Counter/LoveTime（已 Fluent）、全部 `@code` 游戏逻辑、site.css 中与布局相关的 bootstrap 依赖。

## 6. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| FluentButton 内部结构吞掉 pointer 事件（软降） | ↓ 长按软降失效 | §4.2 首项验证；不通过则该按钮保留原生并登记豁免 |
| FluentNavMenu 独立使用时样式与 sidebar 深色背景不协调 | 导航观感劣化 | 降级方案：保留 Bootstrap 骨架仅换菜单项渲染；最差回退整个文件（git 还原） |
| shadow DOM 导致 `:hover`/尺寸 CSS 部分失效 | 游戏按钮手感变化 | 宿主元素级属性（尺寸/flex）有效；`filter/transform` 实测；失效项移到 `::deep` 等效或保留在宿主可作用范围 |
| e2e 选择器批量失效（`button` 标签 → `fluent-button`） | 既有 spec 假失败 | 统一改用 Playwright **text/role 引擎**（`getByRole('button', { name: '暂停游戏' })`），一次适配全绿后不再依赖标签名 |
| FluentUI 3.8 无 dark theme | 游戏页配色需手工覆盖 | 已在 §1.2 定为策略而非缺陷；覆盖集中在一个 css 块内便于后续 4.x 升级时替换 |

**回退**：按文件粒度 git 还原；任务 A/B 相互独立可单独回退。

## 7. 测试计划

### 7.1 新增 `d15_home_fluent.spec.mjs`

| # | 断言 |
|---|---|
| 1 | 首页含 5 张卡片，标题文案与目标路由一一对应 |
| 2 | 点击"俄罗斯方块"卡片 → URL 变为 `/tetris`（其余卡片抽测 1 个） |
| 3 | 首页 PageTitle 为"夜游桃花源" |
| 4 | 备案链接存在于文档流（非 fixed：其 boundingBox.y + 文档滚动位置 > 视口外或随内容，取"不与卡片区重叠"判定） |
| 5 | 375×667：首页无横向溢出，卡片纵向单列堆叠 |
| 6 | NavMenu：`/tetris` 页面可见导航项含"俄罗斯方块"文本（不依赖标签名）；375×667 下折叠按钮存在且点击后菜单可见 |

### 7.2 既有套件适配（必做，作为迁移的回归门禁）

- `helpers.mjs`：`readScore/readTetris` 等若含 `button` 标签选择器 → 改 role/text 引擎；
- `g2048.spec / tris.spec / d02_keyboard_ui.spec / d11_d12.spec / d14_mobile_layout.spec`：全量重跑，**全绿是关闭 D-15 的前置条件**；其中 d14 spec 的按钮 boundingBox 断言天然验证"类名保留"决策；
- D-14 复核：FluentButton 迁移后 `flex:1/height:52px` 等仍生效（若失效，按 §6 第三行处理）。

### 7.3 手工清单

1. 桌面 1280px：首页卡片 hover 效果、四功能卡跳转全部正确；
2. 游戏页逐按钮核对配色与 disabled 态（游戏结束/暂停时）与迁移前一致；
3. Tetris 按住 ↓ 软降（**软降事件验证点**）、按住 ← 连发；
4. 移动端 375px：折叠菜单开合、首页单列、tetris 右栏布局不回归；
5. `/coding_place` 直达访问：无 RZ10012（浏览器控制台无未知元素警告），内容正常展示；
6. 真机抽查：卡片点击跳转、游戏按钮触控。

### 7.4 实施后流程（按 09 固化约定）

build → `test:nav + test:g2048 + test:tris + test:lt + test:d02 + test:d11_d12 + test:d14 + test:d15 + test:smoke` 全绿 → 执行记录登记 → 台账关 D-15/D-06/D-10、D-07 部分关闭、D-14 复核关闭 → 最后更新《现状》（v1.6 → v1.7：模块一览、待改进项删 4-1/4-3 相关条目）与《更新记录》。

## 8. 后续可选项

- MainLayout → FluentLayout 整体重构（含 FluentLayout 头部/主题/抽屉）；
- FluentUI 升级 4.x 后启用官方 dark theme，替换游戏页手工配色覆盖；
- 首页卡片增加"上次游玩分数"（需引入持久化，联动未来可能的存储设计）；
- open-iconic / bootstrap 包引用彻底移除（待布局层重构后评估）。
