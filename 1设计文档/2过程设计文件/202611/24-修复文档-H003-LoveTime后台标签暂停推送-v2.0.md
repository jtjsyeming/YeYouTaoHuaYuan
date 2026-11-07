# 24-v2.0 - 修复文档：H-003（D-08 后台标签仍每秒推送 SignalR 帧）

> 来源：《3测试报告/2026-11-06.md》总结表 H-003（台账 D-08）；《3测试报告/2026-11-07.md》§6 H 段复核「仍存在」。
> 单独成文理由：这是唯一涉及 LoveTime 页计时器生命周期与 JS interop 注册的改动，与 23/25/26/27 号文档无文件交集。
> 性质：仅设计文档，未动代码。实施后才更新《技术栈与代码结构现状》《更新记录》并关闭 D-08。
>
> **v2.0 修订依据**：2026-11-07 在 14074 实例（`--environment Development`）实测 + 逐行读码。v1.0 的**方案主体（Visibility 事件 + JS 模块）成立**，但**取用的 API 全部对不上现有代码**（Timer/Stop/Start 并不存在），且漏了 `IDisposable → IAsyncDisposable` 的结构性改动与门禁脚本入口。v1.0 原件保留不动。

---

## 0. v1.0 → v2.0 差异摘要

| # | v1.0 的说法 | v2.0 的结论 | 依据 |
|---|---|---|---|
| 1 | 秒级计时器是 `System.Timers.Timer`，暂停用 `ticker?.Stop()` | **是 `PeriodicTimer` + `CancellationTokenSource tickerCts`**（`:121`、`:141-174`），根本没有 `ticker` 字段也没有 Stop/Start → 方案必须改成"标志位跳过"或"Cancel/重建 CTS"，二者语义不同 | 读码 |
| 2 | `DisposeAsync` 里注销监听 + 四件套 catch | 本页只实现 **`IDisposable`**（`:2`、`:176`），**没有 DisposeAsync、没有注入 `IJSRuntime`**。加 interop 必须改成 `IAsyncDisposable`，并落进 D-19 陷阱（`Dispose()` 变死代码） | 读码，《21》C-25 |
| 3 | 在 `OnAfterRender(firstRender)` 分支内注册 | 该方法是**同步** `OnAfterRender(bool)`（`:130`），import JS 模块必须 `await` → 要改成 `OnAfterRenderAsync`，并保持"先启 ticker、后 await interop"的顺序（否则 `LT-31` 的相位前提漂移） | 读码 |
| 4 | 回归点是 `LT-32` + 门禁 `test:lt` | LT-32 存在但**在 `d20_lt_consistency.spec.mjs`**，`npm run test:lt` 跑不到 → 门禁必须加 `test:d20`。真正的正面回归其实是 **LT-24（后台 30 秒返回）** | 读码 |
| 5 | 用 `visibilityState` 注入法造 hidden | 手法可行（已实测），但有个致命细节：注入只改 `visibilityState`，**`document.hidden` 仍是 false** → JS 侧必须读 `visibilityState`，读 `hidden` 会让用例假绿 | §5.1 实测 |
| 6 | （未提） | **`LT-24` 今天是恒真的弱用例**：headless 下 `bringToFront` 不产生 hidden、不派发事件（实测切走 2.5 秒 `visibilityState` 仍为 `visible`） | §5.1 实测 |
| 7 | 新 spec 叫 `d24_visibility.spec.mjs` | 与既有命名体系不符（`d16~d20` 都是**缺陷号**不是文档号）→ 应为 `d08_visibility.spec.mjs`，且**必须在 `package.json` 加 `test:d08`**，否则新用例不在任何门禁里 | 读 package.json |
| 8 | 未提《现状》的既有预警 | 《现状》:113 已写明「年份自愈**依附于秒刷**，若换成按需刷新（D-08），须一并迁移」→ visible 分支**必须先 `RefreshAll()` 再恢复 tick**，这是硬约束不是"受益方"的顺带结论 | 读台账 |

---

## 1. 问题与现状（实测）

`LoveTime.razor` 的秒刷是一条 `Task` 循环，而非 `System.Timers.Timer`：

