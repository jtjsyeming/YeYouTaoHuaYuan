# 17 - 修复文档：P-001 D-03 日历用例期望值 off-by-one（测试代码缺陷）

> 来源：《3测试报告/2026-11-06.md》§6.1 P-001　|　日期：2026-11-06　|　状态：待实施
> 性质：**测试代码缺陷**（产品实现正确），报告建议的第一优先修复项（恢复门禁可信度）

---

## 1. 问题

`tools/e2e/tests/d03_calendar.spec.mjs:28` 用 `Math.round((now - t2) / 86400000)` 计算期望天数：`now` 含时分秒，本地时间过 12:00 后 `round` 必然进位 +1。导致 **LT-26 / LT-27 / LT-28 三条用例"上午跑全绿、下午跑必红"**（2026-11-06 19 点全量 3 条失败的唯一根因）。页面 C# 侧 `(now - t2).Days` 是 `TimeSpan` 截断，行为正确（FT-13 独立实现 floor 口径与页面三行逐字一致）。

## 2. 修复方案

**一行口径修正 + 抽公共函数**：

```js
// d03_calendar.spec.mjs：与 C# TimeSpan.Days 同口径的截断
const daysBetweenFloor = (from, to) => Math.floor((to - from) / 86400000);
```

- 全文件检索 `Math.round(...86400000...)`，全部替换为 `daysBetweenFloor`（LT-26/27/28 共用的期望值 helper 内，预计 1 处定义 + 若干调用点）；
- 函数旁加注释：**必须与 `LoveTime.razor` 的 `(now - t2).Days` 保持同口径（floor/截断），禁止改回 round**——防止下一个维护者重蹈覆辙。

## 3. 改动清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `tools/e2e/tests/d03_calendar.spec.mjs` | `Math.round` → floor 口径，抽 `daysBetweenFloor` helper + 注释 |

产品代码零改动。

## 4. 测试计划

1. `test:d03` 全绿（6 条）；
2. **时刻鲁棒性验证**：临时把系统口径因素纳入——用 FT-17 的手法在脚本内同时算 round/floor 两口径并断言 floor 与页面一致（或选下午时段执行一次确认）；
3. 回归：`test:lt + test:smoke` 全绿。

## 5. 实施后流程

build → 门禁全绿 → 执行记录登记 → **下一版测试报告把 P-001 置为已修** → 《更新记录》追加一条（测试资产修复，产品代码未变）。
