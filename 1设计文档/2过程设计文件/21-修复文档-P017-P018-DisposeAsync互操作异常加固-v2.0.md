# 21 - 修复文档：P-017/P-018 DisposeAsync 互操作异常加固（含 Firefox 偶发异常根因）

> 来源：《3测试报告/2026-11-06.md》§6.1 P-017 / P-018　|　日期：2026-11-06　|　状态：待实施
> 版本：**v2.0**（检视修订版，v1.0 保留作对照）
> 检视基线：`5e9c3bd` + 工作区未提交改动（《18》存档完整性加固 / 《19》恢复与落盘生命周期 / 《20》爱情计时器一致性 均已落地于 `Game_2048.razor`、`LoveTime.razor`、`site.css`）
> 检视方式：源码逐行核对 + 反编译 `blazor.server.js`（站点实取）定位报错抛出点 + 3 组浏览器实测（Chromium / Firefox，14074）

---

## 0. 检视结论摘要

v1.0 的**意图**是对的（拆除路径不该让异常逃逸），但它的三条核心论断里有两条与框架实际行为不符，导致「修 18 验 17」这个闭环**在原理上不成立、在验收上不可证伪**：

| # | v1.0 论断 | 检视结果 | 等级 |
|---|---|---|---|
| 1 | 「页面拆除时这一发（`unregister`）会落到『没有 interop 方法的 renderer』」 | **错**。该文案唯一抛出点是 `getInteropMethods(rendererId)`，只被 **Blazor 自己的 DOM 事件派发**调用；`.NET→JS` 调用（`unregister`）走的是另一条路径，**从不查这张表** | 阻塞（根因定性错误） |
| 2 | 「补 `catch (JSException)` → 修复 P-017」 | **错**。`unregister` 只做比较与 `removeEventListener`，不可能抛 `JSException`；拆除期 .NET 侧抛的是 `JSDisconnectedException` / `ObjectDisposedException`（已 catch）。**补上它是防御性对齐，不是修复** | 阻塞（验收落空） |
| 3 | 「P-017 ≈33% 复现，修复后 0/6」 | **不可证伪**。我按两种更极端的方式（主动关 WS、直接杀服务端进程）各试一次，都**没有**复现出该文案；本机无法在修复前造出红样本，则「0/6 通过」不构成证据 | 阻塞（判据无效） |
| 4 | （未提及） | 拆除期**确实存在**可稳定复现的未捕获异常，但它来自 `blazor.server.js`/SignalR 内部，**改 C# 或改 `gamekeyboard.js` 都拦不住**（下方 §4 有 A/B 实验） | 新增（框架级，登记不修） |
| 5 | （未提及） | `Tetris.DisposeAsync` 把 `Dispose()` 放在**最后**一行 → 两个 await 期间 `isDisposed` 仍为 `false`，3 个 Timer 继续跑（2048 是首行置位）。**这是本文件真正该修的对称性缺口** | 新增（D-19） |
| 6 | （未提及） | 两页 `OnAfterRenderAsync` 在 `await import/register` 之后**没有复检 `disposed`**；组件在此期间被销毁时仍会完成注册，`register()` 内部 `removeListeners() + ++seq` 会抢走新页的监听 | 新增（低成本守卫） |
| 7 | 测试计划 1（Firefox 6 轮）／3（门禁） | 新写的 `d2x_*.spec.mjs` **不会被 firefox 项目收录**（`testMatch` 只认 `code_nf.spec.mjs`）；实测 `--project=firefox` 直接 `No tests found`，不加 `--project` 则只跑 chromium、`test.skip(browserName!=='firefox')` 恒跳过 → **假绿** | 阻塞（测试计划不可执行） |
| 8 | 行号引用 `Game_2048.razor:445` | 已漂移：`Game_2048.razor:445` 现在是恢复分支里的 `try {`；`DisposeAsync` 在 **521-537**（《18》《19》共 +76 行）。`Tetris.razor:1091` 仍准确 | 轻微 |

