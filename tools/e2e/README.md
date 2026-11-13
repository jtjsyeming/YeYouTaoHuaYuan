# tools/e2e —— 夜游桃花源端到端回归套件

Playwright + `@playwright/test` 驱动的浏览器端回归测试，覆盖《07-测试文档-全量测试用例-v2.0.md》的 NAV / FISH / LT / G2048 / TRIS / MS / CODE / NF 八个模块。

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
| `npm run test:d24` | D-24 对局会话保持 + 后台自动暂停 / D-25 最高分落盘加固（切页往返 / 结束清档 / 重玩清档 / 8 种坏档 / 恢复后继续 / 切后台 / 软降零头） | 55 秒 |
| `npm run test:ms` | H-013 扫雷（首屏 / 首点安全 / 洪泛边界 / 插旗 / 败局 / 胜局纪录 / 坏值 / 会话保持 / 重开切档 / 窄屏 / 无异常） | 65 秒 |
| `npm run test:llk` | H-014 连连看每日一关（首屏 / 每日确定性 / 消除与不可连 / 死局重排 / 胜局 / 纪录口径 / 会话保持 / 切后台 / 窄屏横纵 / 资产完整） | 65 秒 |
| `npm run test:fast` | nav + lt + g2048 + code_nf（不含 tris 长时项） | 6 分钟 |
| `npm run test:pr` | **CI 的 PR/push 子集**（chromium + 编号前缀白名单，见下） | 16 分钟 |
| `npm run test:all` | 全部 | 17~20 分钟 |

- **`test:pr` 是 CI 与本地同源的唯一子集定义**（`.github/workflows/tests.yml` 只调 `npm run test:pr`）。它靠 `--grep` 的前缀白名单选用例，**新增 spec 时必须把标题编号前缀加进去**，否则该 spec 永远不会在 PR 上跑（`D02-`/`NF-`/`D15-`/`D-1[12]` 就这样漏过 40 条）。当前白名单：`NAV-|FISH-|G2048-|LT-|TRIS-0|D14-|D08-|D02-|D-1[12]|D15-|NF-|CODE-|D22-|D24-|MS-|LL-`（**2026-11-13 实测：157 条选中 155 条通过 / 2 跳过 / 0 失败**；故意排除 TRIS-10~14/20/21/25/26/ERR 与 smoke 的人工项）；
- 换端口：`BASE_URL=http://localhost:14099 npm run test:lt`；
- 按用例编号过滤依赖"编号写在 `test()` 标题首段"的约定，例如 `npx playwright test --grep "LT-11"`；
- **`trace` 默认关闭**（见 §6），失败时 `test-results/` 里有失败截图、`error-context.md`（ARIA 快照）与 **`env-snapshot.json`**（环境快照，见 §3.1）；要逐帧复盘就临时加 `--trace on`；
- HTML 报告在 `playwright-report/index.html`（自包含单文件，**不含截图**）。

### 3.1 失败时的自动观测（C-55 / 诊断《32》v2 §4.A）

`helpers.mjs` 里有三件**纯观测、永不参与红绿**的东西，全部挂在 `open()` 上（幂等，多次 `open()` 只挂一次）：

| 设施 | 作用 |
|---|---|
| `trackErrors(page)` | 控制台/页面异常，**每条带来源 URL**：`console: … 404 (Not Found) @ /jtjsym.styles.css`。只加后缀，不改 `length` 语义 |
| `netFailures(page)` | `http 4xx/5xx: <url>` 与 `requestfailed: <url> — <原因>`，供快照引用。会记到 favicon 之类无关 4xx，**这是刻意的** |
| `snapshotEnv(page, testInfo)` | 用例**失败时**自动跑（模块级 `test.afterEach`），落 `test-results/<test>/env-snapshot.json`：`fluentUpgraded` / `scopedCssLoaded` / `shadowHost` / `url` / `net` 前 20 条 |

判读速查：`fluentUpgraded=false` → Fluent 自定义元素没升级（D15-9 的 `null`、尺寸/溢出断言全失效）；`scopedCssLoaded=false` → scoped CSS 没加载（D14-10d 的"纵向恒 56px"）；`net` 里出现 `_content/**` 或 `jtjsym.styles.css` 的 404 → 就是 CI 首跑 37 红的那条根因链。

