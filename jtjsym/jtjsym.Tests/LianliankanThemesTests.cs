using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 生肖月主题（H-023）：点阵数据的结构、月份归属、格位角色换算与文案对齐。
/// <para><b>这组用例守的是"数据"而不是"渲染"</b>：点阵同时决定"哪里有方块"（<c>CellKind</c>）与
/// "这一关有多少块"（<c>PlayableCount</c>），而这两件事直接决定铺盘、<c>RemainingCount</c> 与通关判定 ——
/// 画错一格就是"永远消不完、永不通关"，且页面不会报任何错。剩下的只有"盘面看起来像不像"
/// （e2e LL-50 守铺盘与点阵同构）。</para>
/// <para>《57》v2.7 §7.1 把 U16-1/U16-3 重写为 20×16 口径（v1.x 是 8×6 的染色版），
/// U16-2/U16-5 不动（月份回环与文案同序与盘面尺寸无关）。</para>
/// </summary>
public class LianliankanThemesTests
{
    /// <summary>某年某月 1 日的期号（点阵只与月份有关，日号取 1 最省事）。</summary>
    private static int Issue(int year, int month) => year * 10000 + month * 100 + 1;

    private static readonly string[] Names = { "鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪" };

    // ───────────────────────── U16-1 点阵结构 ─────────────────────────

    /// <summary>
    /// 12 张点阵的结构：张数、行数、每行长度、字符集、可消除数为偶数、可消除区四连通、黑块群贴脸。
    /// <para><b>判别力在于"压缩/改图时最容易坏的那几处"</b>：少一行（<c>art[r]</c> 越界 ⇒ 整页崩）、
    /// 某行 15 或 17 个字符（<c>idx % 16</c> 取到邻行 ⇒ 图案错位）、可消除数为奇数
    /// （最后一对拆开 ⇒ 永远消不完）、可消除区断成两片（生肖认不出）、黑块漂在盘中间（不是身体的一部分）。</para>
    /// <para>行数/列数<b>从 <see cref="LianliankanCore.Rows"/>/<see cref="LianliankanCore.Cols"/> 取</b>，
    /// 不写字面量 20/16 —— 写死等于把盘面尺寸复制成第二份真源，改尺寸时会漏改这里而全部"通过"。</para>
    /// </summary>
    [Fact]
    public void U16_1_ZodiacArt_IsRectangularConnectedAndDense()
    {
        var art = LianliankanThemes.ZodiacArt;

        Assert.Equal(12, art.Length);                       // 鼠..猪 一个不少

        for (var i = 0; i < art.Length; i++)
        {
            var rows = art[i];
            var who = Names[i];

            Assert.Equal(LianliankanCore.Rows, rows.Length);            // 20 行
            foreach (var row in rows)
            {
                Assert.Equal(LianliankanCore.Cols, row.Length);         // 每行 16 字符
                Assert.All(row, ch => Assert.True(ch is '.' or '#' or '+' or 'o',
                    $"{who}：出现非法字符 '{ch}'（只许 . # + o）"));
            }

            var faces = new HashSet<(int R, int C)>();
            var blocks = new HashSet<(int R, int C)>();
            for (var r = 0; r < rows.Length; r++)
            {
                for (var c = 0; c < rows[r].Length; c++)
                {
                    if (rows[r][c] is '#' or '+') faces.Add((r, c));
                    else if (rows[r][c] == 'o') blocks.Add((r, c));
                }
            }

            Assert.True(faces.Count % 2 == 0, $"{who}：可消除格 {faces.Count} 个（必须是偶数，否则最后一对拆开）");
            Assert.True(blocks.Count >= 2, $"{who}：黑块只有 {blocks.Count} 个（《57》v2.7 §4.3 要求 ≥2）");

            // 可消除区必须**四连通**：断成两片就不是"一个生肖"，而是"两撮方块"
            Assert.Equal(faces.Count, Flood(faces).Count);

            // 黑块群必须**贴脸**：每个群至少有一格与可消除区相邻 —— 否则是一块漂在空处的石头
            foreach (var group in Groups(blocks))
            {
                var touches = group.Any(p => Neighbours(p).Any(faces.Contains));
                Assert.True(touches, $"{who}：有一群黑块（{group.Count} 格）完全没贴着形状");
            }
        }
    }

    private static IEnumerable<(int R, int C)> Neighbours((int R, int C) p) => new[]
    {
        (p.R - 1, p.C), (p.R + 1, p.C), (p.R, p.C - 1), (p.R, p.C + 1),
    };

    /// <summary>四连通洪泛：返回与起点同片的全部格（用于断言"只有一片"）。</summary>
    private static HashSet<(int R, int C)> Flood(HashSet<(int R, int C)> set)
    {
        if (set.Count == 0) return set;

        var seen = new HashSet<(int R, int C)>();
        var stack = new Stack<(int R, int C)>();
        stack.Push(set.First());
        while (stack.Count > 0)
        {
            var p = stack.Pop();
            if (!seen.Add(p)) continue;
            foreach (var q in Neighbours(p))
            {
                if (set.Contains(q) && !seen.Contains(q)) stack.Push(q);
            }
        }
        return seen;
    }

