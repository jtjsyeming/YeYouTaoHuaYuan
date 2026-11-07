# 24 - 修复文档：H-003（D-08 后台标签仍每秒推送 SignalR 帧）

> 来源：《3测试报告/2026-11-06.md》总结表 H-003（台账号 D-08）。
> 单独成文理由：这是唯一涉及 LoveTime 页计时器生命周期与 JS interop 注册的改动，与 23/25 号文档无文件交集。
> 性质：仅设计文档，未动代码。

---

## 1. 问题与现状

`LoveTime.razor` 的秒级计时器（`System.Timers.Timer`，1s 周期）只要 circuit 存活就一直跑：

- 用户把标签切到后台（看别的页、干活去了），页面整夜挂着；
- 每 1000ms 一次 `RefreshAll()` + `StateHasChanged()` → SignalR 逐帧推送到一个**用户根本看不见的标签**；
- 量化：单个后台标签每天 **86,400 帧**无意义推送；多人同时挂着时是服务端纯浪费（本站无持久化、每连接 1 个 Timer，这是《06》文档已知的设计代价，本方案把它在后台场景下归零）。

相关现状（已核实）：

- `RefreshAll()`（`:188`）是三行同源唯一汇聚点，内含 `EnsureYearsFresh()`（C-23 的跨年自愈依附于秒刷）；
- `OnAfterRender(firstRender)`（`:130`）已有 ServerPrerendered 守卫模式（只交互实例执行）；
- 页面尚无任何 JS 模块 interop（与 Tetris/2048 的 `gamekeyboard.js` 模式不同，这里是**新增**第一处）。

## 2. 方案：visibilitychange 暂停/恢复 ticker

### 2.1 JS 侧（新文件 `wwwroot/js/lovetimer.js`）

```js
export function register(dotnetRef) {
    const handler = () => dotnetRef.invokeMethodAsync('OnVisibilityChanged', document.visibilityState);
    document.addEventListener('visibilitychange', handler);
    return handler;   // 供注销用
}
export function unregister(handler) {
    document.removeEventListener('visibilitychange', handler);
}
```

沿用工键盘的模块化注册模式（`module.ImportAsync`），不挂 window 全局。

### 2.2 C# 侧（`LoveTime.razor`）

- `OnAfterRenderAsync(firstRender)` 现有 firstRender 分支内：注册 JS 模块 + `DotNetObjectReference.Create(this)`（**注意**：与本页已有的 `OnAfterRender(bool)` 是两个不同生命周期方法，实施时统一合并到 `OnAfterRenderAsync` 或保持现有 `OnAfterRender` 而把模块注册放进去，二选一，不新增第三处入口）；
- 新增 `[JSInvokable] public Task OnVisibilityChanged(string state)`：
  - `"hidden"` → `ticker?.Stop()`；
  - `"visible"` → `RefreshAll()`（**先刷再启**，把后台期间欠的更新一次补齐）→ `ticker?.Start()`；
- `DisposeAsync`：注销监听 + 模块 Dispose，catch 列表按 C-24 四件套（`JSDisconnectedException` / `ObjectDisposedException` / `JSException`）。

### 2.3 两个设计要点

1. **跨年自愈不受损（反而是受益方）**：C-23 的 `EnsureYearsFresh` 依附于 `RefreshAll`。后台跨年后切回 → `"visible"` 分支先 `RefreshAll()` → 年份列表立即自愈，比原来"等下一秒 tick"还快。实施后 LT-32（年份自愈回归用例）必须全绿，这正是《15》文档预留的回归点；
2. **多标签各自独立**：visibilitychange 是标签级事件，每个 circuit 管自己的 ticker，无共享状态。

## 3. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `wwwroot/js/lovetimer.js` | 新建：register/unregister 两个导出 |
| 2 | `LoveTime.razor` | 注入 `IJSRuntime`（若已有则复用）；firstRender 分支内注册模块与 DotNetObjectReference |
| 3 | `LoveTime.razor` | 新增 `OnVisibilityChanged(string)` JSInvokable 方法（hidden 停 / visible 先刷后启） |
| 4 | `LoveTime.razor` | `DisposeAsync` 补注销 + 四件套 catch |
| 5 | `_Layout.cshtml` | 无需改（模块按需加载，与工键盘同机制） |

**不动的**：`RefreshAll` 本体、锚点字典、三行渲染逻辑、`yearsBuiltFor` 自愈结构。

## 4. 测试计划

1. **e2e（新 spec `d24_visibility.spec.mjs`，2~3 断言）**：Playwright 无法真隐藏标签，用语义等价注入——
   `Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })` + `dispatchEvent(new Event('visibilitychange'))`；
   - 断言 A（暂停）：注入 hidden 后 3 秒窗口内三行主行文本**零变化**（对照注入前每秒必变）；
   - 断言 B（恢复）：恢复 visibilityState 为 'visible' + 派发事件后 2 秒内文本恢复跳动，且第一帧即为当前时间（先刷后启）；
2. **LT-32 回归**：`npm run test:lt` 全绿（C-23 年份自愈不受影响）；
3. **手工观察项**（登记不自动化的理由：服务端帧数无法从 e2e 侧断言）：后台 1 分钟，服务器日志/网络面板确认无 LoveTime 相关帧——与 TRIS-23 同类人工项；
4. **门禁**：`npm run test:lt + test:d24 + test:smoke` 全绿 → 登记执行历史 → 关闭 D-08。

## 5. 风险与边界

| 风险 | 处置 |
|---|---|
| 某些浏览器后台节流导致 visibilitychange 延迟触发 | 只是恢复晚一点，无正确性影响；hidden 分支收益不受影响 |
| `invokeMethodAsync` 在 circuit 断开时抛异常 | handler 内由 Blazor 静默丢弃（连接断开后调用返回 rejected promise），Dispose 路径另有四件套兜底 |
| 预渲染实例重复注册 | 复用 firstRender 守卫，与现有模式一致 |
| 移动端切 App 到后台 | 与标签隐藏同语义（visibilitychange 同样触发），一并受益 |