**一句话**：本文件应改名为「拆除路径的异常覆盖与释放顺序对齐」——把 §5.1/§5.2 的 2 处必做改掉，把 P-017 降级为「框架级观察项」，并换掉那两条跑不起来的验证。

---

## 1. 两条问题的重新定性

### 1.1 P-018（确定，代码健壮性）——成立，但等级下调

`Game_2048.razor:521-537` 与 `Tetris.razor:1085-1102` 的 `DisposeAsync` 确实只 catch 两个异常：

```csharp
catch (JSDisconnectedException) { /* 断线/关页，无需清理 */ }
catch (ObjectDisposedException) { /* 电路已释放 */ }
```

而**同一文件内其余三处 interop 都是「四件套」**（`Game_2048.razor:412-414` 的 `SaveSessionAsync`、`476-479` 的恢复分支、`389-391` 的 `WriteBestAsync`）。所以「补齐 `JSException`」的**真正理由是文件内一致性**，不是可达性——按 §2 的取证，这一 catch 在 `DisposeAsync` 里**基本不可达**。

### 1.2 P-017（偶发）——根因不在应用侧

报告记的固定文本是 `No interop methods are registered for renderer 1`（`blazor.server.js:1:13739`）。这句话在框架里只有**一个**抛出点，见 §2。它属于「Blazor 把**浏览器事件**转发给 .NET」这条链路，而 `DisposeAsync` 里做的是反方向（.NET 调 JS）。两者不共用任何代码路径。

因此：**P-018 不可能是 P-017 的根因**，v1.0 的「修 18 验 17」前提不成立。

---

## 2. 取证：那句话到底从哪抛出来

从运行中的站点取框架文件（`curl http://localhost:14074/_framework/blazor.server.js`，151,672 B），检索该文案，唯一命中：

```js
function k(e,t,n){ return D(e, t.eventHandlerId, (()=>T(e).invokeMethodAsync("DispatchEventAsync", t, n))) }
function T(e){ const t=S.get(e); if(!t) throw new Error(`No interop methods are registered for renderer ${e}`); return t }
```

- `S` 是 **rendererId → interop 方法表**；
- `k()` 就是 **DOM 事件派发**（`@onclick` / `@onkeydown` 等被代理到服务端时走它）；
- 该文案在文件中的偏移 ≈ 13749，与报告写的 `1:13739` 吻合（差值是 `throw new Error(` 的起始位置），可确认报告抓的就是这一段。

再找这张表的**删除点**，只有一处：

```js
o.onclose((e)=>{
  this._interopMethodsForReconnection = (function(e){
    const t = S.get(e);
    if (!t) throw new Error(`Interop methods are not registered for renderer ${e}`);
    return S.delete(e), t;
  })(wn.Server),
  ...
})
```

即：**连接一断（`onclose`）→ 该 renderer 的 interop 表被移出 → 此后任何被代理的 DOM 事件都会抛 P-017 的那句话**。而 `.NET→JS` 的调用是：

```js
invokeJSFromDotNet(e,t,n,r){ ... _(e,r)(...o||[])... }        // 直接查模块函数表，不碰 S
beginInvokeJSFromDotNet(e,t,n,r,o){ ... _(t,o)(...r||[]) ... }  // 同上
```

`unregister` 走的就是这两个——**永远不会命中 `T(e)`**。这是 v1.0 机制描述错误的直接证据。

---

## 3. 实测：三次尝试都没造出 P-017，但造出了另一个东西

| 实验 | 手段 | 结果 |
|---|---|---|
| A | `context.setOffline(true)` 保持 12s | Blazor **未进入 onclose**（`#components-reconnect-modal` 的 class 始终为空，说明 `onConnectionDown` 没触发）→ 无任何错误 |
| B | 注入脚本劫持 `WebSocket` 后主动 `ws.close()` | SignalR 已认「不在 Connected 状态」，但 `onclose` 仍未走到 Blazor 层 → 点方向键按钮**无报错**（若 `S` 真被删，必抛那句话） |
| C | 直接 `taskkill` 杀服务端进程（真正的电路消失） | 控制台出现 `Connection disconnected with error 'WebSocket closed with status code: 1006'`，随后 negotiate 失败；**点方向键按钮依然不抛** `No interop methods...`；**按键盘则抛 2 条** `Cannot send data if the connection is not in the 'Connected' State.` |

