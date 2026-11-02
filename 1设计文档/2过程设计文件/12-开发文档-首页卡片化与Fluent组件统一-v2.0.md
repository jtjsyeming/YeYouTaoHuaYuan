# 12 - 开发文档：首页功能入口卡片化 + 组件风格统一迁移 Fluent UI（D-15）（v2.0）

> 版本：v2.0（检视修订版）　|　日期：2026-11-02　|　状态：待实施
> 修订对象：`12-开发文档-首页卡片化与Fluent组件统一.md`（v1.0 保留作对照，未删）
> 代码基线：`6dae092`（工作区另有未提交的文档改动，代码干净）
> 依据：《测试文档-全量测试用例.md》§10.1 **D-15 / D-06 / D-07 / D-09 / D-10 / D-14**；《03-界面与交互设计.md》§3.4/§5；《夜游桃花源网站技术栈与代码结构现状.md》v1.8 §4
> **本次检视方式**：① 逐行读 `Index/NavMenu/MainLayout/_Layout/CodingPlace/Tetris/Game_2048/site.css`；② 反射 + XML 文档核对 FluentUI 3.8.0 实际 API；③ 启动 `localhost:14074`（`--no-launch-profile --environment Development`），用 Playwright **向真实 DOM 注入 `fluent-button` / `fluent-card` 并测量**，再逐档截图取几何值。

---

## 0. 检视结论（先看这一节）

v1.0 的**问题诊断与任务分层是对的**（§1.1 的组件混用清单逐条与代码一致，§2 的非目标划得也合理）。但按 v1.0 原样实施，会遇到 **3 处会当场卡住的错误** 和 **6 处会让"全绿门禁"落空的事实偏差**：

| # | 级别 | v1.0 的说法 | 实测 / 核对结果 |
|---|---|---|---|
| 1 | **阻塞** | 改动清单 #3：`Pages/_Layout.cshtml` 移除 open-iconic 的 css 引用 | `_Layout.cshtml` **只有 bootstrap / site.css / jtjsym.styles.css 三个 `<link>`**，没有 open-iconic。真正的引用是 **`wwwroot/css/site.css:1` 的 `@import url('open-iconic/...')`**。照 v1.0 改会"找不到要删的行"，而 open-iconic 依然全站加载 |
| 2 | **阻塞** | 迁移后既有 spec 全绿，只需"若 nav spec 有依赖 navbar 的选择器则适配" | 实测 **8 类断言会红**：NAV-01（**两个** spec）、NAV-02、NAV-03、NAV-04、NAV-07、NAV-10、`.controls button:has-text`（**5 处**）、`button:has-text("重玩")`（**2 处**）。详见 §7.2 |
| 3 | **阻塞** | 软降按钮"若事件被组件吞掉则回退原生" | 该风险**已被现网证伪**：`Counter.razor` 的 `<FluentButton @onclick=... @onmouseout=...>` 一直工作正常 → 事件处理器会随 AdditionalAttributes 落到宿主元素。真正的坑不在事件，而在 **`:disabled` 伪类不匹配自定义元素**（见 #4） |
| 4 | **必改** | 保留类名即"移动端布局零回归" | 类名在，但 **`:disabled` 伪类对 `fluent-button` 永不匹配**（它不是表单元素）→ `.game-btn:disabled{opacity:.5}` 失效、FAST 内部 `.control` 自带 `opacity:.3`（实测）→ 禁用态由 0.5 变 0.3；同时 `.game-btn:hover:not(:disabled)` 的 `:not()` 恒真 → **禁用按钮仍会 hover 放大**。必须全部改成 `[disabled]` 属性选择器 |
| 5 | **必改** | "宿主元素级属性有效，`filter/transform` 实测" | 方向对，但**漏了唯一有效的正解**：`fluent-button` 暴露 `part="control"`，实测 `fluent-button::part(control){background-color:…}` 生效。只改宿主的话，内部 `<button class="control">` 的 `padding:0 10px`、`border:1px solid transparent` 仍在 → 40px 宽的方向键内宽只剩 20px |
| 6 | **必改** | 页脚问题 = "`position:fixed` 会遮挡内容，随本次消除" | 实测**当前并不遮挡**（`sh == ch == 667`，内容只到 y=144）。真实缺陷是**横向越界**：`fixed` + `width:100%`（= 视口宽）+ `left:auto`（静态位置 = `article` 左内边距）→ 375px 下 `footer` 占 `left=24 ~ right=399`（右溢 24px）、1280px 下 `left=282 ~ right=1562`（右溢 **282px**），黑条左端从侧栏右侧才开始、右端被裁。负向/固定定位溢出**不产生滚动条**，所以一直没人发现 |
| 7 | 建议 | 2048 有 5 枚按钮 | 标记里是 **6 个 `<button>`**：常态可见 5 枚 + `.game-over` 遮罩内 1 枚"重玩"。且 **2048 的按钮一个类名都没有**，全靠 `site.css:107` 的全局 `button{padding:10px;font-size:18px}` —— 迁移后这条规则不再命中，视觉直接变样 |
| 8 | 建议 | 引用 `tools/e2e/tests/nav.spec.mjs`、`test:d11_d12`、`test:d15`、《14-界面与交互设计》 | 实际是 **`nav_fish.spec.mjs`**、**`test:d11d12`**、**`test:d15` 尚未注册**、**《03-界面与交互设计.md》**（"14" 不存在） |
| 9 | 建议 | 《现状》v1.6 → v1.7 | 当前已是 **v1.8** → 应为 v1.9 |
| 10 | 建议 | 台账"实施后 … D-14 复核关闭" | 台账 §10.1 里 **D-02 与 D-14 仍标"开放"**，但《现状》§4 已记录两者于 11-01/11-02 落地 → 本次应**顺带把这两条移入 §10.2**，不是"复核" |

> **一句话**：任务划分保留，实施细节大面积重写。下面 §2 只列"改了什么、为什么"，§3~§4 是可直接照着做的方案。

---

## 1. 基线（实测，2026-11-02 08:1x）

### 1.1 工程与环境

