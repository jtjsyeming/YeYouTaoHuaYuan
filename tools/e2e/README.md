# tools/e2e —— 夜游桃花源端到端回归套件

Playwright + `@playwright/test` 驱动的浏览器端回归测试，覆盖《07-测试文档-全量测试用例-v2.0.md》的 NAV / FISH / LT / G2048 / TRIS / CODE / NF 七个模块。

**仅用于开发期测试**：Node/npm 不进入 `dotnet build` 与发布链路，发布产物里没有这里的任何文件。

---

## 1. 一次性准备

```bash
cd tools/e2e
npm ci
```

- **不要**执行 `npx playwright install`：`@playwright/test` 已钉死 `1.64.1`，与 `%LOCALAPPDATA%\ms-playwright` 里既有的 `chromium-1248` / `firefox-1555` 对齐，可直接复用。换机器缺浏览器时才需要 `npx playwright install chromium firefox`。
- 版本**不要**升：`package.json` 里是 `"@playwright/test": "1.64.1"`（不带 `^`），升级就必须重下约 300MB 浏览器并重跑基线。

## 2. 起站点

`playwright.config.mjs` 自带 `webServer`：若 `http://localhost:14074` 没起，会自动执行

```bash
dotnet run --project ../../jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074
```

也可以手动起，二选一：

- VS Code：F5「jtjsym 网站 (Blazor Server)」（`preLaunchTask` 已含上述参数）；
- 命令行：`dotnet run --project jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074`。

> **`--environment Development` 不能省**：`--no-launch-profile` 跳过 `launchSettings`，环境会回落为 Production，此时 StaticWebAssets 不再从构建输出提供，`_content/Microsoft.Fast.Components.FluentUI/*` 全部 404 → Fluent 自定义元素不升级、`<fluent-option>` 以行内元素撑出 2.7~3.1 倍页宽。**页面看着能点，但所有"横向溢出/尺寸"断言都会得到假结果**。

> **不要**用裸 `dotnet run`：它会走已提交的 `launchSettings` 尝试 14073/https，本机无 HTTPS 开发证书 → 启动失败（《07》§2.1）。

已占用 14074 时脚本会复用现有实例（`reuseExistingServer: true`）。**改了 `.razor` 必须重启站点**再测；只改 CSS 可刷新。

## 3. 怎么跑

| 命令 | 覆盖 | 实测耗时 |
|---|---|---|
| `npm run test:smoke` | 《07》§11.3 冒烟集 28 条 P0（TRIS-23 人工） | 2.6 分钟 |
| `npm run test:nav` | NAV 全量 + D-11 标题断言 | 40 秒 |
| `npm run test:fish` | FISH 全量（含断网恢复） | 1 分钟 |
| `npm run test:lt` | LT 24 条（含 30 秒后台标签） | 2 分钟 |
| `npm run test:g2048` | G2048 全量（含 40 步不变式） | 40 秒 |
| `npm run test:tris` | TRIS 全量（含 150s 自动玩 + 190s 难度项） | 7~8 分钟 |
| `npm run test:code` / `test:nf` | CODE / NF（含 Firefox 兼容、Slow 3G） | 2~3 分钟 |
| `npm run test:d02` | D02 键盘操作 + 2048 数值配色（D02-4 为 `fixme`） | 1.5 分钟 |
| `npm run test:d14` | D14 移动端俄罗斯方块两栏布局（七档视口 + 桌面零变化回归） | 3~4 分钟 |
| `npm run test:d22` | D-23 俄罗斯方块最高分（预置读 / 首屏占位 / 不闪 0 / 未落盘 / 重玩固化 / 损坏值 / 跨页隔离） | 20 秒 |
| `npm run test:fast` | nav + lt + g2048 + code_nf（不含 tris 长时项） | 6 分钟 |
| `npm run test:pr` | **CI 的 PR/push 子集**（chromium + 编号前缀白名单，见下） | 13 分钟 |
| `npm run test:all` | 全部 | 17~20 分钟 |