结论：**P-017 在本机不可复现**（与报告作者本人的全量结果一致：报告里也写了「本轮我的全量里 Firefox NF-01 通过、未复现」）。既然修复前造不出红样本，「修复后 0/6」这条验收就没有信息量。

---

## 4. 顺带挖出的可复现缺陷（框架级，应用侧不可修）

实验 B/C 里那 2 条 `Cannot send data if the connection is not in the 'Connected' State.` 是**稳定复现**的（3/3），栈顶直指自家代码：

```
at pn.send (blazor.server.js:1:83300)
at Ir.beginInvokeDotNetFromJS (blazor.server.js:1:138424)
at y.invokeDotNetMethodAsync (blazor.server.js:1:4125)
at S.invokeMethodAsync (blazor.server.js:1:5633)
at keydownHandler (js/gamekeyboard.js:52:9)   ← 按一次键 = 2 条（keydown + keyup 各一条）
at keyupHandler  (js/gamekeyboard.js:57:9)
```

关键在于 **A/B 对照**：

| 变体 | 断线后按一次 ← 的错误条数 |
|---|---|
| 现状（`.catch(() => {})`） | **2** |
| 外面再套一层 `try { ... } catch { }` | **2**（无效） |
| 把 `invokeMethodAsync` 整行注释掉（不打 interop） | **0** |

也就是说：错误确实由我们的 `invokeMethodAsync` 触发，但 `gamekeyboard.js:51` 注释里那句「Promise 会被 reject，不接住会污染控制台」的假设**不成立**——它不是我们能接住的 rejection，而是 `blazor.server.js` 内部在被捕获后**另起**的未处理拒绝（Playwright 会把它报成 `pageerror`，已用一条 `Promise.reject(new Error('BASELINE'))` 校准过通道）。

**处置**：登记为框架级噪声，**不改** `gamekeyboard.js`（改了也没用，反而留下「已处理」的错误印象）。它只在「连接已断 + 用户还在按键」时出现，此时游戏本来就不可玩；且 `NF-06`（遍历 6 页控制台无红色异常）不按方向键，不会被它误红。

---

## 5. 修订后的方案

### 5.1 必做（2 处，各 1 行）：catch 列表对齐

两个文件的 `DisposeAsync` 补 `JSException`，定位写清「防御性对齐，非 P-017 修复」：

```csharp
catch (JSDisconnectedException) { /* 断线/关页，无需清理 */ }
catch (ObjectDisposedException) { /* 电路已释放 */ }
catch (JSException) { /* 防御性：本方法的两发 interop 都不该抛 JSException，
                         与本文其余三处 interop 的四件套保持同口径（见 SaveSessionAsync） */ }
```

`catch (JSException)` 必须放在 `catch (Exception)` **之前**（本方法没有 `catch (Exception)`，保持现状即可，不要图省事写一个宽 catch）。

### 5.2 必做（Tetris 顺序，1 行搬家）：`Dispose()` 提到首行

现状（`Tetris.razor:1085-1102`）：

```csharp
public async ValueTask DisposeAsync()
{
    if (keyModule is not null)
    {
        try { await keyModule.InvokeVoidAsync("unregister", keyRegId); await keyModule.DisposeAsync(); }
        catch (JSDisconnectedException) { } catch (ObjectDisposedException) { } catch (JSException) { }
        keyModule = null;
    }
    keyRef?.Dispose(); keyRef = null;
    Dispose();   // ← 现在在最后
}
```