```csharp
private CancellationTokenSource? tickerCts;          // :121
private bool isDisposed;                              // :122

protected override void OnAfterRender(bool firstRender)   // :130（同步）
{
    if (firstRender) StartTicker();
}

private void StartTicker()                            // :141
{
    if (isDisposed || tickerCts is not null) return;  // 防重复启动（守卫在 CTS 上）
    tickerCts = new CancellationTokenSource();
    _ = RunTickerAsync(tickerCts.Token);
}

private async Task RunTickerAsync(CancellationToken token)   // :149
{
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
    try
    {
        while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
        {
            await InvokeAsync(() =>
            {
                if (isDisposed) return;
                RefreshAll();
                StateHasChanged();     // InvokeAsync 不会自动渲染
            });
        }
    }
    catch (OperationCanceledException) { }
    catch (Exception) { }              // 静默退出（注意：会吞掉一切，见风险表）
}

public void Dispose()                                 // :176（IAsyncDisposable 缺失）
{
    isDisposed = true;
    tickerCts?.Cancel();
    tickerCts?.Dispose();
    tickerCts = null;
}
```

只要 circuit 存活，`PeriodicTimer` 每秒到点 → `RefreshAll()` + `StateHasChanged()` → 一帧 SignalR 推送，哪怕标签在后台。单个后台标签每天 **86,400 帧**无意义推送。

**真实代价边界（v2.0 补充）**：本站无持久化、每 circuit 一个 ticker，这是《06》已认的设计代价。D-08 要归零的是**帧**（服务端渲染工作 + 网络），不是"每秒一次空转唤醒"——这一点决定了方案选型（见 §2.2）。

---

## 2. 方案

### 2.1 JS 侧（新文件 `wwwroot/js/lovetimer.js`）

```js
// 只读 document.visibilityState —— 不要改读 document.hidden：
// e2e 的注入法只覆盖 visibilityState（见 §5.1），读 hidden 会让用例假绿。
function makeHandler(dotnetRef) {
  return () => dotnetRef.invokeMethodAsync('OnVisibilityChanged', document.visibilityState);
}
export function register(dotnetRef) {
  const handler = makeHandler(dotnetRef);
  document.addEventListener('visibilitychange', handler);
  return handler;               // 句柄要回传给 .NET 才能注销（addEventListener 不能按函数体去重）
}
export function unregister(handler) {
  document.removeEventListener('visibilitychange', handler);
}
```

与 `gamekeyboard.js` 同机制：`IJSObjectReference` 按需 import，不挂 window 全局。

> 句柄回传注意：Blazor 的 `IJSObjectReference` 只能回传可 JSON 序列化的值，**函数不可序列化**。所以 `register` 必须返回一个可序列化句柄（例如把 handler 存进模块内的数组并返回索引），不能直接 `return handler`。v1.0 的这一行在浏览器里会得到 `undefined`，从而无法注销。

### 2.2 C# 侧：两个可选实现，推荐 A

**方案 A（推荐）：标志位 + 循环内跳过**

```csharp
private volatile bool isHidden;                        // JS 回调线程写、ticker 循环读

[JSInvokable]
public Task OnVisibilityChanged(string state)
{
    isHidden = string.Equals(state, "hidden", StringComparison.OrdinalIgnoreCase);
    if (!isHidden && !isDisposed)
    {
        RefreshAll();                    // 硬约束：先补刷（年份自愈依附于此，见《现状》:113）
        StateHasChanged();               // [JSInvokable] 不会自动渲染，与 @onclick 不同
    }
    return Task.CompletedTask;
}

// RunTickerAsync 循环体首行
while (await timer.WaitForNextTickAsync(token).ConfigureAwait(false))
{
    if (isHidden) continue;        // ← 唯一新增：不计算、不渲染、不推帧
    ...
}
```

- 优点：**3 行改动**，不碰 CTS 生命周期，不存在"Cancelled 后 StartTicker 守卫挡住重启"的坑；
- 代价：后台仍每秒唤醒一次线程池（空转），SignalR 帧归零 —— 与 D-08 的诉求一致；
- `volatile` 是必要的（写在线程池、读在 timer 线程）。

**方案 B：Cancel/重建 CTS（真正休眠）**

```csharp
case "hidden": tickerCts?.Cancel(); tickerCts?.Dispose(); tickerCts = null;   // 必须置 null！
case "visible": RefreshAll(); StartTicker();
```

- 优点：CPU 也归零；
- 代价：必须**成对**处理 `tickerCts = null`，否则 `StartTicker()` 的 `tickerCts is not null` 守卫会让恢复后**再也不启动**（静默失效，只有 LT-24/LT-32 能兜）；`using var timer` 在 Cancel 后的释放是异步的，旧循环可能还与新循环并存一个 tick 的窗口（新循环已启动、旧循环正在退出），此时两处 `InvokeAsync` 可能同时跑一帧。

