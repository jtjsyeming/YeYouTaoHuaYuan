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

    // ─────────────────────── 带路径的连通判定（H-015 / 《39》§8.1） ───────────────────────
    //
    // ⚠ 布局全部出自《39》§9 的 C# 实测，**不是手工推演**：v2.0 的布局 C 就是推演产物
    //   （"外圈 2 拐"），实测路径却在盘内。人脑枚举外圈岔路必漏，所以下面每条盘面都当成"钉子"用。

    /// <summary>U3 用的布局 C'：外圈 2 拐。<b>(1,1) 那个 9 是关键</b> —— 抽掉它，盘内 2 拐就通了。</summary>
    private static readonly int[] LayoutOuterTwoTurns =
    {
        1, 2, 3, 2, 3, 1,
        0, 9, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 9,
    };

    /// <summary>U4 用的布局 A'：盘内 3 拐（(3,2)↔(3,5)）。</summary>
    private static readonly int[] LayoutInnerThreeTurns =
    {
        11, 0, 8, 0, 0, 0,
        0, 12, 0, 0, 11, 0,
        12, 0, 0, 0, 13, 0,
        0, 0, 1, 0, 14, 1,
        0, 0, 13, 0, 0, 0,
        0, 14, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        8, 0, 0, 0, 0, 0,
    };

    /// <summary>U5 / LL-18 用的布局 B：彻底没路（但不限拐数也是 null）。</summary>
    private static readonly int[] LayoutDeadEnd =
    {
        3, 3, 2, 6, 6, 0,
        5, 1, 2, 1, 8, 8,
        4, 4, 0, 7, 7, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 5,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
    };

    /// <summary>LL-17 用的布局 D：外圈 3 拐（(0,0)↔(5,5)），12 块 1~6 各两张。</summary>
    private static readonly int[] LayoutOuterThreeTurns =
    {
        1, 2, 3, 4, 5, 6,
        2, 0, 0, 0, 0, 0,
        3, 0, 0, 0, 0, 0,
        4, 0, 0, 0, 0, 0,
        5, 0, 0, 0, 0, 0,
        6, 0, 0, 0, 0, 1,
        0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0,
    };

    /// <summary>从裸数组造盘：走 <c>TryFrom</c>，顺带把"结构闸放行"一起验了。</summary>
    private static LianliankanCore FromCells(int[] cells) => LlkDifferentialProbe.RestoreCore(cells);

    /// <summary>
    /// U1：<c>TryFindPath(TurnLimit) != null</c> ⟺ <c>CanConnect</c>。
    /// <para><b>复用 <see cref="LlkDifferentialProbe.Boards"/> 的盘源</b>，不另写随机构造 ——
    /// 两处盘源一漂，两个差分就不是同一个命题了。这条钉住的是"一次搜索按 Turns 分流"可替代
    /// 页面里的二次 <c>CanConnect</c> 调用（《39》§6.1）。</para>
    /// </summary>
    [Fact]
    public void TryFindPath_MatchesCanConnect_Differential()
    {
        long compared = 0;
        var iter = 0;
        foreach (var cells in LlkDifferentialProbe.Boards())
        {
            iter++;
            var core = FromCells(cells);
            for (var a = 0; a < LianliankanCore.CellCount; a++)
            {
                if (cells[a] == 0) continue;
                for (var b = a + 1; b < LianliankanCore.CellCount; b++)
                {
                    if (cells[b] != cells[a]) continue;
                    var got = core.TryFindPath(a / 6, a % 6, b / 6, b % 6, LianliankanCore.TurnLimit) is not null;
                    var want = core.CanConnect(a / 6, a % 6, b / 6, b % 6);
                    compared++;
                    Assert.True(got == want,
                        $"iter={iter} 格 {a}({a / 6},{a % 6})↔{b}({b / 6},{b % 6}) face={cells[a]}：TryFindPath={got} CanConnect={want} 盘={string.Join(',', cells)}");
                }
            }
        }
        Assert.True(compared > 5000, $"对拍样本过少：{compared}");
    }

    /// <summary>
    /// U2：路径自洽 —— 相邻点必同行或同列、<c>Turns == Points.Count - 2</c>、首尾是两端格子、
    /// 盘内中间点必须是空格。
    /// <para>首点断言<b>专守《39》§3.2 的"回溯补起点"</b>：起点状态记 <c>-1</c> 哨兵、不在 parent 链里，
    /// 少写 <c>Insert(0, …)</c> 就会从起点旁边那一格开始（实测《39》作者首版 5 个布局有 4 个缺起点）。</para>
    /// </summary>
    [Fact]
    public void TryFindPath_PointsAreValid()
    {
        var hits = 0;
        var iter = 0;
        foreach (var cells in LlkDifferentialProbe.Boards())
        {
            iter++;
            var core = FromCells(cells);
            for (var a = 0; a < LianliankanCore.CellCount; a++)
            {
                if (cells[a] == 0) continue;
                for (var b = a + 1; b < LianliankanCore.CellCount; b++)
                {
                    if (cells[b] != cells[a]) continue;

                    var path = core.TryFindPath(a / 6, a % 6, b / 6, b % 6, int.MaxValue);
                    if (path is null) continue;
                    hits++;

                    Assert.True(path.Points.Count >= 2, $"iter={iter} 路径点太少：{path.Points.Count}");
                    Assert.Equal(path.Points.Count - 2, path.Turns);
                    Assert.Equal((a / 6, a % 6), path.Points[0]);       // ← 补起点
                    Assert.Equal((b / 6, b % 6), path.Points[^1]);

                    for (var k = 1; k < path.Points.Count; k++)
                    {
                        var p = path.Points[k - 1];
                        var q = path.Points[k];
                        Assert.True(p.R == q.R || p.C == q.C, $"iter={iter} 出现斜线段 {p}→{q}");
                    }

                    for (var k = 1; k < path.Points.Count - 1; k++)
                    {
                        var p = path.Points[k];
                        if (!LianliankanCore.InBoard(p.R, p.C)) continue;
                        Assert.Equal(0, core.FaceAt(p.R, p.C));
                    }
                }
            }
        }
        Assert.True(hits > 3000, $"样本过少：{hits}");
    }

    /// <summary>
    /// U3：外圈 2 拐。
    /// <para><b>不要抄既有的 <c>CanConnect_TwoTurns_OuterRing_True</c> 的盘面</b> —— 那张盘第 1 行是空行，
    /// 实测盘内 2 拐就通了，名字有误导（《39》§0 新硬错）。布局 C' 靠 (1,1) 的 9 把盘内路堵死。</para>
    /// </summary>
    [Fact]
    public void TryFindPath_OuterRing_GoesOutside()
    {
        var core = FromCells(LayoutOuterTwoTurns);

        Assert.True(core.CanConnect(0, 0, 0, 5));                   // 判定口径：通
        var path = core.TryFindPath(0, 0, 0, 5, int.MaxValue);
        Assert.NotNull(path);
        Assert.Equal(2, path!.Turns);
        Assert.Contains(path.Points, p =>
            !LianliankanCore.InBoard(p.R, p.C));                    // 必须真走出盘外
    }

    /// <summary>U4：盘内 3 拐 —— 判定口径判死，不限拐能拿到 3 拐且全程在盘内。</summary>
    [Fact]
    public void TryFindPath_ThreeTurnsInBoard()
    {
        var core = FromCells(LayoutInnerThreeTurns);

        Assert.False(core.CanConnect(3, 2, 3, 5));
        Assert.Null(core.TryFindPath(3, 2, 3, 5, LianliankanCore.TurnLimit));

        var path = core.TryFindPath(3, 2, 3, 5, int.MaxValue);
        Assert.NotNull(path);
        Assert.Equal(3, path!.Turns);
        Assert.All(path.Points, p => Assert.True(LianliankanCore.InBoard(p.R, p.C), $"{p} 跑出了盘外"));
    }

    /// <summary>U5：彻底没路 —— 不限拐也是 null（④ 层抖动的唯一入口）。</summary>
    [Fact]
    public void TryFindPath_DeadEnd_Null()
    {
        var core = FromCells(LayoutDeadEnd);

        Assert.True(core.HasAnyPair());                             // 盘上仍有别的对，不是死局
        Assert.Null(core.TryFindPath(1, 1, 1, 3, int.MaxValue));
    }

    /// <summary>U3/U4 的布局顺带钉住"页面上要画成几条线"（LL-17 依赖 Turns 分层）。</summary>
    [Fact]
    public void TryFindPath_LayoutD_IsThreeTurnsOutside()
    {
        var core = FromCells(LayoutOuterThreeTurns);

        Assert.False(core.CanConnect(0, 0, 5, 5));
        var path = core.TryFindPath(0, 0, 5, 5, int.MaxValue);
        Assert.NotNull(path);
        Assert.Equal(3, path!.Turns);
        Assert.Contains(path.Points, p => !LianliankanCore.InBoard(p.R, p.C));
    }

    /// <summary>U6：提示对 —— 可连、行优先确定性、<paramref name="excludeIdx"/> 生效、全堵返回 null。</summary>
    [Fact]
    public void FindHintPair_FirstConnectable_Deterministic()
    {
        // 四块、两对都可连：(0,0)/(0,1) 是行优先的第一对，(7,4)/(7,5) 是第二对
        var core = NewCore((0, 0, 1), (0, 1, 1), (7, 4, 2), (7, 5, 2));

        var first = core.FindHintPair();
        Assert.NotNull(first);
        Assert.Equal((0, 0, 0, 1), first!.Value);
        Assert.True(core.CanConnect(first.Value.R1, first.Value.C1, first.Value.R2, first.Value.C2));

        Assert.Equal(first, core.FindHintPair());                   // 连扫两次一致

        // excludeIdx：跳过含该格的对 ⇒ 落到第二对
        var skipped = core.FindHintPair(excludeIdx: 0);
        Assert.NotNull(skipped);
        Assert.Equal((7, 4, 7, 5), skipped!.Value);

        // 全堵盘（2×2 交错死局）⇒ null
        Assert.Null(FromCells(new[]
        {
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 1, 2, 0, 0,
            0, 0, 2, 1, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0,
        }).FindHintPair());
    }

    /// <summary>
    /// U7：快照里的提示次数 —— 旧档补满、越界夹回、写出去与读回来一致，且 <c>V</c> 仍是 1。
    /// <para><b>不升版</b>是《39》§4 拍板 4：结构没变（可选字段向后兼容），
    /// 升 v2 就得把"只认当前版本"改成白名单，以后每加一版回来改一次。</para>
    /// </summary>
    [Fact]
    public void TryFrom_HintsDefaultAndClamp()
    {
        var good = LianliankanCore.NewDaily(Today).ToSnapshot(3);

        LianliankanSnapshot With(int? hints) => new()
        {
            V = good.V,
            Issue = good.Issue,
            Cells = (int[])good.Cells!.Clone(),
            ElapsedSec = good.ElapsedSec,
            Hints = hints,
        };

        Assert.Equal(3, LianliankanCore.TryFrom(With(null), Today)!.HintsLeft);      // 旧档：补满
        Assert.Equal(1, LianliankanCore.TryFrom(With(1), Today)!.HintsLeft);
        Assert.Equal(3, LianliankanCore.TryFrom(With(9), Today)!.HintsLeft);         // 上界夹回
        Assert.Equal(0, LianliankanCore.TryFrom(With(-2), Today)!.HintsLeft);        // 下界夹回

        var core = LianliankanCore.TryFrom(With(2), Today)!;
        Assert.Equal(2, core.ToSnapshot(3).Hints);                                   // 写出去了
        Assert.Equal(LianliankanSnapshot.CurrentVersion, core.ToSnapshot(3).V);      // V 仍为 1
        Assert.Equal(1, LianliankanSnapshot.CurrentVersion);
    }

    /// <summary>提示次数的扣减口径：0 次或已通关都不扣、都返回 false。</summary>
    [Fact]
    public void UseHint_StopsAtZeroAndOnCleared()
    {
        var core = NewCore((0, 0, 1), (0, 1, 1), (7, 4, 2), (7, 5, 2));
        Assert.Equal(LianliankanCore.HintTotal, core.HintsLeft);

        for (var i = 0; i < LianliankanCore.HintTotal; i++) Assert.True(core.UseHint());
        Assert.Equal(0, core.HintsLeft);
        Assert.False(core.UseHint());                                // 0 次：false 且不变成 -1
        Assert.Equal(0, core.HintsLeft);

        var cleared = NewCore((0, 0, 5), (0, 1, 5));
        cleared.Remove(0, 0);
        cleared.Remove(0, 1);
        Assert.True(cleared.IsCleared);
        Assert.False(cleared.UseHint());                             // 已通关：不扣
        Assert.Equal(LianliankanCore.HintTotal, cleared.HintsLeft);
    }
}