| 项 | 值 |
|---|---|
| 最新提交 | `6dae092 手机网页端显示问题修改`（D-14 落地） |
| 工作区 | 仅文档改动：`07-测试文档-全量测试用例-v2.0.md` 被删除并改名为 `1代码结构与更新记录/测试文档-全量测试用例.md`；`12-…v1.0` 未跟踪 |
| 构建基线 | `dotnet build --no-incremental` → **5 warning / 0 error**，全部在 `CodingPlace.razor`：`RZ10012` ×3（L8/L9/L10）、`CS0414` ×2（L111 `InputExample`、L116 `OutputExample`） |
| 运行方式 | `dotnet run --project jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074`（**必须 `--no-launch-profile`**，`launchSettings.json` 的 https:14073 无证书必失败） |
| e2e | `tools/e2e/tests/` 10 个文件：`nav_fish / lt / g2048 / tris / code_nf / d02_keyboard_ui / d11_d12 / d14_mobile_layout / smoke` + `helpers.mjs`；`package.json` 有 `test:nav|fish|lt|g2048|tris|code|nf|d11d12|d02|d14|fast|all|smoke`，**没有 `test:d15`、也没有 `test:d11_d12`** |

### 1.2 首页现状（本次要改的对象）

```
/h1  "欢迎来到夜游桃花源"      y=73.6  (375×667)
h2   "你好！"                y=114.7
footer > div  position=fixed  left=24  right=399  width=375   ← 右溢 24px
```

| 视口 | `footer>div` left | right | 视口宽 | 右溢 |
|---|---|---|---|---|
| 375×667 | 24 | 399 | 375 | **+24px** |
| 1280×900 | 282 | 1562 | 1280 | **+282px** |

`document.scrollWidth` 仍是 375 / 1280 —— 固定定位元素不产生滚动区，所以这个缺陷既不会被"无横向滚动"的断言发现，也不会出现滚动条，只是**黑条明显偏右且右侧被截**。

### 1.3 FluentUI 3.8.0 实测能力矩阵（注入真实元素后测量）

**`fluent-button`**（注入 `class="game-btn control-btn" style="background-color:#0078D4;width:112px;height:38px;border-radius:6px"`）：

| 观察点 | 结果 |
|---|---|
| 宿主 | `FLUENT-BUTTON`，`display: inline-flex`，112×38（**宽高/圆角/背景色在宿主上完全生效**） |
| Shadow | 有。内部为 `<button class="control icon-only" part="control" type="button">` |
| 内部按钮盒子 | **112×38**（撑满宿主），`background: rgba(0,0,0,0)`，`color` 继承宿主（`rgb(255,255,255)`） |
| 内部默认样式 | `padding: 0 10px`、`border: 1px solid transparent`、`border-radius: 6px` |
| hover | `.game-btn:hover{transform:scale(1.05)}` **在宿主上生效**（112→117.6） |
| `::part(control)` | **生效**：设 `background-color:#106EBE` 后内部按钮实测 `rgb(16,110,190)` |
| `disabled` | 宿主带 `disabled` 属性 → 内部 `button.disabled === true`，内部 `opacity: 0.3`（FAST 自带） |
| 设计令牌 | `--accent-fill-rest: #036ac4`、`--neutral-fill-rest: #ffffff`（**存在**，Accent 外观可用） |

**`fluent-card`**：`display: block`、`background:#fff`、`border-radius:8px`、`border:1px #f3f3f3`、`box-shadow: 0 0 2px rgba(0,0,0,.12), 0 2px 4px rgba(0,0,0,.14)`、`color:#212121`。组件另有 `Width`/`Height`（"Must be a valid CSS measurement"）与 `AreaRestricted`。

**样式表实际加载**（`document.styleSheets`）：

```
/css/bootstrap/bootstrap.min.css
/css/site.css
/jtjsym.styles.css          ← 首行是 @import '_content/Microsoft.Fast.Components.FluentUI/…bundle.scp.css'
/_content/Microsoft.Fast.Components.FluentUI/css/Microsoft.Fast.Components.FluentUI.css
```

→ **Fluent 的 scoped CSS（含 `.fluent-nav-*` 规则）是加载了的**，所以 `FluentNavMenu` 不会"裸奔"；但它**依赖 `_Layout.cshtml` 里 `jtjsym.styles.css` 这一行**，任何改动都不要动它。

### 1.4 组件存在性（反射核对，非猜测）

| 类型 | 3.8.0 | 说明 |
|---|---|---|
| `FluentCard` | ✅ | 参数 `Width/Height/AreaRestricted/ChildContent` |
| `FluentNavMenu` | ✅ | 参数 `Title/Width(pixels)/Collapsible/Collapsible/Expanded/ExpandedChanged/Margin/ExpanderContent/CollapsedChildNavigation/NavigationManager` |
| `FluentNavLink` | ✅ | 基类 `FluentNavBase`：`Href/Target/Icon/IconColor/CustomColor/Disabled/ActiveClass/Match/Tooltip/OnClick/ForceLoad`；**`Match` 默认 `Prefix`** |
| `FluentButton` | ✅ | `Appearance/Disabled/BackgroundColor/Color/IconStart/IconEnd/Type/…`，其中 **`BackgroundColor`/`Color` 会覆盖 `Appearance`** |
| `FluentLayout / FluentHeader / FluentStack` | ✅ | 本次不用（§2 非目标） |
| `FluentPage / FluentPageHeader / FluentTextBlock / FluentSection / FluentCodeBlock` | ❌ | 与 D-06 一致，`RZ10012` 来源 |

### 1.5 两个页面按钮的当前形态（375×667 实测）

| 页 | 数量 | 类名 | 尺寸 |
|---|---|---|---|
| Tetris | 6（"继续"与"暂停"同一枚，切文案） | `game-btn` + `control-btn / pause-btn / restart-btn / rotate-btn / direction-btn / down-btn` | 112×38、112×38、132×44、40×52 ×3 |
| 2048 | 6（常态 5 + 遮罩内 1） | **无任何类名** | 由 `site.css:107` `button{padding:10px;font-size:18px}` 决定 |

---

## 2. 对 v1.0 的修订清单（12 条）