**取舍**：选 A。D-08 的量级是"每连接 86400 帧/天"，A 已归零；B 多花的生命周期复杂度换不到可观测收益。

### 2.3 结构改动（v1.0 漏掉的部分）

1. `@implements IDisposable` → `@implements IAsyncDisposable`，并**保留**同步 `Dispose()` 做状态清理（`isDisposed` + CTS），由 `DisposeAsync()` 首行调用 —— 这正是《21》C-25 记录的 D-19 陷阱：实现 `IAsyncDisposable` 后渲染器**只调 DisposeAsync**，原来的 `Dispose()` 会静默变成死代码。
2. `OnAfterRender(bool)` → `OnAfterRenderAsync(bool)`，顺序固定为：

```csharp
protected override async Task OnAfterRenderAsync(bool firstRender)
{
    if (!firstRender || module is not null) return;
    StartTicker();                                   // ① 先启 ticker，保持相位（LT-31 依赖）
    keyRef = DotNetObjectReference.Create(this);      // ② 再注册 interop
    try
    {
        module = await JS.InvokeAsync<IJSObjectReference>("import", "./js/lovetimer.js");
        handlerId = await module.InvokeAsync<int>("register", keyRef);
    }
    catch (Exception) { /* 见风险表：import 失败不应让页面不可用，ticker 已在跑 */ }
}
```

3. `DisposeAsync()` 的 catch 四件套按《21》口径：`JSDisconnectedException` / `ObjectDisposedException` / `JSException` / （`TaskCanceledException` 若用超时）；两发 interop（unregister + module.DisposeAsync）**分开 try**，共用 try 会因第一发抛出而跳过第二发（《21》实测漏一项）。
4. `DotNetObjectReference` 必须 `Dispose()`，否则每进一次页面泄漏一个引用。

---

## 3. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `wwwroot/js/lovetimer.js` | 新建：`register(dotnetRef) → 可序列化句柄` / `unregister(handle)`；只读 `visibilityState` |
| 2 | `LoveTime.razor` | `@inject IJSRuntime JS`；`@implements IDisposable` → `IAsyncDisposable` |
| 3 | `LoveTime.razor` | `OnAfterRender(bool)` → `OnAfterRenderAsync(bool)`；先 `StartTicker()`、后 import + register |
| 4 | `LoveTime.razor` | 新增 `isHidden` 字段 + `[JSInvokable] OnVisibilityChanged(string)`（visible 分支先 `RefreshAll()` 再刷 UI） |
| 5 | `LoveTime.razor` | `RunTickerAsync` 循环体加 `if (isHidden) continue;` |
| 6 | `LoveTime.razor` | `DisposeAsync()` 新增：首行调 `Dispose()`，再分两发 try 做 unregister / module.DisposeAsync / keyRef.Dispose |
| 7 | `tools/e2e/tests/d08_visibility.spec.mjs` | 新建（D08-1 / D08-2 / D08-3，见 §5） |
| 8 | `tools/e2e/package.json` | 新增 `"test:d08": "playwright test tests/d08_visibility.spec.mjs"` |

**不动的**：`RefreshAll` 本体、`anchorDates`/`EnsureYearsFresh`/`yearsBuiltFor`、三行渲染与日期联动逻辑、`_Layout.cshtml`（模块按需加载）。

---

## 4. 测试计划

### 4.1 新 spec：`d08_visibility.spec.mjs`（放 d14/parent 同级，编号 D08-x）

**注入手法（已实测可行）**：`document.visibilityState` 是 `Document.prototype` 上的 getter，`Object.defineProperty(document, 'visibilityState', {get})` 会在实例上遮蔽它并生效；用完可把原 descriptor 写回。

```js
const setVisibility = (page, state) => page.evaluate(s => {
  const d = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  if (s === null) { Object.defineProperty(document, 'visibilityState', d); return; }
  Object.defineProperty(document, 'visibilityState', { get: () => s, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);
```

- **D08-1（暂停）**：`open('/loveTime')` → 注入 `hidden` → 取三次主行文本（间隔 1.2s）→ 断言**完全不变**。对照组：注入前同样三取必须变（否则说明 ticker 根本没跑，用例恒真）。
- **D08-2（恢复且先刷后启）**：还原 descriptor + 派发事件 → 2.5 秒内两次取样必须变化，**且第一次取样已是当前时间**（把页面文本里的"X 天 Y 小时 Z 分钟 W 秒"与 `Date.now()` 独立算一遍比对，容差 ≤2 秒）。这条守的就是 §2.3 的"先 RefreshAll 再恢复 tick"。
- **D08-3（年份自愈迁移）**：注入 hidden → 还原 → 断言年份选项数 `= 当前年 − 1950 + 1`，且已选年份不被重置（等价于把 `LT-32` 的性质在"后台跨年"路径上复验一次）。

