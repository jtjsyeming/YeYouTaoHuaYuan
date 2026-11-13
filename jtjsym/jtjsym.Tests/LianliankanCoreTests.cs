using jtjsym.Services;
using Xunit;

namespace jtjsym.Tests;

/// <summary>
/// 连连看内核（C-60）。用例口径来自《36》v2.0 §5.1 + v2.1 §6.1 的增量。
/// <para><b>棋盘一律用 <see cref="Board"/> 从快照造</b>，而不是给 Core 开测试专用构造器：
/// 走 <c>TryFrom</c> 造的盘同时把"结构闸放行"这件事一起验了，比直挂内部字段更接近真实恢复路径。</para>
/// </summary>
public class LianliankanCoreTests
{
    private const int Today = 20261112;

    private static LianliankanCore NewCore(params (int R, int C, int Face)[] tiles)
    {
        var cells = new int[LianliankanCore.CellCount];
        foreach (var (r, c, face) in tiles)
        {
            cells[r * LianliankanCore.Cols + c] = face;
        }

        var core = LianliankanCore.TryFrom(
            new LianliankanSnapshot { V = LianliankanSnapshot.CurrentVersion, Issue = Today, Cells = cells, ElapsedSec = 1 },
            Today);
        Assert.NotNull(core);
        return core!;
    }

    // ─────────────────────────── 连通矩阵 ───────────────────────────

    /// <summary>0 拐：同一行，中间全空。</summary>
    [Fact]
    public void CanConnect_StraightLine_True() =>
        Assert.True(NewCore((3, 0, 1), (3, 5, 1)).CanConnect(3, 0, 3, 5));

    /// <summary>1 拐：同一行出发、同一列到达。</summary>
    [Fact]
    public void CanConnect_OneTurn_True() =>
        Assert.True(NewCore((0, 0, 1), (3, 2, 1)).CanConnect(0, 0, 3, 2));

    /// <summary>2 拐（内拐）：两条直路都被挡，只能借道盘内空行/空列。</summary>
    [Fact]
    public void CanConnect_TwoTurns_InnerCorner_True()
    {
        // (0,0)→(1,0)→(1,2)→(2,2)：1 拐的两条路分别被 (0,2) 与 (2,0) 的「2」堵死
        var core = NewCore((0, 0, 1), (2, 2, 1), (0, 2, 2), (2, 0, 2));
        Assert.True(core.CanConnect(0, 0, 2, 2));
    }

    /// <summary>
    /// 2 拐（外绕）：整行被占满，两块只能从<b>盘外那一圈</b>绕过去。
    /// 这条是"外圈存在性"的正面看守 —— 少了外扩 1 圈就会判 false。
    /// </summary>
    [Fact]
    public void CanConnect_TwoTurns_OuterRing_True()
    {
        var core = NewCore((0, 0, 1), (0, 5, 1), (0, 1, 2), (0, 2, 2), (0, 3, 3), (0, 4, 3));
        Assert.True(core.CanConnect(0, 0, 0, 5));
    }

    /// <summary>
    /// 需要 3 拐的两块必须判死。这里用经典"棋盘格死局"：2×2 交错摆法，
    /// 任意一条 ≤2 拐的路都被同盘的另外两块挡住。
    /// </summary>
    [Fact]
    public void CanConnect_ThreeTurns_Rejected()
    {
        var core = NewCore((3, 2, 1), (4, 3, 1), (3, 3, 2), (4, 2, 2));
        Assert.False(core.CanConnect(3, 2, 4, 3));
        Assert.False(core.CanConnect(3, 3, 4, 2));
    }

    /// <summary>四邻全被占、且外绕也要穿过被占格：判死（不是"同号就能连"）。</summary>
    [Fact]
    public void CanConnect_BlockedByNeighbors_False()
    {
        var core = NewCore((0, 0, 1), (1, 1, 1), (0, 1, 2), (1, 0, 2));
        Assert.False(core.CanConnect(0, 0, 1, 1));
    }

    /// <summary>非法端点：同格 / 不同号 / 空格，一律 false（不许抛异常）。</summary>
    [Theory]
    [InlineData(3, 0, 3, 0)]     // 同格
    [InlineData(3, 0, 3, 5)]     // 不同号（1 vs 2）
    [InlineData(3, 0, 5, 0)]     // 目标是空格
    public void CanConnect_RejectsBadEndpoints(int r1, int c1, int r2, int c2)
    {
        // (5,0) 特意留空：非法端点里的"目标是空格"这一条要有格子可指
        var core = NewCore((3, 0, 1), (4, 4, 1), (3, 5, 2), (5, 5, 2));
        Assert.False(core.CanConnect(r1, c1, r2, c2));
    }

    // ─────────────────────────── 生成确定性 ───────────────────────────

    /// <summary>同一期号两次生成必须逐格相等 —— 这就是"每日一关"。</summary>
    [Fact]
    public void NewDaily_SameIssue_SameBoard()
    {
        var a = LianliankanCore.NewDaily(Today);
        var b = LianliankanCore.NewDaily(Today);

        Assert.Equal(a.Cells.ToArray(), b.Cells.ToArray());
        Assert.Equal(LianliankanCore.CellCount, a.RemainingCount);
    }

