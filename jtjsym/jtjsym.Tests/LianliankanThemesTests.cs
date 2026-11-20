using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 生肖月主题（H-023 / C-106）：点阵数据的结构、月份归属、位置换算与文案对齐。
/// <para><b>这组用例守的是"数据"而不是"渲染"</b>：形状挂在格位上（<c>LianliankanThemes.IsZodiacCell</c>），
/// 与 cells、快照、成对闸全不相干 —— 所以单元测试能覆盖它的全部逻辑，剩下的只有"染色有没有画出来"（e2e LL-50）。</para>
/// </summary>
public class LianliankanThemesTests
{
    /// <summary>某年某月 1 日的期号（点阵只与月份有关，日号取 1 最省事）。</summary>
    private static int Issue(int year, int month) => year * 10000 + month * 100 + 1;

    // ───────────────────────── U16-1 点阵结构 ─────────────────────────

    /// <summary>
    /// 12 张点阵的结构：张数、行数、每行长度、字符集、'#' 数量区间。
    /// <para><b>判别力在于"压缩时最容易坏的那三处"</b>：少一行、某行 5 或 7 个字符、
    /// 某张图被删到只剩三五格。三种都不会让页面报错，只会让形状变得认不出。</para>
    /// </summary>
    [Fact]
    public void U16_1_ZodiacArt_StructureIsRectangularAndDenseEnough()
    {
        var art = LianliankanThemes.ZodiacArt;

        Assert.Equal(12, art.Length);                       // 鼠..猪 一个不少

        for (var i = 0; i < art.Length; i++)
        {
            var rows = art[i];
            Assert.Equal(8, rows.Length);                   // 与 LianliankanCore.Rows 同高

            foreach (var row in rows)
            {
                Assert.Equal(6, row.Length);                // 与 LianliankanCore.Cols 同宽
                Assert.All(row, ch => Assert.True(ch is '#' or '.', $"第 {i} 张出现非法字符 '{ch}'"));
            }

            var filled = rows.Sum(r => r.Count(ch => ch == '#'));
            Assert.InRange(filled, 24, 30);                 // <22 碎成几片、>32 糊成一团（《57》§2.5）
        }
    }

    // ───────────────────────── U16-2 月份归属 ─────────────────────────

    /// <summary>
    /// 月份 → 生肖：<b>2026-01 起算、每月一轮、跨年回环</b>。
    /// <para><b>只有这条能抓住</b> <c>(month-1)%12</c> 与 <c>month%12</c> 的一行之差 ——
    /// 后者在 2026-01 会给出「牛」，而其它任何断言（点阵结构、位置换算）都发现不了。</para>
    /// </summary>
    [Fact]
    public void U16_2_ZodiacIndex_RollsMonthlyFrom2026Jan()
    {
        Assert.Equal(0, LianliankanThemes.ZodiacIndex(Issue(2026, 1)));    // 鼠
        Assert.Equal(1, LianliankanThemes.ZodiacIndex(Issue(2026, 2)));    // 牛
        Assert.Equal(10, LianliankanThemes.ZodiacIndex(Issue(2026, 11)));  // 狗
        Assert.Equal(11, LianliankanThemes.ZodiacIndex(Issue(2026, 12)));  // 猪
        Assert.Equal(0, LianliankanThemes.ZodiacIndex(Issue(2027, 1)));    // 跨年回到鼠
        Assert.Equal(1, LianliankanThemes.ZodiacIndex(Issue(2028, 2)));    // 隔年同月同生肖

        // 同月任何一天都同一张图（形状只按月份算，不看日号）
        Assert.Equal(
            LianliankanThemes.ZodiacIndex(20261101),
            LianliankanThemes.ZodiacIndex(20261130));
    }

    // ───────────────────────── U16-3 位置换算 ─────────────────────────

    /// <summary>
    /// <c>IsZodiacCell</c> 与点阵<b>逐格一致</b>：把 12 个月的 48 个返回值拼成 8 行字符串，必须逐字等于点阵。
    /// <para><b>防的是行列写反</b>（<c>idx / 6</c> 与 <c>idx % 6</c> 互换）。写反之后点数与"有形状"都还在，
    /// 只是图案被转置 —— 看代码看不出，看截图也未必看出，只有逐格比才抓得住。</para>
    /// </summary>
    [Fact]
    public void U16_3_IsZodiacCell_MatchesArtCellByCell()
    {
        for (var m = 1; m <= 12; m++)
        {
            var issue = Issue(2026, m);
            var rendered = string.Join('\n', Enumerable.Range(0, 8)
                .Select(r => new string(Enumerable.Range(0, 6)
                    .Select(c => LianliankanThemes.IsZodiacCell(issue, r * 6 + c) ? '#' : '.')
                    .ToArray())));
            var expected = string.Join('\n', LianliankanThemes.ZodiacArt[m - 1]);

            Assert.Equal(expected, rendered);
        }

        // 越界不抛（渲染循环里宁可少染一格，也不能整页崩）
        Assert.False(LianliankanThemes.IsZodiacCell(Issue(2026, 11), -1));
        Assert.False(LianliankanThemes.IsZodiacCell(Issue(2026, 11), 48));
    }

    // ───────────────────────── U16-5 文案 ─────────────────────────

    /// <summary>
    /// 生肖名与点阵<b>同序</b>，月名是中文数字。
    /// <para><b>为什么这条不能省</b>：<c>ZodiacNames</c> 与 <c>ZodiacArt</c> 是两份并列的真源，
    /// 中间没有任何编译期约束。把「狗」和「猪」写反，点阵仍然 12 张、结构全合法，只有这条会红。</para>
    /// </summary>
    [Fact]
    public void U16_5_ZodiacLabel_NamesFollowArtOrder()
    {
        string[] expected = { "鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪" };

        for (var m = 1; m <= 12; m++)
        {
            Assert.Equal($"{expected[m - 1]}月 · {LlkCopy.MonthCn(m)}", LlkCopy.ZodiacLabel(Issue(2026, m)));
        }

        Assert.Equal("狗月 · 十一月", LlkCopy.ZodiacLabel(Issue(2026, 11)));
        Assert.Equal("鼠月 · 一月", LlkCopy.ZodiacLabel(Issue(2027, 1)));      // 跨年仍按月份回环
        Assert.Equal("", LlkCopy.MonthCn(0));                                   // 越界给空串，不抛
        Assert.Equal("", LlkCopy.MonthCn(13));
    }
}