问题：`Dispose()` 里才是 `isDisposed = true; StopTimers();`。**两个 await 之间，`isDisposed` 仍是 false**，三个 Timer 照常回调 `DropPiece/SoftDropPiece/IncreaseDifficulty` → `StateHasChanged()`。连接已死时 `InvokeVoidAsync` 的完成可能拖到秒级，这段时间里组件在「已开始拆除」的状态下继续跑。

而 2048 是反过来的（`Game_2048.razor:523` `disposed = true;` 在**第一行**）。→ 把 `Dispose();` 移到方法首行，与 2048 对称：

```csharp
public async ValueTask DisposeAsync()
{
    Dispose();   // ★ 先置 isDisposed + 停 3 个 Timer（与 2048 的 disposed = true 对称），
                 //   不要留在末尾：两个 await 之间 Timer 仍在跑，会继续 StateHasChanged
    if (keyModule is not null) { ... }
    keyRef?.Dispose(); keyRef = null;
}
```

`Dispose()` 里有 `if (isDisposed) return;` 语义吗？没有——但 `StopTimers()` 对 null 有保护、`isDisposed = true` 幂等，重复调用安全（Blazor 只调一次 `DisposeAsync`，`Dispose()` 不会被框架再次调用，因为本类只 `@implements IAsyncDisposable`）。

### 5.3 建议（对称性守卫，2 处约 10 行）：await 之后复检 `disposed`

现状两页都是「先判后 await」：

```csharp
if (keyModule is not null) return;                 // Game_2048:490
keyRef = DotNetObjectReference.Create(this);
keyModule = await JS.InvokeAsync<IJSObjectReference>("import", "./js/gamekeyboard.js");
keyRegId = await keyModule.InvokeAsync<int>("register", keyRef, new { repeatKeys = ... });
```

若在 `import`/`register` 期间组件被销毁（SPA 快速切页），`DisposeAsync` 早已跑完（那时 `keyModule` 还是 `null`，什么都没卸），而续体回来后照样 `register` —— `register()` 第一句是 `removeListeners()`，会把**新页刚装上的监听**拆掉并把 `currentId` 换成自己的，`activeRef` 指向一个已 Dispose 的 `DotNetObjectReference`。

补法（两页同款）：

```csharp
        keyRef = DotNetObjectReference.Create(this);
        keyModule = await JS.InvokeAsync<IJSObjectReference>("import", "./js/gamekeyboard.js");

        // 复检：import 期间组件可能已被销毁，而 DisposeAsync 当时 keyModule 还是 null（什么都没卸）
        if (disposed)                                  // Tetris 用 isDisposed
        {
            try { await keyModule.DisposeAsync(); }
            catch (JSDisconnectedException) { } catch (ObjectDisposedException) { } catch (JSException) { }
            keyModule = null;
            keyRef.Dispose(); keyRef = null;
            return;
        }
```

**等级说明**：这不是确证缺陷。`import` 的 Promise 在文档内只解析一次，两页的续体按注册顺序执行，实测顺序稳定；且既有 **D02-9（跨页注册竞态：导航切换后键盘归属正确）** 已经在 `test:d02` 门禁里守着最终归属。所以这条是「低成本对称性补强」，若不想扩大改动面，**可以只做 5.1 + 5.2**。

### 5.4 建议（资源）：`unregister` 与 `DisposeAsync` 拆两个 try

现状两者共用 try：若 `unregister` 抛出（`JSException`），`keyModule.DisposeAsync()` 会被跳过，然后 `keyModule = null` 把唯一的引用丢掉 → JS 侧对象引用表泄漏一项。拆分：

```csharp
    try { await keyModule.InvokeVoidAsync("unregister", keyRegId); }
    catch (JSDisconnectedException) { } catch (ObjectDisposedException) { } catch (JSException) { }
    try { await keyModule.DisposeAsync(); }
    catch (JSDisconnectedException) { } catch (ObjectDisposedException) { } catch (JSException) { }
```

### 5.5 明确不做（每条都有理由，避免后人重复试）