    /// <summary>把黑块按四连通切成若干群（顺序无关，只用于"每群都贴脸"这条断言）。</summary>
    private static List<List<(int R, int C)>> Groups(HashSet<(int R, int C)> blocks)
    {
        var left = new HashSet<(int R, int C)>(blocks);
        var groups = new List<List<(int R, int C)>>();

        while (left.Count > 0)
        {
            var seed = left.First();
            var slice = new HashSet<(int R, int C)>();
            var stack = new Stack<(int R, int C)>();
            stack.Push(seed);

            while (stack.Count > 0)
            {
                var p = stack.Pop();
                if (!left.Contains(p) || !slice.Add(p)) continue;
                foreach (var q in Neighbours(p))
                {
                    if (left.Contains(q)) stack.Push(q);
                }
            }

            foreach (var p in slice) left.Remove(p);
            groups.Add(slice.ToList());
        }

        return groups;
    }

    // ───────────────────────── U16-2 月份归属 ─────────────────────────

    /// <summary>
    /// 月份 → 生肖：<b>2026-01 起算、每月一轮、跨年回环</b>。
    /// <para><b>只有这条能抓住</b> <c>(month-1)%12</c> 与 <c>month%12</c> 的一行之差 ——
    /// 后者在 2026-01 会给出「牛」，而其它任何断言（点阵结构、格位换算）都发现不了。</para>
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

    // ───────────────────────── U16-3 格位换算 ─────────────────────────

    /// <summary>
    /// <c>CellKind</c> 与点阵<b>逐格一致</b>：12 个月 × 320 格，把返回值拼回字符，必须逐字等于点阵。
    /// <para><b>防的是行列写反</b>（<c>idx / 16</c> 与 <c>idx % 16</c> 互换）。写反之后格数、
    /// "有多少块"、甚至黑白比例全都不变，只是图案被<b>转置</b> —— 看代码看不出，
    /// 看截图也未必看出（U16-1 的结构断言照样全绿），只有逐格拼比对才抓得住。</para>
    /// <para>顺带钉住 <see cref="LianliankanThemes.PlayableCount"/> = 点阵里 <c>#</c>+<c>+</c> 的格数 ——
    /// 它是 <c>RemainingCount</c> 的初值，写错就是"永远消不完"（《57》v2.7 §2 的 ⚠ 逐字提醒过）。</para>
    /// </summary>
    [Fact]
    public void U16_3_CellKind_MatchesArtCellByCell()
    {
        for (var m = 1; m <= 12; m++)
        {
            var issue = Issue(2026, m);
            var rows = LianliankanThemes.ZodiacArt[m - 1];

            var rendered = string.Join('\n', Enumerable.Range(0, LianliankanCore.Rows)
                .Select(r => new string(Enumerable.Range(0, LianliankanCore.Cols)
                    .Select(c => LianliankanThemes.CellKind(issue, r * LianliankanCore.Cols + c) switch
                    {
                        LianliankanThemes.LlkCellKind.Block => 'o',
                        LianliankanThemes.LlkCellKind.Face => '+',     // '#' 与 '+' 同义，统一成一个符号再比
                        _ => '.',
                    })
                    .ToArray())
                    .Replace('#', '+')));                                  // 点阵里的 '#' 也归一成 '+'

            var expected = string.Join('\n', rows).Replace('#', '+');
            Assert.Equal(expected, rendered);

            var playable = rows.Sum(row => row.Count(ch => ch is '#' or '+'));
            Assert.Equal(playable, LianliankanThemes.PlayableCount(issue));
        }

        // 越界不抛（渲染循环里宁可少画一格，也不能整页崩）
        Assert.Equal(LianliankanThemes.LlkCellKind.Empty,
            LianliankanThemes.CellKind(Issue(2026, 11), -1));
        Assert.Equal(LianliankanThemes.LlkCellKind.Empty,
            LianliankanThemes.CellKind(Issue(2026, 11), LianliankanCore.CellCount));
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
        for (var m = 1; m <= 12; m++)
        {
            Assert.Equal($"{Names[m - 1]}月 · {LlkCopy.MonthCn(m)}", LlkCopy.ZodiacLabel(Issue(2026, m)));
        }

        Assert.Equal("狗月 · 十一月", LlkCopy.ZodiacLabel(Issue(2026, 11)));
        Assert.Equal("鼠月 · 一月", LlkCopy.ZodiacLabel(Issue(2027, 1)));      // 跨年仍按月份回环
        Assert.Equal("", LlkCopy.MonthCn(0));                                   // 越界给空串，不抛
        Assert.Equal("", LlkCopy.MonthCn(13));
    }
}