1. **open-iconic 的删除位置**：`_Layout.cshtml` → **`wwwroot/css/site.css:1`**（`@import`）。全仓 `oi-` 只有 **7 处**：`NavMenu.razor` 6 处 + **`Shared/SurveyPrompt.razor` 1 处**（后者是模板残留、全仓无任何引用，建议随 B6 一并删除，否则删掉 import 后它会变成"无样式残留"）。之后 `wwwroot/css/open-iconic/` 目录可整体移除。
2. **`.btn-primary` 不是"Counter 一个地方"**：`site.css:15-19` 有 `.btn-primary{background:#1b6ec2}`，Bootstrap 也有，Counter 的 `<style>` 里第三份。→ 首页卡片与游戏按钮**禁止复用 `btn-primary`** 这个类名。
3. **页脚缺陷重定义**：不是"遮挡"，是 §1.2 的横向越界。修法不是"改成文档流内居中条"这么笼统，而是**去掉 `position:fixed` 与 `width:100%`**（缺一仍会偏，因为 `width:100%` 在 fixed 下按视口算，在文档流下按 `article` 内容宽算，两者都不等于"整条横贯屏幕"）。
4. **`:disabled` → `[disabled]`**：`fluent-button` 不是表单元素，`:disabled` 伪类**永不匹配**。所有 `.game-btn:disabled` / `:hover:not(:disabled)` / `:active:not(:disabled)` 必须改写为属性选择器，并补一条 `::part(control){opacity:1}` 把 FAST 的 0.3 抵消回 0.5。
5. **内部按钮样式用 `::part(control)` 控制**，不要试图从宿主"穿透"。
6. **2048 必须先加类**：现在没有类名，`fluent-button` 迁移后既没有样式锚点、也让"类名保留 → D-14 零回归"这条决策失效。**给按钮加类是本任务的前置改动**（`dir-btn` / `dir-up` / `replay-btn` / `overlay-replay-btn`）。
7. **`button{...}` 全局规则的等价物**：迁移 2048 后这条规则不再命中，需把 `padding/font-size/cursor` 迁到新类，否则按钮从 18px 字号退回 14px。
8. **导航迁移的真实代价**：`FluentNavMenu Collapsible` 是**侧栏收敛成图标栏（rail）**，而现状是 Bootstrap 的**顶栏折叠按钮 + 整块展开**。两者不是同一个交互 → NAV-04 必须重写，且 375px 观感要人工确认。v1.0 说"`Collapsible="true"` 保留现有移动端折叠行为"**不成立**。
9. **降级方案（只换菜单项）也要补 CSS**：`FluentNavLink` 自身只有 `.fluent-nav-link{width:100%;display:flex;color:inherit;text-decoration:none}`；hover 底纹与 active 竖条写在 `.fluent-nav-menu` 的 scoped CSS 里（`.fluent-nav-item .positioning-region:hover`、`a.active .positioning-region::before`）→ 脱离 `FluentNavMenu` 就**没有 hover、没有 active 指示**，且深色侧栏上 `--neutral-fill-secondary-rest` 是浅色，会白底白字。要么补 3 条规则，要么别声称"零回归"。
10. **e2e 影响面按 §7.2 的表格来**，不是"nav spec 若依赖 navbar 选择器"。
11. **引用修正**：`nav.spec.mjs`→`nav_fish.spec.mjs`；`test:d11_d12`→`test:d11d12`；`test:d15` 需在 `package.json` 新增；《14-界面与交互设计》→《03-界面与交互设计.md》；《现状》v1.8→v1.9。
12. **台账**：D-15 已登记 ✅；但 **D-02、D-14 仍开放**（代码已落地），本次落地时一并移入 §10.2（C-05/D-02、C-06/D-14），D-13 若仍未登记需补。

---

## 3. 任务 A：首页卡片化（修订版）

### 3.1 结构（可直接替换 `Pages/Index.razor`）

```razor
@page "/"

<PageTitle>夜游桃花源</PageTitle>

<header class="home-header">
    <h1>欢迎来到夜游桃花源</h1>
    <p class="home-subtitle">木鱼、计时器、两款小游戏——用来打发时间的小站。</p>
</header>

<main class="home-main">
    <section class="home-card home-card--intro" aria-label="站点简介">
        <FluentCard Style="width:100%;height:100%">
            <div class="card-body">
                <h2 class="card-title">关于这里</h2>
                <p class="card-desc">个人小站，所有内容都在浏览器里跑，不存任何数据。</p>
            </div>
        </FluentCard>
    </section>

    <NavLink class="home-card" href="counter">
        <FluentCard Style="width:100%;height:100%">
            <div class="card-body">
                <FluentIcon Value="@(new Icons.Regular.Size32.FoodGrains())" />
                <h3 class="card-title">按下试试</h3>
                <p class="card-desc">电子木鱼，点一下，功德 +1。</p>
            </div>
        </FluentCard>
    </NavLink>

    <NavLink class="home-card" href="loveTime">
        <FluentCard Style="width:100%;height:100%">
            <div class="card-body">
                <FluentIcon Value="@(new Icons.Regular.Size32.Heart())" />
                <h3 class="card-title">爱情计时器</h3>
                <p class="card-desc">相识、相爱、相守，精确到秒。</p>
            </div>
        </FluentCard>
    </NavLink>

    <NavLink class="home-card" href="game_2048">
        <FluentCard Style="width:100%;height:100%">
            <div class="card-body">
                <FluentIcon Value="@(new Icons.Regular.Size32.Grid())" />
                <h3 class="card-title">2048</h3>
                <p class="card-desc">方向键 + 屏幕按钮，合到 2048。</p>
            </div>
        </FluentCard>
    </NavLink>

    <NavLink class="home-card" href="tetris">
        <FluentCard Style="width:100%;height:100%">
            <div class="card-body">
                <FluentIcon Value="@(new Icons.Regular.Size32.GameChat())" />
                <h3 class="card-title">俄罗斯方块</h3>
                <p class="card-desc">消行、升级，手机竖屏也能玩。</p>
            </div>
        </FluentCard>
    </NavLink>
</main>

<footer class="site-footer">
    <a href="https://beian.mps.gov.cn/#/" target="_blank" rel="noopener">陕ICP备2024056488号</a>
</footer>
```

**三处刻意为之**：

- **`<h1>` 文案一字不改**（`NAV-01` 断言它），`<h2>你好！</h2>` 取消 → NAV-01 必须同步改（§7.2）；简介卡的 `<h2>` 保留一个，卡片标题统一 `<h3>`，标题层级仍合法。
- **`<footer>` 标签保留、`<a target="_blank">` 保留**：`NAV-05/NAV-06` 用 `page.textContent('footer')` 与 `footer a` 的 `href`/`target`，改结构别改这两点。
- **卡片跳转用 `NavLink` 而非 `<a>` 或 `NavigationManager`**：`NavLink` 渲染的 `<a>` 会走 Blazor 的 SPA 拦截（无整页刷新），且仍是可右键新开、可键盘 Tab 的原生链接。用 `NavigationManager.NavigateTo` 会丢掉这两点。