| 不做 | 理由 |
|---|---|
| 改 `gamekeyboard.js` 的 `.catch(() => {})` 或加 try/catch | §4 的 A/B 实测：**两种都无效**，错误由框架内部另起，加壳只会造成「已处理」的错觉 |
| 为 P-017 写自定义 Firefox 6 轮循环 | §7.1：新 spec 进不了 firefox 项目；且本机不可复现，判据无意义 |
| 把 `DisposeAsync` 改成 `catch (Exception)` | 会顺带吞掉 `OperationCanceledException` 之外的编程错误；四件套已是本仓库的既有精度 |
| 给 `DisposeAsync` 加超时/`CancellationToken` | `IAsyncDisposable.DisposeAsync()` 无参，无处注入；Blazor 也没有超时机制 |

---

## 6. 改动清单

| # | 文件 | 位置 | 改动 |
|---|---|---|---|
| 1 | `Pages/MyPage/Game_2048.razor` | `DisposeAsync` `L531-532` 之后 | 补 `catch (JSException)` + 注释（1 行） |
| 2 | `Pages/MyPage/Tetris.razor` | `DisposeAsync` `L1094-1095` 之后 | 补 `catch (JSException)` + 注释（1 行） |
| 3 | `Pages/MyPage/Tetris.razor` | `DisposeAsync` `L1085` → 首行 | `Dispose();` 从 `L1101` 移到方法首行 |
| 4 | （可选）两页 | `OnAfterRenderAsync` 键盘注册段 | `import` 之后复检 `disposed`（§5.3，约 10 行/页） |
| 5 | （可选）两页 | `DisposeAsync` | 拆两个 try（§5.4） |

其余（注册逻辑、`keyRef` 释放时机、`keyRegId` 语义、`gamekeyboard.js`）**一行不动**。

---

## 7. 测试计划

### 7.1 先纠正三条跑不起来的验证

| v1.0 计划 | 为什么跑不起来 | 换成什么 |
|---|---|---|
| 1. Firefox 下 NF-01 序列循环 6 轮 | **新 spec 进不了 firefox 项目**：`playwright.config.mjs` 的 `projects[1].testMatch = /code_nf\.spec\.mjs/`。实测 `npx playwright test tests/d20_lt_consistency.spec.mjs --project=firefox --list` → `Error: No tests found`；不加 `--project` 则只列 `[chromium]` 两条，`test.skip(browserName!=='firefox')` 恒跳过 → **报告 1 skipped、退出码 0 的假绿** | 直接用 `npm run test:nf`。实测共 21 条，firefox 侧 7 条（NF-01/02/02b/03/04/06/05-07-08）、chromium 侧含 D-11 三条与 D-12 六条。**NF-01 本身就断言 `errs.length === 0`，NF-06 是专门的控制台巡检**——工具已在，不必新写 |
| 2. 「既有 D02 用例回归」 | 描述不具体，无法执行 | 精确到 **D02-9（跨页注册竞态）+ D02-14（键盘与按钮混用全程无 JS 异常）**，都在 `test:d02` |
| 4. 「服务端日志人工项：连续进出 10 次」 | 无判定标准（"无未处理异常"看哪一行？） | 改为：`dotnet run` 控制台出现 `Unhandled exception` / `fail:` 即失败；且这轮**必须先做 §5.2**，否则观察对象里混着 Timer 噪声 |

### 7.2 可执行的验证

| # | 验证 | 命令 / 方法 | 判定 |
|---|---|---|---|
| 1 | 两个游戏页反复进出后键盘仍正常、无 console 异常 | `npm run test:d02`（含 D02-9 / D02-14） | 全绿 |
| 2 | 2048 / Tetris 主流程无回归 | `npm run test:g2048` + `npm run test:tris` | 全绿 |
| 3 | 导航与首页不回归（改的是两页 markup 之外的 C#） | `npm run test:smoke` | 全绿 |
| 4 | **双浏览器**控制台无红线（P-017 的唯一合法载体） | `npm run test:nf` | 全绿（含 firefox NF-01/NF-06） |
| 5 | 拆除期不再出现 `Unhandled exception` | 手工：连开连关两游戏页 10 次，盯 `dotnet run` 控制台 | 无 `Unhandled exception` |
| 6 | （观察，不进 CI）断线后按键的噪声条数 | 见 §8.2 的 NF-10 | 只记录，不判红 |

