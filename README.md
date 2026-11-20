# 夜游桃花源（YeYouTaoHuaYuan）

个人小站「夜游桃花源」的代码仓库。

## 站点 jtjsym（Blazor Server）

.NET 8 + Blazor **Server** + FluentUI 3.8.0；无数据库，页面状态在服务端内存里
（2048 的最高分与对局进度是浏览器侧 `localStorage` / `sessionStorage`）。
唯一的服务端持久化是**连连看每日榜**：落一个 JSON 文件（默认在发布目录**同级**的 `llk-data/`，
`robocopy /MIR` 镜像不到它），路径可用 `Lianliankan__DataDir` 覆盖。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | 首页 | 入口卡片页，SPA 跳转到下面 8 个页面 |
| `/counter` | 按下试试 | 电子木鱼 |
| `/loveTime` | 爱情计时器 | 秒级刷新、年月日联动、日历精确换算副行 |
| `/game_2048` | 2048 | 键盘 + 按钮双通道、最高分与对局进度持久化 |
| `/tetris` | 俄罗斯方块 | 响应式分档布局，≤520px 两栏 |
| `/minesweeper` | 扫雷 | 初级 9×9 / 中级 16×16，右键或长按插旗、首点安全、最快时间与进度持久化 |
| `/llkcalendar` | 连连看·关卡 | 关卡日历：按日看谁最快，点格子进关；服务端榜按 `yyyyMMdd` 期号存 |
| `/lianliankan` | 连连看 · 每日一关 | 每日一关（同期号全球同盘）、≤2 拐连通、死局自动重排；`?issue=yyyyMMdd` 复玩历史关 |
| `/coding_place` | 编程挑战 | 静态题面 |

### 本地运行

```bash
dotnet run --project jtjsym/jtjsym --no-launch-profile --urls http://localhost:14074
```

> 直接 `dotnet run` 会按 `launchSettings.json` 同时绑 `https://localhost:14073`，本机未信任开发证书时
> 会启动失败或浏览器告警；上面这条只绑 http。

### 端到端回归（仅开发期，不进发布产物）

```bash
cd tools/e2e
npm install && npx playwright install chromium firefox
npm run test:smoke            # 冒烟集，约 3 分钟
npm run test:all              # 全量，约 20 分钟
```

各 spec 与用例编号的对应关系见《夜游桃花源网站技术栈与代码结构现状》§3.4，用例正文见《测试文档-全量测试用例》。

> 设计 / 测试文档已于 2026-11-08 迁出本仓库，独立存放、不受本仓库 git 管理；
> `jtjsym/`、`tools/e2e/` 与 CI 均不依赖其路径。

#### 并行会话约定

本机只有一个 `bin/`、一个日志文件、一个浏览器实例。两路会话同时动测试时按下面四条走 ——
事故形态一句话就能概括：**一边在 `dotnet build`，一边在跑批**，于是站点被杀、成片
`ERR_CONNECTION_REFUSED`，看上去像产品大面积回归。

1. **重建前先停自己的站**：`node tools/e2e/site-runner.mjs --stop`（只杀本机 runner 记录过的 pid）。
   **不要** `Get-Process jtjsym | Stop-Process` —— 那会顺手把另一路的站杀掉，正是这类事故的成因。
2. **开跑前探活 + 看改动**：`curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/` 得 200，
   且 `git status --short` 为空再开跑。非空说明另一路正在实施 ⇒ 等它跑完（端口租借只解决"端口不撞"，
   不解决"两边同时 `dotnet build` 抢 `bin/`"）。
3. **中断互认**：跑批中出现**成片**（≥3 条）`ERR_CONNECTION_REFUSED` / `ERR_CONNECTION_RESET`，
   先判"站点是不是被另一路停掉了"，别当成产品红；用 `--last-failed` 或 `--only` 最小复跑。
   注意区分两种 `127`：**站点进程**的 `exit 127` 与跑批进程自身的退出码不是一回事。
4. **一次只跑一条门禁**：`test:pr` 19 分钟、`test:llk` 4 分钟、全量 30 分钟。串成一条命令时，
   前一条失败后一条照样起，两路同时打一个站点 —— 症状与"站点被杀"完全一样。

站点用 `site-runner.mjs` 起（端口 14074 起、被占自动往上借；站点死掉 2 秒后自动重启）：

```bash
node tools/e2e/site-runner.mjs                                     # 终端 A：前台看护
BASE_URL=$(node tools/e2e/site-runner.mjs --print-base) PW_SITE_MANAGED=1 npm run test:smoke   # 终端 B
node tools/e2e/site-runner.mjs --stop                              # 收工（只停自己那份）
```

`PW_SITE_MANAGED=1` 不能省：它让 `playwright.config.mjs` 的 `webServer` 整体让位（`undefined`），
否则 Playwright 也会去起站，两者抢同一个端口与同一个日志文件。

### 发布

`.vscode/publish-release.ps1`（或 VS Code 任务 `release-jtjsym`）：publish → 同步发布目录 → 同步部署目录 → 打版本 zip。
