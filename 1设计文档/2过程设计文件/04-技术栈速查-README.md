# jtjsym 技术栈速查 / 新人接手 README

> 版本：v1.0　|　日期：2026-11-01

## 一、项目是什么

**夜游桃花源**：C# Blazor Server 个人小站，包含电子木鱼、爱情计时器、2048、俄罗斯方块等功能页。仓库路径 `YeYouTaoHuaYuan/jtjsym`，解决方案为 `jtjsym.sln`，实际工程在二级目录 `jtjsym/jtjsym/`（注意两层同名目录）。

## 二、环境要求

| 依赖 | 版本 |
|---|---|
| .NET SDK | 8.0 |
| IDE | Visual Studio 2022 / VS Code / Rider 均可 |
| 前端工具 | **站点本身无需 Node/npm**（libman.json 管理 libman 静态库；实际静态资源已入库）。**跑端到端测试才需要 Node ≥ 18**（`tools/e2e`，仅开发期依赖，不进发布链路） |
| 数据库 | 无 |

## 三、常用命令

```bash
# 还原 & 运行（在 jtjsym/jtjsym 目录下）
dotnet restore
dotnet run            # 默认监听 launchSettings 配置的端口，HTTPS 重定向已开启

# 站点必须带 --environment Development 才服务 _content/* 静态资源（见下方注）
dotnet run --project jtjsym/jtjsym --no-launch-profile --environment Development --urls http://localhost:14074

# 发布（使用现成的 FolderProfile）
dotnet publish -c Release -o ./bin/publish

# 工具（.config/dotnet-tools.json 中声明过 libman）
dotnet tool restore

# 端到端回归（在仓库根目录；首次需 npx playwright install chromium firefox）
cd tools/e2e && npm ci && npm run test:smoke
```

> **`--no-launch-profile` 必须配 `--environment Development`**：该参数会跳过 `launchSettings.json`，环境回落为 `Production`，此时 StaticWebAssets 不再从构建输出提供，`_content/Microsoft.Fast.Components.FluentUI/*` 全部 404 → Fluent 自定义元素不升级，`<fluent-option>` 以行内元素撑出 2.7~3.1 倍页宽。页面"看着能点"，但所有尺寸/溢出类断言都会得到假结果。

## 四、技术栈速查表

| 层 | 技术 | 备注 |
|---|---|---|
| 运行时 | .NET 8 (net8.0) | Nullable、ImplicitUsings 已启用 |
| 渲染模型 | Blazor **Server** | `AddServerSideBlazor` + `MapBlazorHub`，_Host.cshtml 宿主 |
| UI 库 | Microsoft.Fast.Components.FluentUI 3.8.0 | `AddFluentUIComponents()`；另装了 Icons 包 |
| CSS | Bootstrap 5 + open-iconic + site.css | 部分 game 页样式直接写在 .razor 的 `<style>` 里 |
| 定时器 | System.Timers.Timer | Tetris 游戏循环 |
| 配置 | appsettings.json | 仅默认日志，无自定义配置 |
| 部署 | 文件夹发布（FolderProfile.pubxml） | 需 .NET 8 ASP.NET Core Runtime；已备案，走 HTTPS |

## 五、代码地图（去哪改什么）

| 想做的事 | 去哪里 |
|---|---|
| 加一个新页面 | 新建 `Pages/MyPage/Xxx.razor`（`@page "/xxx"`），并在 `Shared/NavMenu.razor` 加 NavLink |
| 改导航菜单 | `Shared/NavMenu.razor` |
| 改整站布局/页头 | `Shared/MainLayout.razor`、`Pages/_Layout.cshtml` |
| 改首页/备案信息 | `Pages/Index.razor` |
| 改爱情计时器纪念日 | `Pages/MyPage/LoveTime.razor` 的 `timePoints` 字典 |
| 改 Tetris 数值（速度/加分/颜色） | `Pages/MyPage/Tetris.razor` 顶部常量区 |
| 全局样式 | `wwwroot/css/site.css` |
| 依赖包 | `jtjsym.csproj` |

## 六、关键机制一句话备忘

- **Blazor Server = 状态在服务端**：游戏进度、计时器都在服务器内存里，用户刷新/断线即重置；改状态后要 `StateHasChanged()` 才会推送到浏览器。
- **Tetris 的 Timer 必须Dispose**：组件销毁时若 Timer 未停会回调已释放组件——代码用 `isDisposed` + `timerLock` + `InvokeAsync` 三重保护，新增定时逻辑请沿用该模式。
- **没有持久化**：所有数据（木鱼计数、2048 分数）刷新即失；要加存档/排行需先引入存储（SQLite/云数据库均可）。

## 七、模板残留（可安全删除）

- `Data/WeatherForecast.cs`、`Data/WeatherForecastService.cs`（及 Program.cs 中对应注册行）
- `Shared/SurveyPrompt.razor`
- MainLayout 里的 "About" 外链
- `wwwroot/css/open-iconic/` 里的 LICENSE/README 可保留（许可文件）

## 八、相关文档

- 《1代码结构与更新记录/夜游桃花源网站技术栈与代码结构现状.md》 —— 技术栈与代码结构现状
- 《02-详细设计-俄罗斯方块.md》 —— 最复杂模块的实现细节
- 《03-界面与交互设计.md》 —— 页面布局与交互说明