### 7.3 门禁组合

```bash
npm run test:d02 && npm run test:g2048 && npm run test:tris && npm run test:nf && npm run test:smoke
```

注意：`test:tris` / `test:g2048` 的 `webServer.reuseExistingServer: true` 会复用已在跑的实例。**改了 .razor 必须先重启**（否则跑的是旧 IL，我此前踩过：`reuseExistingServer` 复用了未重建的实例，四条断言假红）。

---

## 8. 台账登记

### 8.1 缺陷编号

| 编号 | 模块 | 描述 | 来源 | 关闭号 |
|---|---|---|---|---|
| **D-18** | G2048/TRIS | `DisposeAsync` 的 interop 清理段只 catch 两个异常，与同文件其余三处 interop 的「四件套」不一致（P-018）。可达性低，属一致性补齐 | 报告 P-018 | **C-24** |
| **D-19** | TRIS | `DisposeAsync` 把 `Dispose()`（`isDisposed=true` + `StopTimers()`）放在末尾，两个 await 期间 3 个 Timer 仍在跑；应与 2048 的「首行置位」对称 | 本次检视新增 | **C-25** |

> **关闭号已按队列排到 C-24/C-25，不是 C-22/C-23**。当前台账（§10.2）最大只到 C-21，但**未落地文档已占号**：《19》占 C-19/C-20/C-21，《20》应占 C-22/C-23。而《20》v2.0 正文里写的仍是 `C-19/C-20`，与《19》**直接冲突**——落地《20》前必须先把它改成 `C-22/C-23`（这条也写进了《20》的待修项）。本文件排在其后，故取 C-24/C-25；若实际落地顺序变成 21 先于 20，则本文件改用 C-22/C-23、20 顺延为 C-24/C-25，**两者不可同时用同一号**。

> `P-017` **不占 D 号**：它是框架级竞态（`blazor.server.js` 在 `onclose` 删表后仍派发事件），应用侧无修复点。建议在下一版报告 §6.1 末尾加一行分类说明：「P-017：框架级，登记不修；本机两轮独立尝试均未复现（见《21》§3）」。

### 8.2 用例编号

新增 **NF-10**（观察项，**不设门禁**）：断线后按方向键产生的错误条数。放 `code_nf.spec.mjs` 的 NF describe 内，这样 firefox 项目会收录：

```js
  test('NF-10 观察：断线后按键的框架级噪声（不设门禁）', async ({ page }) => {
    // 背景：《21》§4 实测——连接断开后按键会让 blazor.server.js 抛
    // "Cannot send data if the connection is not in the 'Connected' State."
    // 且 .catch()/try-catch 均无效（框架内部另起未处理拒绝）。本条只记录条数，不判红。
    await page.addInitScript(() => {
      const Orig = window.WebSocket;
      window.__ws = [];
      window.WebSocket = class extends Orig { constructor(...a) { super(...a); window.__ws.push(this); } };
    });
    const errs = trackErrors(page);
    await open(page, '/game_2048', 2000);
    await page.evaluate(() => window.__ws.forEach(w => { try { w.close(); } catch { } }));
    await sleep(2500);
    const before = errs.length;
    await page.keyboard.press('ArrowLeft');
    await sleep(1200);
    const delta = errs.length - before;
    check('NF-10', true, `断线后按一次 ← 新增错误 ${delta} 条（基线：2；仅记录，不判红）`);
  });
```

汇总表改动：`NF 9 → 10`。合计要**分两步**算，不要直接写 130：

| 时点 | 合计 | 说明 |
|---|---|---|
| 当前台账（含《18》《19》的 G2048-37~45） | **129** | LT 30 / G2048 45 / NF 9 |
| 《20》落地后 | **131** | LT 30 → **32**（LT-31/32），G2048 不变 |
| 本文件落地后 | **132** | NF 9 → **10**（NF-10） |