### 4.2 回归门禁

1. **`test:d20`**：LT-31（相位/三行秒级同步）、**LT-32（年份自愈）必须全绿** —— 这是《现状》:113 预警的直接守卫，也是 v1.0 写错门禁的那一条；
2. **`test:lt`**：LT-01~LT-24 全绿（尤其 LT-19 切页速率、LT-22 三行秒数一致、LT-ERR 无未处理异常）；
3. **`test:d03`**：LT-25~LT-30 日历换算不受影响（`RefreshAll` 未改）；
4. **`test:smoke`**：六页可达；
5. **手工**：后台挂 60 秒，DevTools → Network → WS 帧数应≈0；`dotnet run` 控制台无新异常。
6. 门禁命令：`npm run test:lt && npm run test:d20 && npm run test:d03 && npm run test:d08 && npm run test:smoke`。

### 4.3 LT-24 的既有缺陷（建议顺手登记）

`lt.spec.mjs:294` 的「后台标签 30 秒后返回数值仍正确」用 `bg.bringToFront()` 造后台，**headless 下不产生 hidden、不派发 visibilitychange**（实测：切走 2.5 秒后 `visibilityState` 仍 `visible`，事件日志只有初始一条）。所以：

- 它今天的断言（"秒数 > 0 且三行可解析"）恒真，注释里的"后台持续渲染属已知 D-08"从未被真正验证；
- 本单不改它（改了会与 D-08 的判据缠绕），但应在《现状》/《07》登记为"弱用例——依赖 bringToFront 的可见性语义，headless 不成立"，或后续改用 §4.1 的注入法重写。

---

## 5. 风险与边界

| 风险 | 处置 |
|---|---|
| `IAsyncDisposable` 落地后 `Dispose()` 变死代码（D-19） | `DisposeAsync()` 首行显式调用 `Dispose()`；Grep 检查是否还有别处 new 出本组件（无） |
| 恢复分支不刷 → 年份自愈失效（《现状》:113） | §4.1 的 D08-2/D08-3 双守；`LT-32` 兜底 |
| JS handler 读 `document.hidden` 导致注入法失效 | 模块注释写死"只读 visibilityState"；D08-1 的对照组（注入前必须变）能间接发现"注入没生效" |
| `register` 回传函数被序列化成 `undefined` → 永远注销不掉 | 回传可序列化句柄（索引/字符串），不要回传函数 |
| `RunTickerAsync` 的 `catch (Exception)` 吞掉一切 | 本次不改（会牵动《06》的沉默退出语义），但在 `OnVisibilityChanged` 里不写复杂逻辑，只做"置标志 + RefreshAll" |
| `isHidden` 跨线程可见性 | 声明 `volatile`；写入与读取不在同一线程（timer 回调 vs interop 调用） |
| 某些浏览器后台节流导致 visibilitychange 延迟 | 恢复晚一点，无正确性影响；hidden 分支靠"切走那一刻的事件"，不受节流影响（事件本身在切走时立即触发） |
| 移动端切 App 到后台 | 同语义，一并受益；真机需手工确认一次（§4.2 第 5 条） |

---

## 6. 台账与文档同步（实施后执行）

1. **《现状》**：版本 +1；LoveTime 行补「秒刷在 hidden 期间跳过（D-08）」「年份自愈已迁移到 visible 分支（P-014 依赖关系闭合）」；**:113 那条预警**改写为已闭环；§4 待改进表删 D-08。
2. **《更新记录》**：顶部加一条，写清 6 个代码改动 + 8 项门禁结果。
3. **《07》**：新增 D08-1~3 与 `test:d08` 入口；LT-24 标注为弱用例（若采纳 §4.3）。
4. **编号**：C 号从 **C-27** 起（C-24~C-26 已被《21》占用，22 号不占号）。建议 C-27 = D-08。
5. **测试用例计数**：新增 3 条（D08-1/2/3），总数 132 → 135。

---

## 7. 状态

- 文档状态：**待实施**（v2.0，方案落点已与现有代码对齐）
- 阻塞项：无
- 改动面：`LoveTime.razor` 1 个文件（生命周期 + 4 处逻辑）、1 个 JS 新文件、1 个 spec 新文件、`package.json` 1 行