- **`test:pr` 是 CI 与本地同源的唯一子集定义**（`.github/workflows/tests.yml` 只调 `npm run test:pr`）。它靠 `--grep` 的前缀白名单选用例，**新增 spec 时必须把标题编号前缀加进去**，否则该 spec 永远不会在 PR 上跑（`D02-`/`NF-`/`D15-`/`D-11`/`D-12` 就这样漏过 40 条）。当前白名单：`NAV-|FISH-|G2048-|LT-|TRIS-0|D14-|D08-|D02-|D-1[12]|D15-|NF-|CODE-`（126 条选中 115 条；故意排除 TRIS-10~14/20/21/25/26/ERR 与 smoke 的人工项）；
- 换端口：`BASE_URL=http://localhost:14099 npm run test:lt`；
- 按用例编号过滤依赖"编号写在 `test()` 标题首段"的约定，例如 `npx playwright test --grep "LT-11"`；
- **`trace` 默认关闭**（见 §6），失败时 `test-results/` 里只有失败截图；要逐帧复盘就临时加 `--trace on`；
- HTML 报告在 `playwright-report/index.html`。

## 4. 用例 ↔ 文件映射

| spec | 覆盖用例 | 权威来源 |
|---|---|---|
| `tests/nav_fish.spec.mjs` | NAV-01~NAV-10、FISH-01~FISH-07 | `nav_fish.mjs` + `fix.mjs` + `fix2.mjs` |
| `tests/lt.spec.mjs` | LT-01~LT-24 + LT-ERR | `lt.mjs` |
| `tests/g2048.spec.mjs` | G2048-01~G2048-22 | `g2048.mjs` + `g2048b.mjs` |
| `tests/tris.spec.mjs` | TRIS-01~TRIS-26 | `tris_core.mjs` + `tris_long.mjs` + `tris14.mjs` + `tris25.mjs` |
| `tests/code_nf.spec.mjs` | CODE-01~03、NF-01~NF-08（含 NF-02b） | `code_nf.mjs` |
| `tests/d11_d12.spec.mjs` | D-11-1~3、D-12-1~6 | 《09》§6 新写 |
| `tests/d14_mobile_layout.spec.mjs` | D14-1~D14-9 + D14-10/10b/10c/10d（横屏四档、桌面四档含 768×1024）（+ 一条控制台错误辅助断言） | 《11》§5.1 新写、《28》P-023 |
| `tests/smoke.spec.mjs` | 《07》§11.3 的 28 条 P0 | 从上列各文件抽子集，不新增逻辑 |

## 5. 迁移约定（改脚本前先看）

1. **一个场景 = 一个 `test()`，场景内多条用例用 `check()`（内部是 `expect.soft`）**。原脚本是"单 browser + 单 page + `rec()` 顺序记录"，用例间存在状态依赖（LT-10→LT-11、TRIS 连续操作同一局），拆成"一用例一 `test()`"会破坏顺序并被迫重跑前置。
2. 用例编号写在 `test()` 标题首段，`--grep` 才能过滤，也才能与《07》一一对应。
3. 等待策略保持原样（`window.Blazor` + 固定 `sleep`）。Blazor Server 没有稳定的"就绪"信号，改 `networkidle` 反而更脆（SignalR 长连接永不 idle）。
4. `FluentSelect` 类下拉**不能**靠"赋 `value` + 派发 `change`"驱动 Blazor，必须点击展开后点 `fluent-option`。
5. 俄罗斯方块当前方块的坐标改用 `getBoundingClientRect()` 计算（08 起 `top/left` 是 `calc(var(--cell-size) * n)`，`parseInt(style.top)` 会得到 NaN）。

## 6. 踩坑清单