> 为什么不加 G2048/TRIS 用例：§5.2 是「顺序搬家」、§5.3 是「非确证竞态」，两者都**没有确定性的红/绿差异**可断言；强行加只会得到一条恒真的用例（比没有更糟）。它们的验收靠 §7.2 的 1~5。

---

## 9. 文档同步清单（代码落地后再改，本次不动）

| 文件 | 改动 |
|---|---|
| `1代码结构与更新记录/测试文档-全量测试用例.md` | ① §10.1 增 D-18 / D-19；② §10.2 在既有最大号之后顺延增 C-24 / C-25（**先确认《19》《20》已各自占号**，见 §8.1 的冲突说明）；③ §11.2 用例表加 NF-10；④ §11.4 汇总表 `NF 9→10`、`合计 129→132`（其中 LT 30→32 由《20》带入）；⑤ §12「手工保留项」补一句 NF-10 为观察项 |
| `1代码结构与更新记录/夜游桃花源网站技术栈与代码结构现状.md` | ① 版本号 **v1.18 → v1.19**；② §3.x 两处 `DisposeAsync` 描述改为「四件套 + 首行置位」；③ 若做 §5.3，补一句「键盘注册在 await 后复检 disposed」；④ 待改进项无需增删（D-18/D-19 落地即关） |
| `1代码结构与更新记录/更新记录.md` | 顶部追加一条：`2026-11-06 \| <commit> \| 2048/Tetris 拆除路径加固（D-18/D-19 → C-24/C-25，P-018；P-017 降级为框架级观察项）` |
| `3测试报告/2026-11-06.md` | **不改本轮记录**（执行事实快照）。下一版报告：P-018 置「已修」；P-017 置「框架级，本机未复现，转观察」 |

---

## 10. 残余风险（如实登记，不承诺消除）

1. **P-017 未归零也不能归零**：它发生在「连接已断 + 用户仍有交互」的窗口内，属框架行为。若下一轮又出现，应作为**环境/网络**问题排查（Firefox + 本地 IIS Express 的 WS 握手），而不是继续在 `DisposeAsync` 里加 catch。
2. **断线后按键的 2 条噪声依旧存在**（§4）。它在 `NF-06` 的视野里，但 `NF-06` 不按方向键，所以不会误红；若将来有人把「断线后按键」写成断言，会得到一条**永远红**的用例。
3. **§5.3 的竞态只是收窄，不能证明消除**：`register()` 是跨 circuit 的第二次 await，两页续体的实际先后仍取决于 SignalR 往返；`D02-9` 守的是最终归属，不是「中间态从不抢占」。
4. **`Tetris.Dispose()` 提前后，`StopTimers()` 会在 interop 之前执行**：若 `unregister` 因此拿不到 `keyRegId`……不会——`keyRegId` 是独立字段，与 Timer 无关。这一条写在这里只为提醒复核者：改顺序时**不要顺手把 `keyRegId = 0` 也提到前面**，否则 `unregister` 会传入旧的 id，`unregister` 里 `id !== currentId` 直接短路，监听就卸不掉了。

---

## 附：v1.0 → v2.0 改动索引

| v1.0 段落 | 变化 |
|---|---|
| §1 P-018 描述 | 保留事实，删除「是 P-017 的疑似根因」这一因果（§1.2 反证） |
| §1 P-017 描述 | 补「本机两轮尝试未复现」与框架级定性 |
| §2 修复方案 | 保留代码片段，重写「要点」：语义正确性论据由「清理目标已不存在」改为「与同文件四件套对齐」；新增 §5.2~5.5 |
| §3 改动清单 | 2 项 → 3 必做 + 2 可选；行号由 `445` 修正为 `521` |
| §4 测试计划 | 4 项全部重写（3 项不可执行/1 项无判据），见 §7 |
| §5 实施后流程 | 拆成 §9 同步清单（含下一版报告的置位口径） |