> **图标命名**：`Icons.Regular.Size32.*` 的存在性只能在编译期确认（`DLL` 的字符串表去重，grep 无法区分 `Regular/Filled`）。**先沿用已验证可用的写法**——`Counter.razor` 用的是 `Icons.Filled.Size32.AnimalPawPrint()`；若 `Regular` 目录不覆盖某个名字，编译会直接报错，届时换 `Filled` 或同级近义图标即可。不要为此阻塞任务 A。
>
> **`@using` 提醒**：`Icons` / `Appearance` 位于 `Microsoft.FluentUI.AspNetCore.Components`，而 `_Imports.razor` 里只有 `Microsoft.Fast.Components.FluentUI`。`Counter.razor` 与 `Tetris.razor` 都在页首手工加了这行，而 **`Index.razor` / `NavMenu.razor` / `Game_2048.razor` 没有**。若新写的标记报"找不到 `Icons`"或"找不到 `Appearance`"，在文件头补 `@using Microsoft.FluentUI.AspNetCore.Components` 即可（或一次性加进 `_Imports.razor`，但那是全局改动，需同步验证不产生歧义）。

### 3.2 页脚修复（本次唯一必须"先修后加"的一步）

```css
/* site.css 末尾追加 */
.site-footer {
    margin: 8px 0 24px;
    padding: 12px 0;
    border-top: 1px solid rgba(0, 0, 0, .08);
    text-align: center;
    font-size: .9rem;
    /* 关键：不要写 width:100%；不要 position:fixed；不要 position:sticky */
}

.site-footer a {
    color: #6b7280;
    text-decoration: none;
}

.site-footer a:hover {
    text-decoration: underline;
}
```

- `position:fixed` + `width:100%` 是 §1.2 越界的**唯一成因**，两者必须同时去掉；
- 去掉后页脚随内容流走，短页面时它紧跟卡片下方（不再"钉在屏幕底"）——这是有意的：`fixed` 页脚在长页面上会盖住卡片，在短页面上又和内容脱节；
- **如果确实想要"贴底"**：用 `.home-main{min-height:calc(100dvh - 200px)}` 把内容撑高，而不是恢复 `fixed`；
- 375 / 1280 双档验收：`getBoundingClientRect().right <= document.documentElement.clientWidth`，且 `getComputedStyle(footer).position !== 'fixed'`。

### 3.3 卡片样式

```css
.home-header { padding: 4px 0 0; }

.home-subtitle {
    color: #6b7280;
    margin-top: .35rem;
    font-size: 1rem;
}

.home-main {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
    margin: 24px 0 8px;
    align-items: stretch;      /* 同一行卡片等高 */
}

a.home-card,
.home-card {
    display: block;            /* NavLink 渲染成 <a>，默认 inline，会掉出网格 */
    height: 100%;
    text-decoration: none;
    color: inherit;
    border-radius: 10px;
    transition: transform .15s ease;
}

a.home-card:hover { transform: translateY(-2px); }
a.home-card:focus-visible { outline: 2px solid #1b6ec2; outline-offset: 3px; }

.card-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 2px;
    text-align: left;          /* body{text-align:center} 会继承进来 */
}

.card-title  { margin: 0; font-size: 1.05rem; }
.card-desc   { margin: 0; color: #6b7280; font-size: .9rem; line-height: 1.5; }
```

**为什么 `FluentCard` 要显式 `Style="width:100%;height:100%"`**：`FluentCard` 的 `Width/Height` 参数默认不设，`fluent-card` 宿主是 `display:block`（实测），在 grid 单元里能拉伸，但高度不会跟随 `align-items:stretch` 撑满整卡——hover 上浮时会出现"卡片高度不齐、只有内容块在动"的观感。写死 100% 后，整卡是一个实心块。

**为什么不用 `btn-primary`**：§2 第 2 条，三处定义会打架。

---

## 4. 任务 B：Fluent 统一（分层重写）

| 层 | 范围 | 本次 | 与 v1.0 的差异 |
|---|---|---|---|
| L1 控件 | 卡片 / 按钮 | ✅ 全量 | 补 `::part(control)`、`[disabled]`、2048 前置加类 |
| L2 导航 | `NavMenu` | ⚠️ 二选一（§4.2） | v1.0 直接定为"迁 FluentNavMenu"，实测交互模型不同，改为带决策准则的两条路 |
| L3 布局 | `MainLayout → FluentLayout` | ❌ 不做 | 同 v1.0（判断正确） |

### 4.1 B1 卡片（并入任务 A，无独立工作项）

### 4.2 B2 导航：两条路，先定再动手

**现状结构**：`<div class="top-row ps-3 navbar navbar-dark">`（品牌 + `navbar-toggler`）+ `<div class="@NavMenuCssClass">`（`collapse` 类控制）+ `<nav class="flex-column">` + 5 个 `.nav-item` + `<span class="oi oi-*">`。`NavMenu.razor.css` 在 `min-width:641px` 时隐藏 toggler 并强制 `.collapse{display:block}`。

#### 方案 B2-A：全量迁 `FluentNavMenu`（推荐，达成"观感统一"的唯一路径）

```razor
<div class="nav-brand-row">
    <a class="navbar-brand" href="">夜游桃花源</a>
</div>

<FluentNavMenu Title="站点导航" Width="248" Collapsible="true" @bind-Expanded="navExpanded">
    <FluentNavLink Href="" Match="NavLinkMatch.All" Icon="@(new Icons.Regular.Size20.Home())">jtjsym</FluentNavLink>
    <FluentNavLink Href="counter"  Icon="@(new Icons.Regular.Size20.Fingerprint())">按下试试</FluentNavLink>
    <FluentNavLink Href="loveTime" Icon="@(new Icons.Regular.Size20.Heart())">爱情计时器</FluentNavLink>
    <FluentNavLink Href="game_2048" Icon="@(new Icons.Regular.Size20.Grid())">2048</FluentNavLink>
    <FluentNavLink Href="tetris"   Icon="@(new Icons.Regular.Size20.GameChat())">俄罗斯方块</FluentNavLink>
</FluentNavMenu>

@code {
    private bool navExpanded = true;
}
```

**四个必须处理的点**：