    /// <summary>不同期号至少一格不同（抽查 8 个相邻期号，防止 seed 只用了 issue 的低位）。</summary>
    [Fact]
    public void NewDaily_DifferentIssue_DifferentBoard()
    {
        var baseCells = LianliankanCore.NewDaily(Today).Cells;
        for (var d = 1; d <= 8; d++)
        {
            var other = LianliankanCore.NewDaily(Today + d).Cells.ToArray();
            Assert.NotEqual(baseCells.ToArray(), other);
        }
    }

    /// <summary>连续 100 个期号开出来的盘都必须至少有一对可连（生成期唯一的可解性保证）。</summary>
    [Fact]
    public void NewDaily_AlwaysHasPair()
    {
        for (var d = 0; d < 100; d++)
        {
            var core = LianliankanCore.NewDaily(Today + d);
            Assert.True(core.HasAnyPair(), $"期号 {Today + d} 的盘面没有可连对");
        }
    }

    // ─────────────────────────── 期号 ───────────────────────────

    /// <summary>跨日边界与 UTC 口径：北京时间 16:00Z 已经是次日。</summary>
    [Theory]
    [InlineData("2026-11-12T23:59:59+08:00", 20261112)]
    [InlineData("2026-11-13T00:00:00+08:00", 20261113)]
    [InlineData("2026-11-12T16:00:00+00:00", 20261113)]   // = 11-13 00:00 +08
    [InlineData("2026-11-12T15:59:59+00:00", 20261112)]
    public void IssueFor_UsesChinaFixedOffset(string iso, int expected) =>
        Assert.Equal(expected, LianliankanCore.IssueFor(DateTimeOffset.Parse(iso)));

    // ─────────────────────────── 主题与文案 ───────────────────────────

    /// <summary>24 个 Id 必须是 1..24 且唯一（sprite 格位就是按它算的，缺号/重号会让两张图重影）。</summary>
    [Fact]
    public void Themes_IdsAreOneToTwentyFour()
    {
        var ids = LianliankanThemes.Characters.Select(c => c.Id).ToArray();
        Assert.Equal(Enumerable.Range(1, 24), ids);
        Assert.Equal(24, ids.Distinct().Count());
    }

    /// <summary>6 色族 × 4 人：这条守的是"40px 下靠色族分 6 档、族内靠剪影"的选角结构。</summary>
    [Fact]
    public void Themes_SixFamiliesOfFour()
    {
        var groups = LianliankanThemes.Characters.GroupBy(c => c.Family).ToArray();
        Assert.Equal(6, groups.Length);
        Assert.All(groups, g => Assert.Equal(4, g.Count()));
    }

    /// <summary>sprite 格位：24 个编号必须落在 6×4 内且两两不同（否则两格显示同一张脸）。</summary>
    [Fact]
    public void Themes_Position_AllDistinctWithinSprite()
    {
        var positions = Enumerable.Range(1, 24).Select(LianliankanThemes.Position).ToArray();

        Assert.Equal(24, positions.Distinct().Count());
        Assert.All(positions, p =>
        {
            Assert.InRange(p.Col, 0, LianliankanThemes.Columns - 1);
            Assert.InRange(p.Row, 0, LianliankanThemes.Rows - 1);
        });
    }

    /// <summary>期号文案的格式看守：改前缀必须先改这条（《36》v2.1 §3.5 只允许一处拼接）。</summary>
    [Fact]
    public void IssueLabel_HasSingleFormat() =>
        Assert.Equal("地球日20261112关", LlkCopy.IssueLabel(20261112));

    // ─────────────────────────── 死局与重排 ───────────────────────────

    /// <summary>2×2 交错摆法是死局（两条同号对都连不上）。</summary>
    [Fact]
    public void CheckerBoard_HasNoPair()
    {
        var core = NewCore((3, 2, 1), (4, 3, 1), (3, 3, 2), (4, 2, 2));
        Assert.False(core.HasAnyPair());
    }

    /// <summary>只剩 2 块时必然可连（空盘任意两格 ≤2 拐）—— 写进测试，别写成 if。</summary>
    [Fact]
    public void TwoRemaining_AlwaysConnectable()
    {
        var core = NewCore((0, 0, 1), (LianliankanCore.Rows - 1, LianliankanCore.Cols - 1, 1));
        Assert.True(core.HasAnyPair());
    }

    /// <summary>重排只动位置：剩余数与图案多重集不变，且重排后一定存在可连对。</summary>
    [Fact]
    public void Reshuffle_PreservesMultiset_AndRestoresPair()
    {
        var core = NewCore((3, 2, 1), (4, 3, 1), (3, 3, 2), (4, 2, 2));
        Assert.False(core.HasAnyPair());

        Assert.True(core.Reshuffle());
        Assert.True(core.HasAnyPair());
        Assert.Equal(4, core.RemainingCount);
        Assert.Equal(new[] { 1, 1, 2, 2 }, core.Cells.Where(v => v != 0).OrderBy(v => v).ToArray());
    }

