using Microsoft.Extensions.Configuration;
using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// H-018 服务端榜单：<c>LianliankanLeaderboard</c> 的落盘口径（U13-1~8）。
/// </summary>
/// <para>
/// <b>每个用例一份独立 DataDir</b>（<c>Path.GetTempPath()/llk-tests/{guid}</c>），<c>Dispose</c> 里删。
/// 绝不碰 <c>bin/Debug/llk-data</c> —— 那会把开发机上的真实榜写成测试数据，
/// 而"单测污染真实数据"这种缺陷没有任何断言看得见。
/// </para>
public sealed class LlkLeaderboardTests : IDisposable
{
    private readonly string _dir;
    private readonly LianliankanLeaderboard _board;

    public LlkLeaderboardTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "llk-tests", Guid.NewGuid().ToString("N"));
        _board = NewBoard(_dir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static LianliankanLeaderboard NewBoard(string dir) =>
        new(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Lianliankan:DataDir"] = dir })
            .Build());

    private static DateTimeOffset Now => DateTimeOffset.UtcNow;

    private static int Today => LianliankanCore.IssueFor(Now);

    private static int DaysAgo(int n) => LianliankanCore.IssueFor(Now.AddDays(-n));

    private string FilePath => Path.Combine(_dir, LianliankanLeaderboard.FileName);

    // ───────────────────────── U13-1 覆盖语义 ─────────────────────────

    /// <summary>
    /// 首次入榜；更快覆盖<b>且名字换成新提交者</b>；相同不覆盖；更慢不覆盖。
    /// <para>名字跟着纪录走是刻意的：榜上的一行是"谁跑出了这个成绩"，
    /// 允许"最快的秒数 + 别人的名字"就等于半个假数据。</para>
    /// </summary>
    [Fact]
    public async Task U13_1_Submit_OvertakesOnlyFaster_AndNameFollowsRecord()
    {
        var issue = Today;

        var first = await _board.SubmitAsync(issue, 90, "阿P");
        Assert.NotNull(first);
        Assert.Equal(90, first!.Sec);
        Assert.Equal("阿P", first.Name);

        // 相同秒数：不覆盖，名字也不换
        Assert.Null(await _board.SubmitAsync(issue, 90, "后来者"));
        Assert.Equal("阿P", (await _board.GetAsync(issue))!.Name);

        // 更慢：不覆盖
        Assert.Null(await _board.SubmitAsync(issue, 120, "慢慢来"));
        Assert.Equal(90, (await _board.GetAsync(issue))!.Sec);

        // 更快：覆盖，且名字换成新提交者
        var faster = await _board.SubmitAsync(issue, 42, "魏老夫人");
        Assert.NotNull(faster);
        Assert.Equal(42, faster!.Sec);
        Assert.Equal("魏老夫人", faster.Name);

        var stored = await _board.GetAsync(issue);
        Assert.Equal(42, stored!.Sec);
        Assert.Equal("魏老夫人", stored.Name);
    }

    // ───────────────────────── U13-2 名字归一 ─────────────────────────

    /// <summary>空白 → 「神秘嘉宾」；首尾空白 Trim；控制字符清掉；超长按文本元素截断（emoji 不劈半）。</summary>
    [Fact]
    public async Task U13_2_NormalizeName_Blank_Trim_Control_And_TextElements()
    {
        Assert.Equal(LlkCopy.GuestName, LianliankanLeaderboard.NormalizeName(null));
        Assert.Equal(LlkCopy.GuestName, LianliankanLeaderboard.NormalizeName("    "));
        Assert.Equal(LlkCopy.GuestName, LianliankanLeaderboard.NormalizeName(" \t\r\n "));   // 全是控制/空白

        Assert.Equal("阿P", LianliankanLeaderboard.NormalizeName("  阿P "));
        Assert.Equal("阿P", LianliankanLeaderboard.NormalizeName("阿\r\nP"));                // 换行不是分隔符，是垃圾

        Assert.Equal(12, LianliankanLeaderboard.NormalizeName(new string('长', 20)).Length);

        // 13 个 emoji：按 char 截 12 会把第 12 个劈成半个代理对（落盘变 U+FFFD）
        var emoji = string.Concat(Enumerable.Repeat("😀", 13));
        var cut = LianliankanLeaderboard.NormalizeName(emoji);
        Assert.Equal(12, new System.Globalization.StringInfo(cut).LengthInTextElements);
        Assert.False(char.IsHighSurrogate(cut[^1]), "截断后以高位代理结尾 = 劈开了代理对");
        Assert.Equal(24, cut.Length);                                                    // 12 个 emoji = 24 个 char

        // 归一在 Submit 里也生效（不是只在静态方法里对）
        var issue = Today;
        var rec = await _board.SubmitAsync(issue, 30, "   ");
        Assert.Equal(LlkCopy.GuestName, rec!.Name);
        Assert.Equal(LlkCopy.GuestName, (await _board.GetAsync(issue))!.Name);
    }

    // ───────────────────────── U13-3 坏数据自愈 ─────────────────────────

    /// <summary>
    /// 非 JSON / 半截 JSON / 顶层是数组 ⇒ 空榜、不抛、<b>不删文件</b>；随后一次提交能写回合法文件。
    /// <para>"不删文件"和"自愈"要一起看：删文件是破坏性行为（用户可能手工改过），
    /// 而只要下一次提交正常写回，坏档就自然被替换掉。</para>
    /// </summary>
    [Theory]
    [InlineData("abc")]
    [InlineData("{\"20261101\":{\"sec\":87,")]                       // 半截
    [InlineData("[1,2,3]")]                                          // 顶层不是对象
    public async Task U13_3_BadData_ReadsAsEmpty_ThenSelfHeals(string garbage)
    {
        Directory.CreateDirectory(_dir);
        await File.WriteAllTextAsync(FilePath, garbage);

        var issue = DaysAgo(1);
        Assert.Null(await _board.GetAsync(issue));                    // 不抛
        Assert.Empty(await _board.GetRangeAsync(LianliankanCore.MinIssue, Today));
        Assert.True(File.Exists(FilePath), "坏档不该被删掉（用户可能手工改过，删除是破坏性行为）");

        var rec = await _board.SubmitAsync(issue, 55, "自愈");
        Assert.NotNull(rec);
        Assert.Equal("自愈", (await _board.GetAsync(issue))!.Name);

        // 落盘的是合法 JSON：新实例能读出来（证明写回去的是文件，不是只改了内存）
        var reread = NewBoard(_dir);
        Assert.Equal(55, (await reread.GetAsync(issue))!.Sec);
    }

    // ───────────────────────── U13-4 区间两端 ─────────────────────────

    /// <summary><c>GetRangeAsync</c> 两端都含；区间外的期号不出现。</summary>
    [Fact]
    public async Task U13_4_GetRange_IsInclusiveOnBothEnds()
    {
        var a1 = DaysAgo(3);
        var a2 = DaysAgo(2);
        var a3 = DaysAgo(1);

        await _board.SubmitAsync(a1, 70, "一");
        await _board.SubmitAsync(a2, 60, "二");
        await _board.SubmitAsync(a3, 50, "三");

        var all = await _board.GetRangeAsync(a1, a3);
        Assert.Equal(3, all.Count);
        Assert.Equal(a1, all.Keys.Min());                              // 左端含
        Assert.Equal(a3, all.Keys.Max());                              // 右端含

        var tail = await _board.GetRangeAsync(a2, a3);
        Assert.Equal(2, tail.Count);
        Assert.DoesNotContain(a1, tail.Keys);

        // 区间外的期号：MinIssue 之前与"明天"都不可能在榜上（提交闸挡着）
        Assert.DoesNotContain(LianliankanCore.MinIssue - 1, all.Keys);
        Assert.DoesNotContain(LianliankanCore.IssueFor(Now.AddDays(1)), all.Keys);
    }

    // ───────────────────────── U13-5 数据目录 ─────────────────────────

    /// <summary>
    /// 缺省 = <c>BaseDirectory/../llk-data</c>（发布目录的<b>兄弟</b>目录，robocopy /MIR 碰不到）；
    /// 配置非空则原样采用。
    /// </summary>
    [Fact]
    public void U13_5_DataDir_Default_And_Configured()
    {
        var fallback = new LianliankanLeaderboard(new ConfigurationBuilder().Build());
        var expected = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "llk-data"));
        Assert.Equal(expected, fallback.DataDir);
        Assert.EndsWith("llk-data", fallback.DataDir);
        Assert.DoesNotContain("bin", Path.GetFileName(fallback.DataDir));   // 只是可读性：目录名就是 llk-data

        // 配置里给空串/空白 ⇒ 回落缺省（appsettings 里那行 `""` 就是靠这条成立）
        var blank = NewBoard("   ");
        Assert.Equal(expected, blank.DataDir);

        // 非空 ⇒ 原样采用
        var custom = Path.Combine(Path.GetTempPath(), "llk-cfg", Guid.NewGuid().ToString("N"));
        Assert.Equal(Path.GetFullPath(custom), NewBoard(custom).DataDir);
    }

    // ───────────────────────── U13-6 读路径无写 ─────────────────────────

    /// <summary>
    /// <b>读路径绝不写盘</b>：目录不存在时连调 <c>GetAsync</c>/<c>GetRangeAsync</c> 各 3 次，
    /// 目录仍不存在。
    /// </summary>
    /// <remarks>
    /// 这条守的是"首次启动自动创建空榜"那类实现 —— 它会让日历页在<b>预渲染</b>里产生副作用，
    /// 而 <c>ServerPrerendered</c> 每次请求都跑两遍。运行期只能覆盖"目录不存在"这一种入口，
    /// 静态那侧由 FT-94 看（读方法体里不许出现 CreateDirectory）。
    /// </remarks>
    [Fact]
    public async Task U13_6_ReadPath_NeverCreatesAnything()
    {
        Assert.False(Directory.Exists(_dir), "前置：目录一开始就不该存在");

        for (var i = 0; i < 3; i++)
        {
            Assert.Null(await _board.GetAsync(Today));
            Assert.Empty(await _board.GetRangeAsync(LianliankanCore.MinIssue, Today));
        }

        Assert.False(Directory.Exists(_dir), "读路径建了目录");
        Assert.False(File.Exists(FilePath), "读路径建了文件");
    }

    // ───────────────────────── U13-7 并发 ─────────────────────────

    /// <summary>20 个并发提交不丢更新；最终值是最小秒数（<c>SemaphoreSlim</c> 的看守）。</summary>
    [Fact]
    public async Task U13_7_ConcurrentSubmits_KeepTheFastest()
    {
        var issue = Today;
        var tasks = Enumerable.Range(0, 20)
            .Select(i => _board.SubmitAsync(issue, 100 - i, $"n{i}"))
            .ToArray();

        await Task.WhenAll(tasks);

        var rec = await _board.GetAsync(issue);
        Assert.NotNull(rec);
        Assert.Equal(81, rec!.Sec);                                    // 100-19

        // 落盘也必须是 81（不是只有内存对）
        Assert.Equal(81, (await NewBoard(_dir).GetAsync(issue))!.Sec);
    }

    // ───────────────────────── U13-8 期号闸 ─────────────────────────

    /// <summary>期号闸：下界之前 / 明天 / 0 一律拒收，且<b>拒收路径也不建目录</b>。</summary>
    [Fact]
    public async Task U13_8_IssueGate_Rejects_BeforeMin_Future_And_Zero()
    {
        Assert.Null(await _board.SubmitAsync(LianliankanCore.MinIssue - 1, 30, "旧关卡"));   // 20261031
        Assert.Null(await _board.SubmitAsync(LianliankanCore.IssueFor(Now.AddDays(1)), 30, "未来"));
        Assert.Null(await _board.SubmitAsync(0, 30, "零"));

        Assert.False(Directory.Exists(_dir), "被拒的提交不该建目录");
        Assert.False(File.Exists(FilePath), "被拒的提交不该建文件");

        // 上界是"今天"，今天必须能过（否则闸写反了也会被上面三条"全拒"的断言放过）
        Assert.NotNull(await _board.SubmitAsync(Today, 30, "今天"));
        Assert.True(File.Exists(FilePath));
    }

    // ───────────────────────── 秒数闸（U13-1 的补角） ─────────────────────────

    /// <summary><c>sec &lt; 1</c> 与超过一天一律拒收 —— 与 <c>TryUpdateBest</c>/<c>TryParseBest</c> 同口径。</summary>
    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    [InlineData(LianliankanCore.MaxElapsedSec + 1)]
    public async Task U13_8b_SecGate_Rejects_OutOfRange(int sec)
    {
        Assert.Null(await _board.SubmitAsync(Today, sec, "越界"));
        Assert.False(File.Exists(FilePath));
    }
}
