using Microsoft.Fast.Components.FluentUI;
using jtjsym.Services;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();
builder.Services.AddFluentUIComponents();

// 连连看每日榜（H-018）：singleton —— 缓存 + SemaphoreSlim 都必须是进程级单例，
// 换成 Scoped 就是"每个 circuit 一份缓存、互相覆盖"。构造只算路径、不读盘（启动 IO 失败不能让站点起不来）。
builder.Services.AddSingleton<LianliankanLeaderboard>();

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
    // 只在非开发环境跳 https：本地 `--no-launch-profile --urls http://…` 没有 https 端口可推断，
    // 放在判断外只会让 HttpsRedirectionMiddleware 每次请求刷 `Failed to determine the https port`（H-012）
    app.UseHttpsRedirection();
}

app.UseStaticFiles();

app.UseRouting();

app.MapBlazorHub();
app.MapFallbackToPage("/_Host");

app.Run();