1. **`Match="NavLinkMatch.All"` 必须显式写在首页那一条**。`FluentNavLink.Match` 默认是 `Prefix`（XML 确认），`Href=""` 在 Prefix 下匹配所有路由 → 每页都高亮首页。这条正好被 `NAV-03` 断言（`rootHref === ''`）。
2. **深色侧栏配色要重写**。现状靠 `NavMenu.razor.css` 的 `.nav-item ::deep a{color:#d7d7d7}` 与 `.active{background:rgba(255,255,255,.25)}`，这些选择器锚在 `.nav-item` 上，迁移后失效。补：

   ```css
   /* site.css 末尾 */
   .sidebar .fluent-nav-link { color: #d7d7d7; }
   .sidebar .fluent-nav-item a.fluent-nav-link:hover { background: rgba(255, 255, 255, .1); color: #fff; }
   .sidebar .fluent-nav-item a.fluent-nav-link.active { background: rgba(255, 255, 255, .25); color: #fff; }
   .sidebar .fluent-nav-item a.fluent-nav-link.active::before { background: #fff; }
   ```

   （库内规则是 `.fluent-nav-item .positioning-region:hover:not(:has(.disabled))`，特异性 0,3,0；上面第三条是 0,3,1，且写在 `site.css` 之后，可覆盖。）

3. **`Collapsible` 的语义要接受**：它是"整栏收敛成图标轨 + 一个展收按钮"，**不是** Bootstrap 的"顶部汉堡 + 抽屉"。375px 下是否可接受必须人工看一眼；不可接受就走 B2-B。
4. **`NAV-02/03/04` 三条用例重写**（§7.2）：选择器从 `nav a.nav-link` 变为 `nav a.fluent-nav-link`（`FluentNavMenu` 根元素仍是 `<nav>`），`.navbar-toggler` / `.flex-column` 在 A 方案下不存在。

#### 方案 B2-B：保留 Bootstrap 骨架，只换菜单项（降级，零 e2e 改动）

保留 `top-row navbar` + `toggler` + `nav.flex-column` + `.nav-item` 包装，仅把 `<NavLink class="nav-link">` 换成 `<FluentNavLink Href="…" Class="nav-link" Icon="…">`。此时 `.nav-item ::deep a` 与 `.active` 规则继续命中，`NAV-02/03/04` **一行都不用改**。

**但**：`FluentNavLink` 脱离 `FluentNavMenu` 会失去 hover 底纹与 active 竖条（它们写在 `FluentNavMenu.razor.rz.scp.css` 里），必须补回：

```css
.nav-item a.fluent-nav-link:hover  { background-color: rgba(255, 255, 255, .1);  color: #fff; }
.nav-item a.fluent-nav-link.active { background-color: rgba(255, 255, 255, .25); color: #fff; }
```

**决策准则**：B2-A 的收益是"控件语言统一（图标、焦点框、rail 收敛）"，代价是 3 条用例重写 + 移动端交互变更；B2-B 收益是"图标系统统一（Fluent Icons 替 open-iconic）+ 零测试改动"。**若本次不想承担 NAV-04 的重写与真机回归，就选 B2-B，并把 B2-A 列入后续项**——这比"照着 A 做、卡住了再降级"安全。

### 4.3 B3 Tetris 按钮（6 枚）

```razor
<FluentButton Class="game-btn rotate-btn"
              Disabled="@(isGameOver || isPaused)"
              @onclick="RotatePiece">旋转</FluentButton>

<FluentButton Class="game-btn direction-btn down-btn"
              Disabled="@(isGameOver || isPaused)"
              @onpointerdown="OnDownButtonPress"
              @onpointerup="OnDownButtonRelease"
              @onpointerout="OnDownButtonRelease"
              @onpointerleave="OnDownButtonRelease">↓</FluentButton>
```

**样式（`Tetris.razor` 内 `<style>` 追加，紧跟现有 `.game-btn` 规则）**：

```css
/* 内部按钮：抹掉 FAST 的 padding/border，让宿主背景与圆角说话 */
fluent-button.game-btn::part(control) {
    background: transparent;
    border: none;
    border-radius: 6px;
    padding: 0 4px;
    font: inherit;
    color: inherit;
    width: 100%;
    height: 100%;
}

/* :disabled 伪类不匹配自定义元素 → 全部改属性选择器 */
.game-btn[disabled]        { opacity: .5; cursor: not-allowed; }
fluent-button.game-btn[disabled]::part(control) { opacity: 1; }  /* 抵消 FAST 的 .3，保持 0.5 */
.game-btn:hover:not([disabled])  { filter: brightness(1.1); transform: scale(1.05); }
.game-btn:active:not([disabled]) { filter: brightness(0.9); transform: scale(0.95); }
```

**要点**：

- `.game-btn` 的 `background-color` 保留在宿主上（`pause-btn #0078D4` / `resume-btn #107C10` / `restart-btn #D83B01` / `rotate/direction #106EBE`），实测宿主色可正常显示；
- 内部 `padding:0 10px` 必须归零：`.direction-btn` 在 375px 只有 40px 宽，两侧各 10px 后文字区仅 20px，会导致 `←` 视觉偏挤；
- **`::part(control)` 是唯一可靠入口**，`Class="…"` 只能作用在宿主；
- 事件：`@onclick/@onpointerdown/…` 会随 AdditionalAttributes 落到宿主元素（`Counter.razor` 的 `<FluentButton @onclick @onmouseout>` 是现网先例）。**但** `pointerleave` 在带 Shadow DOM 的宿主上语义未在本仓验证过，实施后按 §7.3 手工第 3 条实测"按住 ↓ 三秒再松手"。

### 4.4 B4 2048 按钮（6 个标签，5 枚常态可见）

**前置动作（v1.0 缺，必做）**：先加类，再迁移。

```razor
<div class="controls">
    <FluentButton Class="dir-btn dir-up"     IconStart="@(new Icons.Regular.Size20.ArrowUp())"   @onclick="MoveUp"    Disabled="@isGameOver" />
    <div class="dir-row">
        <FluentButton Class="dir-btn" IconStart="@(new Icons.Regular.Size20.ArrowLeft())"  @onclick="MoveLeft"  Disabled="@isGameOver" />
        <FluentButton Class="dir-btn" IconStart="@(new Icons.Regular.Size20.ArrowDown())"  @onclick="MoveDown"  Disabled="@isGameOver" />
        <FluentButton Class="dir-btn" IconStart="@(new Icons.Regular.Size20.ArrowRight())" @onclick="MoveRight" Disabled="@isGameOver" />
    </div>
</div>

<p><FluentButton Class="replay-btn" @onclick="RestartGame">重玩</FluentButton></p>

@if (isGameOver)
{
    <div class="game-over">
        <h2>游戏结束</h2>
        <FluentButton Class="overlay-replay-btn" Appearance="Appearance.Accent" @onclick="RestartGame">重玩</FluentButton>
    </div>
}
```