> ⚠ `scopedCssLoaded` 用 `cssRules.length > 0` 判定，不能只数 `<link>` —— 404 的样式表在 `document.styleSheets` 里**仍占一项**。

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
| `tests/minesweeper.spec.mjs` | MS-01~MS-13（扫雷，H-013） | 《34》§6.2 新写；C-59（D-26/D-27）与 C-65（D-29）各改过判据，条数未变 |
| `tests/lianliankan.spec.mjs` | LL-01~LL-12（连连看每日一关，H-014） | 《36》§6 新写 |

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
- **同一个 test 里连续 `open()` 多个视口，等于让"上一次的对局"污染下一次**（2026-11-10，D-24b）：`/tetris` 从 D-24b 起会把对局写 `sessionStorage`，第二个 `open()` 就恢复成**暂停态**（面板多一颗按钮，手机档 +46px）。`d14_mobile_layout.spec.mjs` 因此加了 `beforeEach` 的 `addInitScript` 清 `jtjsym.tetris.session` —— 布局类断言要的永远是"运行中"的规范态，暂停态另有 `D14-6` 专门看守。**新增任何"一个 test 里反复导航"的用例前，先想清楚上一次的浏览器侧存储会不会被下一次读到。**
- **给俄罗斯方块造"顶到天花板"的存档时，别把行填满**：19 行全满会在锁定那一刻被 `ClearRows` 一次清掉（`_ => 100 * rowsCleared` = **1900 分**），棋盘瞬间清空，于是永远到不了 `GameOver`。D24-2 首版就是这么红的（分数 1900 / 难度 1 / 无遮罩），正确姿势是每行留一格空（171 格）。
- **`click()` 返回 ≠ DOM 已更新（Blazor Server 必踩）**：点击事件要经 SignalR 到服务端、处理完再回传 render batch。`locator.click()` 只保证事件在**浏览器侧**已派发，紧接着读 DOM 拿到的是**点击前**的样子。平时不炸只是因为后面恰好有 `expect.poll` / `sleep` 顶出几十毫秒余量。**2026-11-10 实测**：`D22-5` 把「点重开 → 分数归零」写成点完直读，孤立跑 `test:d22` 绿（7/7）、全量 `test:pr` 红（读到 `score=17`），而失败截图的可访问性快照里分数已是 `0` —— 典型假红。**凡是"点一下 → 断言画面变了"的判据，一律 `expect.poll` 读，不要 `sleep` 也不要点完直读。**
- **`testInfo.attach()` 不等于"文件在 `test-results/` 里"**（2026-11-10，C-55）：`attach({ body })` 会让条目进 `testInfo.attachments`，但磁盘上没有文件 —— HTML 报告是自包含单文件，附件被压进它自己的 base64 zip，而 CI 的 artifact 收的是 `test-results/`。要给 CI 看到附件，必须**先 `fs.writeFile(testInfo.outputPath(name), body)` 再 attach**。
- **别指望 `localStorage` 的 poll 顺便充当延时**：`expect.poll(() => stored(page))` 在"值早就在盘上"时会**立刻**返回，一个毫秒都不等。D-25 把 best 的落盘点扩到每个锁定点之后，`D22-5` 里那发 localStorage poll 就从"延时来源"退化成"瞬间通过"，于是紧跟着的 DOM 读取直接吃到上面那条坑。判据顺序上，**先 poll DOM，再 poll 存储**。
- **Razor 的 `@for` 循环变量不能在 lambda 里直接用**（2026-11-11，扫雷首跑 9 红）：`@onclick="() => RevealCellAsync(r, c)"` 捕获的是**同一个变量**，等事件触发时它已是终值 —— 于是每格都去翻最后一格。首跑表现极具误导性：MS-02/03/04/07/08 全是"点了没反应"（`revealed` 恒为 0），看着像 Blazor 事件没接上，实际是闭包。写法必须先 `var row = r; var col = c;` 再进 lambda。**棋盘/列表类渲染（几十上百个带回调的元素）第一次跑就"全都不响应"时，先查这个。**
- **扫雷的会话档只在"翻格/插旗"与 `DisposeAsync` 落盘**（2026-11-11）：秒数是 1 秒一拍，若只在翻格时写，离开后回来的用时会把最后一次操作之后的时间全丢掉（MS-08 首版实测 1s → 0s）。`DisposeAsync` 补了一发 `SaveSessionAsync()`（与 Tetris 同口径），所以**站内切页**能精确恢复，**关标签页**仍可能丢最后几秒。判据要留 ±1s 容差：读 `before` 到离开之间可能又跳了一拍，那不是"暂停态在走表"。
- **「随机开局 + 单步操作 → 盘面必须变」的断言天生会偶发假红**（2026-11-13，`D15-12`）：2048 开局两块随机，若恰好都落在最左列且值不同，左移是**合法但无位移**的一步（`AfterMove` 见盘面没变直接返回，连新块都不生成）⇒ 约 3% 概率判红，失败文案是「棋盘未变、分数 0→0」。**能构造就构造**（连连看 `LL-03`/`LL-04` 靠"额外留一对"把局面钉死），构造不了就**先做一个必然使其成立的前置动作**（`D15-12` 先点 ➡️ 右对齐，此后 ⬅️ 必然位移），别写成"变了就算过"或加重试。复查手法：`--repeat-each=8` 连跑看频率，再用 `sessionStorage` 注入对抗局面做**确定性复现**。
- **`sessionStorage` 注入的正确姿势**（2026-11-13）：先 `open` 到目标页 → `page.evaluate` 写键 → `reload`；`addInitScript` 在 `about:blank` 上写 `sessionStorage` 不落到目标源。另外 2048 的存档键名是**小写**（`{"v","cells","score"}` 靠 `[JsonPropertyName]` 映射），写成 `Cells` 会被结构闸静默丢弃，看到的是随机新局。
- **红检/门禁前先杀站点进程**（2026-11-13）：`reuseExistingServer: true` 在端口被占用时会**直接复用**，复用的可能是一个跑着旧 dll 的遗留进程 —— 红检首跑因此假绿（改错的地方照样通过）。同时该进程会锁住 `bin\Debug\net8.0\jtjsym.dll`，`dotnet build` 直接 MSB3026→MSB3027→MSB3021。跑门禁前一律 `Get-Process -Name jtjsym | Stop-Process -Force`。
- **多条门禁别串在一条命令里跑**（2026-11-13）：`npm run test:nf; npm run test:smoke; npm run test:pr` 连跑时，前一条的站点没退干净，后一条的 `webServer` 会判定"没站点"去起新实例，于是 `Failed to bind to address http://127.0.0.1:14074: address already in use` 直接崩，测试跑在半死站点上，表现为**成片 400ms 快速判红**（本轮 40 余条）。看到"失败快得离谱"先查这条，别逐条读断言。两条之间要留出站点退出时间，或先 `Get-Process -Name jtjsym | Stop-Process -Force` 并确认 14074 不再 LISTENING。
  同一次实测还暴露出另一半原因：**沙箱/容器环境里站点子进程活不过 7~8 分钟**（两次都在启动后约 7.2 分钟被回收，日志无异常堆栈）。`test:pr` 要 16 分钟 ⇒ 长跑门禁要放到沙箱外跑，否则后半段全是 `ECONNREFUSED`。
- **`test:pr` 最稳的跑法是「手动起站点 + 复用」，不是靠 `webServer`**（2026-11-13 订正上一条，连撞两次才定因）：即使放到沙箱外，**Playwright 自己拉起的那个站点子进程照样会在跑批中途被回收**（实测两次：3 分钟死一次、11.8 分钟死一次，失败位置不固定、全是 `ERR_CONNECTION_REFUSED`；而**手动 `dotnet run` 起的独立进程连续探测 7 分钟 14 次全 200**，从不自然死亡）。`webServer.stdout` 设为 `'ignore'` 时死因完全不可见，是最卡的一步。**跑法**：先在外部 `dotnet run --project jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074` 并 `tee` 日志，再跑 `npm run test:pr`（`reuseExistingServer: true` 会直接复用它）。判据：站点在整个门禁期间一直 200、跑完仍 200。
- **"红点紧挨着某条用例"不是定因依据**（2026-11-13）：两次首红都紧跟 `D02-14`，一度归因于它长按 `ArrowDown` 打崩 Tetris，单跑 `D02-14` 却是绿的。要单条复现再下结论。