- **`trace` 必须保持 `off`**：`trace` 录的是逐帧截图，TRIS-14 / TRIS-26 单条跑 3 分钟，一次能产 **7000+ 文件**（实测 7144）。Playwright 每轮开跑前会清 `test-results/`，文件数过大时会被宿主机的"批量删除守卫"拦截，直接报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` 让整轮测试失败（不是用例失败）。断言失败信息（`expect.soft` 的期望/实际）已够定位；真要逐帧复盘再临时 `--trace on`。
- 站点在 VS 调试中时 `dotnet build` 可能报 `MSB3027/MSB3021`（dll 被锁）。**这不影响对运行中的实例执行测试**；要构建新版本时改用 `dotnet publish -c Release -o <临时目录>` 另起实例。
- `--grep` 过滤不到任何用例时 Playwright 报 "no tests found"（不会静默通过），注意标题是否被改名。
- 计时类用例（LT 秒级跳动、TRIS 难度升级）偶发抖动时，先确认 `workers` 仍为 1、`retries` 仍为 0，再排查是否并行/复用实例导致。
- 冒烟集的 `TRIS-10`（消行）/ `TRIS-20`（游戏结束）依赖有界自动玩：`TRIS-10` 用启发式落点评估（能稳定消行），`TRIS-20` 用"只堆中间两列"的会输策略（约 20 秒堆满）。若某次不触发，先看是否 `workers` 被改成 >1；全量 `tris.spec.mjs` 覆盖更充分。
- 当前仍有 2 处 `fixme`：`NF-05/07/08`（需生产环境）与 `TRIS-23`（需读服务端控制台），均为人工验收项，按《07》§11.3 在册。`TRIS-26`（D-04）与 `D02-4` 已分别随 C-27、H-011 修好并转为真实用例，不要再按旧的"5 处 fixme"理解。
- **同一「数量常量」可能写在两个 spec 里**：`FISH-02` 的装饰 gif 数在 `nav_fish.spec.mjs` 与 `smoke.spec.mjs` 各有一份，改一处会让另一处**静默失配**（`test:fish` 绿、`test:smoke` 红、`test:pr` 红）。改数量类判据前先 `grep -rn` 全库。**第二例（2026-11-09，D-23）**：Tetris 面板 `.info-value` 的行数写在 `NF-01`（`code_nf.spec.mjs:134`）与 `NF-04`（`:251`）两处，加「最高分」行后两处都得由 2 改 3；**`NF-01` 只在 firefox 跑**，`test:pr`（chromium 子集）看不见它，只有 `test:nf` 才会红 —— 这类"同一条断言两份拷贝、且分属不同 project"的最容易漏。
- **汇总读数不要 `grep ... | tail -2`**：Playwright 的汇总行顺序是 `failed` → `skipped` → `passed`，`tail -2` 正好把 `1 failed` 切掉（2026-11-08 实测把 smoke 的失败误读成「1 skipped / 5 passed」，直到跑 PR 全量才暴露）。用 `tail -3`，或直接看 `echo "exit=$?"`。
- **木鱼状态行取数一律用 `fishCount()`，不要写文案正则**：文案改过两次（`次数: ` → `本次功德：`，C-50），17 处数字比对已改为 `fishCount(x) === N`（`helpers.mjs`，只认行尾数字）。标签本身只在两处显式断言：`FISH-01` 的 `/^本次功德：/` 前缀与 `FISH-07` 的整串锚定 `/^本次功德：105$/` —— 这两条是唯一还看着文案的断言，改动时别顺手删。浏览器内 `waitForFunction` 用不了 Node 侧 helper，改行尾后缀正则 `(?<!\d)N$`。
- **`git checkout -- X.razor` 只还原源码，不还原 bin**：2026-11-09 实测 `bin/Debug/net8.0/jtjsym.dll` 里留着上一轮探针构建的 `best-score` / `jtjsym.tetris.best`，页面照样渲染出「最高分」行，而 `git status` 是空的 —— 任何「以页面输出为准」的实测都会测到探针行为。改过代码后一律 `dotnet build --no-incremental` 再起站；怀疑残留时用 `python -c "print(open('jtjsym/jtjsym/bin/Debug/net8.0/jtjsym.dll','rb').read().count('关键字'.encode('utf-16-le')))"` 直查 dll（.NET 字符串是 UTF-16，`grep`/`strings` 都抓不到）。