```css
/* 接替 site.css:107 的全局 button 规则（迁移后不再命中） */
.dir-btn {
    padding: 10px;
    font-size: 18px;
    cursor: pointer;
    background-color: #106EBE;
    color: #fff;
    border: none;
    border-radius: 6px;
}
.dir-btn::part(control) { background: transparent; border: none; font: inherit; color: inherit; }
.dir-row { display: flex; gap: 5px; }
.replay-btn { padding: 6px 14px; font-size: 15px; }
/* 遮罩内是深底白字，与页面上的"重玩"不是同一视觉，单独给类 */
.overlay-replay-btn { margin-top: 8px; }
```

**要点**：

- 若改用文字箭头（`⬆️` 等 emoji）而非 FluentIcon，可保留 `<FluentButton>⬆️</FluentButton>`，但 emoji 在不同系统渲染差异大，**建议顺手换成图标**（本次非必需，但 `Class` 必须加）；
- **`.game-over` 遮罩里那枚"重玩"必须单独一个类**：它压在半透明黑底上，若与页面上的"重玩"共用样式，非 accent 外观在深底上几乎看不见；
- `@onclick` 已在 2048 的四个 `MoveX()` 上挂了 `isGameOver` 守卫（D-02 落地），`Disabled="@isGameOver"` 只是视觉冗余，两者不冲突。

### 4.5 B5 CodingPlace 重写（顺带关 D-06 / D-10）

```razor
@page "/coding_place"

<PageTitle>编程挑战</PageTitle>

<h1>编程挑战</h1>

<FluentCard Style="max-width:880px;margin:0 auto;text-align:left">
    <h2 style="margin-top:0">任务混部</h2>
    <pre class="problem-description">@ProblemDescription</pre>
</FluentCard>
```

- **`<h1>编程挑战</h1>` 必须保留**：`NAV-08` 断言 `h1.includes('编程挑战')`（v1.0 只说"重写展示"，没说这层约束）；
- 用 `<pre>` 而不是 `<p>`：`ProblemDescription` 是多行原始字符串，`<p>` 会把换行压平；若要 `<p>` 则加 `white-space: pre-line`；
- 删除 `InputExample` / `OutputExample` 两个字段 → **`CS0414` ×2 消失，D-10 关闭**（已用 `--no-incremental` 构建确认这 2 条来自它们）；
- `CodeAnswer` 未触发 `CS0414`（说明仍在被引用，可能在注释块外的某处），**不要顺手删**；
- 删除 `FluentPage/FluentPageHeader/FluentTextBlock` → **`RZ10012` ×3 消失，D-06 关闭**；
- 页面仍在导航隐藏状态，不新增功能。

### 4.6 B6 MainLayout 清理（顺带 D-07 一部分）

```razor
<main>
    <article class="content px-4">
        @Body
    </article>
</main>
```

- 删除 `top-row` 整行（含 "About" 外链）→ **`NAV-10` 必须同时删除**（它断言该外链存在）；
- `MainLayout.razor.css` 的 `.top-row` 与 `site.css` 中对应规则可一并删除（`.top-row` 还被 `NavMenu.razor.css` 用作品牌行，两处都要看）；
- `MainLayout` 第 3 行的 `<PageTitle>jtjsym</PageTitle>` **保留**（C-03 的兜底），首页用自己的 PageTitle 覆盖。

---

## 5. 改动清单（修正版）

| # | 文件 | 改动 | 任务 |
|---|---|---|---|
| 1 | `Pages/Index.razor` | 重写：卡片网格 + 文档流页脚 + `<PageTitle>夜游桃花源</PageTitle>`，保留 `<h1>` 文案 | A |
| 2 | `wwwroot/css/site.css` | 追加 `.home-header/.home-subtitle/.home-main/a.home-card/.card-*/.site-footer`；追加 `.sidebar .fluent-nav-*` 配色；追加 `.dir-btn/.replay-btn`；改写 `.game-btn:disabled` 一族为 `[disabled]` | A/B3/B4 |
| 3 | `wwwroot/css/site.css:1` | **删除** `@import url('open-iconic/…')` | B2 |
| 4 | `wwwroot/css/open-iconic/` | 目录整体删除（可选，删前 grep 确认无 `oi-` 残留） | B2 |
| 5 | `Shared/NavMenu.razor` | B2-A：迁 `FluentNavMenu`+`FluentNavLink`+Fluent Icons；B2-B：仅换 `FluentNavLink` 保留骨架 | B2 |
| 6 | `Shared/NavMenu.razor.css` | A：`.nav-item ::deep a` 规则作废改为 `.sidebar .fluent-nav-*`；B：追加 hover/active 两条 | B2 |
| 7 | `Pages/MyPage/Tetris.razor` | 6 枚 → `FluentButton`（类名保留、加 `::part` 与 `[disabled]` 规则） | B3 |
| 8 | `Pages/MyPage/Game_2048.razor` | **先加类**，再迁 6 枚 → `FluentButton`（含遮罩内那枚） | B4 |
| 9 | `Pages/MyPage/CodingPlace.razor` | 删 `FluentPage` 三件套；删 `InputExample/OutputExample`；补 `FluentCard`+`<pre>` | B5 |
| 10 | `Shared/MainLayout.razor` | 删 `top-row` 与 About 外链 | B6 |
| 11 | `tools/e2e/tests/nav_fish.spec.mjs` | 改 NAV-01/02/03/04/07，**删 NAV-10** | 测试 |
| 12 | `tools/e2e/tests/smoke.spec.mjs` | 改 NAV-01（第二处） | 测试 |
| 13 | `tools/e2e/tests/{helpers,d02_keyboard_ui,code_nf,g2048}.spec.mjs` | `.controls button:has-text` → `.controls fluent-button:has-text`；`button:has-text("重玩")` → `.replay-btn` | 测试 |
| 14 | `tools/e2e/tests/d15_home_fluent.spec.mjs` | 新增（§7.1） | 测试 |
| 15 | `tools/e2e/package.json` | 新增 `"test:d15": "playwright test tests/d15_home_fluent.spec.mjs"` | 测试 |
| 16 | `1设计文档/1代码结构与更新记录/测试文档-全量测试用例.md` | 登记/关闭：D-06→C、D-10→C、D-07 部分、D-02/D-14 补关闭；NAV-01~04/07/10 用例文本；新增 D15-* | 流程 |
| 17 | `1设计文档/2过程设计文件/03-界面与交互设计.md` | §3.4 2048 要点、§5 改进清单（第 2/3 条完成、第 5 条已被《08》证伪） | 流程 |
| 18 | 《现状》→v1.9 /《更新记录》 | 代码落地后一次性更新（按约定：**写文档/检视不动这两份**） | 流程 |

