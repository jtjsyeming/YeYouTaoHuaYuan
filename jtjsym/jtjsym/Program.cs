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

// 排行榜存储自检（D-40 / C-97）：发布验收第 1 步，也是"数据到底存在哪、能不能写"的第一探针。
// 放在 MapFallbackToPage 之前 —— fallback 的 Order 最低、理论上抢不走，但写前面省得以后有人调了顺序再回来查。
// 返回里不带异常消息、默认也不带绝对路径（?detail=1 才给），因为这是个公开端点。
app.MapGet("/llkhealth", async (LianliankanLeaderboard board, string? detail) =>
{
    var probe = await board.EnsureWritableAsync();
    // 收 string 而不是 bool：最小 API 的 bool 绑定只认 "true"/"false"，运维手打 `?detail=1` 会 400
    var showDir = detail is "1" or "true" or "yes";
    return Results.Json(new
    {
        writable = probe.Ok,
        kind = probe.Kind,                                     // ok | permission | path | io | unknown
        error = probe.Error,                                   // 异常类型名；null = 无
        dataDir = showDir ? board.DataDir : null,               // 默认不回路径，避免公开
    });
});

app.MapBlazorHub();
app.MapFallbackToPage("/_Host");

app.Run();
