# 21 - 修复文档：P-017/P-018 DisposeAsync 互操作异常加固（含 Firefox 偶发异常根因）

> 来源：《3测试报告/2026-11-06.md》§6.1 P-017 / P-018　|　日期：2026-11-06　|　状态：待实施
> 合并理由：P-018 是**根因**（代码健壮性缺口），P-017 是其**疑似表现**（Firefox 偶发 interop 异常）——修 18 验 17，一个文档闭环
> 证据：FT/静态审查（P-018 确定）；同日独立报告 §4（P-017 偶发 ≈33%，本报告未独立复现，证据等级较低）

---

## 1. 两条问题

**P-018（确定，代码健壮性）**：`Game_2048.razor:445` 与 `Tetris.razor:1091` 的 `DisposeAsync` 调用 `keyModule.InvokeVoidAsync("unregister", …)`，catch 列表只有 `JSDisconnectedException` / `ObjectDisposedException`。**页面拆除时渲染器可能已注销**，此时 interop 调用抛出的 `JSException`（如 `No interop methods are registered for renderer N`）无人接住，从 Dispose 路径逃逸。

**P-017（偶发，疑似 P-018 的表现）**：Firefox 下 `/game_2048` 载入期偶发 `No interop methods are registered for renderer 1`（6 轮复现 2 次），DOM 断言全通过、功能无影响，属渲染器/电路拆除期竞态。文本与 P-018 缺口完全吻合——**修 P-018 后按观察项跟踪 P-017 是否归零**，不单独为 17 设计修复。

## 2. 修复方案

两个文件的 `DisposeAsync` 中，interop 清理段的 catch 列表**补 `JSException`**：

```csharp
catch (JSDisconnectedException) { /* 断线/关页，无需清理 */ }
catch (ObjectDisposedException) { /* 电路已释放 */ }
catch (JSException) { /* 渲染器已注销（拆除期竞态）：清理目标本就随渲染器消失，静默 */ }
```

要点：

- 语义正确性：`unregister` 的目的是"JS 侧停止回调"——若渲染器已注销，监听随渲染器一起消失，**清理目标已不存在**，静默是正确处置而非掩盖；
- 不影响正常路径：渲染器健在时 `unregister` 正常执行，catch 不触发；
- 两页同改（2048 / Tetris 共用 `gamekeyboard.js` 注册模型），保持对称。

## 3. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `Pages/MyPage/Game_2048.razor` `DisposeAsync` | catch 列表补 `JSException`（1 行 + 注释） |
| 2 | `Pages/MyPage/Tetris.razor` `DisposeAsync` | 同上 |

其余（注册逻辑、`keyRef` 释放、`Dispose()` Timer 清理）不动。

## 4. 测试计划

| # | 验证 |
|---|---|
| 1 | **P-017 复现序列**：Firefox 下按 NF-01 序列循环 6 轮（进入/离开 `/game_2048`）→ console 无 `No interop methods...`（修复前 ≈33% 复现率，修复后目标 0/6；若仍偶发则证明另有根因，P-017 降级继续观察并在下轮报告注明） |
| 2 | 正常离开页面后键盘在其它页无效（既有 D02 用例回归，确认 catch 未吞掉真实路径） |
| 3 | 门禁：`test:g2048 + test:tris + test:d02 + test:smoke` 全绿 |
| 4 | 服务端日志人工项：连续进出两游戏页 10 次，输出窗口无未处理异常 |

## 5. 实施后流程

build → 门禁全绿 → 执行记录登记 → **下一版测试报告：P-018 置为已修；P-017 视复现序列结果置为已修（归零）或继续观察** → 按约定更新《现状》与《更新记录》。