    // ─────────────────────────── 快照闸 ───────────────────────────

    [Fact]
    public void Snapshot_RoundTrip()
    {
        var core = LianliankanCore.NewDaily(Today);

        // 必须消掉**一对**：随便消两格会让两个头像各剩 1 个（奇数）⇒ 成对闸拒收
        var cells = core.Cells;
        var first = Enumerable.Range(0, LianliankanCore.CellCount).First(i => cells[i] != 0);
        var second = Enumerable.Range(first + 1, LianliankanCore.CellCount - first - 1)
            .First(i => cells[i] == cells[first]);
        core.Remove(first / LianliankanCore.Cols, first % LianliankanCore.Cols);
        core.Remove(second / LianliankanCore.Cols, second % LianliankanCore.Cols);

        var snap = core.ToSnapshot(42);
        var back = LianliankanCore.TryFrom(snap, Today);

        Assert.NotNull(back);
        Assert.Equal(core.Cells.ToArray(), back!.Cells.ToArray());
        Assert.Equal(core.Issue, back.Issue);
        Assert.Equal(core.RemainingCount, back.RemainingCount);
        Assert.Equal(LianliankanCore.CellCount - 2, back.RemainingCount);
    }

    /// <summary>结构闸：长度错 / 值域越界 / 某头像剩余奇数 / 期号不符 / 全 0（已通关）一律整档丢弃。</summary>
    [Fact]
    public void TryFrom_RejectsBrokenSnapshots()
    {
        var good = LianliankanCore.NewDaily(Today).ToSnapshot(3);

        LianliankanSnapshot Mutate(Action<LianliankanSnapshot> f)
        {
            var copy = new LianliankanSnapshot
            {
                V = good.V,
                Issue = good.Issue,
                Cells = (int[])good.Cells!.Clone(),
                ElapsedSec = good.ElapsedSec,
            };
            f(copy);
            return copy;
        }

        Assert.NotNull(LianliankanCore.TryFrom(good, Today));                       // 对照：好档必须过

        Assert.Null(LianliankanCore.TryFrom(Mutate(s => s.Cells = s.Cells!.Take(47).ToArray()), Today));
        Assert.Null(LianliankanCore.TryFrom(Mutate(s => s.Cells![0] = 25), Today));
        Assert.Null(LianliankanCore.TryFrom(Mutate(s => s.Cells![0] = -1), Today));
        Assert.Null(LianliankanCore.TryFrom(Mutate(s => s.V = 2), Today));
        Assert.Null(LianliankanCore.TryFrom(null, Today));
        Assert.Null(LianliankanCore.TryFrom(good, Today + 1));                      // 期号闸
        Assert.Null(LianliankanCore.TryFrom(Mutate(s => s.ElapsedSec = -1), Today));

        // 成对闸：只清掉一格 ⇒ 该头像剩奇数 ⇒ 永远消不完
        Assert.Null(LianliankanCore.TryFrom(
            Mutate(s =>
            {
                var k = Array.FindIndex(s.Cells!, v => v != 0);
                s.Cells![k] = 0;
            }),
            Today));

        // 全 0 = 已通关的盘：结构上"成对"成立，但恢复出来只会立刻弹一次胜利遮罩
        Assert.Null(LianliankanCore.TryFrom(Mutate(s => Array.Fill(s.Cells!, 0)), Today));
    }

    // ─────────────────────────── 今日最快（秒，越小越好） ───────────────────────────

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("abc", null)]
    [InlineData("{}", null)]                                              // issue=0 ≠ 今日
    [InlineData("{\"issue\":20260101,\"sec\":9}", null)]                  // 昨天（或任意别的日子）
    [InlineData("{\"issue\":20261112,\"sec\":0}", null)]                  // 0 秒非法（与 D-27 同口径）
    [InlineData("{\"issue\":20261112,\"sec\":87}", 87)]
    public void TryParseBest_FollowsTodayAndPositiveRule(string? raw, int? expected) =>
        Assert.Equal(expected, LianliankanCore.TryParseBest(raw, Today));

    [Theory]
    [InlineData(null, 1, 1)]        // 首条纪录
    [InlineData(10, 9, 9)]          // 更快 ⇒ 刷新
    [InlineData(10, 11, null)]      // 更慢 ⇒ 不动
    [InlineData(10, 10, null)]      // 相等 ⇒ 不动
    [InlineData(null, 0, null)]     // 0 秒非法
    public void TryUpdateBest_KeepsTheSmallest(int? current, int sec, int? expected) =>
        Assert.Equal(expected, LianliankanCore.TryUpdateBest(current, sec));

    /// <summary>落盘载荷与解析必须互逆（键名/字段名只有这一处，别在页面里手拼 JSON）。</summary>
    [Fact]
    public void BestJson_RoundTrips()
    {
        var json = LianliankanCore.BestJson(Today, 87);
        Assert.Equal(87, LianliankanCore.TryParseBest(json, Today));
    }
}