**明确不动**：`Program.cs`、`_Imports.razor`、`Pages/_Layout.cshtml`（§2 第 1 条：open-iconic 不在这里）、`MainLayout.razor.css` 的布局骨架、`Counter.razor`、`LoveTime.razor`、全部 `@code` 游戏逻辑、`Tetris.razor` 的 D-14 响应式 CSS。

---

## 6. 风险与回退

| 风险 | 实测依据 | 缓解 |
|---|---|---|
| `:disabled` 相关规则静默失效 | `fluent-button` 非表单元素，`:disabled` 不匹配 | 全部改 `[disabled]`；验收取 `getComputedStyle(host).opacity === '0.5'` |
| 内部按钮 padding 挤压文字 | 内部 `.control` 实测 `padding:0 10px` | `::part(control){padding:0 4px}` |
| 禁用态过淡 | FAST 内部 `opacity:.3` | `[disabled]::part(control){opacity:1}` + 宿主 `.5` |
| `FluentNavMenu` 的折叠语义与现状不同 | 组件 `Collapsible` 为图标轨收敛 | 先做 B2-B；要做 A 则必须真机看 375px |
| 深色侧栏上 Fluent 默认 hover 是浅色底 | 库规则用 `--neutral-fill-secondary-rest`（浅） | 三条 `.sidebar .fluent-nav-*` 覆盖 |
| `fluent-card` 高度不齐 | 宿主 `display:block`，`stretch` 只拉行高 | `Style="width:100%;height:100%"` |
| 2048 迁移后整体尺寸变化 | 现全靠全局 `button{padding:10px;font-size:18px}` | 新类里把这两条抄回去 |
| `Icons.Regular.Size32.*` 名称不确定 | 字符串表去重，无法静态确认 | 沿用 `Icons.Filled.Size32.*` 已在用的写法；编译报错就换名 |
| 导航迁移连带 5 条用例 | §7.2 | 与其"先迁后补测试"，不如**先改测试再迁代码** |
| 首页重写打破 2 个 spec | `nav_fish:11-16` 与 `smoke:24-27` 各一处 | 两处同批改，别只改一个 |

**回退**：按文件粒度 `git checkout --`。任务 A（首页+页脚）、B5（CodingPlace）、B3/B4（按钮）、B2（导航）四组相互独立，**建议分 4 次提交**，任何一组出问题都不牵连其余。

---

## 7. 测试计划

### 7.1 新增 `d15_home_fluent.spec.mjs`

| # | 断言（可判定） |
|---|---|
| D15-1 | 首页 `h1` 含"欢迎来到夜游桃花源"；`.home-card` 数量 = 5（1 简介 + 4 链接） |
| D15-2 | 4 张链接卡的 `href` 分别等于 `counter` / `loveTime` / `game_2048` / `tetris`（读属性，不点击，快且稳） |
| D15-3 | 点击"俄罗斯方块"卡 → `new URL(page.url()).pathname === '/tetris'`，且未整页刷新（点击前在 `window` 上打标记，点击后标记仍在） |
| D15-4 | `await page.title() === '夜游桃花源'` |
| D15-5 | 页脚：`getComputedStyle(footer).position !== 'fixed'`，且 `footer.getBoundingClientRect().right <= document.documentElement.clientWidth`（375 与 1280 双档） |
| D15-6 | 备案链接 `href === 'https://beian.mps.gov.cn/#/'`、`target === '_blank'`（与 NAV-06 同源，只测一次即可） |
| D15-7 | 375×667：`scrollWidth === clientWidth`；5 张卡片的 `width` 两两相差 ≤ 1px（单列）；每张 `right <= clientWidth` |
| D15-8 | 1280×900：同排卡片数 ≥ 3（读 `getBoundingClientRect().top` 相同者计数） |
| D15-9 | `/tetris`：`.game-btn` 数量 = 6，`tagName === 'FLUENT-BUTTON'`；`el.shadowRoot.querySelector('.control')` 的 `backgroundColor` 为 `rgba(0, 0, 0, 0)`（证明 `::part` 生效、宿主色在起作用） |
| D15-10 | `/tetris` 暂停后：暂停按钮 `hasAttribute('disabled')` 且 `getComputedStyle(host).opacity === '0.5'` |
| D15-11 | `/coding_place`：`h1` 含"编程挑战"、`FluentCard` 渲染出 `fluent-card` 标签、页面文本含"任务混部" |
| D15-12 | `/game_2048`：`.dir-btn` 数量 = 4、`.replay-btn` = 1；点击 `⬅️` 后分数或棋盘有变化（复用 `helpers.simulate` 对照） |

> RZ10012 的消失**只能靠构建验证**（浏览器端看不到编译警告）→ 归入 §7.4 的 `dotnet build | grep -c warning` 断言 `0`。

### 7.2 既有套件必须同步的断言（**这是本次最大的隐性工作量**）

