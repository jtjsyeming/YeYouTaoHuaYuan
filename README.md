# 夜游桃花源（YeYouTaoHuaYuan）

个人小站 + 两个独立小游戏的代码仓库。

## 一、站点 jtjsym（Blazor Server）

.NET 8 + Blazor **Server** + FluentUI 3.8.0；无数据库、无服务端持久化，页面状态在服务端内存里
（2048 的最高分与对局进度是浏览器侧 `localStorage` / `sessionStorage`）。

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | 首页 | 入口卡片页，SPA 跳转到下面 5 个页面 |
| `/counter` | 按下试试 | 电子木鱼 |
| `/loveTime` | 爱情计时器 | 秒级刷新、年月日联动、日历精确换算副行 |
| `/game_2048` | 2048 | 键盘 + 按钮双通道、最高分与对局进度持久化 |
| `/tetris` | 俄罗斯方块 | 响应式分档布局，≤520px 两栏 |
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

### 发布

`.vscode/publish-release.ps1`（或 VS Code 任务 `release-jtjsym`）：publish → 同步发布目录 → 同步部署目录 → 打版本 zip。

## 二、MineSweeper（WinForms）

`MineSweeper/` 是独立的 C# WinForms 扫雷（`net8.0-windows`），主站不引用。用 Visual Studio 打开，
或 `dotnet run --project MineSweeper`。

## 三、Mini-game/tetris.py

pygame 版俄罗斯方块原型，主站不引用，保留作历史参考。