| 用例 | 位置 | 现状 | 迁移后 |
|---|---|---|---|
| **NAV-01** | `nav_fish.spec.mjs:11-16` **与** `smoke.spec.mjs:24-27`（两份） | `h1 含"欢迎…" && main h2 含"你好"` | 改断言为 `h1 含"欢迎…" && .home-card 数量 5`；`main h2` 已不存在 |
| **NAV-02** | `nav_fish.spec.mjs:29-38` | `nav a.nav-link`（5 次循环点击） | B2-A：`nav a.fluent-nav-link`；B2-B：不变 |
| **NAV-03** | `nav_fish.spec.mjs:40-52` | `nav a.nav-link.active` + `href==='tetris'` / `''` | B2-A：`nav a.fluent-nav-link.active`（`ActiveClass` 默认 `active`，`Href` 写相对路径才等于 `tetris`） |
| **NAV-04** | `nav_fish.spec.mjs:54-70` | `.navbar-toggler` 可见 + 点击后 `nav.flex-column` 父容器无 `collapse` + 1280 不可见 | **B2-A 整条重写**（无 toggler、无 `collapse` 类）：改为断言 `FluentNavMenu` 的展收按钮存在、点击后菜单项文本仍可达；B2-B 不变 |
| **NAV-07** | `nav_fish.spec.mjs:85-100` | `'/' : 'jtjsym'` | 改为 `'夜游桃花源'` |
| **NAV-10** | `nav_fish.spec.mjs:123-133` | 断言 About 外链存在 | **删除**（B6 移除该外链） |
| 2048 方向键 | `code_nf.spec.mjs:55,86,171`、`d02_keyboard_ui.spec.mjs:343`、`helpers.mjs:75` | `.controls button:has-text("⬅️")` 等 | `.controls fluent-button:has-text("⬅️")`（5 处） |
| 2048 重玩 | `g2048.spec.mjs:193,202` | `button:has-text("重玩")` | `.replay-btn`（2 处） |
| D-14 几何 | `d14_mobile_layout.spec.mjs` | `.game-btn` + textContent 定位、`.control-buttons`/`.side-panel` 度量 | **不用改**（类名保留），但需在迁移后重跑：`flex:1`/`height:52px` 作用在 `fluent-button` 宿主上，实测宿主尺寸可控 |

**执行顺序建议**：先改测试 → 跑一遍确认"红得符合预期" → 再改代码 → 全绿。（`test:nav` 的 `--grep "NAV-[0-9]|D-11"` 不受影响。）

### 7.3 手工清单

1. 1280px：首页 4 张卡 hover 上浮、点击直达、Tab 键能聚焦（`:focus-visible` 蓝框可见）；
2. 1280px：页脚**横向位置**——黑边/分隔线是否横贯内容区、备案号是否居中（这是 v1.0 完全没提的验收点）；
3. Tetris：按住 ↓ 三秒再松手（软降起停）、按住 ← 连发、暂停后按钮变淡且**hover 不再放大**；
4. Tetris 375px：D-14 右栏布局不回归（棋盘 20.5px/格、四键同排、无滚动）；
5. 2048：四个方向键触控 + 键盘双通道；游戏结束后遮罩内"重玩"可点、颜色在深底上看得清；
6. 375px：导航展开/收起（A 方案重点看 rail 是否可接受）；
7. `/coding_place` 直达：内容正常、无未知元素样式塌陷；
8. 真机抽查一次（iOS Safari）：卡片点击、按钮触控、页脚位置。

### 7.4 落地后门禁

```bash
cd tools/e2e
npm run test:nav      # NAV-01~09（NAV-10 已删）
npm run test:smoke    # 冒烟集，含 NAV-01（两处之一，另一处在 nav_fish）
npm run test:g2048 && npm run test:tris && npm run test:d02 && npm run test:d14 && npm run test:nf && npm run test:lt
npm run test:d15
```

```bash
cd jtjsym/jtjsym && dotnet build --no-incremental -v q --nologo 2>&1 | grep -c "warning"   # 期望 0（D-06/D-10 关闭后）
```

> 站点由 `playwright.config.mjs` 的 `webServer` 自动拉起（`reuseExistingServer: true`）。**`--environment Development` 必须带上**，否则 `_content/*` 404 → Fluent 的 scoped CSS 不加载 → 所有尺寸/颜色断言都是假的。

---

## 8. 实施顺序（4 次提交）

| 批次 | 内容 | 完成后验证 |
|---|---|---|
| ① 测试先行 | 改 NAV-01（2 处）/07、删 NAV-10，新增 `d15_*` 与 `test:d15` | 跑一遍，确认红的是"首页无卡片""`/` 标题不对"这类预期失败 |
| ② 任务 A | `Index.razor` 重写 + 页脚 + 卡片 CSS | `test:d15`（D15-1~8）+ `test:nav` |
| ③ 任务 B5+B6 | `CodingPlace` 重写、`MainLayout` 删 About | `dotnet build` 警告 0；`test:nav`（NAV-08） |
| ④ 任务 B3+B4 | 两个游戏页按钮 | `test:tris` / `test:g2048` / `test:d02` / `test:d14` / `test:nf` + `test:d15`（D15-9~12） |
| ⑤ 任务 B2 | 导航（选 A 或 B） | `test:nav` 全绿 + 375px 真机 |

**每批单独提交**，导航放最后：它是唯一会改动共享布局的批次，出问题时前面 4 批已在主干上稳定。

---

## 9. 文档同步（代码落地后一次性做）

| 文档 | 改什么 |
|---|---|
| 《测试文档-全量测试用例.md》§10 | D-06→已关闭、D-10→已关闭、D-07→部分关闭（About 已删，`WeatherForecast/SurveyPrompt` 另计）、**D-02/D-14 补关闭**（代码早已落地）、新增 D-15→已关闭 |
| 同上 §3 | NAV-01/02/03/04/07/10 用例文本（NAV-10 删除）、新增 D15-01~12 |
| 同上 §11.4 | 用例总数与冒烟集条数（当前 100 / 28，本次 +12 用例） |
| 《03-界面与交互设计.md》 | §3.4 2048 要点（去掉"纯按钮""无配色"）、§3.5 Tetris 网格尺寸（`--cell-size` 已由《08》改）、§5 改进清单逐条勾销 |
| 《现状》→ v1.9 | 模块一览补"首页=入口卡片页"；§4 待改进项删"模板残留 About 外链"、"`.btn-primary` 三处定义"改为已收口 |
| 《更新记录》 | 按批次的 4~5 条记录（commit + 摘要） |

> 按当前约定：**写/改/检视文档时不动《更新记录》与《现状》**，它们只在代码落地后更新。

---

## 10. 后续（不在本次）

- `MainLayout → FluentLayout`（header / drawer / 主题注入），另立文档；
- 用 `FluentDesignSystemProvider`（3.8.0 有此组件，`FluentDesignTheme` 是 4.x 才有的）承载暗色基调，再谈"游戏页官方化"；
- bootstrap / open-iconic 依赖彻底移除；
- 首页卡片加"上次分数"（需持久化，依赖未来存储方案）；
- `Counter.razor` 的 `.btn-primary` 全局污染（D-09）单独收口：改名 `.knock-btn` 并迁移样式到 `site.css`。
